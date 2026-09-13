# Level Builder Guide

How to author a level for this game — by hand, from the editor, or from an automated
(agentic) generator. It documents the JSON model, every validation rule, the simulation rules
a level must respect to be *solvable*, and a verification procedure you should run before
emitting a level.

The machine-readable schema lives in [`src/world/level.d.ts`](../src/world/level.d.ts).
The authoritative implementation lives in
[`src/world/level-loader.js`](../src/world/level-loader.js) (validation) and
[`src/world/level-builder.js`](../src/world/level-builder.js) (a worked, parametric example).

---

## 1. Pipeline

```
JSON text ──parseLevel/loadLevel──▶ normalizeLevel(raw) ──▶ Level object
                                                              │
                                              buildWorld(level) ──▶ World (voxel grid)
                                                              │
                                                   simulation: pod → troops → objective
```

* `normalizeLevel` **deep-clones** the input, throws on structural errors, and fills in every
  default. Anything it does not recognise is dropped silently (bad guards, unknown sign kinds,
  crates with unknown equipment…), so *silence is not success* — verify your output.
* `buildWorld` paints the voxel grid: first `voxels.rle`, then each entry of `fills` in order.
* `exportLevel(level, world)` converts a world back to `voxels.rle` and deletes `fills`.
* `encodeLevelHash` / `decodeLevelHash` base64url a whole level into the URL hash for sharing.

---

## 2. Coordinate system and conventions

* `size = [w, h, d]` → x ∈ [0, w-1] (width/east), y ∈ [0, h-1] (height/up), z ∈ [0, d-1]
  (depth/south). Each between 1 and 256; volume `w*h*d` should stay under ~200 000 cells for
  comfortable rendering.
* **Units occupy air cells.** A troop standing "on the floor" is in the *air* cell whose
  neighbour below is solid. If the floor's top voxel is `y = 2`, troops walk at `y = 3`.
* Directions are `[dx, dz]` pairs, axis aligned and non-zero:
  `[1,0]` east (+x), `[0,1]` south (+z), `[-1,0]` west (−x), `[0,-1]` north (−z).
  Internally these become `DIRS` indices 0..3 (clockwise from +x).
* **The level edge is an unbreakable wall.** Units never step, climb, ladder or fan out of
  bounds; they turn around instead. You do not need a wall of voxels around the map.
* Recommended house layout (used by the parametric builder):

  | y | content |
  |---|---------|
  | 0 | `bedrock` floor |
  | 1–2 | `dirt` sub-floor |
  | 3 | **`FLOOR_Y`** — the air lane troops walk in |
  | 3..9 | walls, obstacles, keep |
  | 10..11 | parapets, turret posts |

---

## 3. Field reference

Required fields are marked **R**. Everything else has a default.

| Field | Type | Default / rule |
|---|---|---|
| `name` | string | `"Untitled Level"` if missing/blank |
| `description` | string | `""` — shown in the briefing; say what the obstacles are and what the tools are for |
| **R** `size` | `[w,h,d]` ints | each 1..256, else throws |
| **R** `spawn.pos` | `[x,y,z]` ints | throws if absent/malformed |
| `spawn.dir` | facing | `[1,0]`; a zero vector is replaced by the default |
| `spawn.count` | int > 0 | `20` |
| `spawn.rate` | number > 0 | `1.5` — **seconds between drops** (20 troops at 1.5 = 30 s of column) |
| **R** `objective.from` / `.to` | `[x,y,z]` ints | throws if absent; corners are sorted per axis, so any two opposite corners work |
| `objective.type` | `'reach'` | `'reach'`; anything else throws |
| `objective.required` | int > 0 | `1`; must be ≤ `spawn.count` to be winnable |
| `lethalFall` | int > 0 | `4` — a fall of **exactly** this many cells survives, one more kills |
| `timeLimit` | number ≥ 0 | `0` = unlimited (seconds) |
| `rules` | object | see §8; each key clamped to its range, missing keys use the default |
| `budget.crates` | `{kind: n}` | `{}` |
| `budget.signs` | `{kind: n}` | `{}`; legacy kinds folded, non-finite values and unknown kinds dropped, counts rounded and clamped to ≥ 0 |
| `budget.roles` | `{builder: n}` | `{}` |
| `guards[]` | array | non-array → `[]`; entries without a valid `pos` are dropped |
| `enemySpawners[]` | array | as above; `dir` defaults to the reverse of `spawn.dir` |
| `signs[]` | array | entries need a valid `pos` **and** a known `kind`, else dropped |
| `crates[]` | array | entries need a valid `pos` **and** a known equipment `kind`, else dropped |
| `voxels` | `{rle:[[id,n],…]}` | if present, `voxels.rle` must be an array or it throws |
| `fills` | `Fill[]` | if present must be an array or it throws |
| `generator`, `campaign` | metadata | passed through untouched |

