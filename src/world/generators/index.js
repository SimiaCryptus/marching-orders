/**
 * Manifest of level generators.
 *
 * To add a generator: drop one file into this folder that default-exports a `Generator` (see
 * generator.d.ts and docs/generators.md), import it here and add one entry to the dictionary.
 * The key must equal the generator's `id`; it is what levels store in `generator.id` and what
 * the designer and `buildLevel()` look up.
 */
import siege from './siege.js';
import arena from './arena.js';

export const GENERATORS = Object.freeze({
  siege,
  arena,
});

/** Used when a level does not say which generator made it, and as the designer's initial choice. */
export const DEFAULT_GENERATOR = 'siege';