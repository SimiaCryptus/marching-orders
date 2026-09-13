/**
 * Type model for the level JSON consumed by `src/world/level-loader.js`.
 *
 * Two shapes are described:
 *   `LevelInput`  — what an author (human, editor or generator) writes. Almost everything is
 *                   optional; `normalizeLevel()` fills in defaults and clamps ranges.
 *   `Level`       — what `normalizeLevel()` returns and what the rest of the game consumes.
 *                   Every optional field is materialised, ranges are clamped, legacy names
 *                   are rewritten and `objective.from/to` are sorted per-axis.
 *
 * This file is documentation/tooling only (nothing imports it at runtime), but it is kept in
 * sync with `normalizeLevel()`; if the loader changes, change this too.
 */

// ---------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------

/** Integer voxel coordinate triple: x = width (east), y = height (up), z = depth (south). */
export type Vec3 = [x: number, y: number, z: number];

/** Horizontal direction. Must be axis-aligned and non-zero: [1,0] [-1,0] [0,1] [0,-1]. */
export type Facing = [dx: number, dz: number];

/** Sides. Signs and crates only ever affect troops of their own team; guards are always enemy. */
export type Team = 'player' | 'enemy';

/**
 * Voxel names accepted by `fills[].type` (canonical list = `VOXEL_BY_NAME` in world/voxel.js).
 * Semantics used by the simulation:
 *   air        — empty; troops occupy air cells.
 *   bedrock    — hard, indestructible floor/boundary material.
 *   dirt       — the soft block: diggable with a pickaxe, the standard obstacle material.
 *   stone      — hard structural block: not diggable, forces detours / gates / ladders.
 *   plank      — placed by the Builder role; solid.
*   mud        — solid floor that slows every step taken onto it (rules.mudSpeed); diggable.
 *   ladder     — climbable, also counts as support (troops can stand "in" it).
 *   spikes     — lethal on contact: a troop that arrives in the cell *above* spikes dies.
 *   objective  — solid marker block, drawn as the vault floor. Purely cosmetic/semantic:
 *                the scoring volume is `objective.from/to`, not this block.
 * Always verify unusual names against `VOXEL_BY_NAME`; an unknown name throws at build time.
 */
export type VoxelName =
  | 'air' | 'bedrock' | 'dirt' | 'stone' | 'plank' | 'ladder' | 'spikes' | 'objective' | 'mud';

/** Numeric voxel ids as stored in `World.data` (see `VOXEL` / `VOXEL_TYPES`). */
export type VoxelId = number;

export type GuardType = 'sentry' | 'turret' | 'grenadier';
export type SignKind = 'blocker' | 'arrow' | 'fan' | 'forward';
/** Accepted on input and rewritten by the loader: turnLeft|turnRight|turn -> arrow, fanOut|divert -> fan. */
export type LegacySignKind = 'turnLeft' | 'turnRight' | 'turn' | 'fanOut' | 'divert';
export type EquipmentKind = 'rifle' | 'pickaxe' | 'ladder' | 'bridge' | 'medic' | 'grenade' | 'armor' | 'parachute';
export type RoleName = 'builder';

// ---------------------------------------------------------------------------------------
// Rules (src/rules.js) — every key is optional on input, all are present after normalisation
// ---------------------------------------------------------------------------------------

