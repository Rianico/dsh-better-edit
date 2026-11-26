/**
 * One pure formatter owns BOTH unserved-interior messages, so the strict `[E_UNSERVED_RANGE]`
 * refusal and the hint `[W_UNSERVED_INTERIOR]` applied warning cannot drift in grammar, plural
 * agreement or list compression. Voice is the only difference: the summary clause and the trailing
 * remedy. Every number is an absolute FILE line, and the list is the `offset`/`limit` encoding
 * itself, so no prose read instruction is needed.
 *
 * WHY zero imports: this module is a leaf so `domain-errors` can import it and stay store-free.
 * The run cap is declared here rather than in `constants.ts` because `constants.ts` imports
 * `formatError` from `domain-errors.ts`, so a formatter → constants edge would cycle
 * `domain-errors → unserved-span-message → constants → domain-errors`.
 */

/** Max runs the unserved list renders before the hidden line count is appended. */
export const UNSERVED_LIST_MAX_RUNS = 8;

type UnservedSpanMessageInput =
  | {
      /** The refusal voice: nothing was written, so nothing is promised. */
      voice: "strict";
      path?: string;
      unservedLines: readonly number[];
      /** The resolved span length the edit replaces (`servedLen` in `verifyRebasedSpan`). */
      replacedLineCount: number;
    }
  | {
      /** The applied voice: the edit committed and this names what it replaced unseen. */
      voice: "hint";
      unservedLines: readonly number[];
      /** Every removed old-file line in the diff (`removedLineCount` in `genDiff`). */
      replacedLineCount: number;
    };

const HINT_REMEDY =
  "Edits should only modify lines previously read and served (enforced under strict mode); " +
  "verify this uninspected replacement was intended.";

/**
 * Ascending, de-duplicated `[first, last]` runs. Sorting and dropping repeats here is what lets
 * every caller pass raw collection order without owning the compression contract.
 */
function runsOf(lines: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last === undefined) {
      runs.push([line, line]);
      continue;
    }
    if (line <= last[1]) continue;
    if (line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}

const runWidth = ([first, last]: [number, number]): number => last - first + 1;

/**
 * The compressed absolute-line list: contiguous runs as `a-b`, comma-separated, capped at
 * `UNSERVED_LIST_MAX_RUNS` entries with the remaining LINE count appended. The cap spends its
 * budget on runs, because one long run is already one readable token.
 */
function unservedList(runs: ReadonlyArray<[number, number]>, lineCount: number): string {
  const shown = runs.slice(0, UNSERVED_LIST_MAX_RUNS);
  const entries = shown.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`));
  const hidden = lineCount - shown.reduce((total, run) => total + runWidth(run), 0);
  const label = lineCount === 1 ? "Unserved file line" : "Unserved file lines";
  const listed = entries.join(", ");
  if (hidden > 0) return `${label}: ${listed} (+${hidden} more ${hidden === 1 ? "line" : "lines"})`;
  return `${label}: ${listed}`;
}

const fileLines = (count: number): string => `${count} file ${count === 1 ? "line" : "lines"}`;

export function formatUnservedSpanMessage(input: UnservedSpanMessageInput): string {
  if (input.unservedLines.length === 0) {
    throw new TypeError("formatUnservedSpanMessage: requires at least one unserved line");
  }
  const runs = runsOf(input.unservedLines);
  const unserved = runs.reduce((total, run) => total + runWidth(run), 0);
  const agreement = unserved === 1 ? "was" : "were";
  const list = unservedList(runs, unserved);
  if (input.voice === "strict") {
    const path = input.path ?? "this file";
    return (
      `Strict span mode refused the edit to ${path}: ${unserved} of the ` +
      `${fileLines(input.replacedLineCount)} it replaces ${agreement} never served.\n${list}`
    );
  }
  return (
    `Span replaced ${fileLines(input.replacedLineCount)}, ${unserved} of which ` +
    `${agreement} never served; the edit applied.\n${list}\n${HINT_REMEDY}`
  );
}