### Errors thrown by `normalizeLevel` (exact strings)

```
Level must be a JSON object
"size" must be [width, height, depth] integers between 1 and 256
"spawn.pos" must be [x, y, z]
"objective" needs "from" and "to" cells
Unsupported objective type "<t>" (the MVP supports "reach")
"voxels.rle" must be an array of [type, count] pairs
"fills" must be an array
```

`buildWorld` adds:

```
Malformed run in "voxels.rle"
Unknown voxel type id <n> in "voxels.rle"
Unknown voxel type "<name>" in level "<level name>"
```

---

## 4. Terrain

### `fills` (preferred for hand-authored and generated levels)

```json
{ "type": "dirt", "from": [0, 1, 0], "to": [31, 2, 11] }
```

* Inclusive boxes, corners in any order, painted **in array order** after the RLE blob, so a
  later `"air"` fill carves openings (gates, tunnels, trenches) out of earlier solids.
* Readable and diffable — a generator should emit `fills`, never RLE.

### `voxels.rle` (editor export only)

Runs of `[voxelId, count]` over a linear scan of `World.data`. The index layout is an
implementation detail; produce it only via `encodeWorld()` / `exportLevel()`. Unknown ids
throw. Runs that overflow the array are clipped; a short list leaves the tail as air.

### Voxel palette

| name | solid | diggable | climbable | lethal | use |
|---|---|---|---|---|---|
| `air` | – | – | – | – | empty space, carving |
| `bedrock` | ✔ | ✘ | – | – | map floor, permanent structure |
| `dirt` | ✔ | ✔ | – | – | the soft obstacle material (pickaxe target) |
| `stone` | ✔ | ✘ | – | – | keeps, pillars, anything that must force a detour |
| `plank` | ✔ | (soft) | – | – | placed by the Builder role |
| `ladder` | – | – | ✔ | – | climbable, counts as support |
| `spikes` | ✔ | – | – | ✔ | kills a troop that arrives in the cell above it |
| `mud` | ✔ | ✔ | – | – | slow floor: a step onto a mud-floored cell takes `speed × rules.mudSpeed` (default ½) |
| `objective` | ✔ | – | – | – | vault-floor marker under the objective volume |

The canonical list and the predicates (`isSolid`, `isDiggable`, `isClimbable`, `isLethal`) are
in `src/world/voxel.js` — check there before using a name not in this table.

---

## 5. Movement rules the terrain must respect

Everything a troop does when it reaches a cell centre is decided by `nextStep()`
(`src/units/pathing.js`). A level is only solvable if its geometry is compatible with these:

1. **Support.** A unit in air cell `(x,y,z)` is supported by a solid at `(x,y-1,z)` *or* by a
   ladder in its own cell. Otherwise it **falls** one cell per tick (7 cells/s).
2. **Out of bounds ahead → turn around.**
3. **Solid ahead at head-of-foot level `y`:**
   * `(tx,y+1,tz)` free (and `y+1 < h`) → **stepUp** (1-voxel ledges are climbed for free).
   * else ladder at `(x,y+1,z)` → **climb**.
   * else the troop has ladder charges and `(x,y+1,z)` is air → **ladder** (0.7 s per segment;
     also fills its own cell so the column can follow it up).
   * else it has a pickaxe and the block ahead is diggable → **dig** (0.6 s per voxel).
   * else → **turn around**.
4. **Air ahead:** walk if `(tx,y-1,tz)` is solid; **stepDown** if `(tx,y-2,tz)` is solid;
   otherwise, if the troop carries a bridge kit and `(tx,y-1,tz)` is air, it lays a plank there
   (**bridge**, 0.5 s per plank) and walks on; otherwise it walks off the ledge and gravity takes over.
