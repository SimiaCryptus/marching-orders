/**
 * Contract for pluggable level generators (see docs/generators.md).
 *
 * A generator is a plain object exported as the default export of one file in this folder and
 * listed once in `index.js`. It declares its parameters as a schema (`params`) so the designer
 * can render a form for it without knowing anything about the generator, and turns a resolved
 * parameter set into a level (`build`). The framework in `src/world/level-builder.js` does the
 * rest: coercion / clamping of parameters, "auto" values, `normalizeLevel()`, and stamping
 * `level.generator = { id, ...storedParams }` so a level remembers how it was made.
 *
 * Documentation/tooling only — nothing imports it at runtime.
 */

import type { Level, LevelInput } from '../level';

/** Parameter kinds the designer knows how to render. */
export type ParamType = 'int' | 'number' | 'boolean' | 'select' | 'string';

/** A concrete (non-auto) parameter value. */
export type ParamValue = number | string | boolean;

interface ParamBase {
  /**
   * Property name in the parameter object. Must be unique within the generator and must not be
   * `id` (reserved: the framework stores the generator id under `level.generator.id`).
   * The key `seed` is special only by convention: the designer's "Random seed" button targets it.
   */
  key: string;
  /** Form label. Auto parameters get " (auto)" appended while they are derived. */
  label: string;
  /** Optional tooltip. */
  help?: string;
  /**
   * Informational: this parameter changes the terrain layout. Generators are encouraged to seed
   * their RNG from layout parameters only, so tweaking a count never reshuffles the map.
   */
  layout?: boolean;
  /**
   * May be left blank. A blank / missing / unparsable input is stored as `null` and, at build
   * time, replaced by the value the generator's `autoParams()` returns for that key. Requires
   * `autoParams` on the generator. Intended for numeric parameters (counts) but allowed on all.
   */
  auto?: boolean;
}

/** Whole number (`int`, rounded) or real number. Clamped into `min..max` when given. */
export interface NumberParam extends ParamBase {
  type: 'int' | 'number';
  min?: number;
  max?: number;
  /** Form step. Default 1 for `int`, "any" for `number`. */
  step?: number;
  /** Used when the value is missing (and the parameter is not auto). Falls back to `min`, then 0. */
  default?: number;
}

export interface BooleanParam extends ParamBase {
  type: 'boolean';
  /** Default false. */
  default?: boolean;
}

/** One of a fixed set of string values. Unknown values fall back to `default`, then the first option. */
export interface SelectParam extends ParamBase {
  type: 'select';
  options: ReadonlyArray<{ value: string; label?: string }>;
  default?: string;
}

export interface StringParam extends ParamBase {
  type: 'string';
  /** Default ''. */
  default?: string;
}

export type ParamDef = NumberParam | BooleanParam | SelectParam | StringParam;

/**
 * Parameters as remembered on a level (`level.generator` minus `id`): every declared key is
 * present; auto parameters left on auto are `null`.
 */
export type StoredParams = Record<string, ParamValue | null>;

/** Parameters as handed to `build()`: every declared key is present and concrete. */
export type ResolvedParams = Record<string, ParamValue>;

export interface BuildContext {
  /** The generator being run (handy for shared helpers). */
  generator: Generator;
  /** The parameters as they will be stored on the level (auto values still `null`). */
  stored: StoredParams;
}

export interface Generator {
  /** Stable, lower-case slug (`/^[a-z][a-z0-9-]*$/`). Stored on levels; never rename it. */
  readonly id: string;
  /** Shown in the designer's generator drop-down. */
  readonly label: string;
  /** One or two sentences shown under the drop-down. */
  readonly description: string;
  /** Parameter schema in display order. */
  readonly params: ReadonlyArray<ParamDef>;
  /**
   * Derive values for parameters left on auto. Receives the normalised parameters (auto ones
   * are `null`); return at least the keys currently `null`. Values are clamped by the framework.
   * Required when any param has `auto: true`.
   */
  autoParams?(params: StoredParams): Partial<ResolvedParams>;
  /**
   * Produce the level. May return an author-style `LevelInput` — the framework runs
   * `normalizeLevel()` on it and sets `generator`. Must be deterministic for equal parameters
   * (use `mulberry32()` from `./util.js`, seeded from the layout parameters). Throw an Error
   * with a readable message when the parameters cannot produce a valid level.
   */
  build(params: ResolvedParams, ctx: BuildContext): LevelInput | Level;
}

/** Shape of `GENERATORS` in `index.js`: manifest key === generator id. */
export type GeneratorManifest = Readonly<Record<string, Generator>>;