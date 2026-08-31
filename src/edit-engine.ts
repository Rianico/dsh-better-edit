/**
 * @deprecated — private to Mutation seam. Use `from "./mutation/engine.js"` instead.
 * Thin shim re-exporting the engine now owned by Mutation.
 * @module dsh-better-edit/edit-engine
 */
export * from "./mutation/engine.js";
export { persistUndoAndWrite, commit, commitSingle, commitBatch } from "./mutation.js";
