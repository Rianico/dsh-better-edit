/**
 * AnchorPipeline — deep module owning the anchor autofix chain.
 *
 * Single ordering invariant (private):
 *   swapReversed → stripBare → stripDiff → valEdit → verifyServed → resToSpan
 *
 * This seam co-locates the ordering invariant. Public surface is two functions:
 *   resEdit  — pre-validation (tool-layer, no file state)
 *   applyEdit — full pipeline (file + hashes + served verification)
 *
 * Private to this seam (not re-exported): stripBarePrefixes, stripDiffPrefixes,
 * swapReversedRanges, valEdit, warnUnicodeEsc,
 * resAnchorFromMap, assertAligned, etc. They remain exported from resolve.ts
 * for backwards compat but are marked @internal and should be imported via this
 * module only.
 *
 * @module dsh-better-edit/hashline/anchor-pipeline
 */

import { abortIf, splitLines, rejectUnknownFields, clipLine } from "../utils.js";
import { HASH_CLASS, HL_BARE_PREFIX_RE, HL_PREFIX_PLUS_RE, HL_PREFIX_MINUS_RE, HASH_SEP, ANCHOR_LEN, ALPH_RE, canon, lineHashesPure, getCanonForHash, rememberHashCanon } from "./hash-assign.js";
import { recordServed, servedPositionsOf } from "../session-view.js";
import { SERVED_ECHO_CAP } from "../constants.js";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants.js";

export type Anchor = { hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
	}

	if (/^\d+/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.`;
	}

	if (trimmed.includes("│") && trimmed.includes("\n")) {
		const lines = trimmed.split("\n");
		const first = lines[0] ?? "";
		const last = lines[lines.length - 1] ?? "";
		const hashRe = new RegExp(HASH_CLASS);
		const firstMatch = first.match(hashRe);
		const lastMatch = last.match(hashRe);
		const firstHash = firstMatch?.[0] ?? "wUp";
		const lastHash = lastMatch?.[0] ?? "AU6";
		const preview = first.slice(0, 60);
		return `[E_BAD_REF] Invalid anchor — remove_from must be a single bare 3-char hash (e.g. "wUp"), not a block with HASH│. Received ${lines.length} lines starting "${preview}…" — use only the first hash "${firstHash}" as remove_from and "${lastHash}" as remove_to, and put the new content (without HASH│) in replacement_text.`;
	}
	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${trimmed}". remove_from and remove_to must contain the 3-char hash only — remove everything from "│" onward.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-char alphanumeric anchor (e.g. "aB3").`;
}

function parseRef(ref: string): Anchor {
	const trimmed = ref.trim();

	if (
		trimmed.length === ANCHOR_LEN &&
		ALPH_RE.test(trimmed)
	) {
		return { hash: trimmed };
	}

	throw new Error(diagRef(ref));
}

export const parseHashRef = parseRef;

export function parseText(edit: string): string[] {
  if (typeof edit !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  const normalized = edit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  if (/^\n+$/.test(normalized)) return new Array(normalized.length).fill("");
  return normalized.split("\n");
}


export type RAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
	content_lines: string[];
	hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
	context?: RAnchor;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
	replacement_text: string;
	remove_from: string;
	remove_to: string;
};

function resAnchorFromMap(
	ref: Anchor,
	hashIndex: Map<string, number[]>,
): RAnchor | HMismatch {
	const hashMatches = hashIndex.get(ref.hash);
	if (!hashMatches || hashMatches.length === 0) {
		return { ref, kind: "not_found" };
	}
	if (hashMatches.length === 1) {
		return {
			line: hashMatches[0]!,
			hash: ref.hash,
			hashMatched: true,
		};
	}
	return { ref, kind: "ambiguous", candidates: hashMatches };
}