export interface Rules {
  /** def 10, 1..999 */            troopHp: number;
  /** def 10, 1..999 */            enemyTroopHp: number;
  /** def 2.5, 0.5..10 cells/s */  troopSpeed: number;
  /** def 2.5, 0.5..10 cells/s */  enemyTroopSpeed: number;
  /** def 1, 0.5..2.5 (body size of enemy troops, cosmetic) */ enemyTroopScale: number;
  /** def 2, 0..99 */              troopAttack: number;
  /** def 8, 2..32 cells */        rifleRange: number;
  /** def 3, 0..99 */              rifleAttack: number;
  /** def 10, 1..999 voxels */     pickaxeCharges: number;
  /** def 3, 1..99 segments */     ladderCharges: number;
  /** def 4, 1..99 planks */       bridgeCharges: number;
  /** def 5, 1..99 troops */       crateCapacity: number;
  /** def 0.5, 0.1..1 — speed multiplier for steps onto mud */ mudSpeed: number;
   /** def 6, 1..99 heals */        medicCharges: number;
   /** def 4, 1..99 HP per heal */  medicHeal: number;
   /** def 3, 1..16 cells */        medicRange: number;
   /** def 1.5, 0.1..10 s */        medicCooldown: number;
   /** def 3, 1..99 grenades */     grenadeCharges: number;
   /** def 6, 2..16 cells */        grenadeRange: number;
   /** def 2, 0..8 cells */         grenadeMinRange: number;
   /** def 6, 0..99 */              grenadeAttack: number;
   /** def 1.5, 0.5..5 cells */     grenadeSplash: number;
   /** def 3, 0.5..10 s */          grenadeCooldown: number;
   /** def 20, 1..999 damage */     armorPool: number;
   /** def 0.5, 0.05..1 */          armorMitigation: number;
   /** def 3, 1..99 falls */        parachuteCharges: number;
  /** def 1, 0.1..10 */            guardHpScale: number;
  /** def 1, 0.1..10 */            guardDamageScale: number;
  /** def 1, 0.1..4 */             guardRangeScale: number;
   /**
    * Whether a kit takes the troop's single equipment slot (true) or stacks on top of anything
    * it already carries (false). Defaults: everything exclusive except armor and parachute.
    */
   rifleExclusive: boolean;
   pickaxeExclusive: boolean;
   ladderExclusive: boolean;
   bridgeExclusive: boolean;
   medicExclusive: boolean;
   grenadeExclusive: boolean;
   armorExclusive: boolean;
   parachuteExclusive: boolean;
}

export type RulesInput = Partial<Rules>;

// ---------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------

/** The player's drop pod. Releases one troop every `rate` seconds until `count` is exhausted. */
export interface Spawn {
  /** Air cell the troops appear in; must be supported (solid or ladder directly below). */
  pos: Vec3;
  /** Initial march direction. Default [1,0]. */
  dir: Facing;
  /** Total troops released. Integer > 0, default 20. */
  count: number;
  /** Seconds between drops. Finite > 0, default 1.5. */
  rate: number;
}

/** Enemy drop pod. Its column follows *enemy* signs and picks up *enemy* crates. */
export interface EnemySpawner {
  pos: Vec3;
  /** Default: the reverse of `spawn.dir`. */
  dir: Facing;
  /** Integer > 0, default 10. */
  count: number;
  /** Seconds between drops, default 2 (the parametric builder uses 6). */
  rate: number;
}

/**
 * Win condition. The only supported type is 'reach': `required` player troops must arrive in
 * the inclusive box `from..to` (air cells they can stand in). The loader sorts the corners.
 */
export interface Objective {
  type: 'reach';
  from: Vec3;
  to: Vec3;
  /** Integer > 0, default 1. Should be <= spawn.count. */
  required: number;
}

/** A stationary enemy. See GUARD_TYPES for stats; `rules.guard*Scale` scales them. */
export interface Guard {
  /** Unknown types fall back to 'sentry'. */
  type: GuardType;
  /** Air cell; must be supported or the guard hangs in the air (it never falls). */
  pos: Vec3;
  /** Initial facing, default [-1,0]. Cosmetic: guards re-aim at whatever they engage. */
  dir: Facing;
}

/** A pre-placed sign (level furniture). Player budget signs are placed in-game instead. */
export interface SignPlacement {
  kind: SignKind | LegacySignKind;
  /** The walkable air cell the sign sits in. */
  pos: Vec3;
  /** Direction the sign points. Default: a copy of `spawn.dir`. Ignored by 'blocker'. */
  dir: Facing;
  /** Which column it steers. Default 'player'. */
  team: Team;
}

/** A pre-placed weapon crate. The first `capacity` troops of its team to cross it are equipped. */
export interface CratePlacement {
  kind: EquipmentKind;
  pos: Vec3;
  team: Team;
  /** Integer > 0. Omit to use `rules.crateCapacity`. */
  capacity?: number;
   /** Overrides `rules.<kind>Exclusive` for this crate only. Omit to follow the rule. */
   exclusive?: boolean;
}

// ---------------------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------------------

