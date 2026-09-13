/**
 * Strict level validation for the command-line tool (scripts/level-tool.mjs).
 *
 * `normalizeLevel()` in src/world/level-loader.js is forgiving: it fills defaults and silently
 * drops entities it does not understand. This module enforces the documented contract in
 * src/world/level.d.ts to the letter — no unknown properties, exact types, axis-aligned
 * facings, known kinds and voxel names — and then checks the built world against the rules in
 * docs/level-builder-guide.md §11: entities in supported air cells, a standable objective, a
 * winnable troop count and a reachability search from the drop pod with and without the tools
 * the level hands out.
 *
 * Pure Node ES module: it imports the game's data modules, none of which touch the DOM.
 */
import { normalizeLevel, buildWorld } from '../src/world/level-loader.js';
import { VOXEL_BY_NAME, VOXEL_TYPES, voxelInfo, isClimbable, isDiggable, isLethal } from '../src/world/voxel.js';
import { GUARD_TYPES } from '../src/units/guard.js';
import { SIGNS } from '../src/items/sign.js';
import { EQUIPMENT } from '../src/items/equipment.js';
import { ROLES } from '../src/units/roles/index.js';
import { RULE_DEFS } from '../src/rules.js';
import { GENERATORS } from '../src/world/generators/index.js';
import { DIRS } from '../src/units/pathing.js';

const TOP_KEYS = new Set([
  'name', 'description', 'size', 'spawn', 'objective', 'lethalFall', 'timeLimit', 'rules', 'budget',
  'guards', 'enemySpawners', 'signs', 'crates', 'voxels', 'fills', 'generator', 'campaign',
]);
const LEGACY_SIGN_KINDS = { turnLeft: 'arrow', turnRight: 'arrow', turn: 'arrow', fanOut: 'fan', divert: 'fan' };
const TEAMS = ['player', 'enemy'];
const RULE_BY_KEY = Object.fromEntries(RULE_DEFS.map((r) => [r.key, r]));

const isInt = Number.isInteger;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isInt);
const isFacing = (v) => Array.isArray(v) && v.length === 2 && v.every(isInt) && Math.abs(v[0]) + Math.abs(v[1]) === 1;
const fmt = (p) => `(${p.join(', ')})`;

/** Collects findings in three buckets: errors fail the level, warnings are suspicious, notes are informative. */
class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.notes = [];
  }

  error(path, message) { this.errors.push({ path, message }); }
  warn(path, message) { this.warnings.push({ path, message }); }
  note(path, message) { this.notes.push({ path, message }); }

  get ok() { return this.errors.length === 0; }
}

// ---- shape: the LevelInput interface, strictly ------------------------------------------

function checkKeys(rep, path, obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) rep.error(path ? `${path}.${k}` : k, 'unknown property (not part of LevelInput in level.d.ts)');
  }
}