function assertAligned(
	fileLines: string[],
	fileHashes: string[],
	ctx: string,
): void {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`${ctx}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
}

function fmtMismatchWithServes(
	mismatches: HMismatch[],
	fileLines: string[],
	fileHashes: string[],
	filePath?: string,
): { message: string; servedRows: ServedRow[] } {
	assertAligned(fileLines, fileHashes, "fmtMismatch");

	const out: string[] = [];
	const servedRows: ServedRow[] = [];
	const seen = new Set<number>();
	const pushRow = (ln: number) => {
		if (ln < 1 || ln > fileLines.length) return;
		const position = ln - 1;
		if (seen.has(position)) return;
		seen.add(position);
		servedRows.push({ position, hash: fileHashes[ln - 1]! });
	};
	const notFound = mismatches.filter((m) => m.kind === "not_found");
	const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

	const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
	if (notFound.length > 0) {
		out.push(
			`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. Re-read for fresh anchors.`,
		);
		for (const m of notFound) {
			const ctx = m.context;
			if (!ctx) continue;
			const from = Math.max(1, ctx.line - 1);
			const to = Math.min(fileLines.length, ctx.line + 1);
			const rows: string[] = [];
			for (let ln = from; ln <= to; ln++) {
				rows.push(
					`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? "")}`,
				);
				pushRow(ln);
			}
			out.push("");
			out.push(
				`  Current context around resolved anchor "${ctx.hash}" (line ${ctx.line}):\n${rows.join("\n")}`,
			);
		}
	}
	if (ambiguous.length > 0) {
		if (out.length > 0) out.push("");
		out.push(
			`[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Re-read for fresh anchors.`,
		);
		for (const m of ambiguous) {
			const sample = (m.candidates ?? []).slice(0, 5);
			const more =
				(m.candidates?.length ?? 0) > sample.length
					? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
					: "";
			const lines = sample
				.map((line) => {
					const content = clipLine(fileLines[line - 1] ?? "");
					pushRow(line);
					return `    ${line}: ${fileHashes[line - 1]}│${content}`;
				})
				.join("\n");
			out.push(
				`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
			);
		}
	}

	return { message: out.join("\n"), servedRows };
}

const ITEM_KS = new Set(["replacement_text", "remove_from", "remove_to"]);

function assertItem(edit: Record<string, unknown>): void {
	rejectUnknownFields(
		edit,
		ITEM_KS,
		"Edit",
		"The edit takes only { replacement_text, remove_from, remove_to }.",
	);

	if ("remove_from" in edit && typeof edit.remove_from !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_from" must be an anchor string (3-char hash).`,
		);
	}
	if ("remove_to" in edit && typeof edit.remove_to !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_to" must be an anchor string (3-char hash).`,
		);
	}
	if (!("replacement_text" in edit)) {
		throw new Error(
			`[E_BAD_SHAPE] The edit requires a "replacement_text" field. Provide the replacement text (use "" to delete).`,
		);
	}
	if (typeof edit.replacement_text !== "string") {
		throw new Error(NEW_CONTENT_NOT_STRING_MSG);
	}
	if (
		typeof edit.remove_from !== "string" ||
		typeof edit.remove_to !== "string"
	) {
		throw new Error(
			`[E_BAD_SHAPE] The edit requires "remove_from" and "remove_to" anchor strings (3-char hashes from read output).`,
		);
	}
}