5. **Falling.** `fallDistance` counts cells; `fallDistance > lethalFall` kills on landing.
   Landing on a cell whose block below is lethal (spikes) always kills.
6. **Blocked cells.** A troop will not step into a cell occupied by a hostile guard, nor onto
   a `blocker` sign of its own team — it turns around.
7. **Mud.** A step onto a cell whose floor voxel is `mud` is taken at `speed × rules.mudSpeed`
   (both teams). Mud never blocks; it buys turrets and patrols time.
8. **On arrival**, in this order: hazard check → objective check (player troops only, →
   `SAVED`) → crate pickup → sign effects (skipped while a role is running).

### Consequences for authoring

* **A 1-high step is not an obstacle.** Walls must be ≥ 2 voxels above the walking lane.
* A 2-high `dirt` wall = "dig, ladder, or build over". A 3-high wall defeats a single ladder
  kit (`rules.ladderCharges` = 3 gets you up 3 cells only if the wall is exactly reachable —
  test it) and usually demands a Builder or a pickaxe.
* A `stone` wall can only be gone *around* or *over* — never through.
* Trenches: carving `air` from `y=1` to `FLOOR_Y-1` gives a 2-deep pit; troops drop in
  (survivable at the default `lethalFall`) and face a 2-high wall on the far side. A bridge
  crate lets the column plank straight across instead (one plank per gap cell).
* Never leave a drop that exceeds `lethalFall` on the only viable route unless you intend it
  as a hazard.
* The default corridor must eventually reach the objective volume; if the only path is through
  diggable material, you *must* grant a pickaxe (budget or crate).

---

## 6. Entities

### 6.1 Spawn (player drop pod)

`spawn.pos` must be a supported air cell facing into the level. The column marches as a single
file along `spawn.dir`; everything downstream is about steering and equipping that file.

### 6.2 Objective

* The scoring volume is the inclusive box `objective.from..objective.to`, given in **air cells
  troops stand in**. Paint an `objective` voxel slab one cell *below* it so the player can see
  the vault (the marker block is cosmetic).
* `required` troops must arrive; each arrival removes the troop from play (`SAVED`).
* Rule of thumb: `required` ≈ 30–60 % of `spawn.count`. The parametric builder uses
  `round(troops * (0.3 + 0.03 * difficulty))`, floor 3.

### 6.3 Guards (`GUARD_TYPES`, all stationary, always on the enemy team)

| type | hp | melee | reach | ranged | range | min range | cooldown | notes |
|---|---|---|---|---|---|---|---|---|
| `sentry` | 30 | 4 | 1 | – | – | – | 1.2 s | gate/corridor blocker; also physically blocks the cell |
| `turret` | 40 | – | 0 | 2 | 6 | – | 0.5 s | hitscan bullet, needs line of sight; park on walls/parapets |
| `grenadier` | 25 | 2 | 1 | 6 | 7 | 2 | 3.0 s ranged | arcing grenade, 1.5 splash; deadly against bunched columns |

Scaled at construction by `rules.guardHpScale`, `guardDamageScale`, `guardRangeScale`.
Place guards in **supported air cells** — they never fall, but a floating sentry looks broken.
Do not place a guard inside the objective volume.

### 6.4 Enemy spawners (enemy drop pods)

Enemy troops use `rules.enemyTroopHp`, follow **enemy-team** signs, pick up **enemy-team**
crates, and fight the player's column on contact. The classic pattern is a pod on one wall of
the corridor marching straight across the player's lane:

```json
{ "pos": [20, 3, 0], "dir": [0, 1], "count": 8, "rate": 6 }
```

Alternate sides down the corridor so the player must both fight and time the crossings.

### 6.5 Signs (`src/items/sign.js`)

Signs sit in walkable air cells, belong to a team, and only steer that team. Effects are
evaluated when a troop *finishes* a step; the first matching sign of the troop's team wins.

| kind | directional | effect |
|---|---|---|
| `blocker` | no | troops refuse to enter the cell and turn around |
| `arrow` | yes | any troop that steps onto it marches the sign's direction, whatever it arrived from |
| `fan` | yes | troops crossing it in the sign's direction are round-robined over three lanes (straight / diag-left / diag-right); troops marching *back* toward it within `radius = 2` cells are funnelled onto its lane |
| `forward` | yes | troops crossing it *sideways* turn to the sign's direction; troops already on its axis pass through (a one-way gate that leaves the return trip alone) |

