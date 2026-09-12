import { mulberry32, plural } from './util.js';

/**
 * "Siege" — the reference level generator (the original parametric builder). Turns a handful of
 * numbers into a complete level:
 *
 *   [pod] --runway--> [segment 0] [segment 1] ... [segment n-1] --> [stone keep with the vault]
 *
 * Every segment is one obstacle picked from a difficulty-gated catalogue (dirt walls to dig or
 * ladder over, trenches to fall into and climb out of, spike fields the column must be steered
 * around, turret pillars). Enemy drop pods are spread along the approach so their columns cross
 * the player's path, the keep is garrisoned from a fixed roster of posts, and the player's budget
 * is derived from the obstacles and hostiles actually placed, so a generated level is always
 * solvable with the tools it hands out.
 *
 * Parameters come in two groups (see PARAMS):
 *   layout — seed, difficulty, segments (length of the approach), depth (width of the corridor)
 *   counts — troops, patrols (enemy pods), enemyTroops (per pod), guards (keep garrison) and
 *            enemyCrates (rifle crates for the patrols). Each may be left on auto, in which case
 *            it is derived from the difficulty and length; see `autoParams`.
 *
 * Generation is fully deterministic (seeded RNG): the same parameters always give the same
 * level, which is what makes the fixed campaign progression reproducible. Only the layout
 * parameters seed the RNG, so tweaking a count never reshuffles the terrain.
 *
 * This file doubles as the template for new generators: see docs/generators.md.
 */

/** Parameter schema (generator.d.ts). Order = display order in the designer. */
export const PARAMS = Object.freeze([
  { key: 'seed', label: 'Seed', type: 'int', min: 0, max: 999999, default: 1, layout: true },
  { key: 'difficulty', label: 'Difficulty (0–10)', type: 'int', min: 0, max: 10, default: 3, layout: true },
  { key: 'segments', label: 'Obstacle segments', type: 'int', min: 1, max: 20, default: 6, layout: true },
  { key: 'depth', label: 'Corridor width', type: 'int', min: 10, max: 40, default: 16, layout: true },
  { key: 'name', label: 'Name', type: 'string', default: '', help: 'Blank: "Siege #<seed> (difficulty n)"' },
  { key: 'troops', label: 'Player troops', type: 'int', min: 5, max: 300, auto: true },
  { key: 'patrols', label: 'Enemy pods', type: 'int', min: 0, max: 40, auto: true },
  { key: 'enemyTroops', label: 'Troops per enemy pod', type: 'int', min: 1, max: 60, auto: true },
  { key: 'guards', label: 'Keep guards', type: 'int', min: 0, max: 12, auto: true },
  { key: 'enemyCrates', label: 'Enemy rifle crates', type: 'int', min: 0, max: 40, auto: true },
]);

// Derived views of the schema, kept for code that used the pre-framework constants.
export const GENERATOR_LIMITS = Object.freeze(Object.fromEntries(
  PARAMS.filter((p) => p.type === 'int').map((p) => [p.key, Object.freeze({ min: p.min, max: p.max })]),
));
export const AUTO_PARAMS = Object.freeze(PARAMS.filter((p) => p.auto).map((p) => p.key));
export const GENERATOR_DEFAULTS = Object.freeze(Object.fromEntries(
  PARAMS.filter((p) => !p.auto).map((p) => [p.key, p.default]),
));

const SEGMENT_SPAN = 8;    // x cells per obstacle segment (obstacle + run-up)
const RUNWAY = 12;         // open ground between the pod and the first obstacle
const KEEP_SPAN = 15;      // outer width of the keep along x
const MARGIN = 4;          // ground behind the keep
const HEIGHT = 16;
const FLOOR_Y = 3;         // the air cell troops walk in (bedrock at 0, dirt at 1..2)
const WALL_TOP = 9;        // top voxel of the keep walls
const POD_OFFSETS = [2, 6]; // x offsets inside a segment where an enemy pod may sit

