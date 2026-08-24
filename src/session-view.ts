/**
 * SessionView — deep module owning served rows + drift + position reconstruction.
 *
 * Previously split: served-store (merge invariant, persistence via hash-store)
 * and drift (pure computeDrift + IO scanDrift that reads+writes served state).
 * The drift notice both *reads* served state and *writes* it (marking reported
 * + recording drift rows) — a side effect hidden inside a "notice" module.
 *
 * This seam co-locates that invariant. Public surface:
 *   view(sessionKey, path) -> {served, reported}
 *   recordRead(sessionKey, path, rows, lineCount)
 *   recordEdit(sessionKey, path, rows, lineCount, clearFrom)
 *   scanDrift(sessionKey, path, resultHashes, resultLines, range) -> notice?
 *   servedPositionsOf, currentPositionOfDrifted, _mergeServedRows (via served-store)
 *
 * Explicit Workspace note: loadHashStore(cwd) now requires cwd. The
 * AsyncLocalStorage magic in workspace.ts is @internal — new code should pass
 * cwd explicitly through read-and-serve / edit-pipeline / drift. Forgetting
 * cwd is now a compile error where callers use this seam; legacy callers
 * via served-store still fall back to workspaceCwd() for backwards compat
 * but are marked deprecated.
 *
 * Ownership: This file now OWNS the served-merge invariant
 * (_mergeServedRows), the position-reconstruction math, and the drift
 * computation. Deleting it would scatter the served+drift invariant
 * across 4 files — it concentrates (deep).
 *
 * @module dsh-better-edit/session-view
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { HASH_RE } from "./hashline/hash-assign.js";
import { loadHashStore, loadServedStore, withStore } from "./hash-store.js";
import { SERVED_ECHO_CAP } from "./constants.js";
import type { ServedRow, ResolvedRange } from "./hashline/served.js";
import { fmtServedRows } from "./hashline/served.js";
import { configDir, hashStorePath, resolveTarget } from "./paths.js";

// --- workspace (private to this seam, @internal) ---
const current = new AsyncLocalStorage<string>();

export function withWorkspace<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  return current.run(cwd, fn);
}

export function workspaceCwd(): string | undefined {
  return current.getStore();
}

// --- dsh-context (private to this seam) ---
let fallbackSessionKey: string | undefined;

export function sessionKeyFor(sessionId?: string): string {
  if (sessionId && sessionId.length > 0) return sessionId;
  // fallback for previews/tests
  return fallbackSessionKey ??= randomUUID();
}

export function execCwd(exec: ToolExecution): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}

export function execSessionKey(exec: ToolExecution): string {
  return sessionKeyFor(exec.agent?.session.id);
}

// --- paths re-export (seam visibility) ---
export { configDir, hashStorePath, resolveTarget };

// --- hash-store re-export (persistence note) ---
export { loadHashStore, loadServedStore, shutdownHashStore, withStore } from "./hash-store.js";
export type { HashStore } from "./hash-store.js";

// --- served state (owned here) ---
export type ServedEntry = { position: number; hash: string | null };

/**
 * Merge served rows into a copy of the stored array. This single helper owns
 * the served-merge invariant shared by recordServed and recordServedTruncated.
 * Eagerly heals orphaned serves: if the same hash is written at a new position
 * the old position is nulled (O(n) scan, no extra I/O). This prevents a
 * partial re-serve from leaving a stale duplicate behind (ADR-0008).
 */
export function _mergeServedRows(
  current: (string | null)[],
  rows: ServedEntry[],
  options?: { truncateTo?: number; clearFrom?: number },
): (string | null)[] {
  const updated = current.slice();
  if (options?.truncateTo !== undefined && updated.length > options.truncateTo) {
    updated.length = options.truncateTo;
  }
  if (options?.clearFrom !== undefined) {
    for (let i = options.clearFrom; i < updated.length; i++) updated[i] = null;
  }
  // Build index of existing hashes and heal duplicates already in the array
  const index = new Map<string, number>();
  for (let i = 0; i < updated.length; i++) {
    const h = updated[i];
    if (h === null) continue;
    const prev = index.get(h);
    if (prev !== undefined) {
      updated[prev] = null;
    }
    index.set(h, i);
  }
  for (const entry of rows) {
    if (!Number.isInteger(entry.position) || entry.position < 0) {
      throw new TypeError(`Invalid served position: ${entry.position}`);
    }
    if (entry.hash !== null && (typeof entry.hash !== "string" || !HASH_RE.test(entry.hash))) {
      throw new TypeError(`Invalid served hash: ${String(entry.hash)}`);
    }
    while (updated.length <= entry.position) updated.push(null);
    if (entry.hash !== null) {
      const existing = index.get(entry.hash);
      if (existing !== undefined && existing !== entry.position) {
        updated[existing] = null;
        index.delete(entry.hash);
      }
      const oldAtPos = updated[entry.position];
      if (oldAtPos !== null && oldAtPos !== entry.hash) {
        index.delete(oldAtPos);
      }
      index.set(entry.hash, entry.position);
    } else {
      const oldAtPos = updated[entry.position];
      if (oldAtPos !== null) index.delete(oldAtPos);
    }
    updated[entry.position] = entry.hash;
  }
  while (updated.length > 0 && updated[updated.length - 1] === null) updated.pop();
  return updated;
}