function checkShape(raw, rep) {
  if (!isObj(raw)) { rep.error('', 'level must be a JSON object'); return; }
  checkKeys(rep, '', raw, TOP_KEYS);

  const str = (path, v) => { if (v !== undefined && typeof v !== 'string') rep.error(path, 'must be a string'); };
  str('name', raw.name);
  str('description', raw.description);
  if (raw.name !== undefined && typeof raw.name === 'string' && !raw.name.trim()) rep.warn('name', 'is blank; the game shows "Untitled Level"');

  let bounds = null;
  if (!isVec3(raw.size)) rep.error('size', 'must be [width, height, depth] integers');
  else if (raw.size.some((n) => n < 1 || n > 256)) rep.error('size', 'every axis must be between 1 and 256');
  else bounds = raw.size;
  if (bounds && bounds[0] * bounds[1] * bounds[2] > 200000) rep.warn('size', `${bounds[0] * bounds[1] * bounds[2]} cells is large; keep levels under ~200 000 cells`);

  const vec = (path, v, required = false) => {
    if (v === undefined) { if (required) rep.error(path, 'is required'); return; }
    if (!isVec3(v)) { rep.error(path, 'must be [x, y, z] integers'); return; }
    if (bounds && v.some((n, i) => n < 0 || n >= bounds[i])) rep.error(path, `${fmt(v)} is outside the ${bounds.join('×')} map`);
  };
  const facing = (path, v) => {
    if (v !== undefined && !isFacing(v)) rep.error(path, 'must be an axis-aligned unit facing: [1,0] [-1,0] [0,1] [0,-1]');
  };
  const posInt = (path, v) => { if (v !== undefined && !(isInt(v) && v > 0)) rep.error(path, 'must be an integer > 0'); };
  const posNum = (path, v) => { if (v !== undefined && !(Number.isFinite(v) && v > 0)) rep.error(path, 'must be a number > 0'); };
  const oneOf = (path, v, table, what) => {
    if (v !== undefined && !(typeof v === 'string' && table[v])) rep.error(path, `unknown ${what} "${v}" (known: ${Object.keys(table).join(', ')})`);
  };
  const team = (path, v) => { if (v !== undefined && !TEAMS.includes(v)) rep.error(path, `must be 'player' or 'enemy'`); };

  // spawn
  if (!isObj(raw.spawn)) rep.error('spawn', 'is required and must be an object');
  else {
    checkKeys(rep, 'spawn', raw.spawn, new Set(['pos', 'dir', 'count', 'rate']));
    vec('spawn.pos', raw.spawn.pos, true);
    facing('spawn.dir', raw.spawn.dir);
    posInt('spawn.count', raw.spawn.count);
    posNum('spawn.rate', raw.spawn.rate);
  }
  // objective
  if (!isObj(raw.objective)) rep.error('objective', 'is required and must be an object');
  else {
    checkKeys(rep, 'objective', raw.objective, new Set(['type', 'from', 'to', 'required']));
    if (raw.objective.type !== undefined && raw.objective.type !== 'reach') rep.error('objective.type', `unsupported type "${raw.objective.type}" (only 'reach')`);
    vec('objective.from', raw.objective.from, true);
    vec('objective.to', raw.objective.to, true);
    posInt('objective.required', raw.objective.required);
  }
  posInt('lethalFall', raw.lethalFall);
  if (raw.timeLimit !== undefined && !(Number.isFinite(raw.timeLimit) && raw.timeLimit >= 0)) rep.error('timeLimit', 'must be a number ≥ 0 (0 = unlimited)');

  // rules
  if (raw.rules !== undefined) {
    if (!isObj(raw.rules)) rep.error('rules', 'must be an object');
    else {
      for (const [k, v] of Object.entries(raw.rules)) {
        const def = RULE_BY_KEY[k];
        if (!def) { rep.error(`rules.${k}`, `unknown rule (known: ${RULE_DEFS.map((r) => r.key).join(', ')})`); continue; }
        if (def.type === 'boolean') {
          if (typeof v !== 'boolean') rep.error(`rules.${k}`, 'must be a boolean');
          continue;
        }
        if (!Number.isFinite(v)) { rep.error(`rules.${k}`, 'must be a finite number'); continue; }
        if (v < def.min || v > def.max) rep.warn(`rules.${k}`, `${v} is outside ${def.min}..${def.max} and will be clamped`);
        if (def.step === 1 && !isInt(v)) rep.warn(`rules.${k}`, `${v} will be rounded to an integer`);
      }
    }
  }
  // budget
  if (raw.budget !== undefined) {
    if (!isObj(raw.budget)) rep.error('budget', 'must be an object');
    else {
      checkKeys(rep, 'budget', raw.budget, new Set(['crates', 'signs', 'roles']));
      const table = (path, obj, known, legacy = {}) => {
        if (obj === undefined) return;
        if (!isObj(obj)) { rep.error(path, 'must be an object of counts'); return; }
        for (const [k, v] of Object.entries(obj)) {
          if (legacy[k]) rep.warn(`${path}.${k}`, `legacy kind; write "${legacy[k]}" instead`);
          else if (!known[k]) rep.error(`${path}.${k}`, `unknown kind (known: ${Object.keys(known).join(', ')})`);
          if (!(isInt(v) && v >= 0)) rep.error(`${path}.${k}`, 'must be an integer ≥ 0');
        }
      };
      table('budget.crates', raw.budget.crates, EQUIPMENT);
      table('budget.signs', raw.budget.signs, SIGNS, LEGACY_SIGN_KINDS);
      table('budget.roles', raw.budget.roles, ROLES);
    }
  }

  // entity arrays
  const list = (path, arr, allowed, each) => {
    if (arr === undefined) return;
    if (!Array.isArray(arr)) { rep.error(path, 'must be an array'); return; }
    arr.forEach((e, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(e)) { rep.error(p, 'must be an object'); return; }
      checkKeys(rep, p, e, allowed);
      each(p, e);
    });
  };
  list('guards', raw.guards, new Set(['type', 'pos', 'dir']), (p, g) => {
    oneOf(`${p}.type`, g.type, GUARD_TYPES, 'guard type');
    vec(`${p}.pos`, g.pos, true);
    facing(`${p}.dir`, g.dir);
  });
  list('enemySpawners', raw.enemySpawners, new Set(['pos', 'dir', 'count', 'rate']), (p, s) => {
    vec(`${p}.pos`, s.pos, true);
    facing(`${p}.dir`, s.dir);
    posInt(`${p}.count`, s.count);
    posNum(`${p}.rate`, s.rate);
  });
  list('signs', raw.signs, new Set(['kind', 'pos', 'dir', 'team']), (p, s) => {
    if (typeof s.kind !== 'string') rep.error(`${p}.kind`, 'is required');
    else if (LEGACY_SIGN_KINDS[s.kind]) rep.warn(`${p}.kind`, `legacy kind "${s.kind}"; write "${LEGACY_SIGN_KINDS[s.kind]}"`);
    else oneOf(`${p}.kind`, s.kind, SIGNS, 'sign kind');
    vec(`${p}.pos`, s.pos, true);
    facing(`${p}.dir`, s.dir);
    team(`${p}.team`, s.team);
  });
  list('crates', raw.crates, new Set(['kind', 'pos', 'team', 'capacity', 'exclusive']), (p, c) => {
    if (typeof c.kind !== 'string') rep.error(`${p}.kind`, 'is required');
    else oneOf(`${p}.kind`, c.kind, EQUIPMENT, 'equipment kind');
    vec(`${p}.pos`, c.pos, true);
    team(`${p}.team`, c.team);
    posInt(`${p}.capacity`, c.capacity);
    if (c.exclusive !== undefined && typeof c.exclusive !== 'boolean') rep.error(`${p}.exclusive`, 'must be a boolean');
  });

  // terrain
  if (raw.voxels !== undefined) {
    if (!isObj(raw.voxels) || !Array.isArray(raw.voxels.rle)) rep.error('voxels', 'must be { rle: [[typeId, count], ...] }');
    else {
      checkKeys(rep, 'voxels', raw.voxels, new Set(['rle']));
      let total = 0;
      raw.voxels.rle.forEach((run, i) => {
        if (!Array.isArray(run) || run.length !== 2 || !isInt(run[0]) || !isInt(run[1]) || run[1] < 0) {
          rep.error(`voxels.rle[${i}]`, 'must be [typeId, count] with integer count ≥ 0');
          return;
        }
        if (!VOXEL_TYPES[run[0]]) rep.error(`voxels.rle[${i}]`, `unknown voxel type id ${run[0]}`);
        total += run[1];
      });
      if (bounds && total !== bounds[0] * bounds[1] * bounds[2]) {
        rep.warn('voxels.rle', `runs cover ${total} cells but the map has ${bounds[0] * bounds[1] * bounds[2]} (the blob is clipped / padded with air)`);
      }
    }
  }
  if (raw.fills !== undefined) {
    if (!Array.isArray(raw.fills)) rep.error('fills', 'must be an array');
    else {
      raw.fills.forEach((f, i) => {
        const p = `fills[${i}]`;
        if (!isObj(f)) { rep.error(p, 'must be an object'); return; }
        checkKeys(rep, p, f, new Set(['type', 'from', 'to']));
        if (typeof f.type !== 'string' || VOXEL_BY_NAME[f.type] === undefined) {
          rep.error(`${p}.type`, `unknown voxel name "${f.type}" (known: ${Object.keys(VOXEL_BY_NAME).join(', ')})`);
        }
        vec(`${p}.from`, f.from, true);
        vec(`${p}.to`, f.to, true);
      });
    }
  }
  // metadata
  if (raw.generator !== undefined) {
    if (!isObj(raw.generator)) rep.error('generator', 'must be an object');
    else if (typeof raw.generator.id !== 'string') rep.error('generator.id', 'must be a generator id string');
    else if (!GENERATORS[raw.generator.id]) rep.warn('generator.id', `unknown generator "${raw.generator.id}"; the designer falls back to the default one`);
  }
  if (raw.campaign !== undefined) {
    if (!isObj(raw.campaign)) rep.error('campaign', 'must be an object');
    else {
      checkKeys(rep, 'campaign', raw.campaign, new Set(['index', 'length']));
      if (!(isInt(raw.campaign.index) && raw.campaign.index >= 0)) rep.error('campaign.index', 'must be an integer ≥ 0');
      if (!(isInt(raw.campaign.length) && raw.campaign.length > 0)) rep.error('campaign.length', 'must be an integer > 0');
    }
  }
}

