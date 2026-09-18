import { mulberry32, plural } from './util.js';

/**
 * "Maze" — a labyrinth generator. A perfect maze (exactly one route between any two cells, no
 * loops) is carved with a recursive backtracker on an n×n grid; every cell is a `corridor`-wide
 * square of floor and the walls between cells are one voxel thick and two voxels high, so the
 * column cannot step over them: it marches to the next wall, turns around and marches back until
 * the player plants arrow signs at the corners. The vault sits in the cell farthest from the pod.
 *
 * The maze carries three kinds of trouble besides its walls:
 *   traps    — dead ends off the route are floored with spikes (or, from difficulty 5, dug out
 *              into two-deep pits): a wrong turn costs troops.
 *   mud      — stretches of the route are floored with mud, which slows the column
 *              (rules.mudSpeed) while turrets and patrols get more shots at it.
 *   patrols  — enemy pods are put on straight stretches of the route together with an enemy arrow
 *              sign at the stretch's near corner: the enemy column marches to the far corner, turns
 *              around at the wall, walks back onto its arrow and is sent up the stretch again, so
 *              it patrols exactly that part of the maze until the player's column runs into it.
 *   guards   — sentries hold corners of the route near the vault, turrets stand on the wall tops
 *              beside the route and look down into the corridors.
 *
 * Only the layout parameters seed the RNG; every count (troops, traps, patrols, guards) takes a
 * prefix of a fixed, seeded ordering, so changing a count never reshuffles the maze.
 */

const FLOOR_Y = 3; // the air cell troops walk in (bedrock at 0, dirt at 1..2)
const WALL_TOP = 4; // walls are two voxels high above the lane: no stepping over
const HEIGHT = 8;
const NEIGHBOURS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export const PARAMS = Object.freeze([
  { key: 'seed', label: 'Seed', type: 'int', min: 0, max: 999999, default: 1, layout: true },
  {
    key: 'cells',
    label: 'Maze size (cells per side)',
    type: 'int',
    min: 4,
    max: 14,
    default: 8,
    layout: true,
  },
  {
    key: 'corridor',
    label: 'Corridor width',
    type: 'int',
    min: 1,
    max: 3,
    default: 2,
    layout: true,
  },
  {
    key: 'difficulty',
    label: 'Difficulty (0–10)',
    type: 'int',
    min: 0,
    max: 10,
    default: 3,
    layout: true,
  },
  {
    key: 'mud',
    label: 'Mud on the route (%)',
    type: 'int',
    min: 0,
    max: 100,
    default: 25,
    layout: true,
    help: "Share of the route's cells floored with mud (troops slow down on it)",
  },
  {
    key: 'name',
    label: 'Name',
    type: 'string',
    default: '',
    help: 'Blank: "Maze #<seed> (difficulty n)"',
  },
  { key: 'troops', label: 'Player troops', type: 'int', min: 5, max: 300, auto: true },
  { key: 'traps', label: 'Trapped dead ends', type: 'int', min: 0, max: 60, auto: true },
  { key: 'patrols', label: 'Enemy patrols', type: 'int', min: 0, max: 20, auto: true },
  { key: 'enemyTroops', label: 'Troops per patrol', type: 'int', min: 1, max: 40, auto: true },
  { key: 'guards', label: 'Guards', type: 'int', min: 0, max: 6, auto: true },
]);

/** Values used for the count parameters left on auto, derived from difficulty and size. */
export function autoParams(p) {
  const d = p.difficulty;
  return {
    troops: 20 + 2 * p.cells,
    traps: Math.round((p.cells * d) / 5),
    patrols: d >= 2 ? 1 + Math.floor(d / 3) : 0,
    enemyTroops: 3 + Math.floor(d / 2),
    guards: d === 0 ? 0 : Math.min(6, 1 + Math.floor(d / 3)),
  };
}

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Recursive-backtracker perfect maze on an n×n grid; returns the adjacency list (cell index -> linked cells). */
function carveMaze(rng, n) {
  const idx = (i, j) => j * n + i;
  const links = Array.from({ length: n * n }, () => []);
  const visited = new Uint8Array(n * n);
  const stack = [0];
  visited[0] = 1;
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const i = cur % n,
      j = Math.floor(cur / n);
    const options = [];
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di,
        nj = j + dj;
      if (ni < 0 || ni >= n || nj < 0 || nj >= n || visited[idx(ni, nj)]) continue;
      options.push(idx(ni, nj));
    }
    if (!options.length) {
      stack.pop();
      continue;
    }
    const next = options[Math.floor(rng() * options.length)];
    visited[next] = 1;
    links[cur].push(next);
    links[next].push(cur);
    stack.push(next);
  }
  return links;
}