const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(${HASH_CLASS})│`);
function firstHashFromBlock(block: string): string | undefined {
	for (const line of block.split("\n")) {
		const m = line.match(ANCHOR_ROW_RE);
		if (m) return m[2]!;
		const bare = line.match(new RegExp(HASH_CLASS));
		if (bare) return bare[0]!;
	}
	return undefined;
}

export function resEdit(edit: HTEdit, warnings?: string[]): HEdit {
	assertItem(edit as Record<string, unknown>);

	const editLines = parseText(edit.replacement_text);
	const bounds = [edit.remove_from, edit.remove_to].map((ref) => {
		const trimmed = ref.trim();
		if (trimmed.includes("\n")) {
			const hash = firstHashFromBlock(trimmed);
			if (hash) {
				const lines = trimmed.split("\n").length;
				warnings?.push(`[E_BAD_REF] extracted first hash "${hash}" from ${lines}-line block — use bare "${hash}" next time`);
				return hash;
			}
		}
		const match = trimmed.match(ANCHOR_ROW_RE);
		if (match) {
			let message: string;
			if (match[1] === "+") {
				message = `[E_BAD_REF] stripped diff-preview marker from remove_from/remove_to "${trimmed}".`;
			} else if (match[1] === "-") {
				message = `[E_BAD_REF] stripped leading "-" marker from remove_from/remove_to "${trimmed}".`;
			} else {
				message = `[E_BAD_REF] stripped "HASH│" prefix from remove_from/remove_to "${trimmed}".`;
			}
			warnings?.push(message);
			return match[2]!;
		}
		return ref;
	}) as [string, string];
	return {
		content_lines: editLines,
		hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
	};
}

function warnUnicodeEsc(edit: HEdit, warnings: string[]): void {
	if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
		warnings.push(
			"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
		);
	}
}

/** @internal — private to anchor-pipeline seam; do not import directly, use anchor-pipeline.ts */
function stripBarePrefixes(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
): HEdit {
	const fileHashSet = new Set(fileHashes);
	const stripped: { lineIndex: number; matched: boolean }[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const match = line.match(HL_BARE_PREFIX_RE);
		if (!match) return line;
		stripped.push({ lineIndex, matched: fileHashSet.has(match[1]!) });
		return line.slice(match[0].length);
	});
	if (stripped.length === 0) return edit;
	const locations = stripped
		.map((s) => `replacement_text line ${s.lineIndex + 1}`)
		.join(", ");
	const matchedCount = stripped.filter((s) => s.matched).length;
	const evidence = matchedCount === 0 ? "0 matched — verify literal 'HASH│' content" : `${matchedCount}/${stripped.length} matched`;
	if (matchedCount === stripped.length) {
		warnings.push(
			`[info E_BARE_HASH_PREFIX] stripped "HASH│" prefix from ${locations} (${evidence}) — use bare content without HASH│ next time.`,
		);
	} else {
		warnings.push(
			`[E_BARE_HASH_PREFIX] stripped "HASH│" prefix from ${locations} (${evidence}).`,
		);
	}
	return { ...edit, content_lines: contentLines };
}

/** @internal — private to anchor-pipeline seam */
function stripDiffPrefixes(edit: HEdit, warnings: string[]): HEdit {
	const stripped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const plus = line.match(HL_PREFIX_PLUS_RE);
		if (plus) {
			stripped.push(lineIndex);
			return line.slice(plus[0].length);
		}
		const minus = line.match(HL_PREFIX_MINUS_RE);
		if (minus) {
			stripped.push(lineIndex);
			return line.slice(minus[0].length);
		}
		return line;
	});
	if (stripped.length === 0) return edit;
	const locations = stripped
		.map((i) => `replacement_text line ${i + 1}`)
		.join(", ");
	warnings.push(
		`[E_INVALID_PATCH] stripped diff-preview marker from ${locations}.`,
	);
	return { ...edit, content_lines: contentLines };
}

/** @internal — private to anchor-pipeline seam */
function swapReversedRanges(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
): HEdit {
	const lineByHash = new Map<string, number>();
	for (let i = 0; i < fileHashes.length; i++) {
		lineByHash.set(fileHashes[i]!, i + 1);
	}
	const [startRef, endRef] = edit.hash_bounds;
	const startLine = lineByHash.get(startRef.hash);
	const endLine = lineByHash.get(endRef.hash);
	if (
		startLine === undefined ||
		endLine === undefined ||
		startLine <= endLine
	) {
		return edit;
	}
	warnings.push(
		`[E_BAD_OP] reversed remove_from/remove_to (${startRef.hash} after ${endRef.hash}); swapped.`,
	);
	return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

/** @internal — private to anchor-pipeline seam */
function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): {
	resolved: RHEdit | undefined;
	mismatches: HMismatch[];
} {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];

	const hashIndex = new Map<string, number[]>();
	for (let i = 0; i < fileHashes.length; i++) {
		const h = fileHashes[i]!;
		const list = hashIndex.get(h) ?? [];
		list.push(i + 1);
		hashIndex.set(h, list);
	}

	const tryResolve = (ref: Anchor): RAnchor | undefined => {
		const result = resAnchorFromMap(ref, hashIndex);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	abortIf(signal);
	const startResolved = tryResolve(edit.hash_bounds[0]);
	const endResolved = tryResolve(edit.hash_bounds[1]);
	if (!startResolved || !endResolved) {
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast(
				(m) => m.ref === edit.hash_bounds[0],
			);
			if (startMismatch && startMismatch.kind === "not_found")
				startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast(
				(m) => m.ref === edit.hash_bounds[1],
			);
			if (endMismatch && endMismatch.kind === "not_found")
				endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].hash}).`,
		);
	}
	const endLine = endResolved.line;
	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
		},
		mismatches,
	};
}

