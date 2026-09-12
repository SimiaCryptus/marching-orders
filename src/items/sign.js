import { DIRS, DIR_LABELS, turnAround, turnLeft, turnRight } from '../units/pathing.js';
import { TEAM } from '../units/team.js';

const QUARTER = Math.PI / 2;

/**
 * Sign definitions (notes.md). Signs are markers on walkable cells that shape the flow of a
 * column. Every sign belongs to a team and only steers troops of that team.
 *
 * Every directional sign is a single rotatable placement (Q / mouse wheel / rotate button) and
 * the renderer draws its effect on the ground under it (and under the placement ghost), so what
 * you see is what the column does:
 *   arrow    — the one rule to remember: every troop that steps onto the sign marches the way
 *              the arrow points, whatever direction it arrived from.
 *   fan      — fans the column over three lanes marching its way; troops marching back toward
 *              it from within `radius` cells are funnelled onto its lane instead.
 *   forward  — troops crossing it sideways turn to march its way; troops already moving along
 *              its axis pass through (a one-way arrow that leaves the return trip alone).
 *   blocker  — not directional: troops refuse to step onto it and turn around.
 * `arrows` are rendering hints for the plate in the sign's local frame: yaw in radians
 * (+ = left) and a lateral offset `ox` (+ = left).
 */
export const SIGNS = Object.freeze({
  blocker: {
    name: 'blocker', label: 'Blocker Sign', color: 0xe04848, directional: false, bar: true, arrows: [],
    describe: 'troops that bump into it turn around',
  },
  arrow: {
    name: 'arrow', label: 'Arrow Sign', color: 0x4ad0c0, directional: true,
    arrows: [{ yaw: 0 }],
    describe: 'every troop that steps onto it marches the way the arrow points',
  },
  fan: {
    name: 'fan', label: 'Fan Sign', color: 0xc47ae8, directional: true, radius: 2,
    arrows: [{ yaw: 0 }, { yaw: QUARTER / 2, ox: 0.22 }, { yaw: -QUARTER / 2, ox: -0.22 }],
    describe: 'spreads the column over three lanes marching its way; funnels troops within 2 cells onto its lane marching back (rotate 180° to swap)',
  },
  forward: {
    name: 'forward', label: 'Forward Sign', color: 0xf0a030, directional: true,
    arrows: [{ yaw: 0, ox: 0.16 }, { yaw: 0, ox: -0.16 }],
    describe: 'troops crossing it sideways turn to march its way; troops already on its axis pass through',
  },
});

/** Concrete effect of a sign kind at a given facing, using compass names (for hints). */
export function describeSign(kind, dir) {
  const def = SIGNS[kind];
  if (!def || !def.directional) return def ? def.describe : '';
  const L = (d) => DIR_LABELS[d];
  switch (kind) {
    case 'arrow':
      return `every troop crossing it marches ${L(dir)}`;
    case 'fan':
      return `fans troops marching ${L(dir)} over three lanes; funnels troops marching ${L(turnAround(dir))} onto its lane`;
    case 'forward':
      return `troops marching ${L(turnLeft(dir))} or ${L(turnRight(dir))} turn to march ${L(dir)}`;
    default:
      return def.describe;
  }
}

/** A placed sign. `dir` is a DIRS index; `counter` drives the round-robin distributor. */
export class Sign {
  constructor(id, kind, x, y, z, dir, team = TEAM.PLAYER) {
    this.id = id;
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.z = z;
    this.dir = dir;
    this.team = team;
    this.counter = 0;
  }

  get def() {
    return SIGNS[this.kind];
  }

  get cell() {
    return { x: this.x, y: this.y, z: this.z };
  }

  /** Rotate a quarter turn: clockwise for positive steps, counter-clockwise for negative. */
  rotate(steps = 1) {
    this.dir = steps < 0 ? turnLeft(this.dir) : turnRight(this.dir);
  }
}

