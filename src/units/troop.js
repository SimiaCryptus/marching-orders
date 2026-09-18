import {
  DIRS,
  nextStep,
  turnAround,
  turnLeft,
  turnRight,
  supported,
  wallBeside,
  stepTarget,
} from './pathing.js';
import { VOXEL, isLethal } from '../world/voxel.js';
import { applySigns } from '../items/sign.js';
import { TEAM } from './team.js';
import { DEFAULT_RULES } from '../rules.js';

export const TROOP_STATE = Object.freeze({
  WALKING: 'walking',
  FALLING: 'falling',
  CLIMBING: 'climbing',
  DIGGING: 'digging',
  BUILDING: 'building', // placing a ladder segment
  FIGHTING: 'fighting',
  SHOOTING: 'shooting',
  WORKING: 'working', // executing a role (builder, ...)
  DEAD: 'dead',
  SAVED: 'saved',
});

const FALL_SPEED = 7; // voxels per second
const PARACHUTE_FALL_SPEED = 3; // voxels per second under a canopy
const DIG_TIME = 0.6; // seconds per soft voxel
const LADDER_TIME = 0.7; // seconds per ladder segment
const BRIDGE_TIME = 0.5; // seconds per bridge plank
const CLIMB_SPEED = 0.8; // fraction of walking speed
const GRENADE_MUZZLE = 0.8; // height above the feet a troop lobs a grenade from

/**
 * Base troop: a brawler that marches, turns, steps and falls. Equipment (crates) and
 * roles mutate its stats / behaviour; signs on the ground steer it. Movement is cell-to-cell
 * with interpolation so the simulation stays on the grid while rendering is smooth.
 * Troops belong to a team: player troops fight guards and enemy troops, enemy troops fight
 * player troops, and each team only follows its own signs and crates.
 *
 * Equipment: one exclusive slot (`equipment`) plus any number of stackable kits; `kits` lists
 * everything carried. Effects stay applied until a consumable kit is used up (see removeKit).
 */
export class Troop {
  constructor(id, x, y, z, dir, team = TEAM.PLAYER, rules = DEFAULT_RULES) {
    this.id = id;
    this.team = team;
    this.cell = { x, y, z };
    this.pos = { x: x + 0.5, y, z: z + 0.5 }; // feet position at the centre of the cell floor
    this.dir = dir;
    this.target = null;
    this.moveSpeed = 0;
    this.state = TROOP_STATE.WALKING;

    // §2.2 stats — base values come from the level's rules (rules.js)
    const hp = team === TEAM.ENEMY ? rules.enemyTroopHp : rules.troopHp;
    this.maxHp = hp;
    this.hp = hp;
    this.armor = 0;
    this.speed = team === TEAM.ENEMY ? rules.enemyTroopSpeed : rules.troopSpeed;
    this.scale = team === TEAM.ENEMY ? rules.enemyTroopScale : 1; // body size (rendering only)
    this.attack = rules.troopAttack;
    this.range = 1;
    this.attackCooldown = 0.8;
    this.morale = 100;
    this.attackTimer = 0;

    // equipment (items/equipment.js)
    this.equipment = null; // kind in the exclusive slot
    this.kits = []; // every kind carried, in pickup order
    this.canDig = false;
    this.digUses = 0;
    this.digTimer = 0;
    this.ladders = 0;
    this.bridges = 0;
    // medic kit
    this.healCharges = 0;
    this.healAmount = 0;
    this.healRange = 0;
    this.healCooldown = 1;
    this.healTimer = 0;
    // grenades
    this.grenades = 0;
    this.grenadeRange = 0;
    this.grenadeMinRange = 0;
    this.grenadeAttack = 0;
    this.grenadeSplash = 1;
    this.grenadeCooldown = 1;
    this.grenadeTimer = 0;
    // armor / parachute
    this.armorPool = 0;
    this.armorMitigation = 0;
    this.parachutes = 0;

    // role
    this.role = null;
    this.roleData = null;
    this.suspended = null; // { role, data } of a paused role, kept so it can be resumed (see suspendRole)
    // Wall following (set by signs, see items/sign.js): 0 = off, +1 = wall on the right, -1 = left.
    this.wallSide = 0;

    this.fallDistance = 0;
    this.flash = 0;
  }