export function findNewEdge(): undefined { return undefined; }

export { warnUnicodeEsc };


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

export function findEditHashEcho(
	replacementLines: string[],
	served: readonly (string | null)[],
	startLine: number,
): { k: number; hash: string } | undefined {
	for (let k = 0; k < replacementLines.length; k++) {
		const pos = startLine + k - 1;
		if (pos < served.length && served[pos] !== null && replacementLines[k]!.startsWith(served[pos]! + HASH_SEP)) {
			return { k: k + 1, hash: served[pos]! };
		}
	}
	return undefined;
}

export class EditHashEchoError extends AnchorMismatchError {
	constructor(message: string, servedRows: ServedRow[] = []) {
		super(message, servedRows);
		this.name = "EditHashEchoError";
	}
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
	return "Retry with these anchors (no read needed).";
}

function paginationHint(nextOffset: number, more: number): string {
	return `[... ${more} more — read offset=${nextOffset}]`;
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
	servedCanons?: (string | null)[];
	tombstone?: ReadonlySet<string>;
	epochSnapshotId?: string;
	curSnapshotId?: string;
	strictPos?: boolean;
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
	const tombstone = args.tombstone ?? new Set<string>();
	const servedCanons = args.servedCanons;
	const strictPos = args.strictPos ?? false;
	const epochSnapshotId = args.epochSnapshotId;
	const curSnapshotId = args.curSnapshotId;
	let isHealed = false;
	for (let i = 0; i < fileHashes.length; i++) {
		const h = fileHashes[i]!;
		if (getCanonForHash(h) === undefined)
			rememberHashCanon(h, canon(fileLines[i] ?? ""));
	}
	for (let i = 0; i < served.length; i++) {
		const h = served[i];
		if (h !== null && getCanonForHash(h) === undefined) {
			const pos = fileHashes.indexOf(h);
			if (pos >= 0) rememberHashCanon(h, canon(fileLines[pos] ?? ""));
		}
	}
	const echoRows = buildRangeEcho(startLine, endLine, fileHashes);
	const totalLen = endLine - startLine + 1;
	const tail =
		echoRows.length < totalLen
			? `\n${paginationHint(startLine + echoRows.length, totalLen - echoRows.length)}`
			: "";
	const echo = fmtServedRows(echoRows, fileLines) + tail;

	// Tombstone check for boundaries (whole-span S@3==S@3)
	// If hash was freed in this epoch, any reuse is stale even at same pos+same canon.
	// Early reject checks canon change to avoid false positive on same line re-read.
	if (tombstone.has(startHash) || tombstone.has(endHash)) {
		const tombstonedHash = tombstone.has(startHash) ? startHash : endHash;
		if (servedCanons) {
			const pos = fileHashes.indexOf(tombstonedHash);
			if (pos >= 0) {
				const servedIdx = served.indexOf(tombstonedHash);
				const expected = servedIdx >= 0 ? servedCanons[servedIdx] : undefined;
				const actual = canon(fileLines[pos] ?? "");
				if (expected !== undefined && expected !== null && expected !== actual) {
					throw new ServedRejectionError({
						code: "E_RANGE_STALE",
						message: `[E_RANGE_STALE] anchor "${tombstonedHash}" was freed since last full read (tombstoned, canon changed from "${expected}" to "${actual}"). Re-read.\nCurrent range:\n${echo}`,
						firstOffendingLine: pos + 1,
						servedRows: echoRows,
					});
				}
			}
		}
	}

	const startPositions = servedPositionsOf(served, startHash);
	const endPositions = servedPositionsOf(served, endHash);
	const currentLen = endLine - startLine + 1;
	let from: number | undefined;
	let to: number | undefined;
	if (startPositions.length === 1 && endPositions.length === 1) {
		from = Math.min(startPositions[0]!, endPositions[0]!);
		to = Math.max(startPositions[0]!, endPositions[0]!);
	} else {
		const candidates: Array<{ from: number; to: number }> = [];
		for (const s of startPositions) {
			for (const e of endPositions) {
				const candFrom = Math.min(s, e);
				const candTo = Math.max(s, e);
				if (candTo - candFrom + 1 !== currentLen) continue;
				let ok = true;
				for (let k = 0; k < currentLen; k++) {
					if (served[candFrom + k] !== fileHashes[startLine - 1 + k]) {
						ok = false;
						break;
					}
				}
				if (ok) candidates.push({ from: candFrom, to: candTo });
			}
		}
		if (candidates.length === 1) {
			from = candidates[0]!.from;
			to = candidates[0]!.to;
		} else if (candidates.length > 1) {
			candidates.sort(
				(a, b) =>
					Math.abs(a.from - (startLine - 1)) - Math.abs(b.from - (startLine - 1)),
			);
			from = candidates[0]!.from;
			to = candidates[0]!.to;
		}
	}
	if (from === undefined || to === undefined) {
		let healed: { from: number; to: number } | undefined;
		if (startPositions.length === 1 && endPositions.length === 1) {
			const sPos = startPositions[0]!;
			const ePos = endPositions[0]!;
			const servedFrom = Math.min(sPos, ePos);
			const servedTo = Math.max(sPos, ePos);
			const servedLen = servedTo - servedFrom + 1;
			if (servedLen === currentLen) {
				const expectedCanons: string[] = [];
				let canBuild = true;
				for (let k = 0; k < servedLen; k++) {
					const h = served[servedFrom + k];
					if (h === null) {
						canBuild = false;
						break;
					}
					const c = getCanonForHash(h);
					if (c === undefined) {
						canBuild = false;
						break;
					}
					expectedCanons.push(c);
				}
				if (canBuild) {
					const matches: number[] = [];
					for (let i = 0; i <= fileLines.length - servedLen; i++) {
						let ok = true;
						for (let k = 0; k < servedLen; k++) {
							if (canon(fileLines[i + k] ?? "") !== expectedCanons[k]) {
								ok = false;
								break;
							}
						}
						if (ok) matches.push(i);
						if (matches.length > 1) break;
					}
					if (matches.length === 1) {
						healed = { from: matches[0]!, to: matches[0]! + servedLen - 1 };
					}
				}
			}
		}
		if (!healed) {
			const hasServed = served.some((h) => h !== null);
			const startInFile = fileHashes.includes(startHash);
			const endInFile = fileHashes.includes(endHash);
			if (hasServed && (!startInFile || !endInFile)) {
				const startCanon = getCanonForHash(startHash);
				const endCanon = getCanonForHash(endHash);
				if (startCanon !== undefined && endCanon !== undefined) {
					const startMatches: number[] = [];
					const endMatches: number[] = [];
					for (let i = 0; i < fileLines.length; i++) {
						if (canon(fileLines[i] ?? "") === startCanon) startMatches.push(i);
						if (canon(fileLines[i] ?? "") === endCanon) endMatches.push(i);
						if (startMatches.length > 1 && endMatches.length > 1) break;
					}
					if (startMatches.length === 1 && endMatches.length === 1) {
						const s = startMatches[0]!;
						const e = endMatches[0]!;
						const healedFrom = Math.min(s, e);
						const healedTo = Math.max(s, e);
						if (healedTo - healedFrom + 1 === currentLen) {
							let interiorOk = true;
							if (currentLen > 2) {
								const healedCanons = [];
								for (let k = 0; k < currentLen; k++)
									healedCanons.push(canon(fileLines[healedFrom + k] ?? ""));
								let count = 0;
								for (let i = 0; i <= fileLines.length - currentLen; i++) {
									let ok = true;
									for (let k = 0; k < currentLen; k++)
										if (canon(fileLines[i + k] ?? "") !== healedCanons[k]) {
											ok = false;
											break;
										}
									if (ok) count++;
									if (count > 1) break;
								}
								if (count !== 1) interiorOk = false;
							}
							if (interiorOk) healed = { from: healedFrom, to: healedTo };
						}
					}
				}
			}
		}
		if (healed) {
			from = healed.from;
			to = healed.to;
			isHealed = true;
		} else {
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
					`[E_RANGE_UNVERIFIED] cannot verify range against served state${where}: ${problems.join("; ")}. ` +
					`No served span matched the current range (${currentLen} lines). ` +
					`A full read will re-sync the served mirror — the echoed range below is current content, ` +
					`but retrying without re-reading cannot clear a stale duplicate outside the echoed window.\n` +
					`Current range:\n${echo}`,
				servedRows: echoRows,
			});
		}
	}

	if (isHealed) {
		for (let k = 0; k < currentLen; k++) {
			const servedHash = served[from + k];
			if (servedHash === null) continue;
			const expectedCanon = getCanonForHash(servedHash);
			const actualCanon = canon(fileLines[from + k] ?? "");
			if (expectedCanon !== undefined && expectedCanon !== actualCanon) {
				const offendingLine = from + k + 1;
				throw new ServedRejectionError({
					code: "E_RANGE_STALE",
					message: `[E_RANGE_STALE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: offendingLine,
					servedRows: echoRows,
				});
			}
		}
	} else {
		for (let i = from; i <= to; i++) {
			if (served[i] === null) {
				throw new ServedRejectionError({
					code: "E_RANGE_UNSERVED",
					message: `[E_RANGE_UNSERVED] line ${i + 1}${where} was never served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: i + 1,
					servedRows: echoRows,
				});
			}
		}
		const servedLen = to - from + 1;
		if (servedLen !== currentLen) {
			let lenHealed = false;
			const expectedCanons: string[] = [];
			let canBuild = true;
			for (let k = 0; k < servedLen; k++) {
				const h = served[from + k];
				if (h === null) {
					canBuild = false;
					break;
				}
				const c = getCanonForHash(h);
				if (c === undefined) {
					canBuild = false;
					break;
				}
				expectedCanons.push(c);
			}
			if (canBuild) {
				let matches = 0;
				for (let i = 0; i <= fileLines.length - servedLen; i++) {
					let ok = true;
					for (let k = 0; k < servedLen; k++)
						if (canon(fileLines[i + k] ?? "") !== expectedCanons[k]) {
							ok = false;
							break;
						}
					if (ok) matches++;
					if (matches > 1) break;
				}
				if (matches === 1) lenHealed = true;
			}
			if (!lenHealed) {
				throw new ServedRejectionError({
					code: "E_RANGE_STALE",
					message: `[E_RANGE_STALE] served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: startLine,
					servedRows: echoRows,
				});
			}
		}
		// Strict pos check for concurrency (pos-free vs strict)
		if (strictPos && from !== startLine - 1) {
			throw new ServedRejectionError({
				code: "E_RANGE_STALE",
				message: `[E_RANGE_STALE] anchor was served at line ${from + 1} but now resolves to line ${startLine} (pos-restricted concurrency). Re-read.\nCurrent range:\n${echo}`,
				firstOffendingLine: startLine,
				servedRows: echoRows,
			});
		}
		// Canon check for same-pos different content (collision)
		if (servedCanons) {
			for (let k = 0; k < servedLen; k++) {
				const expected = servedCanons[from + k];
				if (expected !== null && expected !== undefined) {
					const actual = canon(fileLines[startLine - 1 + k] ?? "");
					if (expected !== actual) {
						throw new ServedRejectionError({
							code: "E_RANGE_STALE",
							message: `[E_RANGE_STALE] line ${startLine + k}${where} canon differs from served (expected "${expected}" vs actual "${actual}").\nCurrent range:\n${echo}`,
							firstOffendingLine: startLine + k,
							servedRows: echoRows,
						});
					}
				}
			}
		}
		// Tombstone interior check (whole-span) — gated on canon inequality (fail-closed only for different canon)
		for (let k = 0; k < servedLen; k++) {
			const h = fileHashes[startLine - 1 + k];
			if (h && tombstone.has(h)) {
				const expectedCanon = servedCanons?.[from + k] ?? undefined;
				const actualCanon = canon(fileLines[startLine - 1 + k] ?? "");
				if (expectedCanon !== undefined && expectedCanon !== null && expectedCanon !== actualCanon) {
					throw new ServedRejectionError({
						code: "E_RANGE_STALE",
						message: `[E_RANGE_STALE] line ${startLine + k}${where} uses tombstoned anchor "${h}" (freed since last full read, canon changed). Re-read.\nCurrent range:\n${echo}`,
						firstOffendingLine: startLine + k,
						servedRows: echoRows,
					});
				}
			}
		}
		for (let k = 0; k < servedLen; k++) {
			if (served[from + k] !== fileHashes[startLine - 1 + k]) {
				const offendingLine = startLine + k;
				throw new ServedRejectionError({
					code: "E_RANGE_STALE",
					message: `[E_RANGE_STALE] line ${offendingLine}${where} differs from what was served.\nCurrent range:\n${echo}\n${retryHint()}`,
					firstOffendingLine: offendingLine,
					servedRows: echoRows,
				});
			}
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


type LIdx = {
	fileLines: string[];
	lineStarts: number[];
};

export function buildIdx(content: string): LIdx {
	const fileLines = splitLines(content);
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
	};
}

type RESpan = {
	kind: "replace";
	start: number;
	end: number;
	replacement: string;
};

type NoopSpan = {
	kind: "noop";
	loc: string;
	currentContent: string;
};
function assertNotEmpty(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Cannot empty a non-empty file via edit. Use `write` if you need to clear the file.",
		);
	}
}

function resToSpan(
	edit: RHEdit,
	content: string,
	lineIndex: LIdx,
): RESpan | NoopSpan {
	const { fileLines, lineStarts } = lineIndex;

	const startLine = edit.hash_bounds[0].line;
	const endLine = edit.hash_bounds[1].line;
	const originalLines = fileLines.slice(startLine - 1, endLine);
	if (
		originalLines.length === edit.content_lines.length &&
		originalLines.every(
			(line, lineIndex) => line === edit.content_lines[lineIndex],
		)
	) {
		return {
			kind: "noop",
			loc: edit.hash_bounds[0].hash,
			currentContent: originalLines.join("\n"),
		};
	}

	if (edit.content_lines.length > 0) {
		return {
			kind: "replace",
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
			replacement: edit.content_lines.join("\n"),
		};
	}

	if (startLine === 1 && endLine === fileLines.length) {
		return {
			kind: "replace",
			start: 0,
			end: content.length,
			replacement: "",
		};
	}

	if (endLine < fileLines.length) {
		return {
			kind: "replace",
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine]!,
			replacement: "",
		};
	}

	if (content.endsWith("\n")) {
		return {
			kind: "replace",
			start: lineStarts[startLine - 1]!,
			end: content.length,
			replacement: "",
		};
	}

	const prevLine = startLine >= 2 ? fileLines[startLine - 2] : undefined;
	return {
		kind: "replace",
		start:
			prevLine !== undefined && prevLine.length === 0
				? lineStarts[startLine - 1]!
				: Math.max(0, lineStarts[startLine - 1]! - 1),
		end: content.length,
		replacement: "",
	};
}

function assemble(
	content: string,
	span: RESpan,
	signal: AbortSignal | undefined,
): string {
	abortIf(signal);
	return (
		content.slice(0, span.start) + span.replacement + content.slice(span.end)
	);
}

export function applyEdit(
	content: string,
	edit: HEdit,
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
	served?: (string | null)[],
	servedCanons?: (string | null)[],
	tombstone?: ReadonlySet<string>,
	epochSnapshotId?: string,
	curSnapshotId?: string,
	strictPos?: boolean,
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	range: ResolvedRange;
	warnings?: string[];
	noopEdit?: NEdit;
} {
	abortIf(signal);

	const lineIndex = buildIdx(content);
	const fileHashes = precomputedHashes ?? lineHashesPure(content);
	const warnings: string[] = [];

	const rangeFixed = swapReversedRanges(edit, fileHashes, warnings);
	const prefixFixed = stripDiffPrefixes(
		stripBarePrefixes(rangeFixed, fileHashes, warnings),
		warnings,
	);

	const {
		resolved: initialResolved,
		mismatches,
	} = valEdit(prefixFixed, lineIndex.fileLines, fileHashes, warnings, signal);
	if (mismatches.length || !initialResolved) {
		const { message, servedRows } = fmtMismatchWithServes(
			mismatches,
			lineIndex.fileLines,
			fileHashes,
			filePath,
		);
		throw new AnchorMismatchError(message, servedRows);
	}

	warnUnicodeEsc(prefixFixed, warnings);

	const resolved = initialResolved;

if (served) {
		const startLineEcho = resolved.hash_bounds[0].line;
		const rawEcho = findEditHashEcho(edit.content_lines, served, startLineEcho);
		let echo = rawEcho;
		if (!echo) echo = findEditHashEcho(resolved.content_lines, served, startLineEcho);
		if (!echo) echo = findEditHashEcho(prefixFixed.content_lines, served, startLineEcho);
		if (echo) {
			const msg = `[E_EDIT_HASH_ECHO] Refused edit to ${filePath ?? "(unknown file)"}: replacement line ${echo.k} begins with the exact ${echo.hash}${HASH_SEP} anchor served for this session, path, and range-relative line. Remove the copied anchors and retry. Nothing was written.`;
			throw new EditHashEchoError(msg, []);
		}
		const startAnchor = resolved.hash_bounds[0];
		const endAnchor = resolved.hash_bounds[1];
		verifyServedRange({
			served,
			startHash: startAnchor.hash,
			endHash: endAnchor.hash,
			startLine: startAnchor.line,
			endLine: endAnchor.line,
			fileHashes,
			fileLines: lineIndex.fileLines,
			filePath,
			servedCanons,
			tombstone,
			epochSnapshotId,
			curSnapshotId,
			strictPos,
		});
	}

	const spanResult = resToSpan(resolved, content, lineIndex);
	if (spanResult.kind === "noop") {
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
			range: resolvedRange(resolved),
			...(warnings.length ? { warnings } : {}),
			noopEdit: {
				loc: spanResult.loc,
				currentContent: spanResult.currentContent,
			},
		};
	}

	const result = assemble(content, spanResult, signal);
	assertNotEmpty(content, result);
	const changed = changedRange(content, result);

	return {
		content: result,
		firstChangedLine: changed?.firstChangedLine,
		lastChangedLine: changed?.lastChangedLine,
		range: resolvedRange(resolved),
		...(warnings.length ? { warnings } : {}),
	};
}

function resolvedRange(resolved: RHEdit): ResolvedRange {
	const [start, end] = resolved.hash_bounds;
	return {
		startLine: start.line,
		endLine: end.line,
		startHash: start.hash,
		endHash: end.hash,
		delta:
			resolved.content_lines.length - (Math.abs(end.line - start.line) + 1),
	};
}

export function fmtRegion(hashes: string[], lines: string[]): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	return lines
		.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`)
		.join("\n");
}

export function changedRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: splitLines(result).length,
		};
	}

	const originalLines = splitLines(original);
	const resultLines = splitLines(result);

	if (
		originalLines.length === resultLines.length &&
		originalLines.every((line, index) => line === resultLines[index])
	) {
		return null;
	}

	const minLen = Math.min(originalLines.length, resultLines.length);
	let first = 0;
	while (first < minLen && originalLines[first] === resultLines[first]) {
		first++;
	}
	let lastOrig = originalLines.length - 1;
	let lastRes = resultLines.length - 1;
	while (
		lastOrig >= first &&
		lastRes >= first &&
		originalLines[lastOrig] === resultLines[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}
	return {
		firstChangedLine: first + 1,
		lastChangedLine: Math.max(first, lastRes) + 1,
	};
}

// ---------------------------------------------------------------------------
// Sealed seam — single public entry for hashline (Candidate 5)
// HashAssign allocation + hash persistence re-exported here so callers import
// only from anchor-pipeline. Private modules (hash-assign, hash, hasher,
// alphabet, pure, parse, apply, resolve, served) are @internal and guarded
// by biome noRestrictedImports. Deleting this re-export block would scatter
// the hashline surface again — it concentrates (deep).
// ---------------------------------------------------------------------------
export {
  HASH_RE,
  HASH_CLASS,
  HASH_SEP,
  ANCHOR_LEN,
  ALPH_RE,
  ALPH,
  HASH_LEN,
  HASH_SPACE,
  MAX_HASH_LINES,
  HASH_PROBE_STRIDE,
  CANON_VERSION,
  canon,
  lineHashesPure,
  mapStableHashes,
  initHasher,
  contentChecksum,
  getCanonForHash,
  rememberHashCanon,
} from "./hash-assign.js";
export { lineHashes } from "./hash.js";
