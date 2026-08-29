/**
 * AnchorPipeline — deep module owning the anchor autofix chain.
 *
 * Single ordering invariant (private):
 *   swapReversed → stripBare → stripDiff → valEdit → boundaryDups splice → valEdit → verifyServed → resToSpan
 *
 * Detection (valEdit → boundaryDups[]) and correction (splice + second valEdit)
 * were split across resolve.ts / apply.ts with an implicit coupling.
 * This seam co-locates that invariant. Public surface is two functions:
 *   resEdit  — pre-validation (tool-layer, no file state)
 *   applyEdit — full pipeline (file + hashes + served verification)
 *
 * Private to this seam (not re-exported): stripBarePrefixes, stripDiffPrefixes,
 * swapReversedRanges, valEdit, boundaryDups helpers, warnUnicodeEsc, findNewEdge,
 * resAnchorFromMap, assertAligned, etc. They remain exported from resolve.ts
 * for backwards compat but are marked @internal and should be imported via this
 * module only.
 *
 * @module dsh-better-edit/hashline/anchor-pipeline
 */

import { abortIf, splitLines, rejectUnknownFields, firstNonEmptyIndex, lastNonEmptyIndex, clipLine } from "../utils.js";
import { HASH_CLASS, HL_BARE_PREFIX_RE, HL_PREFIX_PLUS_RE, HL_PREFIX_MINUS_RE, HASH_SEP, ANCHOR_LEN, ALPH_RE, canon, lineHashesPure, getCanonForHash, rememberHashCanon } from "./hash-assign.js";
import { recordServed, servedPositionsOf } from "../served-store.js";
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

export interface BDup {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	replacementLineIndex: number;
}