const LEGS = [0, -1, 1]; // straight, one lane left, one lane right

/**
 * Where a single diagonal step (one forward along `fd`, one sideways: -1 = left, +1 = right)
 * from `c` lands, following the same ledge rules as `nextStep`. Null when it is not walkable
 * for a troop of `team` (blockers are per team) or when it would leave the map.
 */
export function diagonalTarget(sim, c, fd, side, team = TEAM.PLAYER) {
  const world = sim.world;
  const f = DIRS[fd], r = DIRS[turnRight(fd)];
  const tx = c.x + f.dx + side * r.dx;
  const tz = c.z + f.dz + side * r.dz;
  if (tx < 0 || tx >= world.w || tz < 0 || tz >= world.d) return null; // the level edge is a wall
  let target = null;
  if (world.isSolid(tx, c.y, tz)) {
    if (!world.isSolid(tx, c.y + 1, tz) && c.y + 1 < world.h) target = { x: tx, y: c.y + 1, z: tz };
  } else if (world.isSolid(tx, c.y - 1, tz)) {
    target = { x: tx, y: c.y, z: tz };
  } else if (world.isSolid(tx, c.y - 2, tz)) {
    target = { x: tx, y: c.y - 1, z: tz };
  }
  if (!target || sim.isBlocked(target, team) || sim.guardAt(target)) return null;
  return target;
}

/** Round-robin 3-leg distributor: straight, forward-left, forward-right. */
function distribute(troop, sign, fd, sim) {
  const side = LEGS[sign.counter++ % LEGS.length];
  if (side === 0) return true;
  const target = diagonalTarget(sim, troop.cell, fd, side, troop.team);
  if (target) troop.setTarget(target, troop.speed);
  return true;
}

/**
 * Funnel: a troop approaching along `fd`, off to the side of the sign's lane and within
 * `radius` cells of it, takes a diagonal step toward the lane. Repeated each cell, this lands the
 * column on the sign's lane before (or as) it passes the sign.
 */
function funnel(troop, sign, fd, radius, sim) {
  const f = DIRS[fd], r = DIRS[turnRight(fd)];
  const dx = troop.cell.x - sign.x, dz = troop.cell.z - sign.z;
  const along = dx * f.dx + dz * f.dz;   // < 0: still approaching the sign's row
  const across = dx * r.dx + dz * r.dz;  // > 0: right of the sign's lane
  if (across === 0 || Math.abs(across) > radius || along < -radius || along > -1) return false;
  if (Math.abs(troop.cell.y - sign.y) > 1) return false;
  const target = diagonalTarget(sim, troop.cell, fd, across > 0 ? -1 : 1, troop.team);
  if (!target) return false;
  troop.setTarget(target, troop.speed);
  return true;
}

/**
 * Called when a troop finishes a step. Applies the first sign of the troop's team whose rule
 * matches its cell and facing. Returns true when a sign changed the troop's facing or gave it a
 * diagonal step.
 */
export function applySigns(troop, sim) {
  const c = troop.cell;
  for (const sign of sim.signs) {
    if (sign.team !== troop.team) continue;
    const def = SIGNS[sign.kind];
    if (!def || !def.directional) continue;
    const here = sign.x === c.x && sign.y === c.y && sign.z === c.z;
    const sd = sign.dir, back = turnAround(sd);
    switch (sign.kind) {
      case 'arrow':
        // Whatever way it arrived from, a troop on the sign takes the arrow's direction.
        if (here && troop.dir !== sd) { troop.dir = sd; return true; }
        break;
      case 'fan':
        if (here && troop.dir === sd) return distribute(troop, sign, sd, sim);
        if (troop.dir === back && funnel(troop, sign, back, def.radius, sim)) return true;
        break;
      case 'forward':
        if (!here) break;
        if (troop.dir === turnLeft(sd) || troop.dir === turnRight(sd)) { troop.dir = sd; return true; }
        break;
      default:
        break;
    }
  }
  return false;
}