import { Troop, TROOP_STATE } from './units/troop.js';
import { Guard } from './units/guard.js';
import { Crate } from './items/crate.js';
import { EQUIPMENT, isExclusive } from './items/equipment.js';
import { Sign, SIGNS } from './items/sign.js';
import { ROLES } from './units/roles/index.js';
import { TEAM } from './units/team.js';
import { dirIndexFromVector } from './units/pathing.js';
import { VOXEL, isSlow } from './world/voxel.js';
import { DEFAULT_RULES } from './rules.js';

export const GAME_STATUS = Object.freeze({ PLAYING: 'playing', WON: 'won', LOST: 'lost' });

const center = (c) => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });

/** A drop pod: releases `pool` troops of `team`, `rate` seconds apart, marching along `dir`. */
function makeSpawner(sp, team) {
  return {
    team,
    x: sp.pos[0],
    y: sp.pos[1],
    z: sp.pos[2],
    dir: dirIndexFromVector(sp.dir[0], sp.dir[1]),
    rate: sp.rate ?? 1.5,
    pool: sp.count,
    timer: 0.5,
  };
}

/**
 * Deterministic game state: troops (both teams), guards, crates, signs, projectiles, budgets and
 * the objective. No randomness is used here so replays / level validation stay reproducible.
 */
export class Simulation {
  constructor(world, level) {
    this.world = world;
    this.level = level;
    this.time = 0;
    this.status = GAME_STATUS.PLAYING;
    this.loseReason = '';
    this.events = [];
    this.nextId = 1;

    this.troops = [];
    this.guards = [];
    this.crates = [];
    this.signs = [];
    this.projectiles = [];

    this.spawn = makeSpawner(level.spawn, TEAM.PLAYER);
    this.enemySpawners = (level.enemySpawners || []).map((sp) => makeSpawner(sp, TEAM.ENEMY));
    this.spawners = [this.spawn, ...this.enemySpawners];

    this.objective = level.objective;
    this.saved = 0;
    this.lost = 0;
    this.lethalFall = level.lethalFall ?? 4;
    this.timeLimit = level.timeLimit ?? 0;
    this.rules = level.rules || DEFAULT_RULES; // tunable stats (rules.js)

    this.budget = {
      crates: { ...(level.budget?.crates || {}) },
      signs: { ...(level.budget?.signs || {}) },
      roles: { ...(level.budget?.roles || {}) },
    };

    for (const g of level.guards || []) {
      const dir = g.dir ? dirIndexFromVector(g.dir[0], g.dir[1]) : 2;
      this.guards.push(
        new Guard(this.nextId++, g.type, g.pos[0], g.pos[1], g.pos[2], dir, this.rules)
      );
    }
    // Level-authored signs and crates (either team). Player ones behave exactly like placed ones.
    for (const s of level.signs || []) {
      if (!SIGNS[s.kind]) continue;
      const dir = s.dir ? dirIndexFromVector(s.dir[0], s.dir[1]) : this.spawn.dir;
      this.signs.push(new Sign(this.nextId++, s.kind, s.pos[0], s.pos[1], s.pos[2], dir, s.team));
    }
    for (const c of level.crates || []) {
      const def = EQUIPMENT[c.kind];
      if (!def) continue;
      this.crates.push(
        new Crate(
          this.nextId++,
          c.kind,
          c.pos[0],
          c.pos[1],
          c.pos[2],
          c.capacity ?? def.capacity ?? this.rules.crateCapacity,
          c.team,
          c.exclusive ?? null
        )
      );
    }
  }

  /** Reinforcements still waiting in the player's drop pod. */
  get pool() {
    return this.spawn.pool;
  }

  countTroops(team) {
    let n = 0;
    for (const t of this.troops) if (t.alive && t.team === team) n++;
    return n;
  }

  // ---- main step ------------------------------------------------------------