  get alive() {
    return this.state !== TROOP_STATE.DEAD && this.state !== TROOP_STATE.SAVED;
  }

  get facing() {
    return DIRS[this.dir];
  }

  /** The kit that colours the troop: the exclusive one, else the last stackable one picked up. */
  get displayKit() {
    return this.equipment ?? (this.kits.length ? this.kits[this.kits.length - 1] : null);
  }

  hasKit(kind) {
    return this.kits.includes(kind);
  }

  addKit(kind, exclusive) {
    if (exclusive) this.equipment = kind;
    if (!this.kits.includes(kind)) this.kits.push(kind);
  }

  /** A kit is dropped when it is used up (pickaxe worn out, last ladder placed, ...). */
  removeKit(kind) {
    const i = this.kits.indexOf(kind);
    if (i >= 0) this.kits.splice(i, 1);
    if (this.equipment === kind) this.equipment = null;
  }

  snapToCell() {
    this.pos.x = this.cell.x + 0.5;
    this.pos.y = this.cell.y;
    this.pos.z = this.cell.z + 0.5;
  }

  update(dt, sim) {
    if (!this.alive) return;
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.grenadeTimer > 0) this.grenadeTimer -= dt;
    if (this.healCharges > 0) this.tryHeal(dt, sim); // medics patch up the column while marching

    if (this.target) {
      this.advance(dt, sim);
      return;
    }