/** Safety net: anything the loader dropped that the shape checks did not already flag. */
function compareCounts(raw, level, rep) {
  for (const k of ['guards', 'enemySpawners', 'signs', 'crates']) {
    if (Array.isArray(raw[k]) && raw[k].length !== level[k].length) {
      rep.error(k, `${raw[k].length - level[k].length} of ${raw[k].length} entries were dropped by the loader (invalid pos / kind)`);
    }
  }
}

// ---- semantics: the level as the simulation will see it ---------------------------------

function checkSemantics(level, world, rep) {
  const solid = (p) => world.isSolid(p[0], p[1], p[2]);
  const supported = (p) => world.isSolid(p[0], p[1] - 1, p[2]) || isClimbable(world.get(p[0], p[1], p[2]));
  const occupied = new Map();
  const place = (path, p, label) => {
    if (!world.inBounds(p[0], p[1], p[2])) { rep.error(path, `${label} at ${fmt(p)} is outside the map`); return; }
    if (solid(p)) rep.error(path, `${label} at ${fmt(p)} is inside a solid ${voxelInfo(world.get(p[0], p[1], p[2])).name} voxel`);
    else if (!supported(p)) rep.error(path, `${label} at ${fmt(p)} has nothing to stand on`);
    else if (isLethal(world.get(p[0], p[1] - 1, p[2]))) rep.error(path, `${label} at ${fmt(p)} stands on spikes`);
    const k = p.join(',');
    if (occupied.has(k)) rep.error(path, `${label} shares cell ${fmt(p)} with ${occupied.get(k)}`);
    else occupied.set(k, label);
  };

  place('spawn.pos', level.spawn.pos, 'the drop pod');
  level.enemySpawners.forEach((s, i) => place(`enemySpawners[${i}].pos`, s.pos, 'an enemy pod'));
  level.guards.forEach((g, i) => place(`guards[${i}].pos`, g.pos, `a ${g.type}`));
  level.signs.forEach((s, i) => place(`signs[${i}].pos`, s.pos, `a ${s.team} ${s.kind} sign`));
  level.crates.forEach((c, i) => place(`crates[${i}].pos`, c.pos, `a ${c.team} ${c.kind} crate`));

  const [sx, sy, sz] = level.spawn.pos;
  const [dx, dz] = level.spawn.dir;
  if (!world.inBounds(sx + dx, sy, sz + dz)) rep.warn('spawn.dir', 'the pod faces the edge of the map; troops turn around immediately');
  level.enemySpawners.forEach((s, i) => {
    if (!world.inBounds(s.pos[0] + s.dir[0], s.pos[1], s.pos[2] + s.dir[1])) rep.warn(`enemySpawners[${i}].dir`, 'the pod faces the edge of the map');
  });

  // objective volume
  const o = level.objective;
  let cells = 0, solidCells = 0, standable = 0;
  for (let x = o.from[0]; x <= o.to[0]; x++) {
    for (let y = o.from[1]; y <= o.to[1]; y++) {
      for (let z = o.from[2]; z <= o.to[2]; z++) {
        cells++;
        const p = [x, y, z];
        if (!world.inBounds(x, y, z) || solid(p)) solidCells++;
        else if (supported(p)) standable++;
      }
    }
  }
  if (solidCells) rep.error('objective', `${solidCells} of ${cells} objective cells are solid or outside the map — give the volume in the air cells troops stand in`);
  if (!standable) rep.error('objective', 'no objective cell has a floor under it; troops can never arrive there');
  else if (standable < cells - solidCells) rep.warn('objective', `${cells - solidCells - standable} objective cells have no floor and can never score`);
  if (o.required > level.spawn.count) rep.error('objective.required', `${o.required} troops required but the pod only holds ${level.spawn.count}`);
  else if (o.required > level.spawn.count * 0.8) rep.warn('objective.required', `${o.required} of ${level.spawn.count} troops must arrive — more than 80% of the column`);
  const inObjective = (p) => p[0] >= o.from[0] && p[0] <= o.to[0] && p[1] >= o.from[1] && p[1] <= o.to[1] && p[2] >= o.from[2] && p[2] <= o.to[2];
  level.guards.forEach((g, i) => { if (inObjective(g.pos)) rep.warn(`guards[${i}]`, `${g.type} stands inside the objective volume`); });
  if (inObjective(level.spawn.pos)) rep.error('spawn.pos', 'the drop pod is inside the objective volume — troops are saved on the spot');

  if (level.timeLimit > 0 && level.timeLimit < level.spawn.count * level.spawn.rate) {
    rep.warn('timeLimit', `${level.timeLimit}s expires before the pod has released all ${level.spawn.count} troops (${Math.round(level.spawn.count * level.spawn.rate)}s)`);
  }
  rep.note('spawn', `${level.spawn.count} troops over ${Math.round(level.spawn.count * level.spawn.rate)}s; ${o.required} must reach ${fmt(o.from)}–${fmt(o.to)}`);
}

