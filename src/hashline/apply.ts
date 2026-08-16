import { abortIf, splitLines } from "../utils.js";
import { lineHashesPure, HASH_SEP } from "./pure.js";
import {
	AnchorMismatchError,
	verifyServedRange,
	type ResolvedRange,
} from "./served.js";
import {
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	warnUnicodeEsc,
	fmtMismatchWithServes,
	type RHEdit,
	type NEdit,
	type HEdit,
	type AutoFix,
	type BDup,
} from "./resolve.js";

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
