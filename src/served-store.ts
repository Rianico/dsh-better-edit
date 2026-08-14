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

export function getServed(
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

export function upsertServed(
	store: HashStore,
	sessionKey: string,
	path: string,
	entries: Array<{ position: number; hash: string | null }>,
): void {
	if (entries.length === 0) return;
	withStore(() => {
		const updated = getServed(store, sessionKey, path).slice();
		for (const entry of entries) {
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
		store.stmts.servedUpsert(sessionKey, path, JSON.stringify(updated), Date.now());
	});
}

export function recordServes(
	store: HashStore,
	sessionKey: string,
	path: string,
	rows: Array<{ position: number; hash: string | null }>,
): void {
	if (rows.length === 0) return;
	try {
		upsertServed(store, sessionKey, path, rows);
	} catch (error) {
		console.error("Failed to record served rows:", error);
	}
}

/**
 * Record post-mutation diff serves against the file's CURRENT length. Before
 * upserting the diff rows, positions beyond `lineCount` are dropped from the
 * stored array: after an edit/undo the file has a new shape, and a hash that
 * survived into the diff must not keep its pre-edit position claim — that
 * stale claim is what makes a chained edit's boundary anchor look ambiguous
 * (`E_RANGE_UNVERIFIED`) instead of verifying cleanly.
 * @param store - open hash store.
 * @param sessionKey - the session whose served rows are being updated.
 * @param path - canonical absolute path.
 * @param rows - diff rows (position → post-mutation hash) to record.
 * @param lineCount - the file's line count AFTER the mutation.
 */
export function recordServesTruncated(
	store: HashStore,
	sessionKey: string,
	path: string,
	rows: Array<{ position: number; hash: string | null }>,
	lineCount: number,
	clearFrom = 0,
): void {
	if (rows.length === 0) return;
	try {
		withStore(() => {
			const updated = getServed(store, sessionKey, path).slice();
			if (updated.length > lineCount) updated.length = lineCount;
			// Positions at/after the mutation's first changed line are
			// re-shaped by the edit: the model's previous view of them no
			// longer holds (line positions shift, and only the diff window
			// below is what it now saw). Clear them so a stale hash never
			// makes a boundary anchor look ambiguous; the unchanged prefix
			// before the edit keeps its claims (same content, same position).
			for (let i = clearFrom; i < updated.length; i++) updated[i] = null;
			for (const entry of rows) {
				if (!Number.isInteger(entry.position) || entry.position < 0) {
					throw new TypeError(`Invalid served position: ${entry.position}`);
				}
				if (
					entry.hash !== null &&
					(typeof entry.hash !== 'string' || !HASH_RE.test(entry.hash))
				) {
					throw new TypeError(`Invalid served hash: ${String(entry.hash)}`);
				}
				while (updated.length <= entry.position) updated.push(null);
				updated[entry.position] = entry.hash;
			}
			while (updated.length > 0 && updated[updated.length - 1] === null)
				updated.pop();
			store.stmts.servedUpsert(
				sessionKey,
				path,
				JSON.stringify(updated),
				Date.now(),
			);
		});
	} catch (error) {
		console.error('Failed to record truncated served rows:', error);
	}
}

export function getReported(store: HashStore, sessionKey: string, path: string): Set<string> {
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

export function addReported(
	store: HashStore,
	sessionKey: string,
	path: string,
	hashes: string[],
): void {
	const valid = hashes.filter((hash) => HASH_RE.test(hash));
	if (valid.length === 0) return;
	withStore(() => {
		const current = getReported(store, sessionKey, path);
		for (const hash of valid) current.add(hash);
		store.stmts.servedReportedUpsert(
			sessionKey,
			path,
			JSON.stringify([...current]),
			Date.now(),
		);
	});
}

export function clearReported(store: HashStore, sessionKey: string, path: string): void {
	withStore(() => {
		store.stmts.servedReportedClear(sessionKey, Date.now(), path);
	});
}

export function deleteServed(store: HashStore, sessionKey: string, path: string): void {
	store.stmts.servedDelete(sessionKey, path);
}

export function wipeServed(store: HashStore, sessionKey: string): void {
	store.stmts.servedWipe(sessionKey);
}

export async function loadServed(
	sessionKey: string,
	path: string,
): Promise<(string | null)[]> {
	const store = await loadHashStore();
	return getServed(store, sessionKey, path);
}

export async function recordServed(
	sessionKey: string,
	path: string,
	rows: ServedEntry[],
): Promise<void> {
	if (rows.length === 0) return;
	try {
		const store = await loadHashStore();
		recordServes(store, sessionKey, path, rows);
	} catch (error) {
		console.error('Failed to record served rows:', error);
	}
}

/**
 * Async sibling of {@link recordServesTruncated}: record post-mutation diff
 * rows against the file's current line count.
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
		recordServesTruncated(store, sessionKey, path, rows, lineCount, clearFrom);
	} catch (error) {
		console.error('Failed to record truncated served rows:', error);
	}
}

export async function driftReported(sessionKey: string, path: string): Promise<Set<string>> {
	try {
		const store = await loadHashStore();
		return getReported(store, sessionKey, path);
	} catch (error) {
		console.error("Failed to load reported drift set:", error);
		return new Set();
	}
}

export async function markDriftReported(
	sessionKey: string,
	path: string,
	hashes: string[],
): Promise<void> {
	try {
		const store = await loadHashStore();
		addReported(store, sessionKey, path, hashes);
	} catch (error) {
		console.error("Failed to record reported drift set:", error);
	}
}

export async function clearDriftReported(sessionKey: string, path: string): Promise<void> {
	try {
		const store = await loadHashStore();
		clearReported(store, sessionKey, path);
	} catch (error) {
		console.error("Failed to clear reported drift set:", error);
	}
}

export async function wipeServedState(sessionKey: string): Promise<void> {
	try {
		const store = await loadHashStore();
		wipeServed(store, sessionKey);
	} catch (error) {
		console.error("Failed to wipe served state:", error);
	}
}