    // Standing in a cell: gravity always wins first (a ladder counts as support).
    if (!supported(sim.world, this.cell.x, this.cell.y, this.cell.z)) {
      this.beginFall(sim);
      return;
    }
    if (this.role && this.role.update(this, dt, sim)) return;
    if (this.tryCombat(dt, sim)) return;
    this.decideStep(dt, sim);
  }

  // ---- movement -----------------------------------------------------------------

  setTarget(cell, speed) {
    this.target = cell;
    this.moveSpeed = speed;
    this.digTimer = 0;
  }

  beginFall(sim) {
    if (this.role) this.clearRole(sim);
    this.wallSide = 0; // falling off leaves whatever wall it was hugging
    this.state = TROOP_STATE.FALLING;
    const speed = this.parachutes > 0 ? PARACHUTE_FALL_SPEED : FALL_SPEED;
    this.setTarget({ x: this.cell.x, y: this.cell.y - 1, z: this.cell.z }, speed);
  }

  advance(dt, sim) {
    const tx = this.target.x + 0.5,
      ty = this.target.y,
      tz = this.target.z + 0.5;
    const dx = tx - this.pos.x,
      dy = ty - this.pos.y,
      dz = tz - this.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = this.moveSpeed * dt;
    if (step >= dist) {
      this.arrive(sim);
    } else {
      const k = step / dist;
      this.pos.x += dx * k;
      this.pos.y += dy * k;
      this.pos.z += dz * k;
    }
  }

  arrive(sim) {
    const wasFalling = this.state === TROOP_STATE.FALLING;
    if (wasFalling) this.fallDistance++;
    this.cell = this.target;
    this.target = null;
    this.snapToCell();

    const world = sim.world;
    const { x, y, z } = this.cell;
    const below = world.get(x, y - 1, z);
    if (isLethal(below)) {
      this.die(sim, 'hazard');
      return;
    }
    if (!supported(world, x, y, z)) return; // still airborne, next tick keeps falling

    if (wasFalling) {
      if (this.fallDistance > sim.lethalFall) {
        if (this.parachutes > 0) {
          // The canopy takes the impact instead of the troop.
          sim.events.push({ type: 'parachute', pos: { ...this.pos } });
          if (--this.parachutes <= 0) {
            this.parachutes = 0;
            this.removeKit('parachute');
          }
        } else {
          this.die(sim, 'fall');
          return;
        }
      }
      sim.events.push({ type: 'land', pos: { ...this.pos } });
      this.state = TROOP_STATE.WALKING;
    }
    this.fallDistance = 0;

    // Only the player's column is trying to reach the vault.
    if (this.team === TEAM.PLAYER && sim.inObjective(this.cell)) {
      this.state = TROOP_STATE.SAVED;
      if (this.role) this.clearRole(sim);
      sim.troopReachedObjective(this);
      return;
    }
    // Out in the open with nothing left to hug: stop following.
    if (this.wallSide && !this.keepsWall(world)) this.wallSide = 0;
    sim.tryPickupCrate(this);
    // Signs steer the column; a troop busy with a role ignores them.
    if (!this.role) applySigns(this, sim);
  }

  decideStep(dt, sim) {
    const c = this.cell;
    // A column put onto a wall by a sign takes its turns from the wall, not from going straight.
    if (this.wallSide) this.hugWall(sim);
    const step = nextStep(sim.world, c.x, c.y, c.z, this.dir, {
      canDig: this.canDig && this.digUses > 0,
      ladders: this.ladders,
      bridges: this.bridges,
    });
    switch (step.action) {
      case 'fall':
        this.beginFall(sim);
        break;
      case 'turn':
        this.dir = this.wallSide ? this.turnAlongWall(sim) : turnAround(this.dir);
        this.state = TROOP_STATE.WALKING;
        this.digTimer = 0;
        break;
      case 'dig':
        this.state = TROOP_STATE.DIGGING;
        this.digTimer += dt;
        if (this.digTimer >= DIG_TIME) {
          this.digTimer = 0;
          sim.digVoxel(step.target);
          if (--this.digUses <= 0) {
            this.digUses = 0;
            this.canDig = false;
            this.removeKit('pickaxe'); // pickaxe worn out
          }
        }
        break;
      case 'climb':
      case 'climbDown':
        this.state = TROOP_STATE.CLIMBING;
        this.setTarget(step.target, this.speed * CLIMB_SPEED);
        break;
      case 'ladder':
        this.state = TROOP_STATE.BUILDING;
        this.digTimer += dt;
        if (this.digTimer >= LADDER_TIME) {
          this.digTimer = 0;
          sim.placeVoxel(step.target, VOXEL.LADDER);
          if (sim.world.get(c.x, c.y, c.z) === VOXEL.AIR) sim.placeVoxel(c, VOXEL.LADDER); // foot of the ladder
          if (--this.ladders <= 0) {
            this.ladders = 0;
            this.removeKit('ladder'); // ladder kit used up
          }
        }
        break;
      case 'bridge':
        this.state = TROOP_STATE.BUILDING;
        this.digTimer += dt;
        if (this.digTimer >= BRIDGE_TIME) {
          this.digTimer = 0;
          sim.placeVoxel(step.target, VOXEL.PLANK); // a permanent plank at floor level; the column follows
          if (--this.bridges <= 0) {
            this.bridges = 0;
            this.removeKit('bridge'); // bridge kit used up
          }
        }
        break;
      default: // walk / stepUp / stepDown
        if (sim.isBlocked(step.target, this.team) || sim.guardAt(step.target)) {
          this.dir = this.wallSide ? this.turnAlongWall(sim) : turnAround(this.dir);
          break;
        }
        this.state = TROOP_STATE.WALKING;
        this.setTarget(step.target, sim.moveSpeed(this, step.target)); // slowed on mud
    }
  }
  // ---- wall following -----------------------------------------------------------
  //
  // A sign that puts a troop onto a course along a wall (or along the level bounds) makes it hug
  // that face: it turns the corners of the wall instead of preferring the straight line, exactly
  // like a hand kept on the wall. Anything that takes it off the wall — another sign, a fan's
  // diagonal step, a fall — clears the mode again.
  /** The facing that turns this troop into the wall it follows. */
  get towardWall() {
    return this.wallSide > 0 ? turnRight(this.dir) : turnLeft(this.dir);
  }
  /** The facing that turns this troop away from the wall it follows. */
  get awayFromWall() {
    return this.wallSide > 0 ? turnLeft(this.dir) : turnRight(this.dir);
  }
  /** The cell a plain step that way would land on, or null when it is not walkable for this team. */
  canStep(sim, dir) {
    const c = this.cell;
    const target = stepTarget(sim.world, c.x, c.y, c.z, dir);
    if (!target || sim.isBlocked(target, this.team) || sim.guardAt(target)) return null;
    return target;
  }
  /** Is there a wall (or the edge of the map) on any side of the cell the troop stands in? */
  besideWall(world) {
    const c = this.cell;
    for (let d = 0; d < 4; d++) if (wallBeside(world, c.x, c.y, c.z, d)) return true;
    return false;
  }
  /**
   * Is the wall this troop follows still there — beside it, or just around the exterior angle it
   * has stepped past? A convex corner leaves the followed face diagonally behind for exactly one
   * cell; the old "any wall beside" test dropped the mode right there, so columns missed every
   * outside corner and marched off into the open instead of going around the block.
   */
  keepsWall(world) {
    const c = this.cell;
    if (wallBeside(world, c.x, c.y, c.z, this.towardWall)) return true;
    return this.wallAroundCorner(world);
  }
  /**
   * The exterior angle: the face is gone from the troop's side, but the cell one step toward it
   * still has that face behind it — turning the corner keeps the hand on the very same wall.
   * (After the turn the followed side points back along the old facing, for either hand.)
   */
  wallAroundCorner(world) {
    const c = this.cell;
    const t = DIRS[this.towardWall];
    return wallBeside(world, c.x + t.dx, c.y, c.z + t.dz, turnAround(this.dir));
  }
  /**
   * Called after a sign steered this troop: start following the wall it now marches along, or
   * drop the one it was following when the new course has no wall beside it.
   */
  updateWallFollow(world) {
    const c = this.cell;
    if (wallBeside(world, c.x, c.y, c.z, turnRight(this.dir))) this.wallSide = 1;
    else if (wallBeside(world, c.x, c.y, c.z, turnLeft(this.dir))) this.wallSide = -1;
    else this.wallSide = 0;
  }
  /** The followed wall fell away at an exterior angle: turn into it and go around the corner. */
  hugWall(sim) {
    const c = this.cell;
    const toward = this.towardWall;
    if (wallBeside(sim.world, c.x, c.y, c.z, toward)) return; // still hugging it
    // Only an exterior angle is worth turning for; a wall that truly ended is dropped on arrival.
    if (!this.wallAroundCorner(sim.world)) return;
    if (this.canStep(sim, toward)) this.dir = toward;
  }
  /** Blocked ahead while following a wall: turn away from it (the obstacle becomes the new face). */
  turnAlongWall(sim) {
    const away = this.awayFromWall;
    return this.canStep(sim, away) ? away : turnAround(this.dir);
  }

  // ---- combat -------------------------------------------------------------------

  /** Returns true when the troop is busy fighting this tick. */
  tryCombat(dt, sim) {
    if (this.tryGrenade(sim)) return true;
    const target = sim.findHostileInRange(this);
    if (!target) {
      if (this.state === TROOP_STATE.FIGHTING || this.state === TROOP_STATE.SHOOTING)
        this.state = TROOP_STATE.WALKING;
      return false;
    }
    const ranged = this.range > 1;
    this.state = ranged ? TROOP_STATE.SHOOTING : TROOP_STATE.FIGHTING;
    if (this.attackTimer <= 0) {
      this.attackTimer = this.attackCooldown;
      sim.damageUnit(target, this.attack);
      if (ranged) {
        sim.events.push({
          type: 'tracer',
          from: { x: this.pos.x, y: this.pos.y + 0.7, z: this.pos.z },
          to: { x: target.pos.x, y: target.pos.y + 0.8, z: target.pos.z },
          color: this.team === TEAM.ENEMY ? 0xff9a7a : undefined,
        });
      }
    }
    return true;
  }

  /** Lob a grenade at the nearest hostile inside the grenade band (beyond the minimum range, in sight). */
  tryGrenade(sim) {
    if (this.grenades <= 0 || this.grenadeTimer > 0) return false;
    const target = sim.findHostileInRange(this, this.grenadeRange, this.grenadeMinRange);
    if (!target) return false;
    this.grenadeTimer = this.grenadeCooldown;
    this.state = TROOP_STATE.SHOOTING;
    sim.throwGrenade(this, target.cell, this.grenadeAttack, this.grenadeSplash, GRENADE_MUZZLE);
    if (--this.grenades <= 0) {
      this.grenades = 0;
      this.removeKit('grenade');
    }
    return true;
  }

  /** Medic kit: heal the nearest wounded troop of the team (itself included) within range. */
  tryHeal(dt, sim) {
    this.healTimer -= dt;
    if (this.healTimer > 0) return;
    const wounded = sim.findWoundedNear(this, this.healRange);
    if (!wounded) return;
    this.healTimer = this.healCooldown;
    wounded.hp = Math.min(wounded.maxHp, wounded.hp + this.healAmount);
    sim.events.push({
      type: 'heal',
      pos: { x: wounded.pos.x, y: wounded.pos.y + 0.6, z: wounded.pos.z },
    });
    if (--this.healCharges <= 0) {
      this.healCharges = 0;
      this.removeKit('medic');
    }
  }

  takeDamage(amount, sim) {
    let dmg = Math.max(1, amount - this.armor);
    if (this.armorPool > 0) {
      // Armor soaks up a share of every hit until its pool is spent, then it is discarded.
      const absorbed = Math.min(this.armorPool, dmg * this.armorMitigation);
      this.armorPool -= absorbed;
      dmg -= absorbed;
      if (this.armorPool <= 1e-6) {
        this.armorPool = 0;
        this.removeKit('armor');
      }
    }
    this.hp -= dmg;
    this.flash = 1;
    sim.events.push({ type: 'hit', pos: { x: this.pos.x, y: this.pos.y + 0.5, z: this.pos.z } });
    if (this.hp <= 0) this.die(sim, 'combat');
  }

  die(sim, cause) {
    if (!this.alive) return;
    this.state = TROOP_STATE.DEAD;
    if (this.role) this.clearRole(sim);
    sim.onTroopDied(this, cause);
  }

  // ---- roles --------------------------------------------------------------------

  setRole(role, sim) {
    if (this.role) this.clearRole(sim);
    this.suspended = null; // a fresh assignment replaces a paused job
    this.role = role;
    this.roleData = {};
    this.state = TROOP_STATE.WORKING;
    role.start(this, sim);
  }
  /**
   * Equipment that hands out a job (the Builder Crate) grants the role *paused*, with its charges
   * already set: right-clicking the troop starts it, another right-click pauses it again.
   */
  grantRole(role, data) {
    this.role = null;
    this.roleData = null;
    this.suspended = { role, data };
    if (this.alive && this.state === TROOP_STATE.WORKING) this.state = TROOP_STATE.WALKING;
  }
  /**
   * Pause the current role: the troop marches on like any other, but the job and its progress
   * (a builder's remaining planks) are kept so it can be resumed later at no cost.
   */
  suspendRole(sim) {
    if (!this.role) return false;
    this.suspended = { role: this.role, data: this.roleData };
    this.role = null;
    this.roleData = null;
    if (this.alive && this.state === TROOP_STATE.WORKING) this.state = TROOP_STATE.WALKING;
    return true;
  }
  /** Resume a paused role where the troop stands now (roles may reset per-site progress in `resume`). */
  resumeRole(sim) {
    const s = this.suspended;
    if (!s) return false;
    this.suspended = null;
    this.role = s.role;
    this.roleData = s.data;
    this.state = TROOP_STATE.WORKING;
    if (s.role.resume) s.role.resume(this, sim);
    return true;
  }

  clearRole(sim) {
    const role = this.role;
    this.role = null;
    this.roleData = null;
    if (role && role.stop) role.stop(this, sim);
    if (this.alive && this.state === TROOP_STATE.WORKING) this.state = TROOP_STATE.WALKING;
  }
}
