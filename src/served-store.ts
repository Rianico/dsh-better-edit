/**
 * Served state — what the model has been shown, per session and path.
 *
 * This is the ONE module that owns the served-state concept: persistence
 * (over the hash store), the served-row merge invariant, the reported-drift
 * set, and the position-reconstruction math used by drift notices. The
 * reject-and-serve errors and range verification live with the hashline
 * module (`hashline/served.ts`); drift computation lives in `drift.ts`. Both
 * import from here.
 *
 * The API is async-only: every operation loads the per-workspace hash store
 * and resolves it through the active workspace context. There is deliberately
 * no sync half — the two-vocabulary, every-op-twice surface it produced is
 * gone.
 * @module dsh-better-edit/served-store
 */

import { randomUUID } from "node:crypto";
import { HASH_RE } from "./hashline/alphabet.js";
import { loadHashStore, withStore, type HashStore } from "./hash-store.js";

export type ServedEntry = { position: number; hash: string | null };

let fallbackSessionKey: string | undefined;

/**
 * Map a caller to the served-state session key. dsh passes the live session id
 * (`exec.agent.session.id`); callers without one (tests, previews) share a
 * process-local fallback so hashline verification never fabricates a session.
 */
export function sessionKeyFor(sessionId?: string): string {
	if (sessionId && sessionId.length > 0) return sessionId;
	fallbackSessionKey ??= randomUUID();
	return fallbackSessionKey;
}

function isValidServedList(value: unknown): value is (string | null)[] {
	if (!Array.isArray(value)) return false;
	for (const entry of value) {
		if (entry === null) continue;
		if (typeof entry !== "string" || !HASH_RE.test(entry)) return false;
	}
	return true;
}

/** Read the stored served array for one session+path, healing corrupt rows. */
function readServed(
	store: HashStore,
	sessionKey: string,
	path: string,
): (string | null)[] {
	const row = store.stmts.servedGet(sessionKey, path);
	if (!row) return [];
	try {
		const parsed = JSON.parse(row.hashes as string);
		if (isValidServedList(parsed)) return parsed;
		store.stmts.servedDelete(sessionKey, path);
		return [];
	} catch {
		store.stmts.servedDelete(sessionKey, path);
		return [];
	}
}

/** Persist a served array for one session+path. */
function writeServed(
	store: HashStore,
	sessionKey: string,
	path: string,
	list: (string | null)[],
): void {
	store.stmts.servedUpsert(sessionKey, path, JSON.stringify(list), Date.now());
}

/** Read the reported-drift hash set for one session+path (healing bad rows). */
function readReported(
	store: HashStore,
	sessionKey: string,
	path: string,
): Set<string> {
	const row = store.stmts.servedGet(sessionKey, path);
	if (!row) return new Set();
	const raw = row.reported;
	if (typeof raw !== "string" || raw.length === 0) return new Set();
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return new Set();
		return new Set(
			parsed.filter(
				(h): h is string => typeof h === "string" && HASH_RE.test(h),
			),
		);
	} catch {
		return new Set();
	}
}

/**
 * Merge served rows into a copy of the stored array. This single helper owns
 * the served-merge invariant shared by {@link recordServed} and
 * {@link recordServedTruncated}:
 *
 * - positions are validated before anything is written (invalid rows throw
 *   and never reach the store);
 * - when `truncateTo` is given, positions beyond the file's line count are
 *   dropped FIRST — a serve of the current file state must never leave a hash
 *   at an old position beyond the line count, because that stale claim makes
 *   a chained edit's boundary anchor look ambiguous (`E_RANGE_UNVERIFIED`,
 *   "served at N positions") instead of verifying cleanly;
 * - when `clearFrom` is given, positions at/after the mutation's first
 *   changed line are re-shaped by the edit, so the model's previous view of
 *   them is cleared before the diff rows land;
 * - trailing never-served markers are trimmed so an empty tail never grows
 *   the stored array.
 *
 * Underscore-prefixed: internal, exported only so the invariant has a direct
 * test seam.
 */
export function _mergeServedRows(
	current: (string | null)[],
	rows: ServedEntry[],
	options?: { truncateTo?: number; clearFrom?: number },
): (string | null)[] {
	const updated = current.slice();
	if (
		options?.truncateTo !== undefined &&
		updated.length > options.truncateTo
	) {
		updated.length = options.truncateTo;
	}
	if (options?.clearFrom !== undefined) {
		for (let i = options.clearFrom; i < updated.length; i++) updated[i] = null;
	}
	for (const entry of rows) {
		if (!Number.isInteger(entry.position) || entry.position < 0) {
			throw new TypeError(`Invalid served position: ${entry.position}`);
		}
		if (
			entry.hash !== null &&
			(typeof entry.hash !== "string" || !HASH_RE.test(entry.hash))
		) {
			throw new TypeError(`Invalid served hash: ${String(entry.hash)}`);
		}
		while (updated.length <= entry.position) updated.push(null);
		updated[entry.position] = entry.hash;
	}
	while (updated.length > 0 && updated[updated.length - 1] === null)
		updated.pop();
	return updated;
}

