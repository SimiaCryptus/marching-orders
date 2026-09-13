import { BuilderRole } from './builder.js';

/**
 * Role interface:
 *   start(troop, sim)          — called once when assigned
 *   update(troop, dt, sim)     — called when the troop is idle in a cell; return true if handled
 *   stop(troop, sim)           — called when the role ends (finished, fell, died)
*   resume(troop, sim)         — optional; called when a paused role is resumed (troop.resumeRole)
*   progress(data)             — optional; short text describing the remaining work for hints
  *
  * Roles are Lemmings-style commands given to an individual troop. Blocking is no longer a role:
  * soldiers follow signs (see items/sign.js), so the Blocker is a placeable sign instead.
  * Right-clicking a troop with a role pauses it (it marches on, keeping its charges); another
  * right-click resumes it — so a builder's planks can be spent in several places.
 */
export const ROLES = Object.freeze({
  builder: BuilderRole,
});