export async function loadServed(sessionKey: string, path: string): Promise<(string | null)[]> {
  const store = await loadServedStore();
  return store.getServed(sessionKey, path);
}

export async function recordServed(sessionKey: string, path: string, rows: ServedEntry[], lineCount?: number): Promise<void> {
  if (rows.length === 0) return;
  try {
    const store = await loadServedStore();
    withStore(() => {
      const current = store.getServed(sessionKey, path);
      const updated = _mergeServedRows(current, rows, lineCount === undefined ? undefined : { truncateTo: lineCount });
      if (current.length === updated.length && current.every((v, i) => v === updated[i])) return;
      store.upsertServed(sessionKey, path, JSON.stringify(updated));
    });
  } catch (error) {
    console.error("Failed to record served rows:", error);
  }
}

export async function recordServedTruncated(sessionKey: string, path: string, rows: ServedEntry[], lineCount: number, clearFrom = 0): Promise<void> {
  if (rows.length === 0) return;
  try {
    const store = await loadServedStore();
    withStore(() => {
      const current = store.getServed(sessionKey, path);
      const updated = _mergeServedRows(current, rows, { truncateTo: lineCount, clearFrom });
      // Avoid no-op writes (perf: O(1) check, no extra I/O beyond current read)
      if (current.length === updated.length && current.every((v, i) => v === updated[i])) return;
      store.upsertServed(sessionKey, path, JSON.stringify(updated));
    });
  } catch (error) {
    console.error("Failed to record truncated served rows:", error);
  }
}

export async function driftReported(sessionKey: string, path: string): Promise<Set<string>> {
  try {
    const store = await loadServedStore();
    return store.getServedReported(sessionKey, path);
  } catch (error) {
    console.error("Failed to load reported drift set:", error);
    return new Set();
  }
}

export async function markDriftReported(sessionKey: string, path: string, hashes: string[]): Promise<void> {
  try {
    const valid = hashes.filter((hash) => HASH_RE.test(hash));
    if (valid.length === 0) return;
    const store = await loadServedStore();
    withStore(() => {
      const current = store.getServedReported(sessionKey, path);
      for (const hash of valid) current.add(hash);
      store.upsertServedReported(sessionKey, path, JSON.stringify([...current]));
    });
  } catch (error) {
    console.error("Failed to record reported drift set:", error);
  }
}

export async function clearDriftReported(sessionKey: string, path: string): Promise<void> {
  try {
    const store = await loadServedStore();
    withStore(() => {
      store.clearServedReported(sessionKey, path);
    });
  } catch (error) {
    console.error("Failed to clear reported drift set:", error);
  }
}

export async function wipeServedState(sessionKey: string): Promise<void> {
  try {
    const store = await loadServedStore();
    store.wipeServed(sessionKey);
  } catch (error) {
    console.error("Failed to wipe served state:", error);
  }
}

export function servedPositionsOf(served: (string | null)[], hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < served.length; i++) {
    if (served[i] === hash) out.push(i);
  }
  return out;
}

function nearestSurvivingPosition(served: (string | null)[], surviving: Set<string>, from: number, direction: "below" | "above"): number | undefined {
  if (direction === "below") {
    for (let q = from - 1; q >= 0; q--) {
      const hash = served[q];
      if (hash !== null && surviving.has(hash)) return q;
    }
    return undefined;
  }
  for (let q = from + 1; q < served.length; q++) {
    const hash = served[q];
    if (hash !== null && surviving.has(hash)) return q;
  }
  return undefined;
}

