import type { ServedRow } from "./hashline/anchor-pipeline.js";
import { genDiff } from "./edit-diff.js";
import { formatWarning } from "./domain-errors.js";
import { truncateHead, formatSize } from "./file-view.js";
import { clipLine } from "./utils.js";

export type EditDetails = {
  diff: string;
  /** Bare `E_*` code for the primary error signal, if any (no `[TO MODEL]` prefix). Structured counterpart to message-string codes. */
  errCode?: string;
  /** Disambiguator for `E_UNSERVED_RANGE`: boundary miss vs interior hole. */
  unservedKind?: "boundary" | "interior";
  firstChangedLine?: number;
  snapshotId?: string;
  classification?: "noop";
  metrics?: RMetrics;
  servedRows?: ServedRow[];
  servedByPath?: Array<{ path: string; servedRows: ServedRow[] }>;
  warnings?: string[];
  driftNotice?: string;
  /** A dry run: the diff is hypothetical and no anchor was served. */
  dryRun?: boolean;
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
  const base = input.diff + warnBlock(input.warnings);
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

const DIFF_CARD_MAX_LINES = 400;
const DIFF_CARD_MAX_BYTES = 80 * 1024;

function formatDiffCard(diff: string): string {
  if (!diff || diff.trim().length === 0) return "";
  const truncation = truncateHead(diff, {
    maxLines: DIFF_CARD_MAX_LINES,
    maxBytes: DIFF_CARD_MAX_BYTES,
  });
  const fenced = `\n\n\`\`\`diff\n${truncation.content}\n\`\`\``;
  if (!truncation.truncated) return fenced;
  const hint = truncation.firstLineExceedsLimit
    ? `[Diff truncated: first line exceeds ${formatSize(truncation.maxBytes)} — use read to inspect file]`
    : `[Diff truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}) — re-read file to see full content]`;
  return `${fenced}\n\n${hint}`;
}

export function buildNoop(input: NoopInput): TResult {
  const { path, noopEdit, snapshotId, editMeta, warnings, driftNotice } = input;

  const noopDetailsText = noopEdit
    ? `Edit for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
    : "The edit produced identical content.";
  const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${warnBlock(warnings)}`;

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
  served?: readonly (string | null)[];
};

export type BatchDetails = EditDetails;

export function buildBatchResult(sections: BatchSection[], dryRun = false): TResult {
  const totalEdits = sections.reduce((n, s) => n + s.appliedCount + s.noopCount, 0);
  const appliedFiles = sections.filter((s) => s.appliedCount > 0);
  const appliedTotal = appliedFiles.reduce((n, s) => n + s.appliedCount, 0);
  const noopTotal = sections.reduce((n, s) => n + s.noopCount, 0);
  const addedLines = sections.reduce((n, s) => n + s.totalAddedLines, 0);
  const removedLines = sections.reduce((n, s) => n + s.totalRemovedLines, 0);
  const allNoop = appliedTotal === 0;
  // WHY (#144 T3): one diff per applied section, computed once — it feeds the rendered rows, the
  // WHY: served mirror and the applied-tier disclosure, so the three can never disagree.
  const diffBySection = new Map<BatchSection, ReturnType<typeof genDiff>>();
  const disclosureBySection = new Map<BatchSection, string>();
  for (const s of appliedFiles) {
    const diffResult = genDiff(
      s.originalNormalized,
      s.result,
      1,
      s.resultHashes,
      s.originalHashes,
      s.served,
      dryRun,
    );
    diffBySection.set(s, diffResult);
    const unserved = diffResult.unservedRemovedLines;
    if (unserved.length > 0) {
      disclosureBySection.set(
        s,
        formatWarning("W_UNSERVED_INTERIOR", {
          unservedLines: unserved,
          replacedLineCount: diffResult.removedLineCount,
        }),
      );
    }
  }
  // WHY (#144 T3): a fold keeps section order; one disclosure per committed file, never per row.
  const warnings = sections.flatMap((s) => {
    const disclosure = disclosureBySection.get(s);
    return [...(s.warnings ?? []), ...(disclosure === undefined ? [] : [disclosure])];
  });
  // An empty section is "that file reported no drift", so it must not contribute a blank paragraph
  // to the join; an all-clean batch therefore has no notice at all to publish.
  const notices = sections
    .map((s) => s.driftNotice)
    .filter((d): d is string => d !== undefined && d.length > 0);
  const driftNotice = notices.length > 0 ? notices.join("\n\n") : undefined;

  if (allNoop) {
    // WHY (#145 T3): metrics keep the live vocabulary ("applied"/"noop") because it names the
    // outcome the bytes WOULD have; only the header and `details.dryRun` mark that nothing was written.
    const text = dryRun
      ? `[DRY RUN] No changes would be made. All ${totalEdits} edit(s) in the batch would produce identical content.\nClassification: noop${warnBlock(warnings)}`
      : `No changes made. All ${totalEdits} edit(s) in the batch produced identical content.\nClassification: noop${warnBlock(warnings)}`;
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
        // WHY (#145 T3): a preview served no row, so it says so with the same empty arrays an applied
        // preview publishes; an absent field would read as "not projected", not as "served nothing".
        ...(dryRun ? { dryRun: true, servedRows: [], servedByPath: [] } : {}),
        ...(driftNotice === undefined ? {} : { driftNotice }),
      },
    };
  }

  const servedByPath: Array<{ path: string; servedRows: ServedRow[] }> = [];
  const diffParts: string[] = [];
  for (const s of appliedFiles) {
    const diffResult = diffBySection.get(s)!;
    diffParts.push(`--- ${s.path} ---\n${diffResult.diff}`);
    const denseRows: typeof diffResult.servedRows = [];
    for (let i = 0; i < s.resultHashes.length; i++) {
      denseRows.push({ position: i, hash: s.resultHashes[i]! });
    }
    // WHY (#145): a dry run commits nothing, so every anchor in its diff would name bytes that never
    // landed. Publishing none keeps a lease from being minted from the hypothetical result.
    if (!dryRun && denseRows.length > 0) {
      servedByPath.push({ path: s.path, servedRows: denseRows });
    }
  }
  const diff = diffParts.join("\n\n");

  const countsChanged = addedLines > 0 || removedLines > 0;
  const lineSummary = countsChanged
    ? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
    : "";
  // WHY (#145 T3): the dry clause is hypothetical — a preview added and removed nothing.
  const dryLineSummary = countsChanged
    ? ` Would add ${addedLines} line(s), remove ${removedLines} line(s).`
    : "";
  // WHY (#145 T3): metrics keep the live vocabulary ("applied"/"noop") because it names the outcome
  // the bytes WOULD have; only the `[DRY RUN]` header and `details.dryRun` mark that nothing was written.
  const summary = dryRun
    ? `[DRY RUN] Validated ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) would be applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${dryLineSummary}`
    : `Successfully edited ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${lineSummary}`;
  const baseText = `${summary}${warnBlock(warnings)}`;
  const diffSection = formatDiffCard(diff);
  const text = `${baseText}${diffSection}`;

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
      ...(dryRun ? { dryRun: true } : {}),
      servedRows: servedByPath.flatMap((e) => e.servedRows),
      servedByPath,
      ...(driftNotice === undefined ? {} : { driftNotice }),
    },
  };
}
