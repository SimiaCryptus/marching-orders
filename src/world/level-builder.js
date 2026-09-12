import { normalizeLevel } from './level-loader.js';
import { GENERATORS, DEFAULT_GENERATOR } from './generators/index.js';
import { clampInt } from './generators/util.js';

/**
 * Level generation framework. The generators themselves live in `./generators/` (one file each,
 * registered in `./generators/index.js`; `siege.js` is the reference implementation and the
 * campaign's generator). This module is generator-agnostic: it looks generators up, turns raw
 * parameter objects into validated ones using the generator's parameter schema, fills in "auto"
 * values, runs `build()` and normalises the result. See `generators/generator.d.ts` for the
 * contract and `docs/generators.md` for how to add one.
 *
 * Parameter objects come in two flavours:
 *   stored   — what `normalizeParams()` returns and what a level remembers in `level.generator`
 *              (plus `id`): every declared key present, auto values left on auto are `null`.
 *   resolved — what `resolveParams()` returns and `build()` receives: every key concrete.
 */

export { GENERATORS, DEFAULT_GENERATOR };
// The reference generator's constants used to live in this file; keep them reachable from here.
export { GENERATOR_LIMITS, AUTO_PARAMS, GENERATOR_DEFAULTS, SEGMENT_KINDS, autoParams } from './generators/siege.js';

export const PARAM_TYPES = Object.freeze(['int', 'number', 'boolean', 'select', 'string']);

// ---- registry ---------------------------------------------------------------------------

const validated = new WeakSet();

/** Checks a generator object against the contract once; throws a readable error when it is off. */
function validateGenerator(gen) {
  if (validated.has(gen)) return gen;
  const name = gen && typeof gen.id === 'string' ? `"${gen.id}"` : '(unnamed)';
  const fail = (msg) => { throw new Error(`Level generator ${name} is invalid: ${msg}`); };
  if (!gen || typeof gen !== 'object') fail('not an object');
  if (typeof gen.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(gen.id)) fail('"id" must be a lower-case slug');
  if (typeof gen.label !== 'string' || !gen.label.trim()) fail('"label" is required');
  if (typeof gen.build !== 'function') fail('"build(params, ctx)" is required');
  if (!Array.isArray(gen.params)) fail('"params" must be an array of parameter definitions');
  const seen = new Set();
  for (const def of gen.params) {
    if (!def || typeof def.key !== 'string' || !def.key) fail('every parameter needs a string "key"');
    if (def.key === 'id') fail('the parameter key "id" is reserved');
    if (seen.has(def.key)) fail(`duplicate parameter "${def.key}"`);
    seen.add(def.key);
    if (!PARAM_TYPES.includes(def.type)) fail(`parameter "${def.key}" has unknown type "${def.type}"`);
    if (typeof def.label !== 'string') fail(`parameter "${def.key}" needs a "label"`);
    if (def.type === 'select' && !(Array.isArray(def.options) && def.options.length)) {
      fail(`select parameter "${def.key}" needs a non-empty "options" array`);
    }
    if (def.auto && typeof gen.autoParams !== 'function') {
      fail(`parameter "${def.key}" is auto but the generator has no autoParams()`);
    }
  }
  validated.add(gen);
  return gen;
}

/** All registered generators, in manifest order. */
export function listGenerators() {
  return Object.values(GENERATORS).map(validateGenerator);
}

/** Look a generator up by id (or pass a generator object through). Throws on unknown ids. */
export function getGenerator(ref = DEFAULT_GENERATOR) {
  if (ref && typeof ref === 'object') return validateGenerator(ref);
  const gen = GENERATORS[ref];
  if (!gen) throw new Error(`Unknown level generator "${ref}" (available: ${Object.keys(GENERATORS).join(', ')})`);
  return validateGenerator(gen);
}

// ---- parameters ---------------------------------------------------------------------------

function clampValue(def, v) {
  if (def.type !== 'int' && def.type !== 'number') return v;
  let n = def.type === 'int' ? Math.round(v) : v;
  if (def.min !== undefined) n = Math.max(def.min, n);
  if (def.max !== undefined) n = Math.min(def.max, n);
  return n;
}

/** The value a non-auto parameter takes when it is missing or unusable. */
function fallback(def) {
  if (def.default !== undefined && def.default !== null) return clampValue(def, def.default);
  switch (def.type) {
    case 'boolean': return false;
    case 'select': return def.options[0].value;
    case 'string': return '';
    default: return clampValue(def, def.min ?? 0);
  }
}

