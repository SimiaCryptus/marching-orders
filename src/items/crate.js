import { TEAM } from '../units/team.js';

/**
 * A weapon crate sitting on a walkable cell. The first N troops of its team that walk over it
 * take its contents. `exclusive` overrides the level rule for whether the kit takes the troop's
 * equipment slot (null = follow `rules.<kind>Exclusive`).
 */
export class Crate {
  constructor(id, kind, x, y, z, capacity, team = TEAM.PLAYER, exclusive = null) {
    this.id = id;
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.z = z;
    this.capacity = capacity;
    this.remaining = capacity;
    this.team = team;
    this.exclusive = typeof exclusive === 'boolean' ? exclusive : null;
  }

  get cell() {
    return { x: this.x, y: this.y, z: this.z };
  }

  get depleted() {
    return this.remaining <= 0;
  }
}
