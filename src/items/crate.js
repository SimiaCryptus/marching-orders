import { TEAM } from '../units/team.js';

/**
 * A weapon crate sitting on a walkable cell. The first N troops of its team that walk over it
 * take its contents.
 */
export class Crate {
  constructor(id, kind, x, y, z, capacity, team = TEAM.PLAYER) {
    this.id = id;
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.z = z;
    this.capacity = capacity;
    this.remaining = capacity;
    this.team = team;
  }

  get cell() {
    return { x: this.x, y: this.y, z: this.z };
  }

  get depleted() {
    return this.remaining <= 0;
  }
}