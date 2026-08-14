import { stat } from "fs/promises";
import { HASH_RE } from "./hashline/alphabet.js";
import { contentChecksum } from "./hashline/hasher.js";
import { splitLines } from "./utils.js";
import { loadHashStore, withStore, type HashStore } from "./hash-store.js";

export interface LegacySnapshot {
	content: string;
	hashes: string[];
}

export function isValidHashList(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const hash of value) {
		if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
	}
	return true;
}

export function isValidSnapshot(value: unknown): value is LegacySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.content !== "string") return false;
	return isValidHashList(v.hashes);
}

export function getSnapshot(
	store: HashStore,
	path: string,
	content: string,
	deleteCorrupt = true,
): string[] | undefined {
	const checksum = contentChecksum(content);
	const lineCount = splitLines(content).length;
	const row = store.stmts.get(path, checksum, lineCount);
	if (!row) return undefined;
	try {
		const parsed = JSON.parse(row.hashes as string);
		if (isValidHashList(parsed)) return parsed;
		if (deleteCorrupt) store.stmts.deleteOne(path);
		return undefined;
	} catch {
		if (deleteCorrupt) store.stmts.deleteOne(path);
		return undefined;
	}
}

export function upsertSnapshot(
	store: HashStore,
	path: string,
	checksum: string,
	lineCount: number,
	hashes: string[],
): void {
	store.stmts.upsert(
		path,
		checksum,
		lineCount,
		JSON.stringify(hashes),
		Date.now(),
	);
}

export async function findSnapshotPathsByHashes(
	hashes: string[],
): Promise<string[]> {
	const store = await loadHashStore();
	return findSnapshotPaths(store, hashes);
}

export async function pruneMissingAll(): Promise<void> {
	const store = await loadHashStore();
	await pruneMissing(store);
}

export async function upsertSnapshotFor(
	path: string,
	checksum: string,
	lineCount: number,
	hashes: string[],
): Promise<void> {
	const store = await loadHashStore();
	upsertSnapshot(store, path, checksum, lineCount, hashes);
}

export function findSnapshotPaths(
	store: HashStore,
	hashes: string[],
): string[] {
	const rows = store.stmts.allHashes() as { path: string; hashes: string }[];
	const matches: string[] = [];
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.hashes) as unknown;
			if (!isValidHashList(parsed)) continue;
			if (hashes.every((h) => parsed.includes(h))) matches.push(row.path);
		} catch {
			continue;
		}
	}
	return matches;
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
	const missing: string[] = [];
	for (let i = 0; i < rows.length; i += STAT_BATCH) {
		const batch = rows.slice(i, i + STAT_BATCH);
		const results = await Promise.all(
			batch.map(async (row) => {
				try {
					await stat(row.path);
					return undefined;
				} catch {
					return row.path;
				}
			}),
		);
		for (const path of results) {
			if (path !== undefined) missing.push(path);
		}
	}
	return missing;
}

export async function pruneMissing(store: HashStore): Promise<void> {
	const rows = store.stmts.allPaths() as { path: string }[];
	const missing = await statMissing(rows);
	if (missing.length === 0) return;
	withStore(() => {
		for (const path of missing) {
			store.stmts.deleteOne(path);
			store.stmts.undoDelete(path);
			store.stmts.servedDeletePath(path);
		}
	});
}