// ---- reachability: the movement graph of docs/level-builder-guide.md §11 -----------------

/** True when some objective cell can be reached from the pod using the given tools. */
function reachable(level, world, tools) {
  const o = level.objective;
  const inObjective = (x, y, z) => x >= o.from[0] && x <= o.to[0] && y >= o.from[1] && y <= o.to[1] && z >= o.from[2] && z <= o.to[2];
  const solid = (x, y, z) => world.isSolid(x, y, z);
  const seen = new Uint8Array(world.w * world.h * world.d);
  const queue = [];
  const push = (x, y, z) => {
    if (!world.inBounds(x, y, z)) return;
    const k = world.index(x, y, z);
    if (seen[k]) return;
    seen[k] = 1;
    queue.push([x, y, z]);
  };
  /** Drop from air cell (x, y, z) until supported; null when the fall is deadly. */
  const land = (x, y, z) => {
    let cy = y, depth = 0;
    while (cy >= 0 && !(solid(x, cy - 1, z) || isClimbable(world.get(x, cy, z)))) { cy--; depth++; }
    if (cy < 0) return null;
    if (isLethal(world.get(x, cy - 1, z))) return null;
    if (depth > level.lethalFall && !tools.parachute) return null;
    return [x, cy, z];
  };
  const start = land(level.spawn.pos[0], level.spawn.pos[1], level.spawn.pos[2]);
  if (!start) return false;
  push(...start);
  let head = 0;
  while (head < queue.length) {
    const [x, y, z] = queue[head++];
    if (inObjective(x, y, z)) return true;
    if (isClimbable(world.get(x, y, z)) && !solid(x, y - 1, z)) push(x, y - 1, z); // climb down a ladder
    for (const { dx, dz } of DIRS) {
      const tx = x + dx, tz = z + dz;
      if (tx < 0 || tx >= world.w || tz < 0 || tz >= world.d) continue; // the edge is a wall
      if (solid(tx, y, tz)) {
        if (!solid(tx, y + 1, tz) && y + 1 < world.h) push(tx, y + 1, tz);                 // stepUp
        else if (tools.ladder && y + 1 < world.h && !solid(x, y + 1, z)) push(x, y + 1, z); // ladder / builder
        else if (tools.dig && isDiggable(world.get(tx, y, tz))) {                             // dig
          const l = land(tx, y, tz);
          if (l) push(...l);
        }
        continue;
      }
      if (solid(tx, y - 1, tz)) push(tx, y, tz);                 // walk
      else if (solid(tx, y - 2, tz)) push(tx, y - 1, tz);        // stepDown
      else {
        if (tools.bridge) push(tx, y, tz);                       // bridge kit: a plank across the gap
        const l = land(tx, y, tz);                               // or walk off the ledge
        if (l) push(...l);
      }
    }
  }
  return false;
}