  step(dt) {
    if (this.status !== GAME_STATUS.PLAYING) return;
    this.time += dt;

    for (const sp of this.spawners) {
      if (sp.pool <= 0) continue;
      sp.timer -= dt;
      if (sp.timer <= 0) {
        this.spawnTroop(sp);
        sp.timer += sp.rate;
      }
    }

    for (const t of this.troops) t.update(dt, this);
    for (const g of this.guards) g.update(dt, this);
    this.updateProjectiles(dt);

    this.troops = this.troops.filter((t) => t.alive);
    this.guards = this.guards.filter((g) => g.alive);
    this.crates = this.crates.filter((c) => !c.depleted);

    this.checkEnd();
  }

  spawnTroop(sp) {
    const troop = new Troop(this.nextId++, sp.x, sp.y, sp.z, sp.dir, sp.team, this.rules);
    this.troops.push(troop);
    sp.pool--;
    this.events.push({ type: 'spawn', pos: { ...troop.pos }, team: sp.team });
  }

  // ---- spatial queries -------------------------------------------------------

  /** A cell troops of `team` refuse to walk into (they turn around instead): their Blocker sign. */
  isBlocked(c, team = TEAM.PLAYER) {
    const sign = this.signAt(c, team);
    return !!sign && sign.kind === 'blocker';
  }

  troopAt(c, team = null) {
    for (const t of this.troops) {
      if (!t.alive || (team && t.team !== team)) continue;
      if (t.cell.x === c.x && t.cell.y === c.y && t.cell.z === c.z) return t;
    }
    return null;
  }

  guardAt(c) {
    for (const g of this.guards) {
      if (g.alive && g.cell.x === c.x && g.cell.y === c.y && g.cell.z === c.z) return g;
    }
    return null;
  }

  crateAt(c, team = null) {
    for (const cr of this.crates) {
      if (cr.depleted || (team && cr.team !== team)) continue;
      if (cr.x === c.x && cr.y === c.y && cr.z === c.z) return cr;
    }
    return null;
  }

  signAt(c, team = null) {
    for (const s of this.signs) {
      if (team && s.team !== team) continue;
      if (s.x === c.x && s.y === c.y && s.z === c.z) return s;
    }
    return null;
  }

  signById(id) {
    return this.signs.find((s) => s.id === id) || null;
  }
  /** Walking speed of `troop` for a step into `cell`: its base speed, slowed on mud (rules.mudSpeed). */
  moveSpeed(troop, cell) {
    const below = this.world.get(cell.x, cell.y - 1, cell.z);
    return troop.speed * (isSlow(below) ? this.rules.mudSpeed : 1);
  }

  /**
   * Nearest hostile unit a troop can hit: adjacent for melee; anything within range and line of
   * sight for ranged troops (so riflemen return fire on turrets shooting at them from any side).
   * Player troops fight guards and enemy troops; enemy troops fight player troops.
   * `range` / `minRange` default to the troop's weapon; grenades pass their own band.
   */
  findHostileInRange(troop, range = troop.range, minRange = 0) {
    const c = troop.cell;
    let best = null;
    let bestDist = Infinity;
    const consider = (u) => {
      const dx = u.cell.x - c.x,
        dy = u.cell.y - c.y,
        dz = u.cell.z - c.z;
      const manhattan = Math.abs(dx) + Math.abs(dz);
      let dist;
      if (manhattan <= 1 && Math.abs(dy) <= 1) {
        dist = manhattan;
      } else if (range > 1) {
        dist = Math.hypot(dx, dy, dz);
        if (dist > range || dist >= bestDist) return;
        if (!this.hasLOS(c, u.cell)) return;
      } else {
        return;
      }
      if (dist < minRange) return;
      if (dist < bestDist) {
        bestDist = dist;
        best = u;
      }
    };
    if (troop.team === TEAM.PLAYER) for (const g of this.guards) if (g.alive) consider(g);
    for (const t of this.troops) if (t.alive && t.team !== troop.team) consider(t);
    return best;
  }
  /** Nearest troop of the medic's team (itself included) within `range` cells that is below full health. */
  findWoundedNear(medic, range) {
    let best = null;
    let bestDist = Infinity;
    for (const t of this.troops) {
      if (!t.alive || t.team !== medic.team || t.hp >= t.maxHp) continue;
      const dist = Math.hypot(
        t.cell.x - medic.cell.x,
        t.cell.y - medic.cell.y,
        t.cell.z - medic.cell.z
      );
      if (dist > range || dist >= bestDist) continue;
      best = t;
      bestDist = dist;
    }
    return best;
  }

