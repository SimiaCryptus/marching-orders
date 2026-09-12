import { DEFAULT_RULES } from '../rules.js';

/**
 * Equipment granted by weapon crates. `apply` permanently mutates a troop's stats using the
 * level's rules (rifle range / damage, pickaxe and ladder charges — see rules.js).
 * A troop has a single equipment slot in the MVP; consumable kits (pickaxe, ladder) free the
 * slot again once they are used up. How many troops a crate serves is `rules.crateCapacity`.
 */
export const EQUIPMENT = Object.freeze({
  rifle: {
    name: 'Rifle',
    label: 'Rifle Crate',
    color: 0x4aa3ff,
    apply(troop, rules = DEFAULT_RULES) {
      troop.range = rules.rifleRange;
      troop.attack = rules.rifleAttack;
      troop.attackCooldown = 1.0;
    },
  },
  pickaxe: {
    name: 'Pickaxe',
    label: 'Pickaxe Crate',
    color: 0xff9a3c,
    apply(troop, rules = DEFAULT_RULES) {
      troop.canDig = true;
      troop.digUses = rules.pickaxeCharges;
    },
  },
  ladder: {
    name: 'Ladder Kit',
    label: 'Ladder Crate',
    color: 0xd9c47a,
    apply(troop, rules = DEFAULT_RULES) {
      // Builds permanent ladder segments when a wall too tall to step over blocks the way.
      troop.ladders = rules.ladderCharges;
    },
  },
});