/**
 * Tunable game rules (notes.md). Every level may override any of these under "rules"; the
 * parametric builder and the level designer expose them, so the same map can be made gentler
 * or harsher without touching the terrain. Values are validated by `normalizeRules`.
 *
 * Numeric rules carry min / max / step; `type: 'boolean'` rules are plain flags. `group` is the
 * heading the designer files the rule under (rules without one go into the general block).
 */
const KITS = 'Rifle, pickaxe, ladder & bridge';
const EXCLUSIVE = 'Exclusive kits (take the one equipment slot)';

export const RULE_DEFS = Object.freeze([
  { key: 'troopHp', label: 'Player troop HP', min: 1, max: 999, step: 1, def: 10 },
  { key: 'enemyTroopHp', label: 'Enemy troop HP', min: 1, max: 999, step: 1, def: 10 },
  { key: 'troopSpeed', label: 'Troop speed (cells/s)', min: 0.5, max: 10, step: 0.1, def: 2.5 },
  {
    key: 'enemyTroopSpeed',
    label: 'Enemy troop speed (cells/s)',
    min: 0.5,
    max: 10,
    step: 0.1,
    def: 2.5,
  },
  { key: 'enemyTroopScale', label: 'Enemy troop size ×', min: 0.5, max: 2.5, step: 0.1, def: 1 },
  { key: 'troopAttack', label: 'Troop melee damage', min: 0, max: 99, step: 1, def: 2 },
  { key: 'crateCapacity', label: 'Troops served per crate', min: 1, max: 99, step: 1, def: 5 },
  // Mud voxels slow every step taken onto them (troops of both teams).
  { key: 'mudSpeed', label: 'Speed on mud ×', min: 0.1, max: 1, step: 0.05, def: 0.5 },
  // Rifle, pickaxe and ladder kits
  {
    key: 'rifleRange',
    label: 'Rifle range (cells)',
    min: 2,
    max: 32,
    step: 1,
    def: 8,
    group: KITS,
  },
  { key: 'rifleAttack', label: 'Rifle damage', min: 0, max: 99, step: 1, def: 3, group: KITS },
  {
    key: 'pickaxeCharges',
    label: 'Pickaxe charges',
    min: 1,
    max: 999,
    step: 1,
    def: 10,
    group: KITS,
  },
  {
    key: 'ladderCharges',
    label: 'Ladder segments per kit',
    min: 1,
    max: 99,
    step: 1,
    def: 3,
    group: KITS,
  },
  {
    key: 'bridgeCharges',
    label: 'Bridge planks per kit',
    min: 1,
    max: 99,
    step: 1,
    def: 4,
    group: KITS,
  },
  {
    key: 'builderBricks',
    label: 'Planks per builder crate',
    min: 1,
    max: 99,
    step: 1,
    def: 5,
    group: KITS,
  },
  // Medic kit: heals the nearest wounded troop of its team within range, one charge per heal
  {
    key: 'medicCharges',
    label: 'Medic heal charges',
    min: 1,
    max: 99,
    step: 1,
    def: 6,
    group: 'Medic',
  },
  {
    key: 'medicHeal',
    label: 'HP healed per charge',
    min: 1,
    max: 99,
    step: 1,
    def: 4,
    group: 'Medic',
  },
  {
    key: 'medicRange',
    label: 'Medic range (cells)',
    min: 1,
    max: 16,
    step: 1,
    def: 3,
    group: 'Medic',
  },
  {
    key: 'medicCooldown',
    label: 'Seconds between heals',
    min: 0.1,
    max: 10,
    step: 0.1,
    def: 1.5,
    group: 'Medic',
  },
  // Grenades: lobbed at hostiles between the minimum and the maximum range (line of sight)
  {
    key: 'grenadeCharges',
    label: 'Grenades per crate',
    min: 1,
    max: 99,
    step: 1,
    def: 3,
    group: 'Grenades',
  },
  {
    key: 'grenadeRange',
    label: 'Grenade range (cells)',
    min: 2,
    max: 16,
    step: 1,
    def: 6,
    group: 'Grenades',
  },
  {
    key: 'grenadeMinRange',
    label: 'Grenade minimum range',
    min: 0,
    max: 8,
    step: 1,
    def: 2,
    group: 'Grenades',
  },
  {
    key: 'grenadeAttack',
    label: 'Grenade damage',
    min: 0,
    max: 99,
    step: 1,
    def: 6,
    group: 'Grenades',
  },
  {
    key: 'grenadeSplash',
    label: 'Grenade splash radius',
    min: 0.5,
    max: 5,
    step: 0.1,
    def: 1.5,
    group: 'Grenades',
  },
  {
    key: 'grenadeCooldown',
    label: 'Seconds between grenades',
    min: 0.5,
    max: 10,
    step: 0.1,
    def: 3,
    group: 'Grenades',
  },
  // Armor absorbs a share of every hit until its pool is spent; a parachute survives lethal falls
  {
    key: 'armorPool',
    label: 'Armor: total damage absorbed',
    min: 1,
    max: 999,
    step: 1,
    def: 20,
    group: 'Armor & parachute',
  },
  {
    key: 'armorMitigation',
    label: 'Armor: share of each hit absorbed',
    min: 0.05,
    max: 1,
    step: 0.05,
    def: 0.5,
    group: 'Armor & parachute',
  },
  {
    key: 'parachuteCharges',
    label: 'Parachute: lethal falls survived',
    min: 1,
    max: 99,
    step: 1,
    def: 3,
    group: 'Armor & parachute',
  },
  // Guards
  {
    key: 'guardHpScale',
    label: 'Guard HP ×',
    min: 0.1,
    max: 10,
    step: 0.1,
    def: 1,
    group: 'Guards',
  },
  {
    key: 'guardDamageScale',
    label: 'Guard damage ×',
    min: 0.1,
    max: 10,
    step: 0.1,
    def: 1,
    group: 'Guards',
  },
  {
    key: 'guardRangeScale',
    label: 'Guard range ×',
    min: 0.1,
    max: 4,
    step: 0.1,
    def: 1,
    group: 'Guards',
  },
  // Exclusive kits occupy the troop's single equipment slot; the others stack on top of anything.
  { key: 'rifleExclusive', label: 'Rifle', type: 'boolean', def: true, group: EXCLUSIVE },
  { key: 'pickaxeExclusive', label: 'Pickaxe', type: 'boolean', def: true, group: EXCLUSIVE },
  { key: 'ladderExclusive', label: 'Ladder kit', type: 'boolean', def: true, group: EXCLUSIVE },
  { key: 'bridgeExclusive', label: 'Bridge kit', type: 'boolean', def: true, group: EXCLUSIVE },
  { key: 'medicExclusive', label: 'Medic kit', type: 'boolean', def: true, group: EXCLUSIVE },
  { key: 'grenadeExclusive', label: 'Grenades', type: 'boolean', def: true, group: EXCLUSIVE },
  { key: 'armorExclusive', label: 'Armor', type: 'boolean', def: false, group: EXCLUSIVE },
  { key: 'parachuteExclusive', label: 'Parachute', type: 'boolean', def: false, group: EXCLUSIVE },
  { key: 'builderExclusive', label: 'Builder kit', type: 'boolean', def: false, group: EXCLUSIVE },
]);

export const DEFAULT_RULES = Object.freeze(
  Object.fromEntries(RULE_DEFS.map((r) => [r.key, r.def]))
);

/** Fill in defaults, coerce flags and clamp every numeric rule into its allowed range. */
export function normalizeRules(raw) {
  const out = {};
  for (const r of RULE_DEFS) {
    if (r.type === 'boolean') {
      const v = raw ? raw[r.key] : undefined;
      out[r.key] = v === undefined || v === null ? r.def : !!v;
      continue;
    }
    let v = raw && Number.isFinite(raw[r.key]) ? raw[r.key] : r.def;
    v = Math.max(r.min, Math.min(r.max, v));
    out[r.key] = r.step === 1 ? Math.round(v) : Math.round(v * 100) / 100;
  }
  return out;
}
