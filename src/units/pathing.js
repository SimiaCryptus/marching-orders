import { VOXEL, isDiggable, isClimbable } from '../world/voxel.js';

/** Cardinal facings, indexed clockwise (seen from above) from +x. */
export const DIRS = Object.freeze([
  { dx: 1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: -1 },
]);

/** Human-readable names for DIRS entries (used in hints). */
export const DIR_LABELS = Object.freeze(['east (+x)', 'south (+z)', 'west (−x)', 'north (−z)']);

export function dirIndexFromVector(dx, dz) {
  const sx = Math.sign(dx),
    sz = Math.sign(dz);
  const i = DIRS.findIndex((d) => d.dx === sx && d.dz === sz);
  return i < 0 ? 0 : i;
}

export function turnAround(dirIndex) {
  return (dirIndex + 2) % 4;
}

export function turnRight(dirIndex) {
  return (dirIndex + 1) % 4;
}

export function turnLeft(dirIndex) {
  return (dirIndex + 3) % 4;
}

/** A unit in air cell (x, y, z) is supported by solid ground below or by the ladder it is on. */
export function supported(world, x, y, z) {
  return world.isSolid(x, y - 1, z) || isClimbable(world.get(x, y, z));
}

/**
 * Grid step / fall / turn rules shared by troops and guards (idea.md §2.1).
 * The unit stands in air cell (x, y, z) on top of solid (x, y-1, z) or on a ladder.
 *
 * opts: { canDig, ladders, bridges } — pickaxe available / ladder segments / bridge planks the
 *                                      unit may still place.
 *
 * Returns { action, target } with action one of:
 *   'fall'      — nothing below, drop one cell
 *   'walk'      — move forward on the same level (may walk off an edge)
 *   'stepUp'    — 1-voxel ledge ahead with headroom
 *   'stepDown'  — 1-voxel drop ahead
 *   'climb'     — tall wall ahead and a ladder above: climb one cell
 *   'climbDown' — hanging on a ladder facing away from the wall: descend one cell
 *   'ladder'    — tall wall ahead and the unit can extend a ladder into the cell above
 *   'bridge'    — a gap ahead (a drop of two or more) and the unit can lay a plank across it
 *   'dig'       — soft wall ahead and the unit can dig
 *   'turn'      — wall taller than one voxel, reverse facing
 */
export function nextStep(world, x, y, z, dirIndex, opts = {}) {
  if (!supported(world, x, y, z)) return { action: 'fall', target: { x, y: y - 1, z } };

  const { dx, dz } = DIRS[dirIndex];
  const tx = x + dx,
    tz = z + dz;
  // The level edge is an unbreakable wall on every side: units never step, climb or ladder out
  // of the map (notes.md bug: ladders built against the bounds let soldiers escape).
  if (tx < 0 || tx >= world.w || tz < 0 || tz >= world.d) return { action: 'turn', target: null };
  const onLadder = isClimbable(world.get(x, y, z));

  if (world.isSolid(tx, y, tz)) {
    if (!world.isSolid(tx, y + 1, tz)) {
      if (y + 1 >= world.h) return { action: 'turn', target: null }; // never step out over the top of the map
      return { action: 'stepUp', target: { x: tx, y: y + 1, z: tz } };
    }
    // The wall is at least two high: climb an existing ladder, extend one, dig, or give up.
    if (isClimbable(world.get(x, y + 1, z))) return { action: 'climb', target: { x, y: y + 1, z } };
    // The wall continues at y+1 (checked above), so a ladder placed here always leans on
    // something solid — troops never build a ladder into the air.
    if (
      (opts.ladders ?? 0) > 0 &&
      world.inBounds(x, y + 1, z) &&
      world.get(x, y + 1, z) === VOXEL.AIR
    ) {
      return { action: 'ladder', target: { x, y: y + 1, z } };
    }
    if (opts.canDig && isDiggable(world.get(tx, y, tz)))
      return { action: 'dig', target: { x: tx, y, z: tz } };
    return { action: 'turn', target: null };
  }
  // Hanging on a ladder with nothing ahead (e.g. after turning at the top): climb back down.
  if (onLadder && !world.isSolid(x, y - 1, z) && isClimbable(world.get(x, y - 1, z))) {
    return { action: 'climbDown', target: { x, y: y - 1, z } };
  }
  if (world.isSolid(tx, y - 1, tz)) return { action: 'walk', target: { x: tx, y, z: tz } };
  if (world.isSolid(tx, y - 2, tz))
    return { action: 'stepDown', target: { x: tx, y: y - 1, z: tz } };
  // A real gap: a bridge kit lays a plank at floor level instead of stepping into the void.
  if (
    (opts.bridges ?? 0) > 0 &&
    world.inBounds(tx, y - 1, tz) &&
    world.get(tx, y - 1, tz) === VOXEL.AIR
  ) {
    return { action: 'bridge', target: { x: tx, y: y - 1, z: tz } };
  }
  return { action: 'walk', target: { x: tx, y, z: tz } }; // walks off the ledge; gravity takes over
}
/**
 * Is the cell one step along `dirIndex` a wall for a unit standing in air cell (x, y, z)?
 * Anything solid at the unit's own level counts, and so does the edge of the map: the level
 * bounds are a face a column can follow like any other (see troop.js wall following).
 */
export function wallBeside(world, x, y, z, dirIndex) {
  const { dx, dz } = DIRS[dirIndex];
  const tx = x + dx,
    tz = z + dz;
  if (tx < 0 || tx >= world.w || tz < 0 || tz >= world.d) return true;
  return world.isSolid(tx, y, tz);
}
/**
 * The cell a plain step along `dirIndex` lands on (walk / step up / step down onto solid ground),
 * or null when that way is a wall, a gap, the void or off the map. Wall following uses this so a
 * hugging column never digs, builds or walks off a ledge just to keep its wall.
 */
export function stepTarget(world, x, y, z, dirIndex) {
  const s = nextStep(world, x, y, z, dirIndex);
  if (s.action !== 'walk' && s.action !== 'stepUp' && s.action !== 'stepDown') return null;
  const t = s.target;
  return supported(world, t.x, t.y, t.z) ? t : null;
}
