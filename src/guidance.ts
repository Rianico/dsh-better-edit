/**
 * Backwards-compat barrel — the real seams live in `src/guidance/`:
 * `parse.ts` (pure), `resolve.ts` (IO-light), `materialize.ts` (IO-heavy).
 * Keeping this file means existing `from "./guidance.js"` imports keep working.
 * @module dsh-better-edit/guidance
 */
export * from "./guidance/parse.js";
export * from "./guidance/resolve.js";
export * from "./guidance/materialize.js";
