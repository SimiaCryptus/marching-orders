# Level generators

Levels can be hand-authored (JSON, see `src/world/level.d.ts`) or produced by a **generator**: a
small module that turns a handful of parameters into a level. Generators are pluggable — the
game, the designer's _Generate_ tab and the campaign only talk to the framework in
`src/world/level-builder.js`, never to a particular generator.

```
src/world/
  level-builder.js          framework: registry lookup, parameter normalisation, buildLevel(), campaign
  generators/
    index.js                the manifest — one dictionary entry per generator
    generator.d.ts          the TypeScript contract described below
    util.js                 shared helpers (seeded RNG, clampInt, plural, …)
    siege.js                reference implementation (the campaign's generator)
    arena.js                small second generator; shows select / boolean parameters
    maze.js                 labyrinth: perfect maze, trapped dead ends, mud, programmed enemy patrols
docs/generators.md          this document
```

What the framework does for you:

- **Registry** — `getGenerator(id)`, `listGenerators()`; validates each generator object once
  against the contract and throws a readable error if it is off.
- **Parameters** — `normalizeParams(gen, raw)` coerces and clamps every declared parameter from
  whatever the caller passed (form strings, JSON, nothing); `resolveParams(gen, raw)` additionally
  fills in _auto_ values through the generator's `autoParams()`.
- **Building** — `buildLevel(gen, raw)` resolves the parameters, calls `build()`, runs the
  result through `normalizeLevel()` (defaults, clamping, validation) and stamps
  `level.generator = { id, ...storedParams }` so a level remembers how it was made.
- **UI** — the designer renders a form from `params` automatically: number inputs with min/max,
  checkboxes, drop-downs and text fields; auto parameters show their derived value with an
  "(auto)" label until the user types a value; _Random seed_ targets a parameter with the key
  `seed`; _Auto values_ hands every auto parameter back to the generator. Opening a generated
  level selects its generator and restores its parameters.

## The contract

The authoritative version is `src/world/generators/generator.d.ts`; the essentials:

```ts
export type ParamType = 'int' | 'number' | 'boolean' | 'select' | 'string';
export type ParamValue = number | string | boolean;

interface ParamBase {
  key: string; // property name; unique per generator; `id` is reserved
  label: string; // form label
  help?: string; // tooltip
  layout?: boolean; // changes the terrain (seed your RNG from these only)
  auto?: boolean; // may be left blank -> null -> autoParams() decides at build time
}
export interface NumberParam extends ParamBase {
  type: 'int' | 'number';
  min?: number;
  max?: number;
  step?: number;
  default?: number;
}
export interface BooleanParam extends ParamBase {
  type: 'boolean';
  default?: boolean;
}
export interface SelectParam extends ParamBase {
  type: 'select';
  options: ReadonlyArray<{ value: string; label?: string }>;
  default?: string;
}
export interface StringParam extends ParamBase {
  type: 'string';
  default?: string;
}
export type ParamDef = NumberParam | BooleanParam | SelectParam | StringParam;

export type StoredParams = Record<string, ParamValue | null>; // what a level remembers; auto = null
export type ResolvedParams = Record<string, ParamValue>; // what build() receives

export interface BuildContext {
  generator: Generator;
  stored: StoredParams;
}

export interface Generator {
  readonly id: string; // stable lower-case slug, e.g. 'siege'
  readonly label: string; // drop-down text
  readonly description: string; // one or two sentences under the drop-down
  readonly params: ReadonlyArray<ParamDef>; // schema, in display order
  autoParams?(params: StoredParams): Partial<ResolvedParams>; // required if any param is auto
  build(params: ResolvedParams, ctx: BuildContext): LevelInput | Level;
}
```

Rules of the road:

