import { VOXEL } from '../../world/voxel.js';
import { turnAround } from '../pathing.js';

const BUILD_TIME = 0.5; // seconds per plank
const BRICKS = 5;       // fallback when no rules are available (see rules.builderBricks)

/**
 * Builds a diagonal staircase forward and upward, one plank at a time, then steps onto it.
 * Stops when it runs out of planks, when the stair meets existing terrain (walks on), or
 * when something blocks the next plank (turns around, Lemmings-style).
* A builder can be paused (right-click): it keeps its remaining planks and, once resumed,
* starts a fresh staircase from wherever it stands.
* The job comes from a Builder Crate (items/equipment.js) and starts paused; the empty kit is
* dropped once the last plank has been laid.
 */
export const BuilderRole = Object.freeze({
  name: 'builder',
  label: 'Builder',
  color: 0xf0d040,

  start(troop, sim) {
    troop.roleData = { bricks: sim?.rules?.builderBricks ?? BRICKS, placed: 0, timer: 0 };
  },
  /** Resumed after a pause: same planks, new staircase. */
  resume(troop) {
    const d = troop.roleData || { bricks: BRICKS };
    troop.roleData = { bricks: d.bricks, placed: 0, timer: 0 };
  },
  /** Human-readable progress for hints ("7 planks left"). */
  progress(data) {
    const n = data ? data.bricks : BRICKS;
    return `${n} plank${n === 1 ? '' : 's'} left`;
  },
  /** Out of planks: the job ends and the empty builder kit is dropped. */
  finish(troop, sim) {
    troop.clearRole(sim);
    troop.removeKit('builder');
  },


  update(troop, dt, sim) {
    const d = troop.roleData;
    if (d.bricks <= 0) { this.finish(troop, sim); return true; } // resumed with nothing left to build
    const { dx, dz } = troop.facing;
    const c = troop.cell;
    const world = sim.world;
    const brick = { x: c.x + dx, y: c.y, z: c.z + dz };
    const stand = { x: brick.x, y: brick.y + 1, z: brick.z };

    if (!world.inBounds(brick.x, brick.y, brick.z) ||
         !world.inBounds(stand.x, stand.y, stand.z) ||
        world.isSolid(brick.x, brick.y, brick.z) ||
        world.isSolid(stand.x, stand.y, stand.z) ||
         sim.isBlocked(stand, troop.team)) {
      troop.clearRole(sim);
      troop.dir = turnAround(troop.dir);
      return true;
    }

    // Stair has reached ground that's already walkable: the job is done, march on.
    if (d.placed > 0 && world.isSolid(brick.x, brick.y - 1, brick.z)) {
      troop.clearRole(sim);
      return true;
    }

    d.timer += dt;
    if (d.timer < BUILD_TIME) return true;
    d.timer = 0;

    sim.placeVoxel(brick, VOXEL.PLANK);
    d.placed++;
    d.bricks--;
    troop.setTarget(stand, troop.speed);
    if (d.bricks <= 0) this.finish(troop, sim);
    return true;
  },
});