/**
 * One raw value -> a valid stored value for `def`. Blank / unusable input becomes `null` for auto
 * parameters (when `allowAuto`) and the fallback otherwise.
 */
function coerce(def, raw, allowAuto = true) {
  const blank = raw === null || raw === undefined || raw === '';
  const missing = () => (allowAuto && def.auto ? null : fallback(def));
  if (blank) return missing();
  switch (def.type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'select': {
      const opt = def.options.find((o) => String(o.value) === String(raw));
      return opt ? opt.value : fallback(def);
    }
    case 'string':
      return typeof raw === 'string' ? raw : String(raw);
    default: {
      const n = Number(raw);
      return Number.isFinite(n) ? clampValue(def, n) : missing();
    }
  }
}

/**
 * Fill in defaults and clamp every parameter of `generator` into its allowed range. Auto
 * parameters that are missing / blank stay `null` so callers can tell them from explicit values.
 * Unknown keys (including `id`) are dropped.
 */
export function normalizeParams(generator, raw = {}) {
  const gen = getGenerator(generator);
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const def of gen.params) out[def.key] = coerce(def, src[def.key]);
  return out;
}

/** Like normalizeParams, with every auto parameter replaced by the generator's derived value. */
export function resolveParams(generator, raw = {}) {
  const gen = getGenerator(generator);
  const out = normalizeParams(gen, raw);
  const pending = gen.params.filter((def) => def.auto && out[def.key] === null);
  if (!pending.length) return out;
  const auto = (gen.autoParams && gen.autoParams({ ...out })) || {};
  for (const def of pending) out[def.key] = coerce(def, auto[def.key], false);
  return out;
}

// ---- building -----------------------------------------------------------------------------

/**
 * Build a level with `generator` (id or object) from raw parameters. Returns a validated level
 * (see level-loader) that remembers `generator: { id, ...storedParams }` so the designer can
 * show and tweak the parameters later.
 */
export function buildLevel(generator, rawParams = {}) {
  const gen = getGenerator(generator);
  const stored = normalizeParams(gen, rawParams);
  const resolved = resolveParams(gen, stored);
  const raw = gen.build(resolved, { generator: gen, stored });
  if (!raw || typeof raw !== 'object') throw new Error(`Level generator "${gen.id}" did not return a level`);
  const level = normalizeLevel(raw);
  level.generator = { id: gen.id, ...stored };
  return level;
}

/**
 * Backwards-compatible entry point: build with the generator named by `params.id`, or the
 * default (reference) generator when absent. Prefer `buildLevel(id, params)`.
 */
export function buildParametricLevel(rawParams = {}) {
  return buildLevel(rawParams.id ?? DEFAULT_GENERATOR, rawParams);
}

// ---- the standard progression ---------------------------------------------------------

export const CAMPAIGN_LENGTH = 12;
/** The campaign is a fixed progression of the reference generator. */
export const CAMPAIGN_GENERATOR = 'siege';

const CAMPAIGN_TITLES = [
  'First Wall', 'Spike Row', 'The Trench', 'Twin Walls', 'Patrol Yard', 'Watchtower',
  'Crossfire', 'The Gauntlet', "Grenadier's Keep", 'Long March', 'Broken Ground', 'Last Siege',
];

/** Generator parameters of campaign level `index` (0-based): difficulty, length and width ramp up together. */
export function campaignParams(index) {
  const i = clampInt(index, 0, CAMPAIGN_LENGTH - 1);
  return normalizeParams(CAMPAIGN_GENERATOR, {
    seed: 101 + i * 7919,
    difficulty: Math.round((i * 10) / (CAMPAIGN_LENGTH - 1)),
    segments: 3 + i,
    depth: 14 + 2 * Math.floor(i / 3),
    name: `Campaign ${i + 1}/${CAMPAIGN_LENGTH}: ${CAMPAIGN_TITLES[i]}`,
  });
}

/** Campaign level `index` (0-based), tagged so the game can offer the next one after a win. */
export function buildCampaignLevel(index) {
  const i = clampInt(index, 0, CAMPAIGN_LENGTH - 1);
  const level = buildLevel(CAMPAIGN_GENERATOR, campaignParams(i));
  level.campaign = { index: i, length: CAMPAIGN_LENGTH };
  return level;
}