/** Values used for the count parameters left on auto, derived from difficulty and length. */
export function autoParams(p) {
  const d = p.difficulty, n = p.segments;
  const patrols = d >= 4 ? Math.min(2 * n, 1 + Math.floor((d - 4) / 2) + Math.floor(n / 6)) : 0;
  return {
    troops: 24 + 3 * n,
    patrols,
    enemyTroops: 3 + Math.floor(d / 2),
    guards: d === 0 ? 0 : Math.min(GENERATOR_LIMITS.guards.max, 1 + Math.floor(d / 3)),
    enemyCrates: d >= 7 ? patrols : 0,
  };
}

/**
 * Obstacle catalogue. `minDifficulty` gates when a kind may appear, `weight` its pick chance,
 * `max` how often it may show up in one level.
 */
export const SEGMENT_KINDS = Object.freeze([
  { kind: 'wall', label: 'dirt wall', minDifficulty: 0, weight: 3 },
  { kind: 'spikes', label: 'spike field', minDifficulty: 1, weight: 3 },
  { kind: 'pit', label: 'trench', minDifficulty: 2, weight: 2 },
  { kind: 'tallWall', label: 'tall wall', minDifficulty: 3, weight: 2 },
  { kind: 'pillar', label: 'turret pillar', minDifficulty: 5, weight: 1, max: 3 },
]);

function pickSegments(rng, difficulty, n) {
  const used = {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const pool = SEGMENT_KINDS.filter((k) => difficulty >= k.minDifficulty && (used[k.kind] ?? 0) < (k.max ?? Infinity));
    const prev = out[out.length - 1];
    const choices = pool.length > 1 ? pool.filter((k) => k.kind !== prev) : pool; // avoid back-to-back repeats
    let total = 0;
    for (const k of choices) total += k.weight;
    let r = rng() * total;
    let chosen = choices[choices.length - 1];
    for (const k of choices) {
      r -= k.weight;
      if (r < 0) { chosen = k; break; }
    }
    used[chosen.kind] = (used[chosen.kind] ?? 0) + 1;
    out.push(chosen.kind);
  }
  // Once steering puzzles are unlocked, guarantee one: the column has to be routed, not just dug through.
  if (difficulty >= 1 && n >= 2 && !out.includes('spikes')) out[1] = 'spikes';
  return out;
}