/** The served array for one session+path, or `[]` when nothing was served. */
export async function loadServed(
	sessionKey: string,
	path: string,
): Promise<(string | null)[]> {
	const store = await loadHashStore();
	return readServed(store, sessionKey, path);
}

/**
 * Record served rows for one session+path. Without `lineCount` the rows merge
 * into the stored array as-is; with it, the stored array is truncated to the
 * file's current line count before the rows land (see
 * {@link _mergeServedRows} for why). Failures are logged, never thrown — a
 * store problem must not fail the read that produced these rows.
 */
export async function recordServed(
	sessionKey: string,
	path: string,
	rows: ServedEntry[],
	lineCount?: number,
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadHashStore();
		withStore(() => {
			const current = readServed(store, sessionKey, path);
			const updated = _mergeServedRows(
				current,
				rows,
				lineCount === undefined ? undefined : { truncateTo: lineCount },
			);
			writeServed(store, sessionKey, path, updated);
		});
	} catch (error) {
		console.error("Failed to record served rows:", error);
	}
}

/**
 * Record post-mutation diff serves against the file's CURRENT length. The
 * stored array is truncated to `lineCount` and cleared from `clearFrom`
 * (the edit's first changed line) before the diff rows land, so a hash that
 * survived into the diff never keeps its pre-edit position claim.
 */
export async function recordServedTruncated(
	sessionKey: string,
	path: string,
	rows: ServedEntry[],
	lineCount: number,
	clearFrom = 0,
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadHashStore();
		withStore(() => {
			const current = readServed(store, sessionKey, path);
			const updated = _mergeServedRows(current, rows, {
				truncateTo: lineCount,
				clearFrom,
			});
			writeServed(store, sessionKey, path, updated);
		});
	} catch (error) {
		console.error("Failed to record truncated served rows:", error);
	}
}

/** The hashes already reported as drifted for one session+path. */
export async function driftReported(
	sessionKey: string,
	path: string,
): Promise<Set<string>> {
	try {
		const store = await loadHashStore();
		return readReported(store, sessionKey, path);
	} catch (error) {
		console.error("Failed to load reported drift set:", error);
		return new Set();
	}
}

/** Mark hashes as already reported as drifted, so later notices skip them. */
export async function markDriftReported(
	sessionKey: string,
	path: string,
	hashes: string[],
): Promise<void> {
	try {
		const valid = hashes.filter((hash) => HASH_RE.test(hash));
		if (valid.length === 0) return;
		const store = await loadHashStore();
		withStore(() => {
			const current = readReported(store, sessionKey, path);
			for (const hash of valid) current.add(hash);
			store.stmts.servedReportedUpsert(
				sessionKey,
				path,
				JSON.stringify([...current]),
				Date.now(),
			);
		});
	} catch (error) {
		console.error("Failed to record reported drift set:", error);
	}
}

/** Clear the reported-drift set for one session+path (a fresh read resets it). */
export async function clearDriftReported(
	sessionKey: string,
	path: string,
): Promise<void> {
	try {
		const store = await loadHashStore();
		withStore(() => {
			store.stmts.servedReportedClear(sessionKey, Date.now(), path);
		});
	} catch (error) {
		console.error("Failed to clear reported drift set:", error);
	}
}

/** Drop every served row and reported-drift mark for one session. */
export async function wipeServedState(sessionKey: string): Promise<void> {
	try {
		const store = await loadHashStore();
		store.stmts.servedWipe(sessionKey);
	} catch (error) {
		console.error("Failed to wipe served state:", error);
	}
}

/** Every served position of a hash in a served array (the E_RANGE_UNVERIFIED probe). */
export function servedPositionsOf(
	served: (string | null)[],
	hash: string,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < served.length; i++) {
		if (served[i] === hash) out.push(i);
	}
	return out;
}

function nearestSurvivingPosition(
	served: (string | null)[],
	surviving: Set<string>,
	from: number,
	direction: "below" | "above",
): number | undefined {
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

/**
 * Reconstruct where a drifted hash sits in the current file: map through the
 * nearest surviving served neighbor (below, else above), else fall back to
 * the served index plus the range's line delta.
 */
export function currentPositionOfDrifted(
	served: (string | null)[],
	currentPositions: Map<string, number>,
	surviving: Set<string>,
	servedIndex: number,
	delta: number,
): number {
	const below = nearestSurvivingPosition(
		served,
		surviving,
		servedIndex,
		"below",
	);
	if (below !== undefined) return currentPositions.get(served[below]!)! + 1;
	const above = nearestSurvivingPosition(
		served,
		surviving,
		servedIndex,
		"above",
	);
	if (above !== undefined) return currentPositions.get(served[above]!)! - 1;
	return servedIndex + delta;
}
