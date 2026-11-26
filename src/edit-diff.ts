import * as Diff from "diff";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "./constants.js";
import { lineHashesPure, ANCHOR_LEN, HASH_SEP } from "./hashline/index.js";
import type { ServedRow } from "./hashline/anchor-pipeline.js";

export type LineEnding = "\r\n" | "\n" | "\r";

/** Terminator counts by kind: a CRLF pair counts once, never as CR plus LF. */
export interface LineEndingCounts {
  readonly crlf: number;
  readonly lf: number;
  readonly cr: number;
}

export function detectEnding(content: string): LineEnding {
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) {
    return content.indexOf("\r") >= 0 ? "\r" : "\n";
  }
  const crlfIdx = content.indexOf("\r\n");
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(text: string, ending: LineEnding): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function fmtDiffLine(prefix: " " | "+" | "-", line: string, hash: string | undefined): string {
  if (hash === undefined) {
    return `${prefix}${" ".repeat(ANCHOR_LEN)}${HASH_SEP}${line}`;
  }
  return `${prefix}${hash}${HASH_SEP}${line}`;
}

const UNTOUCHED_MARKER: unique symbol = Symbol("untouched");
const isUntouchedMarker = (line: string | symbol): line is symbol => line === UNTOUCHED_MARKER;

function formatRemovedLines(
  displayLines: string[],
  oldContentHashes: string[] | undefined,
  oldLineNum: number,
  served: readonly (string | null)[] | undefined,
): { rows: string[]; nextOldLineNum: number; unservedRemovedLines: number[] } {
  const rows: string[] = [];
  const unservedRemovedLines: number[] = [];
  let cursor = oldLineNum;
  const emit = (line: string): void => {
    const unserved = served?.[cursor - 1] === null;
    if (unserved) unservedRemovedLines.push(cursor);
    const hash = unserved ? undefined : oldContentHashes?.[cursor - 1];
    rows.push(fmtDiffLine("-", line, hash));
    cursor++;
  };
  if (displayLines.length <= DIFF_REMOVED_CAP) {
    for (const line of displayLines) emit(line);
    return { rows, nextOldLineNum: cursor, unservedRemovedLines };
  }
  const omitted = displayLines.length - DIFF_REMOVED_EDGE * 2;
  for (const line of displayLines.slice(0, DIFF_REMOVED_EDGE)) emit(line);
  let hiddenUnserved = 0;
  for (let line = cursor; line < cursor + omitted; line++) {
    if (served?.[line - 1] === null) {
      hiddenUnserved++;
      unservedRemovedLines.push(line);
    }
  }
  const unservedSuffix = hiddenUnserved > 0 ? ` (${hiddenUnserved} unserved)` : "";
  rows.push(` - ... [${omitted} lines deleted]${unservedSuffix} ...`);
  cursor += omitted;
  for (const line of displayLines.slice(-DIFF_REMOVED_EDGE)) emit(line);
  return { rows, nextOldLineNum: cursor, unservedRemovedLines };
}

/** The renderer's own line split: `split("\n")` with the trailing empty element dropped. */
function renderLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** One alignment entry in render order: the old/new line index each rendered row consumes. */
type AlignmentEntry =
  | { readonly kind: "context"; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: "removed"; readonly oldIndex: number }
  | { readonly kind: "added"; readonly newIndex: number };

function flattenParts(parts: readonly Diff.Change[]): AlignmentEntry[] {
  const entries: AlignmentEntry[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const part of parts) {
    const count = renderLines(part.value).length;
    if (part.added) {
      for (let k = 0; k < count; k++) entries.push({ kind: "added", newIndex: newIndex + k });
      newIndex += count;
    } else if (part.removed) {
      for (let k = 0; k < count; k++) entries.push({ kind: "removed", oldIndex: oldIndex + k });
      oldIndex += count;
    } else {
      for (let k = 0; k < count; k++) {
        entries.push({ kind: "context", oldIndex: oldIndex + k, newIndex: newIndex + k });
      }
      oldIndex += count;
      newIndex += count;
    }
  }
  return entries;
}

interface LineMatch {
  readonly oldIndex: number;
  readonly newIndex: number;
}