/** Build a level from resolved parameters. Returns an author-style level (the framework normalises it). */
export function build(p) {
  // Only the layout parameters seed the RNG: tweaking a count never reshuffles the terrain.
  const rng = mulberry32(p.seed * 1000003 + p.difficulty * 1009 + p.segments * 101 + p.depth);

  const d = p.depth, h = HEIGHT;
  const mid = Math.floor(d / 2);
  const keepX = RUNWAY + p.segments * SEGMENT_SPAN;
  const w = keepX + KEEP_SPAN + MARGIN;

  const fills = [
    { type: 'bedrock', from: [0, 0, 0], to: [w - 1, 0, d - 1] },
    { type: 'dirt', from: [0, 1, 0], to: [w - 1, FLOOR_Y - 1, d - 1] },
  ];
  const guards = [], enemySpawners = [], crates = [], signs = [];
  const counts = { wall: 0, tallWall: 0, spikes: 0, pit: 0, pillar: 0 };

  // ---- obstacle segments ----------------------------------------------------------------
  const kinds = pickSegments(rng, p.difficulty, p.segments);
  kinds.forEach((kind, i) => {
    const x = RUNWAY + i * SEGMENT_SPAN;
    counts[kind]++;
    switch (kind) {
      case 'wall': // two thick, two high: dig, ladder or build over it
        fills.push({ type: 'dirt', from: [x, FLOOR_Y, 0], to: [x + 1, FLOOR_Y + 1, d - 1] });
        break;
      case 'tallWall': // three high: a single ladder kit is no longer enough
        fills.push({ type: 'dirt', from: [x, FLOOR_Y, 0], to: [x + 1, FLOOR_Y + 2, d - 1] });
        break;
      case 'spikes': {
        // A spike row replacing the top soil, with a safe gap that is never on the pod's lane.
        const gapW = p.difficulty >= 8 ? 1 : 2;
        let gz;
        do gz = 1 + Math.floor(rng() * (d - 1 - gapW)); while (gz <= mid && mid <= gz + gapW - 1);
        fills.push({ type: 'spikes', from: [x, FLOOR_Y - 1, 0], to: [x, FLOOR_Y - 1, d - 1] });
        fills.push({ type: 'dirt', from: [x, FLOOR_Y - 1, gz], to: [x, FLOOR_Y - 1, gz + gapW - 1] });
        break;
      }
      case 'pit': // a two-deep trench: troops drop in and face a two-high wall on the far side
        fills.push({ type: 'air', from: [x, 1, 0], to: [x + 1, FLOOR_Y - 1, d - 1] });
        break;
      case 'pillar': {
        // A stone pillar off the centre lane with a turret on top: rifles or a detour.
        const pz = mid + (rng() < 0.5 ? -2 : 2);
        const top = FLOOR_Y + 3;
        fills.push({ type: 'stone', from: [x + 4, FLOOR_Y, pz], to: [x + 4, top, pz] });
        guards.push({ type: 'turret', pos: [x + 4, top + 1, pz], dir: [-1, 0] });
        break;
      }
      default:
        break;
    }
  });

  // ---- enemy patrols --------------------------------------------------------------------
  // Pods sit on one side of the yard between the obstacles (never on an obstacle column) and
  // march their columns straight across the player's path; the first ones may get a rifle crate.
  const slots = [];
  for (let i = 0; i < p.segments; i++) for (const off of POD_OFFSETS) slots.push(RUNWAY + i * SEGMENT_SPAN + off);
  const nPatrols = Math.min(p.patrols, slots.length);
  const flip = rng() < 0.5 ? 1 : 0;
  for (let k = 0; k < nPatrols; k++) {
    const x = slots[Math.floor(((k + 0.5) * slots.length) / nPatrols)];
    const side = (k + flip) % 2 === 0 ? 0 : d - 1;
    enemySpawners.push({ pos: [x, FLOOR_Y, side], dir: [0, side === 0 ? 1 : -1], count: p.enemyTroops, rate: 6 });
    if (k < p.enemyCrates) {
      crates.push({ kind: 'rifle', pos: [x, FLOOR_Y, side === 0 ? 1 : d - 2], team: 'enemy', capacity: 3 });
    }
  }

  // ---- the keep -------------------------------------------------------------------------
  const kz0 = Math.max(1, mid - 5), kz1 = Math.min(d - 2, mid + 4);
  const kx1 = keepX + KEEP_SPAN - 1;
  fills.push(
    { type: 'stone', from: [keepX, FLOOR_Y, kz0], to: [kx1, WALL_TOP, kz0] },
    { type: 'stone', from: [keepX, FLOOR_Y, kz1], to: [kx1, WALL_TOP, kz1] },
    { type: 'stone', from: [keepX, FLOOR_Y, kz0], to: [keepX, WALL_TOP, kz1] },
    { type: 'stone', from: [kx1, FLOOR_Y, kz0], to: [kx1, WALL_TOP, kz1] },
    { type: 'air', from: [keepX, FLOOR_Y, mid - 1], to: [keepX, FLOOR_Y + 1, mid] }, // the gate
  );
  for (const [cx, cz] of [[keepX, kz0], [kx1, kz0], [keepX, kz1], [kx1, kz1]]) {
    fills.push({ type: 'stone', from: [cx, WALL_TOP + 1, cz], to: [cx, WALL_TOP + 2, cz] }); // parapet corners
  }
  const oz0 = Math.max(kz0 + 1, mid - 2), oz1 = Math.min(kz1 - 1, mid + 1);
  const ox0 = keepX + 8, ox1 = keepX + 10;
  fills.push({ type: 'objective', from: [ox0, FLOOR_Y - 1, oz0], to: [ox1, FLOOR_Y - 1, oz1] });

  // Garrison roster: posts are filled in order, so a small garrison is sentries at the gate and
  // a large one adds wall turrets and grenadiers deeper inside (all inside the keep, off the vault).
  const posts = [
    { type: 'sentry', pos: [keepX + 3, FLOOR_Y, mid] },
    { type: 'turret', pos: [keepX, WALL_TOP + 1, mid - 2] },
    { type: 'grenadier', pos: [keepX + 5, FLOOR_Y, mid + 2] },
    { type: 'sentry', pos: [keepX + 3, FLOOR_Y, mid - 1] },
    { type: 'turret', pos: [keepX, WALL_TOP + 1, mid + 1] },
    { type: 'grenadier', pos: [keepX + 5, FLOOR_Y, mid - 3] },
    { type: 'sentry', pos: [keepX + 7, FLOOR_Y, mid + 2] },
    { type: 'turret', pos: [kx1, WALL_TOP + 1, mid] },
    { type: 'sentry', pos: [keepX + 7, FLOOR_Y, mid - 3] },
    { type: 'grenadier', pos: [keepX + 12, FLOOR_Y, mid + 2] },
    { type: 'sentry', pos: [keepX + 1, FLOOR_Y, mid + 2] },
    { type: 'sentry', pos: [keepX + 1, FLOOR_Y, mid - 3] },
  ];
  const keepGuards = Math.min(p.guards, posts.length);
  for (let i = 0; i < keepGuards; i++) guards.push({ ...posts[i], pos: [...posts[i].pos], dir: [-1, 0] });

  // ---- troops, budget, rules ------------------------------------------------------------
  const nWalls = counts.wall + counts.tallWall + counts.pit;
  const hostiles = guards.length + enemySpawners.length;
  const required = Math.max(3, Math.round(p.troops * (0.3 + 0.03 * p.difficulty)));
  const budget = {
    crates: {
      pickaxe: Math.max(1, Math.ceil(nWalls / 2)),
      ladder: nWalls > 0 ? 1 : 0,
      rifle: hostiles > 0 ? 1 + Math.floor(hostiles / 3) : 0,
    },
    signs: {
      blocker: 2 + enemySpawners.length,
      arrow: 2 * counts.spikes + (p.difficulty < 5 ? 2 : 1),
      fan: 1,
      forward: 1 + counts.spikes,
    },
    roles: { builder: nWalls > 0 ? 2 : 1 },
  };
  const timeLimit = p.difficulty >= 8 ? 240 + 45 * p.segments : 0;
  // Harder sieges also field tougher enemies (everything else keeps the default rules).
  const rules = { enemyTroopHp: 10 + p.difficulty, guardHpScale: 1 + 0.05 * p.difficulty };

  const parts = [];
  for (const k of SEGMENT_KINDS) if (counts[k.kind]) parts.push(plural(counts[k.kind], k.label));
  if (enemySpawners.length) {
    parts.push(`${plural(enemySpawners.length, 'enemy patrol')} of ${p.enemyTroops}` +
      (crates.length ? ` (with ${plural(crates.length, 'rifle crate')})` : ''));
  }
  const description =
    `Get ${required} of ${p.troops} troops into the vault. On the way: ${parts.join(', ') || 'an open yard'}. ` +
    `The keep is held by ${plural(keepGuards, 'guard')}` +
    (timeLimit ? ` and you have ${Math.round(timeLimit / 60)} minutes.` : '.');

  return {
    name: p.name || `Siege #${p.seed} (difficulty ${p.difficulty})`,
    description,
    size: [w, h, d],
    lethalFall: 4,
    timeLimit,
    rules,
    spawn: { pos: [2, FLOOR_Y, mid], dir: [1, 0], count: p.troops, rate: 1.5 },
    objective: { type: 'reach', from: [ox0, FLOOR_Y, oz0], to: [ox1, FLOOR_Y, oz1], required },
    budget,
    guards,
    enemySpawners,
    signs,
    crates,
    fills,
  };
}

/** The generator object (generator.d.ts `Generator`). Registered in ./index.js. */
const siege = Object.freeze({
  id: 'siege',
  label: 'Siege — obstacle corridor and keep',
  description:
    'A straight corridor of difficulty-gated obstacles (dirt walls, trenches, spike fields, turret pillars) ' +
    'crossed by enemy patrols and ending in a garrisoned stone keep that holds the vault. ' +
    'Counts left on auto follow the difficulty and length. The campaign is built with this generator.',
  params: PARAMS,
  autoParams,
  build,
});

export default siege;