  findTroopNear(guard, reach, team = TEAM.PLAYER) {
    for (const t of this.troops) {
      if (!t.alive || t.team !== team) continue;
      if (
        Math.abs(t.cell.x - guard.cell.x) <= reach &&
        Math.abs(t.cell.z - guard.cell.z) <= reach &&
        Math.abs(t.cell.y - guard.cell.y) <= 1
      )
        return t;
    }
    return null;
  }

  /** Nearest troop of `team` a ranged guard can see within [minRange, range]. */
  findTroopInRange(guard, range, minRange = 0, team = TEAM.PLAYER) {
    let best = null;
    let bestDist = Infinity;
    for (const t of this.troops) {
      if (!t.alive || t.team !== team) continue;
      const dx = t.cell.x - guard.cell.x,
        dy = t.cell.y - guard.cell.y,
        dz = t.cell.z - guard.cell.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > range || dist < minRange || dist >= bestDist) continue;
      if (!this.hasLOS(guard.cell, t.cell)) continue;
      best = t;
      bestDist = dist;
    }
    return best;
  }

  hasLOS(a, b) {
    const ax = a.x + 0.5,
      ay = a.y + 0.7,
      az = a.z + 0.5;
    const bx = b.x + 0.5,
      by = b.y + 0.7,
      bz = b.z + 0.5;
    const dist = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(1, Math.ceil(dist * 4));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const px = Math.floor(ax + (bx - ax) * t);
      const py = Math.floor(ay + (by - ay) * t);
      const pz = Math.floor(az + (bz - az) * t);
      // The blocks either unit stands on never occlude (a turret on a parapet can shoot down it).
      if (px === a.x && pz === a.z && py <= a.y) continue;
      if (px === b.x && pz === b.z && py <= b.y) continue;
      if (this.world.isSolid(px, py, pz)) return false;
    }
    return true;
  }

  inObjective(c) {
    const o = this.objective;
    if (!o || o.type !== 'reach') return false;
    return (
      c.x >= o.from[0] &&
      c.x <= o.to[0] &&
      c.y >= o.from[1] &&
      c.y <= o.to[1] &&
      c.z >= o.from[2] &&
      c.z <= o.to[2]
    );
  }

  // ---- world edits ------------------------------------------------------------

  digVoxel(c) {
    if (this.world.set(c.x, c.y, c.z, VOXEL.AIR)) this.events.push({ type: 'dig', pos: center(c) });
  }

  placeVoxel(c, type) {
    if (this.world.set(c.x, c.y, c.z, type)) this.events.push({ type: 'build', pos: center(c) });
  }

  // ---- projectiles --------------------------------------------------------------

  /**
   * A grenadier guard or a troop with a grenade crate lobs a grenade on a parabolic arc; it
   * explodes on arrival with `damage` over `radius` against everything not on the thrower's team.
   */
  throwGrenade(thrower, targetCell, damage, radius = 1, muzzle = 1) {
    const from = { x: thrower.pos.x, y: thrower.pos.y + muzzle, z: thrower.pos.z };
    const to = { x: targetCell.x + 0.5, y: targetCell.y, z: targetCell.z + 0.5 };
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    this.projectiles.push({
      id: this.nextId++,
      kind: 'grenade',
      team: thrower.team,
      from,
      to,
      t: 0,
      duration: 0.4 + dist * 0.1,
      height: 1 + dist * 0.2,
      damage,
      radius,
      pos: { ...from },
    });
  }

  updateProjectiles(dt) {
    if (!this.projectiles.length) return;
    for (const p of this.projectiles) {
      p.t += dt;
      const k = Math.min(1, p.t / p.duration);
      p.pos.x = p.from.x + (p.to.x - p.from.x) * k;
      p.pos.z = p.from.z + (p.to.z - p.from.z) * k;
      p.pos.y = p.from.y + (p.to.y - p.from.y) * k + p.height * 4 * k * (1 - k);
      if (k >= 1) {
        p.done = true;
        this.explode(p.to, p.damage, p.radius, p.team);
      }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  /**
   * Area-of-effect damage to every unit not on `team` within `radius` (horizontal) of `pos`:
   * enemy grenades hit the player's troops, player grenades hit enemy troops and guards.
   */
  explode(pos, damage, radius, team = TEAM.ENEMY) {
    this.events.push({ type: 'explosion', pos: { ...pos } });
    for (const t of [...this.troops]) {
      if (!t.alive || t.team === team) continue;
      if (Math.abs(t.pos.y - pos.y) > 1.5) continue;
      if (Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z) > radius) continue;
      t.takeDamage(damage, this);
    }
    if (team === TEAM.ENEMY) return;
    for (const g of [...this.guards]) {
      if (!g.alive) continue;
      if (Math.abs(g.pos.y - pos.y) > 1.5) continue;
      if (Math.hypot(g.pos.x - pos.x, g.pos.z - pos.z) > radius) continue;
      this.damageUnit(g, damage);
    }
  }

  // ---- combat & objective callbacks ----------------------------------------------

  /** Apply damage to a guard or a troop and emit the matching effects. */
  damageUnit(target, amount) {
    if (target instanceof Guard) {
      target.takeDamage(amount);
      this.events.push({
        type: 'hit',
        pos: { x: target.pos.x, y: target.pos.y + 0.6, z: target.pos.z },
      });
      if (!target.alive) this.events.push({ type: 'guardDead', pos: { ...target.pos } });
    } else {
      target.takeDamage(amount, this);
    }
  }

  onTroopDied(troop, cause) {
    if (troop.team === TEAM.PLAYER) this.lost++;
    this.events.push({ type: 'death', pos: { ...troop.pos }, cause, team: troop.team });
  }

  troopReachedObjective(troop) {
    this.saved++;
    this.events.push({ type: 'saved', pos: { ...troop.pos } });
  }

  /**
   * Crates hand their kit to troops of their team crossing the cell. An exclusive kit needs the
   * troop's one equipment slot to be free; a stackable one (rules.<kind>Exclusive = false, or the
   * crate's own flag) goes on top of anything. A troop never takes a kind it already carries.
   */
  tryPickupCrate(troop) {
    const crate = this.crateAt(troop.cell, troop.team);
    if (!crate) return;
    const def = EQUIPMENT[crate.kind];
    if (!def || troop.hasKit(crate.kind)) return;
    const exclusive = isExclusive(crate.kind, this.rules, crate.exclusive);
    if (exclusive && troop.equipment) return; // the equipment slot is taken
    crate.remaining--;
    def.apply(troop, this.rules);
    troop.addKit(crate.kind, exclusive);
    this.events.push({ type: 'pickup', pos: { ...troop.pos }, color: def.color });
  }

  // ---- player actions -----------------------------------------------------------

  budgetFor(kind, key) {
    const table =
      kind === 'crate'
        ? this.budget.crates
        : kind === 'sign'
          ? this.budget.signs
          : this.budget.roles;
    return table[key] ?? 0;
  }

  /**
   * A walkable cell that can take an item: in bounds, air, solid floor, no other crate / sign /
   * guard. Troops standing on the cell do not matter — items may be dropped into a crowd.
   */
  isFreeFloorCell(c) {
    const w = this.world;
    return (
      w.inBounds(c.x, c.y, c.z) &&
      w.get(c.x, c.y, c.z) === VOXEL.AIR &&
      w.isSolid(c.x, c.y - 1, c.z) &&
      !this.crateAt(c) &&
      !this.signAt(c) &&
      !this.guardAt(c)
    );
  }

  canPlaceCrate(kind, c) {
    return (
      this.status === GAME_STATUS.PLAYING &&
      !!EQUIPMENT[kind] &&
      this.budgetFor('crate', kind) > 0 &&
      this.isFreeFloorCell(c)
    );
  }

  placeCrate(kind, c) {
    if (!this.canPlaceCrate(kind, c)) return false;
    this.budget.crates[kind]--;
    const def = EQUIPMENT[kind];
    // Most kits serve `rules.crateCapacity` troops; a kit may declare its own (the Builder Crate serves one).
    const capacity = def.capacity ?? this.rules.crateCapacity;
    this.crates.push(new Crate(this.nextId++, kind, c.x, c.y, c.z, capacity, TEAM.PLAYER));
    this.events.push({ type: 'crate', pos: center(c), color: def.color });
    return true;
  }

  canPlaceSign(kind, c) {
    return (
      this.status === GAME_STATUS.PLAYING &&
      !!SIGNS[kind] &&
      this.budgetFor('sign', kind) > 0 &&
      this.isFreeFloorCell(c)
    );
  }

  placeSign(kind, c, dir) {
    if (!this.canPlaceSign(kind, c)) return false;
    this.budget.signs[kind]--;
    const sign = new Sign(this.nextId++, kind, c.x, c.y, c.z, dir, TEAM.PLAYER);
    this.signs.push(sign);
    this.events.push({ type: 'sign', pos: center(c), color: SIGNS[kind].color });
    return true;
  }

  /** Player signs return to the inventory at no cost; enemy signs are part of the level. */
  pickUpSign(sign) {
    if (sign.team !== TEAM.PLAYER) return false;
    const i = this.signs.indexOf(sign);
    if (i < 0) return false;
    this.signs.splice(i, 1);
    this.budget.signs[sign.kind] = (this.budget.signs[sign.kind] ?? 0) + 1;
    this.events.push({ type: 'pickupSign', pos: center(sign.cell), color: SIGNS[sign.kind].color });
    return true;
  }

  rotateSign(sign, steps = 1) {
    if (!SIGNS[sign.kind]?.directional || sign.team !== TEAM.PLAYER) return false;
    sign.rotate(steps);
    return true;
  }

  assignRole(troop, roleName) {
    const role = ROLES[roleName];
    if (!role || !troop || !troop.alive || troop.team !== TEAM.PLAYER) return false;
    if (this.status !== GAME_STATUS.PLAYING) return false;
    if (troop.state === TROOP_STATE.FALLING || troop.state === TROOP_STATE.CLIMBING) return false;
    if (troop.suspended && troop.suspended.role === role) {
      // Resuming a paused job of the same kind costs nothing.
      troop.resumeRole(this);
      this.events.push({ type: 'role', pos: { ...troop.pos }, color: role.color });
      return true;
    }
    if (this.budgetFor('role', roleName) <= 0) return false;
    if (troop.role === role) return false;
    this.budget.roles[roleName]--;
    troop.setRole(role, this);
    this.events.push({ type: 'role', pos: { ...troop.pos }, color: role.color });
    return true;
  }
  /**
   * Pause the troop's role (it keeps its progress, e.g. a builder's planks) or resume a paused
   * one. Returns 'paused' | 'resumed', or null when there was nothing to toggle / it cannot be
   * resumed right now (mid-fall or on a ladder).
   */
  toggleRole(troop) {
    if (!troop || !troop.alive || troop.team !== TEAM.PLAYER || this.status !== GAME_STATUS.PLAYING)
      return null;
    if (troop.role) {
      troop.suspendRole(this);
      this.events.push({ type: 'role', pos: { ...troop.pos }, color: 0x9aa3b8 });
      return 'paused';
    }
    if (troop.suspended) {
      if (troop.state === TROOP_STATE.FALLING || troop.state === TROOP_STATE.CLIMBING) return null;
      const role = troop.suspended.role;
      troop.resumeRole(this);
      this.events.push({ type: 'role', pos: { ...troop.pos }, color: role.color });
      return 'resumed';
    }
    return null;
  }

  // ---- end conditions -------------------------------------------------------------

  checkEnd() {
    if (this.saved >= this.objective.required) {
      this.status = GAME_STATUS.WON;
      return;
    }
    if (this.timeLimit > 0 && this.time >= this.timeLimit) {
      this.status = GAME_STATUS.LOST;
      this.loseReason = 'Time expired';
      return;
    }
    if (this.spawn.pool <= 0 && this.countTroops(TEAM.PLAYER) === 0) {
      this.status = GAME_STATUS.LOST;
      this.loseReason = 'Reinforcements exhausted';
    }
  }
}