/** Breadth-first distances and parents over the maze tree from `from`. */
function bfs(links, from) {
  const total = links.length;
  const dist = new Int32Array(total).fill(-1);
  const parent = new Int32Array(total).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    for (const m of links[k]) {
      if (dist[m] >= 0) continue;
      dist[m] = dist[k] + 1;
      parent[m] = k;
      queue.push(m);
    }
  }
  return { dist, parent };
}

/** Build a level from resolved parameters. Returns an author-style level (the framework normalises it). */
export function build(p) {
  // Only the layout parameters seed the RNG: tweaking a count never reshuffles the maze.
  const rng = mulberry32(
    p.seed * 1000003 + p.cells * 1009 + p.corridor * 101 + p.difficulty * 7 + p.mud
  );
  const n = p.cells,
    cw = p.corridor,
    S = cw + 1;
  const w = n * S + 1,
    h = HEIGHT,
    d = w;
  const half = Math.floor((cw - 1) / 2);
  const idx = (i, j) => j * n + i;
  const at = (k) => [k % n, Math.floor(k / n)];
  const lo = (i) => i * S + 1,
    hi = (i) => i * S + cw; // corridor voxels of maze cell i along one axis
  const centre = (k) => {
    const [i, j] = at(k);
    return [lo(i) + half, FLOOR_Y, lo(j) + half];
  };
  const key = (pos) => pos.join(',');

  // ---- the maze and its solution -----------------------------------------------------------
  const links = carveMaze(rng, n);
  const start = idx(0, Math.floor(n / 2));
  const { dist, parent } = bfs(links, start);
  let end = start;
  for (let k = 0; k < n * n; k++) if (dist[k] > dist[end]) end = k; // the vault goes where the walk is longest
  const path = [];
  for (let k = end; k >= 0; k = parent[k]) path.push(k);
  path.reverse();
  const L = path.length;
  const steps = path.slice(1).map((k, t) => {
    const [ai, aj] = at(path[t]);
    const [bi, bj] = at(k);
    return [bi - ai, bj - aj];
  });
  let turns = 0;
  for (let t = 1; t < steps.length; t++)
    if (steps[t][0] !== steps[t - 1][0] || steps[t][1] !== steps[t - 1][1]) turns++;
  const onPath = new Uint8Array(n * n);
  for (const k of path) onPath[k] = 1;

  // ---- terrain: floor, a solid slab of wall, then the cells and passages carved out of it ------
  const wallType = p.difficulty >= 4 ? 'stone' : 'dirt'; // soft walls: a pickaxe can shortcut
  const fills = [
    { type: 'bedrock', from: [0, 0, 0], to: [w - 1, 0, d - 1] },
    { type: 'dirt', from: [0, 1, 0], to: [w - 1, FLOOR_Y - 1, d - 1] },
    { type: wallType, from: [0, FLOOR_Y, 0], to: [w - 1, WALL_TOP, d - 1] },
  ];
  for (let k = 0; k < n * n; k++) {
    const [i, j] = at(k);
    fills.push({ type: 'air', from: [lo(i), FLOOR_Y, lo(j)], to: [hi(i), WALL_TOP, hi(j)] });
    for (const m of links[k]) {
      if (m < k) continue; // each passage once
      const [mi] = at(m);
      if (mi === i + 1)
        fills.push({
          type: 'air',
          from: [hi(i) + 1, FLOOR_Y, lo(j)],
          to: [hi(i) + 1, WALL_TOP, hi(j)],
        });
      else
        fills.push({
          type: 'air',
          from: [lo(i), FLOOR_Y, hi(j) + 1],
          to: [hi(i), WALL_TOP, hi(j) + 1],
        });
    }
  }

  // ---- traps in dead ends off the route ----------------------------------------------------
  const deadEnds = shuffle(
    rng,
    [...links.keys()].filter((k) => links[k].length === 1 && k !== start && k !== end && !onPath[k])
  );
  const kinds = deadEnds.map(() => (p.difficulty >= 5 && rng() < 0.4 ? 'pit' : 'spikes'));
  const trapped = deadEnds.slice(0, p.traps).map((k, t) => ({ k, kind: kinds[t] }));
  for (const { k, kind } of trapped) {
    const [i, j] = at(k);
    if (kind === 'pit')
      fills.push({ type: 'air', from: [lo(i), 1, lo(j)], to: [hi(i), FLOOR_Y - 1, hi(j)] });
    else
      fills.push({
        type: 'spikes',
        from: [lo(i), FLOOR_Y - 1, lo(j)],
        to: [hi(i), FLOOR_Y - 1, hi(j)],
      });
  }
  const nPits = trapped.filter((t) => t.kind === 'pit').length;

  // ---- mud on the route -------------------------------------------------------------------
  let mudCells = 0;
  for (let t = 1; t < L - 1; t++) {
    if (rng() * 100 >= p.mud) continue;
    const [i, j] = at(path[t]);
    fills.push({ type: 'mud', from: [lo(i), FLOOR_Y - 1, lo(j)], to: [hi(i), FLOOR_Y - 1, hi(j)] });
    mudCells++;
  }

  // ---- the vault -----------------------------------------------------------------------------
  const [ei, ej] = at(end);
  fills.push({
    type: 'objective',
    from: [lo(ei), FLOOR_Y - 1, lo(ej)],
    to: [hi(ei), FLOOR_Y - 1, hi(ej)],
  });

  // ---- enemy patrols programmed into straight stretches of the route -------------------------
  const occupied = new Set([key(centre(start))]);
  const patrolled = new Uint8Array(n * n);
  const enemySpawners = [],
    signs = [];
  const segments = []; // maximal runs of the route in one direction: path[a] .. path[b]
  for (let a = 0, t = 1; t <= steps.length; t++) {
    if (t === steps.length || steps[t][0] !== steps[a][0] || steps[t][1] !== steps[a][1]) {
      segments.push({ a, b: t, dir: steps[a] });
      a = t;
    }
  }
  let lastB = -1;
  for (const seg of segments) {
    if (enemySpawners.length >= p.patrols) break;
    // Off the pod, off the vault approach, and never sharing a corner with the previous patrol.
    if (seg.a <= lastB || seg.a < 1 || seg.b > L - 3) continue;
    const [bi, bj] = at(path[seg.b]);
    const si = bi + seg.dir[0],
      sj = bj + seg.dir[1];
    // A branch running straight on past the corner would carry the column away instead of turning it.
    if (si >= 0 && si < n && sj >= 0 && sj < n && links[path[seg.b]].includes(idx(si, sj)))
      continue;
    const c0 = centre(path[seg.a]);
    const pod = [c0[0] + seg.dir[0], FLOOR_Y, c0[2] + seg.dir[1]];
    signs.push({ kind: 'arrow', pos: c0, dir: [...seg.dir], team: 'enemy' });
    enemySpawners.push({ pos: pod, dir: [...seg.dir], count: p.enemyTroops, rate: 5 });
    occupied.add(key(c0));
    occupied.add(key(pod));
    for (let t = seg.a; t <= seg.b; t++) patrolled[path[t]] = 1;
    lastB = seg.b;
  }

  // ---- guards: a fixed roster of posts along the route, filled in order ----------------------
  const facingBack = (t) => (t > 0 ? [-steps[t - 1][0], -steps[t - 1][1]] : [-1, 0]);
  const floorPost = (type, t) => {
    if (t <= 0 || t >= L - 1 || patrolled[path[t]]) return null; // never in the pod, the vault or a patrol lane
    return { type, pos: centre(path[t]), dir: facingBack(t) };
  };
  const wallPost = (t) => {
    // A turret on top of a wall of a route cell, on a side without a passage.
    const k = path[Math.max(0, Math.min(L - 1, t))];
    const [i, j] = at(k);
    const c = centre(k);
    for (const [di, dj] of NEIGHBOURS) {
      const ni = i + di,
        nj = j + dj;
      if (ni >= 0 && ni < n && nj >= 0 && nj < n && links[k].includes(idx(ni, nj))) continue;
      const x = di === 0 ? c[0] : di > 0 ? hi(i) + 1 : lo(i) - 1;
      const z = dj === 0 ? c[2] : dj > 0 ? hi(j) + 1 : lo(j) - 1;
      return { type: 'turret', pos: [x, WALL_TOP + 1, z], dir: [-di, -dj] };
    }
    return null;
  };
  const posts = [
    floorPost('sentry', L - 2),
    wallPost(L - 3),
    floorPost('sentry', Math.floor(L / 2)),
    wallPost(Math.floor(L / 3)),
    floorPost('grenadier', Math.floor((2 * L) / 3)),
    wallPost(Math.floor((2 * L) / 3)),
  ];
  const guards = [];
  for (const post of posts) {
    if (guards.length >= p.guards) break;
    if (!post || occupied.has(key(post.pos))) continue;
    occupied.add(key(post.pos));
    guards.push(post);
  }

  // ---- crates, budget, rules ----------------------------------------------------------------
  const hostiles = guards.length + enemySpawners.length;
  const crates = [];
  if (hostiles > 0 && L > 2) {
    const c = centre(path[1]); // a rifle crate on the first stretch: the column arms itself on the way
    if (!occupied.has(key(c))) {
      occupied.add(key(c));
      crates.push({ kind: 'rifle', pos: c, team: 'player', capacity: 5 });
    }
  }
  const required = Math.max(3, Math.round(p.troops * (0.3 + 0.03 * p.difficulty)));
  const budget = {
    crates: {
      rifle: hostiles > 0 ? 1 + Math.floor(hostiles / 3) : 0,
      medic: hostiles >= 3 ? 1 : 0,
      pickaxe: wallType === 'dirt' || nPits > 0 ? 1 : 0, // shortcuts through soft walls / out of a pit
      ladder: nPits > 0 ? 1 : 0,
      armor: p.difficulty >= 6 ? 1 : 0,
    },
    signs: {
      arrow: turns + 2, // one per corner of the route, plus slack
      blocker: 2 + enemySpawners.length,
      forward: 1 + Math.floor(turns / 3),
      fan: 1,
    },
    roles: { builder: 1 },
  };
  const timeLimit = p.difficulty >= 8 ? 90 + 15 * L : 0;
  const rules = {
    enemyTroopHp: 10 + p.difficulty,
    guardHpScale: 1 + 0.05 * p.difficulty,
    enemyTroopSpeed: p.difficulty >= 6 ? 3 : 2.5, // hard patrols move faster than the column
  };

  const parts = [];
  if (trapped.length) {
    parts.push(
      `${plural(trapped.length, 'trapped dead end')} (${plural(trapped.length - nPits, 'spike bed')}` +
        (nPits ? `, ${plural(nPits, 'pit')})` : ')')
    );
  }
  if (mudCells) parts.push(`mud on ${plural(mudCells, 'cell')} of the route`);
  if (enemySpawners.length)
    parts.push(`${plural(enemySpawners.length, 'enemy patrol')} of ${p.enemyTroops}`);
  parts.push(plural(guards.length, 'guard'));
  const description =
    `Steer the column through a ${n}×${n} maze of ${wallType} walls — the route takes ${plural(turns, 'turn')}. ` +
    `Inside: ${parts.join(', ')}. Get ${required} of ${p.troops} troops into the vault in the far corner` +
    (timeLimit ? ` within ${Math.round(timeLimit / 60)} minutes.` : '.');

  return {
    name: p.name || `Maze #${p.seed} (difficulty ${p.difficulty})`,
    description,
    size: [w, h, d],
    lethalFall: 4,
    timeLimit,
    rules,
    spawn: {
      pos: centre(start),
      dir: steps[0] ? [...steps[0]] : [1, 0],
      count: p.troops,
      rate: 1.5,
    },
    objective: {
      type: 'reach',
      from: [lo(ei), FLOOR_Y, lo(ej)],
      to: [hi(ei), FLOOR_Y, hi(ej)],
      required,
    },
    budget,
    guards,
    enemySpawners,
    signs,
    crates,
    fills,
  };
}

/** The generator object (generator.d.ts `Generator`). Registered in ./index.js. */
const maze = Object.freeze({
  id: 'maze',
  label: 'Maze — labyrinth with traps, mud and patrols',
  description:
    'A perfect maze of two-high walls: the column has to be steered corner by corner with arrow signs. ' +
    'Dead ends hide spike beds and pits, mud slows the route, enemy patrols march up and down straight ' +
    'stretches guided by their own arrow signs, and sentries and wall turrets hold the approach to the vault.',
  params: PARAMS,
  autoParams,
  build,
});

export default maze;
