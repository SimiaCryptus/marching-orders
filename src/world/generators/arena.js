import { mulberry32, randInt, plural } from './util.js';

/**
 * "Arena" — a second, deliberately small generator. It exists to show that the generator
 * library is pluggable and to exercise the non-numeric parameter types (`select`, `boolean`)
 * in the designer. A square yard with scattered dirt cover, an optional hazard type and a
 * three-sided stone vault on the far side ringed by guards.
 */

const FLOOR_Y = 3;   // the air cell troops walk in (bedrock at 0, dirt at 1..2)
const HEIGHT = 12;

export const PARAMS = Object.freeze([
  { key: 'seed', label: 'Seed', type: 'int', min: 0, max: 999999, default: 1, layout: true },
  { key: 'size', label: 'Yard size', type: 'int', min: 16, max: 64, default: 28, layout: true },
  { key: 'cover', label: 'Cover density (%)', type: 'int', min: 0, max: 60, default: 15, layout: true,
    help: 'Share of the yard covered by dirt blocks' },
  { key: 'hazard', label: 'Hazard', type: 'select', default: 'none', layout: true,
    options: [{ value: 'none', label: 'None' }, { value: 'spikes', label: 'Spike patches' }, { value: 'pits', label: 'Pits' }] },
  { key: 'rifles', label: 'Hand out a rifle crate', type: 'boolean', default: true },
  { key: 'troops', label: 'Player troops', type: 'int', min: 5, max: 200, auto: true },
  { key: 'guards', label: 'Vault guards', type: 'int', min: 0, max: 8, auto: true },
]);

const HAZARDS = ['none', 'spikes', 'pits'];

export function autoParams(p) {
  return {
    troops: 16 + Math.floor(p.size / 2),
    guards: 1 + Math.floor(p.cover / 20) + (p.hazard !== 'none' ? 1 : 0),
  };
}

export function build(p) {
  const rng = mulberry32(p.seed * 7919 + p.size * 131 + p.cover * 17 + HAZARDS.indexOf(p.hazard));
  const s = p.size, mid = Math.floor(s / 2);
  const fills = [
    { type: 'bedrock', from: [0, 0, 0], to: [s - 1, 0, s - 1] },
    { type: 'dirt', from: [0, 1, 0], to: [s - 1, FLOOR_Y - 1, s - 1] },
  ];

  // ---- the vault: a 3x3 objective floor near the east edge, stone on three sides -----------
  const vx0 = s - 6, vx1 = s - 4, vz0 = mid - 1, vz1 = mid + 1;
  fills.push(
    { type: 'objective', from: [vx0, FLOOR_Y - 1, vz0], to: [vx1, FLOOR_Y - 1, vz1] },
    { type: 'stone', from: [vx1 + 1, FLOOR_Y, vz0 - 1], to: [vx1 + 1, FLOOR_Y + 2, vz1 + 1] }, // back
    { type: 'stone', from: [vx0 - 1, FLOOR_Y, vz0 - 1], to: [vx1 + 1, FLOOR_Y + 2, vz0 - 1] }, // north
    { type: 'stone', from: [vx0 - 1, FLOOR_Y, vz1 + 1], to: [vx1 + 1, FLOOR_Y + 2, vz1 + 1] }, // south
  );

  // ---- cover: dirt blocks (one or two high) scattered over the open yard --------------------
  const x0 = 5, x1 = vx0 - 3;                       // leave the pod's run-up and the vault approach clear
  const yard = (x1 - x0 + 1) * (s - 2);
  const nCover = Math.round((yard * p.cover) / 100 / 3);
  for (let i = 0; i < nCover; i++) {
    const x = randInt(rng, x0, x1), z = randInt(rng, 1, s - 2);
    fills.push({ type: 'dirt', from: [x, FLOOR_Y, z], to: [x, FLOOR_Y + (rng() < 0.3 ? 1 : 0), z] });
  }

  // ---- hazards: 2x2 patches replacing the top soil, never on the last stretch to the vault ---
  const nHazards = p.hazard === 'none' ? 0 : 2 + Math.floor(s / 12);
  for (let i = 0; i < nHazards; i++) {
    const x = randInt(rng, x0 + 1, x1 - 2), z = randInt(rng, 1, s - 3);
    if (p.hazard === 'spikes') fills.push({ type: 'spikes', from: [x, FLOOR_Y - 1, z], to: [x + 1, FLOOR_Y - 1, z + 1] });
    else fills.push({ type: 'air', from: [x, 1, z], to: [x + 1, FLOOR_Y - 1, z + 1] });
  }

  // ---- guards around the vault mouth, filled in roster order --------------------------------
  const posts = [
    { type: 'sentry', pos: [vx0 - 2, FLOOR_Y, mid] },
    { type: 'sentry', pos: [vx0 - 2, FLOOR_Y, mid - 3] },
    { type: 'sentry', pos: [vx0 - 2, FLOOR_Y, mid + 3] },
    { type: 'turret', pos: [vx1 + 1, FLOOR_Y + 3, mid] },
    { type: 'grenadier', pos: [vx0 - 4, FLOOR_Y, mid - 2] },
    { type: 'grenadier', pos: [vx0 - 4, FLOOR_Y, mid + 2] },
    { type: 'turret', pos: [vx0 - 1, FLOOR_Y + 3, vz0 - 1] },
    { type: 'turret', pos: [vx0 - 1, FLOOR_Y + 3, vz1 + 1] },
  ];
  const guards = posts.slice(0, Math.min(p.guards, posts.length)).map((g) => ({ ...g, pos: [...g.pos], dir: [-1, 0] }));

  // ---- troops and budget --------------------------------------------------------------------
  const required = Math.max(2, Math.round(p.troops * 0.35));
  const budget = {
    crates: {
      pickaxe: p.cover > 25 ? 2 : 1,
      ladder: p.hazard === 'pits' ? 2 : 1,
      rifle: p.rifles ? 1 + Math.floor(guards.length / 3) : 0,
    },
    signs: { blocker: 1, arrow: 2 + (nHazards ? 2 : 0), fan: 1, forward: 1 },
    roles: { builder: 1 },
  };
  const hazardText = nHazards ? `, ${plural(nHazards, p.hazard === 'spikes' ? 'spike patch' : 'pit')}` : '';
  const description =
    `Get ${required} of ${p.troops} troops across the yard into the vault. ` +
    `${plural(nCover, 'block')} of cover${hazardText}; the vault is held by ${plural(guards.length, 'guard')}.`;

  return {
    name: `Arena #${p.seed}`,
    description,
    size: [s, HEIGHT, s],
    lethalFall: 4,
    timeLimit: 0,
    spawn: { pos: [2, FLOOR_Y, mid], dir: [1, 0], count: p.troops, rate: 1.5 },
    objective: { type: 'reach', from: [vx0, FLOOR_Y, vz0], to: [vx1, FLOOR_Y, vz1], required },
    budget,
    guards,
    enemySpawners: [],
    signs: [],
    crates: [],
    fills,
  };
}

const arena = Object.freeze({
  id: 'arena',
  label: 'Arena — open yard',
  description:
    'A square yard with scattered dirt cover, an optional hazard (spike patches or pits) and a ' +
    'three-sided stone vault on the far side guarded from a fixed roster of posts.',
  params: PARAMS,
  autoParams,
  build,
});

export default arena;