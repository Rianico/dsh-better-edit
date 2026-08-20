/**
 * Barrel for guidance sub-seams — parse (pure), resolve (IO-light), materialize (IO-heavy).
 * Re-exported via `src/guidance.ts` so existing `from "./guidance.js"` imports keep working.
 * @module dsh-better-edit/guidance/index
 */
export * from "./parse.js";
export * from "./resolve.js";
export * from "./materialize.js";
