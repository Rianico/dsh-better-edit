/**
 * SessionView — deep module owning served rows + drift + position reconstruction.
 *
 * Previously also owned workspace/session context (AsyncLocalStorage +
 * execCwd/execSessionKey/sessionKeyFor + path re-exports) as
 * "private to this seam, @internal". That mixed two invariants:
 * served-merge+drift vs context propagation. Now this seam owns ONLY
 * served state and drift; WorkspaceContext owns execution context.
 *
 * Public surface: _mergeServedRows, loadServed, recordServed,
 * recordServedTruncated, driftReported, markDriftReported,
 * clearDriftReported, wipeServedState, servedPositionsOf,
 * currentPositionOfDrifted, computeDrift, scanDrift, and
 * hash-store persistence delegation (ServedPersistence).
 *
 * Ownership: This file OWNS the served-merge invariant
 * (_mergeServedRows with orphan healing per ADR-0008), the
 * position-reconstruction math, and the drift computation. Deleting
 * it would scatter the served+drift invariant across 4 files — it
 * concentrates (deep).
 *
 * @module dsh-better-edit/session-view
 */

import { HASH_RE, canon } from "./hashline/hash-assign.js";
import {
	loadHashStore,
	loadServedStore,
	withStore,
	type AnchorReservations,
	type ServedPersistence,
} from "./hash-store.js";
import { SERVED_ECHO_CAP } from "./constants.js";
import type { ServedRow, ResolvedRange } from "./hashline/anchor-pipeline.js";
import { fmtServedRows } from "./hashline/anchor-pipeline.js";

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

/** Anchors that must not be allocated while any session can still remember them. */
export async function loadAnchorReservations(
	path: string,
): Promise<AnchorReservations> {
	const store = await loadServedStore();
	return store.getAnchorReservations(path);
}

export async function loadServedCanons(sessionKey: string, path: string): Promise<(string | null)[]> {
	const store = await loadServedStore();
	return store.getServedCanons(sessionKey, path);
}

export async function loadEpochSnapshotId(sessionKey: string, path: string): Promise<string | undefined> {
	const store = await loadServedStore();
	return store.getEpochSnapshotId(sessionKey, path);
}
export async function loadRetiredAnchors(sessionKey: string, path: string): Promise<Set<string>> {
	const store = await loadServedStore();
	return store.getRetiredAnchors(sessionKey, path);
}

function addRetiredAnchors(
	store: ServedPersistence,
	sessionKey: string,
	path: string,
	hashes: Iterable<string>,
): void {
	const additions = [...hashes];
	if (additions.length === 0) return;
	const retired = store.getRetiredAnchors(sessionKey, path);
	for (const hash of additions) {
		if (!HASH_RE.test(hash)) {
			throw new TypeError(`Invalid retired hash: ${hash}`);
		}
		retired.add(hash);
	}
	store.upsertRetiredAnchors(sessionKey, path, JSON.stringify([...retired]));
}

function displacedHashes(
	current: readonly (string | null)[],
	updated: readonly (string | null)[],
): Set<string> {
	const remaining = new Set(updated.filter((hash): hash is string => hash !== null));
	return new Set(
		current.filter(
			(hash): hash is string => hash !== null && !remaining.has(hash),
		),
	);
}

/** Keep freed anchors dead for this session until it has seen the whole file again. */
export async function retireAnchors(
	sessionKey: string,
	path: string,
	hashes: Iterable<string>,
): Promise<void> {
	const additions = [...hashes];
	if (additions.length === 0) return;
	const store = await loadServedStore();
	withStore(() => {
		addRetiredAnchors(store, sessionKey, path, additions);
	});
}

