import type { ServedRow } from "./hashline/served.js";
import { genDiff } from "./edit-diff.js";
import { visLines, clipLine } from "./utils.js";

export type EditDetails = {
	diff: string;
	firstChangedLine?: number;
	snapshotId?: string;
	classification?: "noop";
	metrics?: RMetrics;
	servedRows?: ServedRow[];
	servedByPath?: Array<{ path: string; servedRows: ServedRow[] }>;
	warnings?: string[];
	driftNotice?: string;
};
type TResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: EditDetails;
};

export type RMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type RMeta = {
	editsAttempted: number;
	noopEditsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines: number;
	removedLines: number;
};

type NEditEntry = {
	loc: string;
	currentContent: string;
};

export interface NoopInput {
	path: string;
	noopEdit: NEditEntry | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	warnings: string[] | undefined;
	driftNotice?: string;
}

export interface SuccessInput {
	path: string;
	originalNormalized: string;
	originalHashes: string[];
	result: string;
	resultHashes: string[];
	warnings: string[] | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	driftNotice?: string;
}

export function buildMetrics(args: {
	classification: "applied" | "noop";
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): RMetrics {
	const metrics: RMetrics = {
		edits_attempted: args.editsAttempted,
		edits_noop: args.noopEditsCount,
		warnings: args.warningsCount,
		classification: args.classification,
	};
	if (
		args.classification === "applied" &&
		args.firstChangedLine !== undefined &&
		args.lastChangedLine !== undefined
	) {
		metrics.changed_lines = {
			first: args.firstChangedLine,
			last: args.lastChangedLine,
		};
	}
	if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
	if (args.removedLines !== undefined) metrics.removed_lines = args.removedLines;
	return metrics;
}

export interface FinalizeInput {
	diff: string;
	warnings?: string[];
	driftNotice?: string;
}

export function finalizeResult(input: FinalizeInput): string {
	const modelWarnings = input.warnings?.filter(
		(w) => !w.startsWith("Batch drift note:"),
	);
	const base = input.diff + warnBlock(modelWarnings);
	return base;
}

export function finalizeToolResult(details: EditDetails): {
	content: Array<{ type: "text"; text: string }>;
	servedRows: ServedRow[] | undefined;
} {
	const text = finalizeResult({
		diff: details.diff,
		warnings: details.warnings,
		driftNotice: details.driftNotice,
	});
	return { content: [{ type: "text", text }], servedRows: details.servedRows };
}

function warnBlock(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\n${warnings.join("\n")}` : "";
}

function driftBlock(driftNotice: string | undefined): string {
	return driftNotice ? `\n\n${driftNotice}` : "";
}

export function buildNoop(input: NoopInput): TResult {
	const { path, noopEdit, snapshotId, editMeta, warnings, driftNotice } = input;

	const noopDetailsText = noopEdit
		? `Edit for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
		: "The edit produced identical content.";
	const modelWarnings = warnings?.filter(
		(w) => !w.startsWith("Batch drift note:"),
	);
	const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${warnBlock(modelWarnings)}`;

	const metrics = buildMetrics({
		classification: "noop",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop" as const,
			metrics,
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
			...(driftNotice === undefined ? {} : { driftNotice }),
		},
	};
}

export function buildChanged(input: SuccessInput): TResult {
	const {
		path,
		result,
		warnings,
		snapshotId,
		originalNormalized,
		originalHashes,
		editMeta,
		resultHashes,
		driftNotice,
	} = input;
	const resultLines = visLines(result);
	const diffResult = genDiff(
		originalNormalized,
		result,
		1,
		resultHashes,
		originalHashes,
	);
	const addedLines = editMeta.addedLines;
	const removedLines = editMeta.removedLines;
	const modelWarnings = warnings?.filter(
		(w) => !w.startsWith("Batch drift note:"),
	);
	const warningsBlock = warnBlock(modelWarnings);
	const successPrefix = `Successfully edited in ${path}.`;
	const lineSummary =
		addedLines > 0 || removedLines > 0
			? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
			: "";
	const text =
		resultLines.length === 0
			? "File is empty. Use edit to insert content."
			: warningsBlock
				? `${successPrefix}${lineSummary}${warningsBlock}`
				: `${successPrefix}${lineSummary}`;

	const metrics = buildMetrics({
		classification: "applied",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		addedLines,
		removedLines,
	});
	const denseServedRows: typeof diffResult.servedRows = [];
	for (let i = 0; i < resultHashes.length; i++) {
		denseServedRows.push({ position: i, hash: resultHashes[i]! });
	}

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: editMeta.firstChangedLine ?? diffResult.firstChangedLine,
			snapshotId,
			metrics,
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
			servedRows: denseServedRows,
			...(driftNotice === undefined ? {} : { driftNotice }),
		},
	};
}

export type BatchSection = {
	path: string;
	originalNormalized: string;
	result: string;
	originalHashes: string[];
	resultHashes: string[];
	warnings: string[] | undefined;
	driftNotice: string | undefined;
	appliedCount: number;
	noopCount: number;
	totalAddedLines: number;
	totalRemovedLines: number;
};

export type BatchDetails = EditDetails;

export function buildBatchResult(sections: BatchSection[]): TResult {
	const totalEdits = sections.reduce(
		(n, s) => n + s.appliedCount + s.noopCount,
		0,
	);
	const appliedFiles = sections.filter((s) => s.appliedCount > 0);
	const appliedTotal = appliedFiles.reduce((n, s) => n + s.appliedCount, 0);
	const noopTotal = sections.reduce((n, s) => n + s.noopCount, 0);
	const addedLines = sections.reduce((n, s) => n + s.totalAddedLines, 0);
	const removedLines = sections.reduce((n, s) => n + s.totalRemovedLines, 0);
	const allNoop = appliedTotal === 0;
	const warnings = sections.flatMap((s) => s.warnings ?? []);
	const driftNotice = sections
		.map((s) => s.driftNotice)
		.filter((d): d is string => d !== undefined)
		.join("\n\n");

	if (allNoop) {
		const modelWarnings = warnings.filter(
			(w) => !w.startsWith("Batch drift note:"),
		);
		const text = `No changes made. All ${totalEdits} edit(s) in the batch produced identical content.\nClassification: noop${warnBlock(modelWarnings)}`;
		return {
			content: [{ type: "text", text }],
			details: {
				diff: "",
				classification: "noop" as const,
				metrics: buildMetrics({
					classification: "noop",
					editsAttempted: totalEdits,
					noopEditsCount: noopTotal,
					warningsCount: warnings.length,
				}),
				...(warnings.length > 0 ? { warnings } : {}),
				...(driftNotice === undefined ? {} : { driftNotice }),
			},
		};
	}

	const servedByPath: Array<{ path: string; servedRows: ServedRow[] }> = [];
	const diffParts: string[] = [];
	for (const s of appliedFiles) {
		const diffResult = genDiff(
			s.originalNormalized,
			s.result,
			1,
			s.resultHashes,
			s.originalHashes,
		);
		diffParts.push(`--- ${s.path} ---\n${diffResult.diff}`);
		const denseRows: typeof diffResult.servedRows = [];
		for (let i = 0; i < s.resultHashes.length; i++) {
			denseRows.push({ position: i, hash: s.resultHashes[i]! });
		}
		if (denseRows.length > 0) {
			servedByPath.push({ path: s.path, servedRows: denseRows });
		}
	}
	const diff = diffParts.join("\n\n");

	const lineSummary =
		addedLines > 0 || removedLines > 0
			? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
			: "";
	const summary = `Successfully edited ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${lineSummary}`;
	const modelWarnings = warnings.filter(
		(w) => !w.startsWith("Batch drift note:"),
	);
	const text = `${summary}${warnBlock(modelWarnings)}`;

	return {
		content: [{ type: "text", text }],
		details: {
			diff,
			metrics: buildMetrics({
				classification: "applied",
				editsAttempted: totalEdits,
				noopEditsCount: noopTotal,
				warningsCount: warnings.length,
				addedLines,
				removedLines,
			}),
			...(warnings.length > 0 ? { warnings } : {}),
			servedRows: servedByPath.flatMap((e) => e.servedRows),
			servedByPath,
			...(driftNotice === undefined ? {} : { driftNotice }),
		},
	};
}