export interface AutoFix {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	removedLine: string;
	removedLineIndex: number;
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

export function resEdit(edit: HTEdit, warnings?: string[]): HEdit {
	assertItem(edit as Record<string, unknown>);

	const editLines = parseText(edit.replacement_text);
	const bounds = [edit.remove_from, edit.remove_to].map((ref) => {
		const trimmed = ref.trim();
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
	warnings.push(
		`[E_BARE_HASH_PREFIX] stripped "HASH│" prefix from ${locations} (${evidence}).`,
	);
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

function trailingDups(
	contentLines: string[],
	fileLines: string[],
	endLine: number,
): BDup[] {
	const start = lastNonEmptyIndex(contentLines);
	if (start < 0) return [];
	const dups: BDup[] = [];
	const maxK = Math.min(start + 1, fileLines.length - endLine);
	for (let k = 0; k < maxK; k++) {
		if (contentLines[start - k] !== fileLines[endLine + k]) break;
		dups.push({ kind: "trailing", replacementLineIndex: start - k });
	}
	return dups;
}

function leadingDups(
	contentLines: string[],
	fileLines: string[],
	startLine: number,
): BDup[] {
	const start = firstNonEmptyIndex(contentLines);
	if (start < 0) return [];
	const dups: BDup[] = [];
	const maxK = Math.min(contentLines.length - start, startLine - 1);
	for (let k = 0; k < maxK; k++) {
		if (contentLines[start + k] !== fileLines[startLine - 2 - k]) break;
		dups.push({ kind: "leading", replacementLineIndex: start + k });
	}
	return dups;
}

function sectionIsUnique(
	canonLines: string[],
	start: number,
	length: number,
): boolean {
	let count = 0;
	for (let i = 0; i + length <= canonLines.length; i++) {
		let k = 0;
		while (k < length && canonLines[i + k] === canonLines[start + k]) k++;
		if (k < length) continue;
		count++;
		if (count > 1) return false;
	}
	return true;
}

function firstNewAfterDups(
	contentLines: string[],
	rangeLines: string[],
	canonLines: string[],
	endLine: number,
): BDup[] {
	const firstNew = findNewEdge(contentLines, rangeLines, false);
	if (!firstNew) return [];
	const maxK = Math.min(
		contentLines.length - firstNew.index,
		canonLines.length - endLine,
	);
	let runLen = 0;
	while (
		runLen < maxK &&
		canon(contentLines[firstNew.index + runLen]!) ===
			canonLines[endLine + runLen]!
	) {
		runLen++;
	}
	if (runLen === 0 || !sectionIsUnique(canonLines, endLine, runLen)) return [];
	const dups: BDup[] = [];
	for (let k = 0; k < runLen; k++) {
		dups.push({
			kind: "first-new-after",
			replacementLineIndex: firstNew.index + k,
		});
	}
	return dups;
}

function lastNewBeforeDups(
	contentLines: string[],
	rangeLines: string[],
	canonLines: string[],
	startLine: number,
): BDup[] {
	const lastNew = findNewEdge(contentLines, rangeLines, true);
	if (!lastNew) return [];
	const maxK = Math.min(lastNew.index + 1, startLine - 1);
	let runLen = 0;
	while (
		runLen < maxK &&
		canon(contentLines[lastNew.index - runLen]!) ===
			canonLines[startLine - 2 - runLen]!
	) {
		runLen++;
	}
	if (runLen === 0) return [];
	const sectionStart = startLine - 1 - runLen;
	if (!sectionIsUnique(canonLines, sectionStart, runLen)) return [];
	const dups: BDup[] = [];
	for (let k = 0; k < runLen; k++) {
		dups.push({
			kind: "last-new-before",
			replacementLineIndex: lastNew.index - k,
		});
	}
	return dups;
}

function canonCounts(lines: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const key = canon(line);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** @internal — private to anchor-pipeline seam */
export function findNewEdge(
	contentLines: string[],
	rangeLines: string[],
	fromEnd: boolean,
): { index: number; line: string } | undefined {
	const multiset = canonCounts(rangeLines);
	const step = fromEnd ? -1 : 1;
	const start = fromEnd ? contentLines.length - 1 : 0;
	for (let i = start; i >= 0 && i < contentLines.length; i += step) {
		const line = contentLines[i]!;
		if (line.length === 0) continue;
		const key = canon(line);
		const count = multiset.get(key) ?? 0;
		if (count > 0) {
			multiset.set(key, count - 1);
		} else {
			return { index: i, line };
		}
	}
	return undefined;
}

/** @internal — private to anchor-pipeline seam: detection + boundaryDups belongs to AnchorPipeline ordering */
function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): {
	resolved: RHEdit | undefined;
	mismatches: HMismatch[];
	boundaryDups: BDup[];
} {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];
	const boundaryDups: BDup[] = [];

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
		return { resolved: undefined, mismatches, boundaryDups };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].hash}).`,
		);
	}
	const endLine = endResolved.line;
	const rangeLines = fileLines.slice(startResolved.line - 1, endLine);
	const canonLines = fileLines.map((line) => canon(line));
	boundaryDups.push(
		...trailingDups(edit.content_lines, fileLines, endLine),
		...leadingDups(edit.content_lines, fileLines, startResolved.line),
		...firstNewAfterDups(edit.content_lines, rangeLines, canonLines, endLine),
		...lastNewBeforeDups(
			edit.content_lines,
			rangeLines,
			canonLines,
			startResolved.line,
		),
	);

	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
		},
		mismatches,
		boundaryDups,
	};
}

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
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	range: ResolvedRange;
	warnings?: string[];
	noopEdit?: NEdit;
	autoFixes?: AutoFix[];
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
		boundaryDups,
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

	let resolved = initialResolved;
	let autoFixes: AutoFix[] | undefined;
	if (boundaryDups.length > 0) {
		autoFixes = [];
		const correctedEdit: HEdit = {
			...prefixFixed,
			content_lines: [...prefixFixed.content_lines],
		};
		const seen = new Set<number>();
		const uniqueDups: BDup[] = [];
		for (const dup of boundaryDups) {
			if (seen.has(dup.replacementLineIndex)) continue;
			seen.add(dup.replacementLineIndex);
			uniqueDups.push(dup);
		}
		const dupsByIndex = uniqueDups.sort(
			(a, b) => b.replacementLineIndex - a.replacementLineIndex,
		);
		for (const dup of dupsByIndex) {
			const idx = dup.replacementLineIndex;
			if (idx < 0 || idx >= correctedEdit.content_lines.length) continue;
			const removed = correctedEdit.content_lines.splice(idx, 1)[0];
			autoFixes.push({
				kind: dup.kind,
				removedLine: removed,
				removedLineIndex: idx,
			});
		}
		const correctedResult = valEdit(
			correctedEdit,
			lineIndex.fileLines,
			fileHashes,
			warnings,
			signal,
		);
		if (correctedResult.mismatches.length || !correctedResult.resolved) {
			const { message, servedRows } = fmtMismatchWithServes(
				correctedResult.mismatches,
				lineIndex.fileLines,
				fileHashes,
				filePath,
			);
			throw new AnchorMismatchError(message, servedRows);
		}
		resolved = correctedResult.resolved;
	}

	if (served) {
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
		...(autoFixes ? { autoFixes } : {}),
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
