/**
 * SessionView — deep module owning served rows + drift + position reconstruction.
 *
 * Previously split: served-store (merge invariant, persistence via hash-store)
 * and drift (pure computeDrift + IO scanDrift that reads+writes served state).
 * The drift notice both *reads* served state and *writes* it (marking reported
 * + recording drift rows) — a side effect hidden inside a "notice" module.
 *
 * This seam co-locates that invariant. Public surface:
 *   view(sessionKey, path) → {served, reported}
 *   recordRead(sessionKey, path, rows, lineCount)
 *   recordEdit(sessionKey, path, rows, lineCount, clearFrom)
 *   scanDrift(sessionKey, path, resultHashes, resultLines, range) → notice?
 *   servedPositionsOf, currentPositionOfDrifted, _mergeServedRows (via served-store)
 *
 * Explicit Workspace note: loadHashStore(cwd) now requires cwd. The
 * AsyncLocalStorage magic in workspace.ts is @internal — new code should pass
 * cwd explicitly through read-and-serve / edit-pipeline / drift. Forgetting
 * cwd is now a compile error where callers use this seam; legacy callers
 * via served-store still fall back to workspaceCwd() for backwards compat
 * but are marked deprecated.
 *
 * @module dsh-better-edit/session-view
 */

// --- served state (persistence seam) ---
export {
 sessionKeyFor,
 _mergeServedRows,
 loadServed,
 recordServed,
 recordServedTruncated,
 driftReported,
 markDriftReported,
 clearDriftReported,
 wipeServedState,
 servedPositionsOf,
 currentPositionOfDrifted,
} from "./served-store.js";
export type { ServedEntry } from "./served-store.js";

// --- drift (pure + IO) ---
export { computeDrift, scanDrift, DRIFT_NOTICE_HEADING } from "./drift.js";
export type {
 DriftRow,
 ComputeDriftInput,
 DriftNoticeResult,
} from "./drift.js";

// --- explicit workspace (re-export for seam visibility) ---
export { withWorkspace, workspaceCwd } from "./workspace.js";
export { execCwd, execSessionKey } from "./dsh-context.js";
export { configDir, hashStorePath, resolveTarget } from "./paths.js";

// Re-export hash-store explicit-cwd API as part of this seam's persistence note
export { loadHashStore, shutdownHashStore, withStore } from "./hash-store.js";
export type { HashStore } from "./hash-store.js";
