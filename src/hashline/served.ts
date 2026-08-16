import { HASH_SEP } from "./pure.js";
import { recordServed, servedPositionsOf } from "../served-state.js";
import { SERVED_ECHO_CAP } from "../constants.js";

export type ServedCode =
	| "E_RANGE_STALE"
	| "E_RANGE_UNSERVED"
	| "E_RANGE_UNVERIFIED";

export interface ServedRow {
	position: number;
	hash: string;
}

export class ServedRejectionError extends Error {
	readonly code: ServedCode;
	readonly firstOffendingLine: number | undefined;
	readonly servedRows: ServedRow[];

	constructor(opts: {
		code: ServedCode;
		message: string;
		firstOffendingLine?: number;
		servedRows: ServedRow[];
	}) {
		super(opts.message);
		this.name = "ServedRejectionError";
		this.code = opts.code;
		this.firstOffendingLine = opts.firstOffendingLine;
		this.servedRows = opts.servedRows;
	}
}

export function isServedRejection(
	error: unknown,
): error is ServedRejectionError {
	return error instanceof ServedRejectionError;
}

export class AnchorMismatchError extends Error {
	readonly servedRows: ServedRow[];

	constructor(message: string, servedRows: ServedRow[]) {
		super(message);
		this.name = "AnchorMismatchError";
		this.servedRows = servedRows;
	}
}

export function isAnchorMismatch(error: unknown): error is AnchorMismatchError {
	return error instanceof AnchorMismatchError;
}

export function buildRangeEcho(
	startLine: number,
	endLine: number,
	fileHashes: string[],
): ServedRow[] {
	const total = endLine - startLine + 1;
	const shown = Math.min(total, SERVED_ECHO_CAP);
	const rows: ServedRow[] = [];
	for (let ln = startLine; ln < startLine + shown; ln++) {
		rows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
	}
	return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
	return rows
		.map((row) => `${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`)
		.join("\n");
}

function retryHint(): string {
	return "Retry the edit with remove_from/remove_to copied from these fresh rows (no read needed).";
}

function paginationHint(nextOffset: number, more: number): string {
	return `[... ${more} more lines — use read with offset=${nextOffset} to see the rest]`;
}

export function verifyServedRange(args: {
	served: (string | null)[];
	startHash: string;
	endHash: string;
	startLine: number;
	endLine: number;
	fileHashes: string[];
	fileLines: string[];
	filePath?: string;
}): void {
	const {
		served,
		startHash,
		endHash,
		startLine,
		endLine,
		fileHashes,
		fileLines,
		filePath,
	} = args;
	const where = filePath ? ` in ${filePath}` : "";
	const echoRows = buildRangeEcho(startLine, endLine, fileHashes);
	const totalLen = endLine - startLine + 1;
	const tail =
		echoRows.length < totalLen
			? `\n${paginationHint(startLine + echoRows.length, totalLen - echoRows.length)}`
			: "";
	const echo = fmtServedRows(echoRows, fileLines) + tail;

	const startPositions = servedPositionsOf(served, startHash);
	const endPositions = servedPositionsOf(served, endHash);
	if (startPositions.length !== 1 || endPositions.length !== 1) {
		const problems: string[] = [];
		if (startPositions.length === 0) {
			problems.push(`remove_from "${startHash}" has no served position`);
		} else if (startPositions.length > 1) {
			problems.push(
				`remove_from "${startHash}" was served at ${startPositions.length} positions`,
			);
		}
		if (endPositions.length === 0) {
			problems.push(`remove_to "${endHash}" has no served position`);
		} else if (endPositions.length > 1) {
			problems.push(
				`remove_to "${endHash}" was served at ${endPositions.length} positions`,
			);
		}
		throw new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED] Cannot verify the range against served state${where}: ${problems.join("; ")}. ` +
				`The tool only verifies what it delivered to the model's context; a boundary anchor that cannot be verified is never guessed at. Current range:\n${echo}\n${retryHint()}`,
			servedRows: echoRows,
		});
	}

	const from = Math.min(startPositions[0]!, endPositions[0]!);
	const to = Math.max(startPositions[0]!, endPositions[0]!);

	for (let i = from; i <= to; i++) {
		if (served[i] === null) {
			throw new ServedRejectionError({
				code: "E_RANGE_UNSERVED",
				message: `[E_RANGE_UNSERVED] Line ${i + 1}${where} was never served to the model — the range includes lines the model has not seen. Current range:\n${echo}\n${retryHint()}`,
				firstOffendingLine: i + 1,
				servedRows: echoRows,
			});
		}
	}

	const servedLen = to - from + 1;
	const currentLen = endLine - startLine + 1;
	if (servedLen !== currentLen) {
		throw new ServedRejectionError({
			code: "E_RANGE_STALE",
			message: `[E_RANGE_STALE] The served span (${servedLen} lines) no longer matches the current range (${currentLen} lines)${where}. Current range:\n${echo}\n${retryHint()}`,
			firstOffendingLine: startLine,
			servedRows: echoRows,
		});
	}
	for (let k = 0; k < servedLen; k++) {
		if (served[from + k] !== fileHashes[startLine - 1 + k]) {
			const offendingLine = startLine + k;
			throw new ServedRejectionError({
				code: "E_RANGE_STALE",
				message: `[E_RANGE_STALE] Line ${offendingLine}${where} differs from what you were served — the file changed on disk since it was read. Current range:\n${echo}\n${retryHint()}`,
				firstOffendingLine: offendingLine,
				servedRows: echoRows,
			});
		}
	}
}

export interface ResolvedRange {
	startLine: number;
	endLine: number;
	startHash: string;
	endHash: string;
	delta: number;
}

export type ServeRecordPolicy = "live" | "preview";

export async function recordEchoServes(
	sessionKey: string,
	path: string,
	rows: ServedRow[],
	policy: ServeRecordPolicy,
	lineCount?: number,
): Promise<void> {
	if (policy !== "live") return;
	await recordServed(sessionKey, path, rows, lineCount);
}
