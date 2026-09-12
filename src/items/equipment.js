import { DEFAULT_RULES } from '../rules.js';

/**
 * Equipment granted by weapon crates. `apply` permanently mutates a troop's stats using the
 * level's rules (rifle range / damage, pickaxe and ladder charges, medic / grenade / armor /
 * parachute parameters — see rules.js).
 *
 * A troop has one *exclusive* equipment slot plus any number of stackable kits. Whether a kind
 * takes the slot is the level rule `<kind>Exclusive` (armor and parachute stack by default) or
 * the crate's own `exclusive` flag; see `isExclusive`. Consumable kits (pickaxe, ladder, medic,
 * grenades, armor, parachute) are dropped once used up, which frees the slot again. Whatever a
 * troop picks up it keeps: effects of several kits combine. How many troops a crate serves is
 * `rules.crateCapacity` unless the crate says otherwise.
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
  medic: {
    name: 'Medic Kit',
    label: 'Medic Crate',
    color: 0xf2607a,
    apply(troop, rules = DEFAULT_RULES) {
      // Heals the nearest wounded troop of its team within range, automatically, one charge per heal.
      troop.healCharges = rules.medicCharges;
      troop.healAmount = rules.medicHeal;
      troop.healRange = rules.medicRange;
      troop.healCooldown = rules.medicCooldown;
    },
  },
  grenade: {
    name: 'Grenades',
    label: 'Grenade Crate',
    color: 0x8fb04a,
    apply(troop, rules = DEFAULT_RULES) {
      // Lobs area-of-effect grenades at hostiles between the minimum and maximum range.
      troop.grenades = rules.grenadeCharges;
      troop.grenadeRange = rules.grenadeRange;
      troop.grenadeMinRange = rules.grenadeMinRange;
      troop.grenadeAttack = rules.grenadeAttack;
      troop.grenadeSplash = rules.grenadeSplash;
      troop.grenadeCooldown = rules.grenadeCooldown;
    },
  },
  armor: {
    name: 'Armor',
    label: 'Armor Crate',
    color: 0xb8c2d0,
    apply(troop, rules = DEFAULT_RULES) {
      // Absorbs `armorMitigation` of every hit until `armorPool` damage has been soaked up.
      troop.armorPool = rules.armorPool;
      troop.armorMitigation = rules.armorMitigation;
    },
  },
  parachute: {
    name: 'Parachute',
    label: 'Parachute Crate',
    color: 0xf4efe0,
    apply(troop, rules = DEFAULT_RULES) {
      // Survives falls beyond the lethal height (one charge per saved landing) and floats down slower.
      troop.parachutes = rules.parachuteCharges;
    },
  },
});

/**
 * Whether a kit of `kind` takes the troop's single equipment slot: the crate's own setting when
 * it has one, else the level rule `<kind>Exclusive` (kinds without a rule are exclusive).
 */
export function isExclusive(kind, rules = DEFAULT_RULES, override = null) {
  if (typeof override === 'boolean') return override;
  const v = rules ? rules[`${kind}Exclusive`] : undefined;
  return v === undefined || v === null ? true : !!v;
}