export async function recordServed(
	sessionKey: string,
	path: string,
	rows: ServedEntry[],
	lineCount?: number,
	fullReadHashes?: readonly string[],
	fullReadCanons?: readonly (string | null)[],
	fullReadSnapshotId?: string,
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadServedStore();
		const isFullRead =
			fullReadHashes !== undefined &&
			rows.length === fullReadHashes.length &&
			rows.every(
				(row, index) =>
					row.position === index && row.hash === fullReadHashes[index],
			);
		withStore(() => {
			const current = store.getServed(sessionKey, path);
			const updated = _mergeServedRows(current, rows, lineCount === undefined ? undefined : { truncateTo: lineCount });
			if (current.length !== updated.length || current.some((v, i) => v !== updated[i])) {
				store.upsertServed(sessionKey, path, JSON.stringify(updated));
			}
			if (isFullRead) {
				store.clearRetiredAnchors(sessionKey, path);
				if (fullReadCanons) store.upsertServedCanons(sessionKey, path, JSON.stringify(fullReadCanons));
				if (fullReadSnapshotId) store.upsertEpochSnapshotId(sessionKey, path, fullReadSnapshotId);
			} else {
			// For partial reads, update canons for the served rows via hash-to-canon map (robust for partial views)
				if (fullReadCanons && fullReadHashes) {
					const canonByHash = new Map<string, string | null>();
					for (let i = 0; i < fullReadHashes.length; i++) {
						const h = fullReadHashes[i]!;
						const c = fullReadCanons[i] ?? null;
						if (h) canonByHash.set(h, c);
					}
					const currentCanons = store.getServedCanons(sessionKey, path);
					const updatedCanons = currentCanons.slice();
					while (updatedCanons.length < (lineCount ?? 0)) updatedCanons.push(null);
					for (const row of rows) {
						while (updatedCanons.length <= row.position) updatedCanons.push(null);
						const canonVal = row.hash ? (canonByHash.get(row.hash) ?? null) : null;
						updatedCanons[row.position] = canonVal;
					}
					while (updatedCanons.length > 0 && updatedCanons[updatedCanons.length - 1] === null) updatedCanons.pop();
					store.upsertServedCanons(sessionKey, path, JSON.stringify(updatedCanons));
				}
				if (fullReadSnapshotId) store.upsertEpochSnapshotId(sessionKey, path, fullReadSnapshotId);
				addRetiredAnchors(
					store,
					sessionKey,
					path,
					displacedHashes(current, updated),
				);
			}
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
			if (current.length !== updated.length || current.some((v, i) => v !== updated[i])) {
				store.upsertServed(sessionKey, path, JSON.stringify(updated));
			}
			addRetiredAnchors(
				store,
				sessionKey,
				path,
				displacedHashes(current, updated),
			);
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

export const DRIFT_NOTICE_HEADING = "[USER] drift:";

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
	/** WHY (#68): parallel to `served`, whitespace-stripped form at serve time.
	 * Absent/empty preserves legacy hash-equality (old DBs, unit callers). */
	servedCanons?: (string | null)[];
}

export interface DriftNoticeResult {
	text: string;
	rows: DriftRow[];
	total: number;
	allAlreadyReported: boolean;
}

type RotatedSurvivorCheck = (servedPos: number) => boolean;

/**
 * WHY (#68 hash-rotation vs content loss): probing + tombstone growth reassign
 * distinct hashes to identical duplicate lines across sequential edits, so a
 * served hash missing from the result set may still survive under a fresh hash.
 * Suppress those by consuming one matching canon outside the edited span;
 * report only true canon deficit. Whitespace-only reformats stay silent
 * (canon strips ASCII whitespace, ADR-0002). Absent/empty servedCanons keeps
 * legacy hash-equality.
 */
function buildRotatedSurvivorCheck(
	input: ComputeDriftInput,
	rangeFrom: number,
	rangeTo: number,
	delta: number,
): RotatedSurvivorCheck {
	const canons = input.servedCanons;
	if (!canons || !canons.some((c) => c !== null)) return () => false;
	// Edited served interval mapped to result coordinates (single range).
	const spanFrom = Math.max(0, rangeFrom);
	const spanTo = Math.max(spanFrom - 1, rangeTo + delta);
	const remaining = new Map<string, number>();
	for (let i = 0; i < input.resultLines.length; i++) {
		if (i >= spanFrom && i <= spanTo) continue;
		const c = canon(input.resultLines[i] ?? "");
		remaining.set(c, (remaining.get(c) ?? 0) + 1);
	}
	const take = (c: string): boolean => {
		const left = remaining.get(c) ?? 0;
		if (left <= 0) return false;
		remaining.set(c, left - 1);
		return true;
	};
	// Pre-consume: served lines that survived under their own hash already
	// account for their result content, so a deleted duplicate is not masked
	// by a surviving twin (multiset difference, not per-hash presence).
	const currentPosOfHash = new Map<string, number>();
	for (let i = 0; i < input.resultHashes.length; i++) {
		currentPosOfHash.set(input.resultHashes[i]!, i);
	}
	for (let p = 0; p < input.served.length; p++) {
		const h = input.served[p];
		if (h === null || (p >= rangeFrom && p <= rangeTo)) continue;
		const currentPos = currentPosOfHash.get(h);
		if (currentPos === undefined) continue;
		take(canon(input.resultLines[currentPos] ?? ""));
	}
	return (servedPos) => {
		const c = canons[servedPos] ?? null;
		if (c === null) return false;
		return take(c);
	};
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
	const isRotatedSurvivor = buildRotatedSurvivorCheck(input, rangeFrom, rangeTo, range.delta);
	let total = 0;
	let unshown = 0;
	let anyNotReported = false;
	const driftedPositions: number[] = [];
	for (let p = 0; p < served.length; p++) {
		const servedHash = served[p];
		if (servedHash === null) continue;
		if (p >= rangeFrom && p <= rangeTo) continue;
		if (resultHashSet.has(servedHash)) continue;
		if (isRotatedSurvivor(p)) continue;
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
	const servedCanons = await loadServedCanons(input.sessionKey, input.path);
	const result = computeDrift({ ...input, reported, servedCanons });
	if (!result || result.allAlreadyReported) return result?.text;
	await recordServed(input.sessionKey, input.path, result.rows.map((row) => ({ position: row.position, hash: row.hash })), input.resultLines.length);
	await markDriftReported(input.sessionKey, input.path, result.rows.filter((row) => row.drifted).map((row) => row.hash));
	return result.text;
}
