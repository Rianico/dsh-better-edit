import { loadHashStore, type HashStore } from "./hash-store.js";
import { isValidHashList } from "./snapshot-store.js";

export interface UndoRecord {
	content: string;
	bom: string;
	ending: string;
	hashes: string[];
	resultContent: string;
}

export function upsertUndo(
	store: HashStore,
	path: string,
	entry: UndoRecord,
): void {
	store.stmts.undoUpsert(
		path,
		entry.content,
		entry.bom,
		entry.ending,
		JSON.stringify(entry.hashes),
		entry.resultContent,
		Date.now(),
	);
}

export function getUndoEntry(
	store: HashStore,
	path: string,
): UndoRecord | undefined {
	const row = store.stmts.undoGet(path);
	if (!row) return undefined;
	try {
		const parsed = JSON.parse(row.hashes as string);
		if (!isValidHashList(parsed)) {
			store.stmts.undoDelete(path);
			return undefined;
		}
		return {
			content: row.content as string,
			bom: row.bom as string,
			ending: row.ending as string,
			hashes: parsed as string[],
			resultContent: row.result_content as string,
		};
	} catch {
		store.stmts.undoDelete(path);
		return undefined;
	}
}

export function deleteUndo(store: HashStore, path: string): void {
	store.stmts.undoDelete(path);
}

export async function readUndo(path: string): Promise<UndoRecord | undefined> {
	const store = await loadHashStore();
	return getUndoEntry(store, path);
}

export async function writeUndo(
	path: string,
	entry: UndoRecord,
): Promise<void> {
	const store = await loadHashStore();
	upsertUndo(store, path, entry);
}

export async function removeUndo(path: string): Promise<void> {
	const store = await loadHashStore();
	deleteUndo(store, path);
}