export function currentPositionOfDrifted(served: (string | null)[], currentPositions: Map<string, number>, surviving: Set<string>, servedIndex: number, delta: number): number {
  const below = nearestSurvivingPosition(served, surviving, servedIndex, "below");
  if (below !== undefined) return currentPositions.get(served[below]!)! + 1;
  const above = nearestSurvivingPosition(served, surviving, servedIndex, "above");
  if (above !== undefined) return currentPositions.get(served[above]!)! - 1;
  return servedIndex + delta;
}

export const DRIFT_NOTICE_HEADING = "drift:";

export interface DriftRow extends ServedRow {
  content: string;
  drifted: boolean;
}

export interface ComputeDriftInput {
  served: (string | null)[];
  resultHashes: string[];
  resultLines: string[];
  range: ResolvedRange;
  reported: Set<string>;
  cap?: number;
}

export interface DriftNoticeResult {
  text: string;
  rows: DriftRow[];
  total: number;
  allAlreadyReported: boolean;
}

export function computeDrift(input: ComputeDriftInput): DriftNoticeResult | undefined {
  const { served, resultHashes, resultLines, range, reported, cap = SERVED_ECHO_CAP } = input;
  const resultHashSet = new Set(resultHashes);
  const currentPosOfHash = new Map<string, number>();
  for (let i = 0; i < resultHashes.length; i++) {
    currentPosOfHash.set(resultHashes[i]!, i);
  }
  const startPositions = servedPositionsOf(served, range.startHash);
  const endPositions = servedPositionsOf(served, range.endHash);
  let servedStartIdx: number;
  let servedEndIdx: number;
  if (startPositions.length === 1 && endPositions.length === 1) {
    servedStartIdx = startPositions[0]!;
    servedEndIdx = endPositions[0]!;
  } else {
    servedStartIdx = range.startLine - 1;
    servedEndIdx = range.endLine - 1;
  }
  const rangeFrom = Math.min(servedStartIdx, servedEndIdx);
  const rangeTo = Math.max(servedStartIdx, servedEndIdx);
  let total = 0;
  let unshown = 0;
  let anyNotReported = false;
  const driftedPositions: number[] = [];
  for (let p = 0; p < served.length; p++) {
    const servedHash = served[p];
    if (servedHash === null) continue;
    if (p >= rangeFrom && p <= rangeTo) continue;
    if (resultHashSet.has(servedHash)) continue;
    total++;
    if (!reported.has(servedHash)) anyNotReported = true;
    const currentPos = currentPositionOfDrifted(served, currentPosOfHash, resultHashSet, p, range.delta);
    if (currentPos >= 0 && currentPos < resultHashes.length && currentPos < resultLines.length) {
      driftedPositions.push(currentPos);
    } else {
      unshown++;
    }
  }
  if (total === 0) return undefined;
  const countLabel = `${total} line(s)`;
  if (!anyNotReported) {
    return {
      text: `${DRIFT_NOTICE_HEADING} ${countLabel} changed outside the range (already reported) — re-read to refresh.`,
      rows: [],
      total,
      allAlreadyReported: true,
    };
  }
  const driftedSet = new Set(driftedPositions);
  const windowSet = new Set<number>();
  for (const pos of driftedPositions) {
    for (const w of [pos - 1, pos, pos + 1]) {
      if (w >= 0 && w < resultLines.length) windowSet.add(w);
    }
  }
  const windowPositions = [...windowSet].sort((a, b) => a - b);
  const shownPositions = windowPositions.slice(0, cap);
  unshown += windowPositions.length - shownPositions.length;
  const rows: DriftRow[] = shownPositions.map((position) => ({
    position,
    hash: resultHashes[position]!,
    content: resultLines[position]!,
    drifted: driftedSet.has(position),
  }));
  const rowsText = fmtServedRows(rows, resultLines);
  const moreText = unshown > 0 ? `\n[... ${unshown} more — re-read to see]` : "";
  return {
    text: `${DRIFT_NOTICE_HEADING} ${countLabel} changed outside the range:\n${rowsText}${moreText}`,
    rows,
    total,
    allAlreadyReported: false,
  };
}

export async function scanDrift(input: { sessionKey: string; served: (string | null)[]; resultHashes: string[]; resultLines: string[]; range: ResolvedRange; path: string }): Promise<string | undefined> {
  const reported = await driftReported(input.sessionKey, input.path);
  const result = computeDrift({ ...input, reported });
  if (!result || result.allAlreadyReported) return result?.text;
  await recordServed(input.sessionKey, input.path, result.rows.map((row) => ({ position: row.position, hash: row.hash })), input.resultLines.length);
  await markDriftReported(input.sessionKey, input.path, result.rows.filter((row) => row.drifted).map((row) => row.hash));
  return result.text;
}
