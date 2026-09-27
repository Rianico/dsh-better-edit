import * as Diff from "diff";
import { DIFF_REMOVED_CAP, DIFF_REMOVED_EDGE } from "./constants.js";
import { lineHashesPure, ANCHOR_LEN, HASH_SEP } from "./hashline/index.js";
import type { ServedRow } from "./hashline/anchor-pipeline.js";

export type LineEnding = "\r\n" | "\n" | "\r";

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

const ELLIPSIS_MARKER: unique symbol = Symbol("ellipsis");
const isEllipsisMarker = (line: string | symbol): line is symbol => line === ELLIPSIS_MARKER;

function formatRemovedLines(
  displayLines: string[],
  oldContentHashes: string[] | undefined,
  oldLineNum: number,
): { rows: string[]; nextOldLineNum: number } {
  const rows: string[] = [];
  let cursor = oldLineNum;
  const emit = (line: string): void => {
    const hash = oldContentHashes?.[cursor - 1];
    rows.push(fmtDiffLine("-", line, hash));
    cursor++;
  };
  if (displayLines.length <= DIFF_REMOVED_CAP) {
    for (const line of displayLines) emit(line);
    return { rows, nextOldLineNum: cursor };
  }
  const omitted = displayLines.length - DIFF_REMOVED_EDGE * 2;
  for (const line of displayLines.slice(0, DIFF_REMOVED_EDGE)) emit(line);
  // WHY: ADR-0024/D3 — the model sees the deletion's head, tail, and exact size; the omitted rows
  // WHY: still advance the cursor so every later row keeps its exact old line number and hash.
  rows.push(` - ... [${omitted} lines omitted] ...`);
  cursor += omitted;
  for (const line of displayLines.slice(-DIFF_REMOVED_EDGE)) emit(line);
  return { rows, nextOldLineNum: cursor };
}

export function genDiff(
  oldContent: string,
  newContent: string,
  contextLines = 2,
  newContentHashes?: string[],
  oldContentHashes?: string[],
): {
  diff: string;
  firstChangedLine: number | undefined;
  servedRows: ServedRow[];
} {
  const effectiveNewHashes = newContentHashes ?? lineHashesPure(newContent);

  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const servedRows: ServedRow[] = [];
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
          const hash = effectiveNewHashes[newLineNum - 1];
          output.push(fmtDiffLine("+", displayLines[k]!, hash));
          if (hash !== undefined) {
            servedRows.push({ position: newLineNum - 1, hash });
          }
          newLineNum++;
        }
      } else {
        const removed = formatRemovedLines(displayLines, oldContentHashes, oldLineNum);
        for (const row of removed.rows) output.push(row);
        oldLineNum = removed.nextOldLineNum;
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
        const tail = displayLines.slice(-contextLines);
        linesToShow = [...displayLines.slice(0, contextLines), ELLIPSIS_MARKER, ...tail];
        skipMiddle = displayLines.length - contextLines * 2;
      } else if (linesToShow.length > contextLines) {
        linesToShow = linesToShow.slice(0, contextLines);
      }

      if (skipStart > 0) {
        output.push(" ...");
        newLineNum += skipStart;
        oldLineNum += skipStart;
      }
      for (const line of linesToShow) {
        if (isEllipsisMarker(line)) {
          output.push(" ...");
          newLineNum += skipMiddle;
          oldLineNum += skipMiddle;
          continue;
        }
        const hash = effectiveNewHashes[newLineNum - 1];
        output.push(fmtDiffLine(" ", line, hash));
        if (hash !== undefined) {
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

  return { diff: output.join("\n"), firstChangedLine, servedRows };
}