function checkReachability(level, world, rep) {
  const has = (kind) => (level.budget.crates[kind] ?? 0) > 0 || level.crates.some((c) => c.kind === kind && c.team === 'player');
  const tools = {
    dig: has('pickaxe'),
    ladder: has('ladder') || (level.budget.roles.builder ?? 0) > 0,
    bridge: has('bridge'),
    parachute: has('parachute'),
  };
  const granted = Object.entries(tools).filter(([, v]) => v).map(([k]) => k);
  const open = reachable(level, world, { dig: false, ladder: false, bridge: false, parachute: false });
  if (open) {
    if (granted.length) rep.warn('objective', 'reachable from the pod without any tools (steering aside) — the obstacles can be walked around');
    else rep.note('objective', 'reachable from the pod on foot');
    return;
  }
  if (!reachable(level, world, tools)) {
    rep.error('objective', `unreachable from the pod even with the granted tools (${granted.join(', ') || 'none'}) — check walls, drops and spikes on the route`);
  } else {
    rep.note('objective', `reachable only with tools (${granted.join(', ')})`);
  }
}

// ---- entry point -------------------------------------------------------------------------

/**
 * Validate a raw level object. Returns { ok, errors, warnings, notes, level, world }; `level`
 * and `world` are the normalised level and its voxel grid when they could be built.
 */
export function validateLevel(raw) {
  const rep = new Report();
  checkShape(raw, rep);
  let level = null, world = null;
  try {
    level = normalizeLevel(raw);
  } catch (err) {
    rep.error('', err.message);
  }
  if (level) {
    compareCounts(raw, level, rep);
    try {
      world = buildWorld(level);
    } catch (err) {
      rep.error('fills', err.message);
    }
  }
  if (level && world) {
    checkSemantics(level, world, rep);
    checkReachability(level, world, rep);
  }
  return { ok: rep.ok, errors: rep.errors, warnings: rep.warnings, notes: rep.notes, level, world };
}