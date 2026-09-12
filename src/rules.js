/**
 * Tunable game rules (notes.md). Every level may override any of these under "rules"; the
 * parametric builder and the level designer expose them, so the same map can be made gentler
 * or harsher without touching the terrain. Values are validated by `normalizeRules`.
 */
export const RULE_DEFS = Object.freeze([
  { key: 'troopHp', label: 'Player troop HP', min: 1, max: 999, step: 1, def: 10 },
  { key: 'enemyTroopHp', label: 'Enemy troop HP', min: 1, max: 999, step: 1, def: 10 },
  { key: 'troopSpeed', label: 'Troop speed (cells/s)', min: 0.5, max: 10, step: 0.1, def: 2.5 },
  { key: 'troopAttack', label: 'Troop melee damage', min: 0, max: 99, step: 1, def: 2 },
  { key: 'rifleRange', label: 'Rifle range (cells)', min: 2, max: 32, step: 1, def: 8 },
  { key: 'rifleAttack', label: 'Rifle damage', min: 0, max: 99, step: 1, def: 3 },
  { key: 'pickaxeCharges', label: 'Pickaxe charges', min: 1, max: 999, step: 1, def: 10 },
  { key: 'ladderCharges', label: 'Ladder segments per kit', min: 1, max: 99, step: 1, def: 3 },
  { key: 'crateCapacity', label: 'Troops served per crate', min: 1, max: 99, step: 1, def: 5 },
  { key: 'guardHpScale', label: 'Guard HP ×', min: 0.1, max: 10, step: 0.1, def: 1 },
  { key: 'guardDamageScale', label: 'Guard damage ×', min: 0.1, max: 10, step: 0.1, def: 1 },
  { key: 'guardRangeScale', label: 'Guard range ×', min: 0.1, max: 4, step: 0.1, def: 1 },
]);

export const DEFAULT_RULES = Object.freeze(Object.fromEntries(RULE_DEFS.map((r) => [r.key, r.def])));

/** Fill in defaults and clamp every rule into its allowed range. */
export function normalizeRules(raw) {
  const out = {};
  for (const r of RULE_DEFS) {
    let v = raw && Number.isFinite(raw[r.key]) ? raw[r.key] : r.def;
    v = Math.max(r.min, Math.min(r.max, v));
    out[r.key] = r.step === 1 ? Math.round(v) : Math.round(v * 100) / 100;
  }
  return out;
}