/**
 * Compact run-length blob produced by `encodeWorld()` (editor export). Runs are `[voxelId,
 * count]` over a linear scan of `World.data`; the index layout is an implementation detail,
 * so never hand-write this — author `fills` instead, or round-trip through `exportLevel()`.
 */
export interface VoxelBlob {
  rle: Array<[type: VoxelId, count: number]>;
}

/** An inclusive axis-aligned box painted with one voxel type. Corners may be given in any order. */
export interface Fill {
  type: VoxelName;
  from: Vec3;
  to: Vec3;
}

// ---------------------------------------------------------------------------------------
// Budget — what the player may place during the run
// ---------------------------------------------------------------------------------------

export interface Budget {
  /** How many crates of each kind the player may drop, e.g. { pickaxe: 2, ladder: 1 }. */
  crates: Partial<Record<EquipmentKind, number>>;
  /** How many signs of each kind the player may plant. Legacy kinds are folded into the new ones. */
  signs: Partial<Record<SignKind, number>>;
  /** How many troops may be assigned to each role, e.g. { builder: 2 }. */
  roles: Partial<Record<RoleName, number>>;
}

// ---------------------------------------------------------------------------------------
// Generator metadata (written by buildLevel() in level-builder.js; optional on hand-authored levels)
// ---------------------------------------------------------------------------------------
/**
  * Which generator made the level and with what parameters, so the designer can show and tweak
  * them. `id` is the manifest key in `src/world/generators/index.js`; every other key is one of
  * that generator's declared parameters (see `generators/generator.d.ts`). Parameters left on
  * auto are stored as `null`. Levels written before generators were pluggable have no `id`; the
  * loader treats those as made by the default ('siege') generator.
  */

export interface GeneratorParams {
   id: string;
   [param: string]: number | string | boolean | null;
}

export interface CampaignTag {
  index: number;  // 0-based
  length: number;
}

// ---------------------------------------------------------------------------------------
// The level
// ---------------------------------------------------------------------------------------

/** Author-facing shape: everything except `size`, `spawn.pos` and `objective.from/to` is optional. */
export interface LevelInput {
  name?: string;
  description?: string;
  /** REQUIRED. [width, height, depth]; each integer in 1..256. */
  size: Vec3;
  /** REQUIRED (`pos` at least). */
  spawn: { pos: Vec3; dir?: Facing; count?: number; rate?: number };
  /** REQUIRED (`from` and `to` at least). */
  objective: { type?: 'reach'; from: Vec3; to: Vec3; required?: number };
  /** Max survivable fall in cells. Integer > 0, default 4. A fall of exactly this many cells survives. */
  lethalFall?: number;
  /** Seconds; 0 (default) = no limit. */
  timeLimit?: number;
  rules?: RulesInput;
  budget?: Partial<Budget>;
  guards?: Array<Partial<Guard> & { pos: Vec3 }>;
  enemySpawners?: Array<Partial<EnemySpawner> & { pos: Vec3 }>;
  signs?: Array<Partial<SignPlacement> & { pos: Vec3; kind: SignKind | LegacySignKind }>;
  crates?: Array<Partial<CratePlacement> & { pos: Vec3; kind: EquipmentKind }>;
  /** Applied first (editor export). */
  voxels?: VoxelBlob;
  /** Applied after `voxels`, in array order; 'air' fills carve holes. */
  fills?: Fill[];
  generator?: Partial<GeneratorParams>;
  campaign?: CampaignTag;
}

/** Normalised shape returned by `normalizeLevel()` / `loadLevel()` / `parseLevel()`. */
export interface Level {
  name: string;
  description: string;
  size: Vec3;
  spawn: Spawn;
  objective: Objective;
  lethalFall: number;
  timeLimit: number;
  rules: Rules;
  budget: Budget;
  guards: Guard[];
  enemySpawners: EnemySpawner[];
  signs: Required<SignPlacement> extends infer _ ? Array<{ kind: SignKind; pos: Vec3; dir: Facing; team: Team }> : never;
   crates: Array<{ kind: EquipmentKind; pos: Vec3; team: Team; capacity?: number; exclusive?: boolean }>;
  voxels?: VoxelBlob;
  fills?: Fill[];
  generator?: GeneratorParams;
  campaign?: CampaignTag;
}