| Rule                                                                                     | Why                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` is a stable slug (`/^[a-z][a-z0-9-]*$/`) and equals the manifest key.               | It is stored in every level the generator makes (`level.generator.id`). Renaming it orphans those levels (they fall back to the default generator's form).     |
| `build()` must be **deterministic** for equal parameters.                                | Shared play links, the campaign and "same seed, same level" depend on it. Use `mulberry32()` from `util.js`; never `Math.random()`.                            |
| Seed the RNG from the `layout: true` parameters only.                                    | Then tweaking a count (troops, guards…) never reshuffles the terrain.                                                                                          |
| `build()` may return an author-style `LevelInput`.                                       | The framework runs `normalizeLevel()`: it fills defaults, clamps ranges and validates. Only `size`, `spawn.pos` and `objective.from/to` are strictly required. |
| Throw an `Error` with a readable message when the parameters cannot yield a valid level. | The designer shows it in the status line instead of loading a broken level.                                                                                    |
| Every `auto` parameter must get a value from `autoParams()`.                             | Missing values fall back to `default`/`min`, which is rarely what you want.                                                                                    |
| Do not touch `level.generator` yourself.                                                 | The framework sets it to `{ id, ...storedParams }`.                                                                                                            |
| Hand out a budget that solves the level you built.                                       | Count the obstacles and hostiles you actually placed and derive `budget` from them (see how `siege.js` does it).                                               |

Voxel names accepted in `fills[].type` and the meaning of every level field are documented in
`src/world/level.d.ts`.

## Adding a generator

1. **Create one file** in `src/world/generators/`, e.g. `caves.js`, that default-exports a
   generator object:

   ```js
   import { mulberry32, randInt, plural } from './util.js';

   const FLOOR_Y = 3;

   const PARAMS = Object.freeze([
     { key: 'seed', label: 'Seed', type: 'int', min: 0, max: 999999, default: 1, layout: true },
     {
       key: 'length',
       label: 'Tunnel length',
       type: 'int',
       min: 20,
       max: 120,
       default: 48,
       layout: true,
     },
     { key: 'twisty', label: 'Twisty tunnels', type: 'boolean', default: true, layout: true },
     {
       key: 'lighting',
       label: 'Lighting',
       type: 'select',
       default: 'dim',
       options: [
         { value: 'dim', label: 'Dim' },
         { value: 'dark', label: 'Dark' },
       ],
     },
     { key: 'troops', label: 'Player troops', type: 'int', min: 5, max: 200, auto: true },
   ]);

   function autoParams(p) {
     return { troops: 20 + Math.floor(p.length / 4) };
   }

   function build(p) {
     const rng = mulberry32(p.seed * 7919 + p.length * 13 + (p.twisty ? 1 : 0)); // layout params only
     const w = p.length,
       h = 12,
       d = 16,
       mid = 8;
     const fills = [
       { type: 'bedrock', from: [0, 0, 0], to: [w - 1, 0, d - 1] },
       { type: 'dirt', from: [0, 1, 0], to: [w - 1, FLOOR_Y - 1, d - 1] },
     ];
     // ... carve tunnels with rng(), place guards, crates, signs ...
     const required = Math.max(2, Math.round(p.troops * 0.3));
     return {
       name: `Caves #${p.seed}`,
       description: `Get ${required} of ${p.troops} troops through the tunnels.`,
       size: [w, h, d],
       spawn: { pos: [2, FLOOR_Y, mid], dir: [1, 0], count: p.troops, rate: 1.5 },
       objective: {
         type: 'reach',
         from: [w - 5, FLOOR_Y, mid - 1],
         to: [w - 3, FLOOR_Y, mid + 1],
         required,
       },
       budget: { crates: { pickaxe: 2 }, signs: { arrow: 2, blocker: 1 }, roles: { builder: 1 } },
       fills,
     };
   }

   export default Object.freeze({
     id: 'caves',
     label: 'Caves — dug tunnels',
     description: 'Winding dirt tunnels the column has to dig and steer through.',
     params: PARAMS,
     autoParams,
     build,
   });
   ```

2. **Register it** in `src/world/generators/index.js` — one import and one entry in the
   dictionary (the key must equal the generator's `id`):

   ```js
   import caves from './caves.js';

   export const GENERATORS = Object.freeze({
     siege,
     arena,
     maze,
     caves, // <- the new line
   });
   ```

3. **Try it**: press `E` in the game, open the _Generate_ tab, pick the generator from the
   drop-down. Its parameter form is built from `params`; _Generate_ builds and loads it, _Play_
   starts it. Errors thrown by `build()` or by `normalizeLevel()` appear in the status line.

That is all — no changes to the designer, the loader, `main.js` or the campaign are needed.

## Using generators from code

```js
import {
  buildLevel,
  getGenerator,
  listGenerators,
  normalizeParams,
  resolveParams,
} from './src/world/level-builder.js';

listGenerators().map((g) => g.id); // ['siege', 'arena', ...]
const gen = getGenerator('siege'); // throws on unknown ids
normalizeParams(gen, { difficulty: '7' }); // { seed: 1, difficulty: 7, ..., troops: null, ... }
resolveParams(gen, { difficulty: 7 }); // auto values filled in via gen.autoParams()
const level = buildLevel('siege', { seed: 42, difficulty: 7 });
level.generator; // { id: 'siege', seed: 42, difficulty: 7, ..., troops: null }
buildLevel(level.generator.id, level.generator); // rebuilds the identical level
```

`buildParametricLevel(params)` is kept as a thin wrapper that reads the generator from
`params.id` (default `'siege'`). The campaign (`buildCampaignLevel`) is a fixed parameter
progression of the `siege` generator; see `CAMPAIGN_GENERATOR` in `level-builder.js`.

## Checklist before merging a generator

- [ ] `id` is a slug, equals the manifest key, and is not going to change.
- [ ] Every parameter has a unique `key` (not `id`), a `label` and a supported `type`;
      `select` parameters have `options`; `auto` parameters are all covered by `autoParams()`.
- [ ] `build()` uses `mulberry32()` seeded from the layout parameters — no `Math.random()`, no
      `Date`, no dependence on call order outside `build()`.
- [ ] Generating twice with the same parameters gives byte-identical `stringifyLevel()` output.
- [ ] Extreme parameter values (all at `min`, all at `max`) either produce a valid level or throw
      a readable `Error`; `spawn.pos` and the objective cells are inside `size` and supported.
- [ ] The budget is derived from what was placed, so the level is solvable with the tools it
      hands out.
- [ ] `description` tells the player what to expect (it is shown when the level starts).