/**
 * Order-preserving greedy pairing of old lines to new lines by line identity. Old lines are walked
 * ascending and each takes the earliest still-unclaimed new index after the previous match, so the
 * result is a monotone alignment: every matched index pair is used at most once.
 */
function matchLinesByAnchor(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldHashes: readonly string[],
  newHashes: readonly string[],
): LineMatch[] {
  const newIndexesByHash = new Map<string, number[]>();
  for (let j = 0; j < newHashes.length; j++) {
    const hash = newHashes[j]!;
    const indexes = newIndexesByHash.get(hash);
    if (indexes === undefined) newIndexesByHash.set(hash, [j]);
    else indexes.push(j);
  }
  const matches: LineMatch[] = [];
  let lastNewIndex = -1;
  for (let i = 0; i < oldHashes.length; i++) {
    const candidates = newIndexesByHash.get(oldHashes[i]!);
    if (candidates === undefined) continue;
    const newIndex = candidates.find((j) => j > lastNewIndex && newLines[j] === oldLines[i]);
    if (newIndex === undefined) continue;
    matches.push({ oldIndex: i, newIndex });
    lastNewIndex = newIndex;
  }
  return matches;
}

function changePart(kind: "context" | "removed" | "added", lines: readonly string[]): Diff.Change {
  return {
    value: lines.map((line) => `${line}\n`).join(""),
    count: lines.length,
    added: kind === "added",
    removed: kind === "removed",
  };
}