Legacy input kinds are rewritten by the loader: `turnLeft`/`turnRight`/`turn` → `arrow`,
`fanOut`/`divert` → `fan`. Emit the modern names.

Pre-placed `signs[]` are level furniture (great for scripting the *enemy* column). Signs the
player may place come from `budget.signs`.

### 6.6 Crates and equipment (`src/items/equipment.js`)

| kind | effect on the troop that picks it up |
|---|---|
| `rifle` | `range = rules.rifleRange` (8), `attack = rules.rifleAttack` (3), cooldown 1.0 s — ranged troops out-duel sentries and shoot turrets off walls |
| `pickaxe` | `canDig = true`, `digUses = rules.pickaxeCharges` (10 voxels); consumed, then the slot frees up |
| `ladder` | `ladders = rules.ladderCharges` (3 segments) for climbing walls ≥ 2 high |
| `bridge` | `bridges = rules.bridgeCharges` (4 planks): when a gap (a drop of two or more) is ahead the troop lays a permanent plank at floor level and walks on — trenches and pits become crossings |
| `medic` | `rules.medicCharges` (6) heals of `rules.medicHeal` (4) HP, applied automatically to the nearest wounded troop of its team within `rules.medicRange` (3) cells, every `rules.medicCooldown` (1.5 s) |
| `grenade` | `rules.grenadeCharges` (3) grenades lobbed at hostiles between `rules.grenadeMinRange` (2) and `rules.grenadeRange` (6) cells with line of sight: `rules.grenadeAttack` (6) damage over `rules.grenadeSplash` (1.5) cells, every `rules.grenadeCooldown` (3 s); they hurt enemy troops *and* guards |
| `armor` | absorbs `rules.armorMitigation` (50 %) of every hit until `rules.armorPool` (20 — twice a troop's HP) damage has been soaked up, then it is discarded |
| `parachute` | survives `rules.parachuteCharges` (3) falls beyond `lethalFall`, and floats down at half speed |

A crate serves the first `capacity` troops of its team (`capacity` defaults to
`rules.crateCapacity`, 5). A troop has **one exclusive equipment slot plus any number of
stackable kits**: whether a kind takes the slot is the level rule `rules.<kind>Exclusive`
(everything is exclusive by default except `armor` and `parachute`), and a crate can override
it with `"exclusive": false` / `true`. Effects combine — an armoured rifleman with a parachute is
a legitimate build — and a consumable kit frees its slot when it runs out. A troop never takes a
kind it already carries. Place crates on the walking lane so the column crosses them without
steering, or *off* the lane to make the player route a detachment there with signs.

### 6.7 Roles (`budget.roles`)

Only `builder` exists. A builder lays a diagonal up-and-forward staircase of planks, 0.5 s per
plank, 12 planks max, and stops when the stair meets walkable ground, when it runs out, or when
something blocks the next plank (then it turns around). Grant `builder: 1–2` whenever the level
contains walls or trenches; it is the fallback when ladders/pickaxes run dry.
A right-click (or shift-click) on a builder **pauses** it: it marches on like any other troop
but keeps its remaining planks, and another right-click (or the Builder tool, at no cost)
resumes it with a fresh staircase from wherever it stands — so one builder can bridge two
obstacles if the player rations its 12 planks.

---

## 7. Budget economy

`budget` is the player's toolbox. Derive it from what you actually placed — a level that hands
out tools it doesn't need is noise; one that withholds a needed tool is unsolvable.

The parametric builder's heuristic (a good default):

```
nWalls   = #wall + #tallWall + #pit
hostiles = #guards + #enemySpawners

crates.pickaxe = max(1, ceil(nWalls / 2))
crates.ladder  = nWalls > 0 ? 1 : 0
crates.bridge  = #pit > 0 ? 1 : 0             // plank across the trench instead of dropping in
crates.rifle   = hostiles > 0 ? 1 + floor(hostiles / 3) : 0
crates.medic   = hostiles >= 3 ? 1 : 0
crates.grenade = keepGuards >= 3 ? 1 : 0
crates.armor   = difficulty >= 5 ? 1 : 0

signs.blocker  = 2 + #enemySpawners          // to wall off a crossing pod
signs.arrow    = 2 * #spikeFields + (difficulty < 5 ? 2 : 1)
signs.fan      = 1
signs.forward  = 1 + #spikeFields

roles.builder  = nWalls > 0 ? 2 : 1
```

Unknown sign kinds and non-finite counts are dropped by the loader; counts are rounded and
floored at 0. Legacy sign budgets are merged into the modern kind (`turnLeft: 1, turnRight: 1`
becomes `arrow: 2`).

---

## 8. Rules block

```json
"rules": { "enemyTroopHp": 13, "guardHpScale": 1.15, "rifleRange": 8 }
```

Every key (see the table in `src/rules.js` / `level.d.ts`) is optional; missing keys use the
default, out-of-range values are clamped, integer-stepped keys are rounded, and the
`<kind>Exclusive` flags are booleans. Besides troop and guard stats the block configures every
kit: rifle range/damage, pickaxe, ladder and bridge charges, the medic's charges/heal/range/cooldown,
the grenade band/damage/splash/cooldown, armor pool and mitigation, parachute charges, and
which kits are exclusive. Enemy columns have their own `enemyTroopHp`, `enemyTroopSpeed` and
`enemyTroopScale` (body size), and `mudSpeed` sets how much mud slows a step. Use `rules` to
change *difficulty* without changing *terrain*:
bumping `enemyTroopHp` and `guardHpScale` with difficulty is exactly what the parametric
builder does (`enemyTroopHp = 10 + difficulty`, `guardHpScale = 1 + 0.05 * difficulty`).

---

## 9. Obstacle cookbook

All snippets assume the house layout (floor top at `y = 2`, lane at `FLOOR_Y = 3`) and a
segment origin `x`.

| Obstacle | Fills | Teaches |
|---|---|---|
| **Dirt wall** (2 thick, 2 high) | `{dirt, [x,3,0], [x+1,4,d-1]}` | dig / ladder / build |
| **Tall wall** (3 high) | `{dirt, [x,3,0], [x+1,5,d-1]}` | one ladder kit is not enough |
| **Trench** (2 deep) | `{air, [x,1,0], [x+1,2,d-1]}` | falling is fine, climbing out is not |
| **Mud flat** | `{mud, [x+1,2,0], [x+4,2,d-1]}` | the column crawls: time patrols and turret fire |
| **Spike field** | `{spikes, [x,2,0], [x,2,d-1]}` then `{dirt, [x,2,gz], [x,2,gz+gapW-1]}` | steering: the safe gap is *never* on the pod's lane |
| **Turret pillar** | `{stone, [x,3,pz], [x,6,pz]}` + guard `turret @ [x,7,pz]` | rifles or a detour |
| **Keep** | 4 stone walls `y=3..9` + an `air` gate 2 wide/2 high + parapet corners | funnels the column into a killzone |

Spike gap placement rule: pick `gz` in `1 .. d-1-gapW` such that the gap does **not** contain
the spawn lane `mid`, otherwise the obstacle is free. `gapW = 2` normally, `1` at difficulty ≥ 8.

### Keep template (parametric builder)

```
kz0 = max(1, mid-5), kz1 = min(d-2, mid+4), kx1 = keepX + 14
stone: (keepX,3,kz0)-(kx1,9,kz0) | (keepX,3,kz1)-(kx1,9,kz1)
       (keepX,3,kz0)-(keepX,9,kz1) | (kx1,3,kz0)-(kx1,9,kz1)
air  : (keepX,3,mid-1)-(keepX,4,mid)                      ← the gate
stone: parapet stubs at the four corners, y = 10..11
objective slab: (keepX+8, 2, oz0)-(keepX+10, 2, oz1)
objective volume: same box at y = 3
```

Garrison posts, filled in order so a small garrison is just the gate:
`sentry @ +3,mid` → `turret @ wall, mid-2` → `grenadier @ +5,mid+2` → `sentry @ +3,mid-1` → …

---

## 10. Difficulty ramp

| difficulty | unlocks | typical shape |
|---|---|---|
| 0 | dirt walls | one wall, no hostiles, generous budget |
| 1–2 | spike fields, trenches | steering matters; 1 guard at the gate |
| 3–4 | tall walls | ladder + builder economy |
| 4+ | enemy patrols | blockers and rifles become mandatory |
| 5+ | turret pillars | line-of-sight play |
| 7+ | rifle crates for the enemy | enemy columns win firefights |
| 8+ | narrow spike gaps, `timeLimit` | `240 + 45 * segments` seconds |

---

## 11. Verification checklist (run this before emitting a level)

**Structural**

1. `size` within 1..256 on every axis; every `pos`, `from`, `to` inside the map.
2. `spawn.pos`, every guard, spawner, sign and crate sits in a **non-solid, supported** cell.
3. `objective.from/to` are air cells with solid beneath; `required ≤ spawn.count`.
4. No entity is inside a solid block and no two entities share a cell.
5. Every `fills[].type` exists in `VOXEL_BY_NAME`; no `fills` box leaves the grid.
6. Round-trip: `normalizeLevel(JSON.parse(JSON.stringify(level)))` must not throw **and** must
   preserve the counts of `guards`, `enemySpawners`, `signs` and `crates` (a drop means an
   entity was invalid).

**Playability**

7. Reachability: run the BFS below from the spawn cell. The objective volume must be reachable
   with the tools you granted.
8. Every route with a drop > `lethalFall` is optional, or the level is a trap.
9. If the only path crosses `dirt`, a pickaxe exists (crate or budget). If it crosses `stone`,
   a route around/over exists.
10. Spike gaps are off the spawn lane and the player owns enough `arrow`/`forward` signs to
    reach them.
11. `description` names the obstacles, the hostiles and the win condition.
12. Run the level tool: `node scripts/level-tool.mjs levels/my-level.json`. It enforces
     `level.d.ts` strictly (unknown properties, wrong types, non-axis-aligned facings and unknown
     kinds are errors, not silent drops), performs checks 1–9 above (placement, support, shared
     cells, standable objective, winnable count, reachability with and without the granted
     tools) and writes isometric and top-down thumbnails to `thumbnails/`. `--strict` makes
     warnings fatal, `--campaign` covers the generated progression, `--json` gives a
     machine-readable report for agents.

### Reachability BFS (movement-graph approximation)

```ts
// state = cell + inventory flags; expand with the nextStep rules
walkable(c) = inBounds(c) && !solid(c) && (solid(below(c)) || climbable(c))

for each of the 4 directions f from a walkable cell c:
  t = c + f
  if outOfBounds(t)                         -> no edge (unit turns)
  if solid(t):
    if !solid(above(t)) && t.y+1 < h        -> edge to above(t)              // stepUp
    else if hasLadder                       -> edge to above(c)              // ladder/climb
    else if hasPickaxe && diggable(t)       -> edge to t (cost: 1 dig charge)
    else                                    -> no edge
  else:
    if solid(below(t))                      -> edge to t                     // walk
    else if solid(below(below(t)))          -> edge to below(t)              // stepDown
    else                                    -> fall: drop until supported;
                                               edge only if dropDistance <= lethalFall
                                               and the landing block is not lethal
// crates flip inventory flags when their cell is entered;
// the Builder role additionally allows a diagonal +1y stair of up to 12 cells.
```

A conservative agent should verify reachability **twice**: once with no tools (is the level
trivially open?) and once with the granted budget (is it solvable at all?). A good level fails
the first check and passes the second.

---

## 12. Worked example

A small, complete, hand-authored level: a dirt wall, a spike row with an off-lane gap, and a
stone keep with a gated vault.

```json
{
  "name": "Gatecrash",
  "description": "Dig or climb the dirt wall, steer the column through the gap in the spikes, then take the gate. Get 5 of 20 troops into the vault.",
  "size": [28, 12, 12],
  "lethalFall": 4,
  "timeLimit": 0,
  "rules": { "enemyTroopHp": 12, "guardHpScale": 1.1 },
  "spawn": { "pos": [2, 3, 6], "dir": [1, 0], "count": 20, "rate": 1.5 },
  "objective": { "type": "reach", "from": [24, 3, 5], "to": [25, 3, 6], "required": 5 },
  "budget": {
    "crates": { "pickaxe": 1, "ladder": 1, "rifle": 1 },
    "signs": { "blocker": 2, "arrow": 2, "fan": 1, "forward": 1 },
    "roles": { "builder": 2 }
  },
  "guards": [
    { "type": "sentry", "pos": [23, 3, 6], "dir": [-1, 0] },
    { "type": "turret", "pos": [22, 10, 4], "dir": [-1, 0] }
  ],
  "enemySpawners": [
    { "pos": [14, 3, 0], "dir": [0, 1], "count": 6, "rate": 6 }
  ],
  "signs": [],
  "crates": [
    { "kind": "pickaxe", "pos": [8, 3, 6], "team": "player", "capacity": 4 }
  ],
  "fills": [
    { "type": "bedrock",  "from": [0, 0, 0],  "to": [27, 0, 11] },
    { "type": "dirt",     "from": [0, 1, 0],  "to": [27, 2, 11] },

    { "type": "dirt",     "from": [10, 3, 0], "to": [11, 4, 11] },

    { "type": "spikes",   "from": [16, 2, 0], "to": [16, 2, 11] },
    { "type": "dirt",     "from": [16, 2, 8], "to": [16, 2, 9] },

    { "type": "stone",    "from": [22, 3, 3], "to": [26, 9, 3] },
    { "type": "stone",    "from": [22, 3, 9], "to": [26, 9, 9] },
    { "type": "stone",    "from": [22, 3, 3], "to": [22, 9, 9] },
    { "type": "stone",    "from": [26, 3, 3], "to": [26, 9, 9] },
    { "type": "air",      "from": [22, 3, 5], "to": [22, 4, 6] },
    { "type": "stone",    "from": [22, 10, 3], "to": [22, 11, 3] },
    { "type": "stone",    "from": [22, 10, 9], "to": [22, 11, 9] },

    { "type": "objective","from": [24, 2, 5], "to": [25, 2, 6] }
  ]
}
```

Why it works:

* The wall at `x = 10..11` is 2 high above the lane → turn-around unless the column digs
  (pickaxe crate at `x = 8`, on the lane), ladders, or a builder stairs over it.
* The spike row at `x = 16` has its only safe gap at `z = 8..9`, three lanes off the spawn
  lane `z = 6` → the player must plant an `arrow`/`forward` pair to route the column and a
  second pair to bring it back to the gate lane.
* The keep is `stone` (undiggable) with a single 2×2 gate at `z = 5..6`; the sentry stands
  behind it and the turret watches the approach from the parapet → the rifle crate is the
  intended answer.
* The enemy pod at `x = 14` crosses the lane between the wall and the spikes → `blocker` signs
  or a firefight.

---

## 13. Generating levels programmatically

If you are producing a family of levels, prefer the parametric builder over ad-hoc JSON:

```js
import { buildParametricLevel, normalizeParams, resolveParams } from './world/level-builder.js';

const level = buildParametricLevel({ seed: 42, difficulty: 5, segments: 7, depth: 18 });
```

* Layout parameters (`seed`, `difficulty`, `segments`, `depth`) seed the RNG; count parameters
  (`troops`, `patrols`, `enemyTroops`, `guards`, `enemyCrates`) may be `null` = auto and are
  then derived by `autoParams`. Tweaking a count never reshuffles the terrain.
* Every parameter is clamped by `GENERATOR_LIMITS`; generation is deterministic.
* The chosen parameters are stored back on `level.generator` so the designer UI can show and
  re-tweak them. Keep that field when you post-process a generated level.
* `buildCampaignLevel(i)` / `campaignParams(i)` produce the fixed 12-level progression and tag
  the level with `campaign: { index, length }` so the game can offer the next one after a win.
* Other registered generators (`listGenerators()`): `arena` (open yard) and `maze` (a perfect
  maze with trapped dead ends, mud on the route and enemy patrols programmed into straight
  stretches with enemy arrow signs). `buildLevel('maze', { seed, cells, corridor, difficulty, mud })`
  — see [`generators.md`](generators.md).

When you write a *new* generator, mirror these invariants:

1. Derive the budget from the obstacles and hostiles you actually placed.
2. Guarantee at least one steering puzzle once the difficulty allows it (the builder forces a
   spike field into segment 1).
3. Never place an obstacle column on top of an enemy pod slot, a crate or the keep.
4. Emit a human-readable `description` listing the obstacles, the patrols and the garrison.
5. Finish with `normalizeLevel(...)` and run the checklist in §11 on the result.