/** Rebuild `parts` from a monotone match list: gaps keep their old/new order, matches merge. */
function rebuildParts(
  oldLines: readonly string[],
  newLines: readonly string[],
  matches: readonly LineMatch[],
): Diff.Change[] {
  const parts: Diff.Change[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let contextRun: string[] = [];
  const flushContext = (): void => {
    if (contextRun.length === 0) return;
    parts.push(changePart("context", contextRun));
    contextRun = [];
  };
  for (const match of matches) {
    if (match.oldIndex > oldCursor) {
      flushContext();
      parts.push(changePart("removed", oldLines.slice(oldCursor, match.oldIndex)));
    }
    if (match.newIndex > newCursor) {
      flushContext();
      parts.push(changePart("added", newLines.slice(newCursor, match.newIndex)));
    }
    contextRun.push(oldLines[match.oldIndex]!);
    oldCursor = match.oldIndex + 1;
    newCursor = match.newIndex + 1;
  }
  flushContext();
  if (oldCursor < oldLines.length) parts.push(changePart("removed", oldLines.slice(oldCursor)));
  if (newCursor < newLines.length) parts.push(changePart("added", newLines.slice(newCursor)));
  return parts;
}

/**
 * Anchor refinement of the text diff (#151). A context pairing is valid only when both sides name
 * the SAME line identity: Myers pairs byte-identical lines by position, so two equal `dup` lines are
 * interchangeable to it — but not to the anchors, where the replaced line's anchor is retired and the
 * survivor keeps its own. Line identity therefore refines the text pairing, never the reverse.
 *
 * Returns `parts` untouched when no context pair disagrees on identity, and also when nothing matches
 * at all — a rewrite retires every identity, so the text diff is already the best projection there.
 */
function refinePartsByAnchor(
  parts: readonly Diff.Change[],
  oldLines: readonly string[],
  newLines: readonly string[],
  oldHashes: readonly string[],
  newHashes: readonly string[],
): readonly Diff.Change[] {
  const disagrees = flattenParts(parts).some(
    (entry) => entry.kind === "context" && oldHashes[entry.oldIndex] !== newHashes[entry.newIndex],
  );
  if (!disagrees) return parts;
  const matches = matchLinesByAnchor(oldLines, newLines, oldHashes, newHashes);
  if (matches.length === 0) return parts;
  return rebuildParts(oldLines, newLines, matches);
}

/**
 * The alignment `genDiff` renders. Myers text pairing is the base; both sides' anchors refine it only
 * when each array covers its own content line-for-line. A side without anchors stays on the
 * text-only path: the renderer cannot tell line identities apart there, so it must not guess.
 */
function diffParts(
  oldContent: string,
  newContent: string,
  oldContentHashes: string[] | undefined,
  newContentHashes: string[] | undefined,
): readonly Diff.Change[] {
  const parts = Diff.diffLines(oldContent, newContent);
  if (!Array.isArray(oldContentHashes) || !Array.isArray(newContentHashes)) return parts;
  const oldLines = renderLines(oldContent);
  const newLines = renderLines(newContent);
  if (oldContentHashes.length !== oldLines.length) return parts;
  if (newContentHashes.length !== newLines.length) return parts;
  return refinePartsByAnchor(parts, oldLines, newLines, oldContentHashes, newContentHashes);
}

/**
 * genDiff is the single diff projection (#169). Return contract:
 * - every emitted row's anchor equals the true new-file line content hash at that
 *   position; removed rows carry the true old-file hash when old hashes are provided.
 * - every emitted marker's count equals the span it hides:
 *   ` ... [N lines untouched] ...` advances both cursors past N hidden rows (lease-covered,
 *   they stay addressable through the served leases), and ` - ... [N lines deleted] ...`
 *   advances the old cursor past N deleted rows (cursor-exact).
 * - collapse invariant: a middle gap smaller than 2×context renders whole (#166/#172);
 *   at context 0 every non-empty middle gap collapses to a single counted untouched
 *   marker (#170); bare ` ...` appears only at leading/trailing edges; added spans are never collapsed.
 */
export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldContentHashes?: string[],
  served?: readonly (string | null)[],
  dryRun = false,
): {
  diff: string;
  firstChangedLine: number | undefined;
  servedRows: ServedRow[];
  unservedRemovedLines: number[];
  /** Every removed OLD line in the whole diff, whatever the fold cap and the mirror say. */
  removedLineCount: number;
} {
  const effectiveNewHashes = newContentHashes ?? lineHashesPure(newContent);

  const parts = diffParts(oldContent, newContent, oldContentHashes, newContentHashes);
  const output: string[] = [];
  const servedRows: ServedRow[] = [];
  const unservedRemovedLines: number[] = [];
  let removedLineCount = 0;
  let newLineNum = 1;
  let oldLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();
    const displayLines = raw;

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      if (part.added) {
        for (let k = 0; k < displayLines.length; k++) {
          const hash = dryRun ? undefined : effectiveNewHashes[newLineNum - 1];
          output.push(fmtDiffLine("+", displayLines[k]!, hash));
          if (hash !== undefined) {
            servedRows.push({ position: newLineNum - 1, hash });
          }
          newLineNum++;
        }
      } else {
        const removed = formatRemovedLines(displayLines, oldContentHashes, oldLineNum, served);
        for (const row of removed.rows) output.push(row);
        unservedRemovedLines.push(...removed.unservedRemovedLines);
        oldLineNum = removed.nextOldLineNum;
        removedLineCount += displayLines.length;
      }
      lastWasChange = true;
      continue;
    }

    const nextPartIsChange = i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
    if (lastWasChange || nextPartIsChange) {
      let linesToShow: (string | symbol)[] = displayLines;
      let skipStart = 0;
      let skipMiddle = 0;

      if (!lastWasChange) {
        skipStart = Math.max(0, displayLines.length - contextLines);
        linesToShow = displayLines.slice(skipStart);
      } else if (nextPartIsChange && displayLines.length > contextLines * 2) {
        const tail = contextLines === 0 ? [] : displayLines.slice(-contextLines);
        linesToShow = [...displayLines.slice(0, contextLines), UNTOUCHED_MARKER, ...tail];
        skipMiddle = displayLines.length - contextLines * 2;
      } else if (!nextPartIsChange && linesToShow.length > contextLines) {
        linesToShow = linesToShow.slice(0, contextLines);
      }

      if (skipStart > 0) {
        output.push(" ...");
        newLineNum += skipStart;
        oldLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (isUntouchedMarker(line)) {
          output.push(` ... [${skipMiddle} lines untouched] ...`);
          newLineNum += skipMiddle;
          oldLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        output.push(fmtDiffLine(" ", line, hash));
        if (hash !== undefined && !dryRun) {
          servedRows.push({ position: newLineNum - 1, hash });
        }
        newLineNum++;
        oldLineNum++;
      }
    } else {
      newLineNum += displayLines.length;
      oldLineNum += displayLines.length;
    }
    lastWasChange = false;
  }

  return {
    diff: output.join("\n"),
    firstChangedLine,
    servedRows,
    unservedRemovedLines,
    removedLineCount,
  };
}
