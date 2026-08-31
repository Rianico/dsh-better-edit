import { describe, expect, it } from "vitest";
import { applyEdit, lineHashes, resEdit, canon } from "../../src/hashline/index.js";
import {
  firstNonEmptyIndex,
  lastNonEmptyIndex,
  splitLines,
} from "../../src/utils.js";
import { useTestHome, expectedEditContent } from "../support/fixtures.js";

const home = useTestHome();

const VOCAB = [
  "",
  "}",
  "  foo",
  "import x",
  "dup",
  "dup",
  "a = 1;",
  "// c",
  "  bar",
  "a",
  "a ",
  "x",
  "x\t",
  "héllo",
  "  ",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

function randLine(rnd: () => number): string {
  return VOCAB[randInt(rnd, 0, VOCAB.length - 1)]!;
}

function randContent(rnd: () => number): string {
  const lines = Array.from({ length: randInt(rnd, 0, 25) }, () => randLine(rnd));
  const content = lines.join("\n");
  return rnd() < 0.5 ? content + "\n" : content;
}

function replToContent(repl: string[]): string {
  if (repl.length > 0 && repl.every((line) => line === "")) {
    return "\n".repeat(repl.length);
  }
  return repl.join("\n");
}

function randRepl(rnd: () => number, lines: string[], s: number, e: number): string[] {
  const n = lines.length;
  const prev = s >= 2 ? lines[s - 2] : undefined;
  const next = e < n ? lines[e] : undefined;
  if (rnd() < 0.15) return lines.slice(s - 1, e);
  const repl = Array.from({ length: randInt(rnd, 0, 4) }, () => randLine(rnd));
  if (repl.length > 0 && prev !== undefined && rnd() < 0.5) repl[0] = prev;
  if (repl.length > 0 && next !== undefined && rnd() < 0.5) repl[repl.length - 1] = next;
  const afterAvail = n - e;
  if (afterAvail >= 2 && rnd() < 0.3) {
    const runLen = randInt(rnd, 2, Math.min(4, afterAvail));
    for (let k = runLen - 1; k >= 0; k--) repl.unshift(lines[e + k]!);
  }
  const beforeAvail = s - 1;
  if (beforeAvail >= 2 && rnd() < 0.3) {
    const runLen = randInt(rnd, 2, Math.min(4, beforeAvail));
    for (let k = runLen - 1; k >= 0; k--) repl.push(lines[s - 2 - k]!);
  }
  return repl;
}

function sectionCount(lines: string[], start: number, length: number): number {
  const canonLines = lines.map((line) => canon(line));
  let count = 0;
  for (let i = 0; i + length <= canonLines.length; i++) {
    let k = 0;
    while (k < length && canonLines[i + k] === canonLines[start + k]) k++;
    if (k === length) count++;
  }
  return count;
}

function applyAutoFix(
  repl: string[],
  fileLines: string[],
  s: number,
  e: number,
): { fixed: string[]; fixes: { kind: string; removedLine: string; removedLineIndex: number }[] } {
  // boundaryDups removed — no auto-fix, pure replacement
  return { fixed: [...repl], fixes: [] };
}

type StepResult = {
  content: string;
  hashes: string[];
  autofixed: boolean;
  noop: boolean;
};

async function runStep(
  content: string,
  hashes: string[],
  path: string,
  rnd: () => number,
): Promise<StepResult | null> {
  const lines = splitLines(content);
  const n = lines.length;
  const s = randInt(rnd, 1, n);
  const e = randInt(rnd, s, n);
  const repl = randRepl(rnd, lines, s, e);
  const { fixed, fixes } = applyAutoFix(repl, lines, s, e);
  const expected = expectedEditContent(lines, s, e, fixed, content.endsWith("\n"));
  const edit = resEdit({
    remove_from: hashes[s - 1]!,
    remove_to: hashes[e - 1]!,
    replacement_text: replToContent(repl),
  });
  let result;
  try {
    result = applyEdit(content, edit, undefined, hashes, path);
  } catch (error) {
    if (error instanceof Error && /^\[E_WOULD_EMPTY\]/.test(error.message)) return null;
    throw error;
  }
  expect(result.content).toBe(expected);
  if (expected === content) {
    expect(result.autoFixes).toBeUndefined();
    const rehashed = await lineHashes(content, path, { content, hashes });
    expect(rehashed).toEqual(hashes);
    return { content, hashes, autofixed: fixes.length > 0, noop: true };
  }
  if (fixes.length > 0) {
    expect(result.autoFixes).toBeDefined();
    expect(result.autoFixes!.map((f) => f.kind)).toEqual(fixes.map((f) => f.kind));
    expect(result.autoFixes!.map((f) => f.removedLine)).toEqual(fixes.map((f) => f.removedLine));
    expect(result.autoFixes!.map((f) => f.removedLineIndex)).toEqual(fixes.map((f) => f.removedLineIndex));
  } else {
    expect(result.autoFixes).toBeUndefined();
  }
  const removedHashes = new Set(hashes.slice(s - 1, e));
  const resultHashes = await lineHashes(expected, path, { content, hashes, removedHashes });
  const newLines = splitLines(expected);
  expect(resultHashes).toHaveLength(newLines.length);
  expect(new Set(resultHashes).size).toBe(resultHashes.length);
  const shift = newLines.length - lines.length;
  for (let i = 0; i < s - 1; i++) {
    expect(resultHashes[i]).toBe(hashes[i]);
  }
  for (let i = e; i < lines.length; i++) {
    expect(resultHashes[i + shift]).toBe(hashes[i]);
  }
  const reloaded = await lineHashes(expected, path);
  expect(reloaded).toEqual(resultHashes);
  return { content: expected, hashes: resultHashes, autofixed: fixes.length > 0, noop: false };
}

describe("fuzz: boundary-dup autocorrection with hash stability", () => {
  it("applies 1500 random edits with boundary dups and keeps mapping invariants", async () => {
    let autofixed = 0;
    let noop = 0;
    for (let iter = 0; iter < 1500; iter++) {
      const rnd = mulberry32(iter * 32452843 + 5);
      const path = `${home.testPath}-fuzz-${iter}`;
      const content = randContent(rnd);
      const hashes = await lineHashes(content, path);
      const state = await runStep(content, hashes, path, rnd);
      if (!state) continue;
      if (state.autofixed) autofixed++;
      if (state.noop) noop++;
    }
    expect(autofixed).toBe(0);
    expect(noop).toBeGreaterThan(20);
  }, 120_000);

  it("keeps mapping invariants across chained random edits with boundary dups", async () => {
    let autofixed = 0;
    for (let iter = 0; iter < 100; iter++) {
      const rnd = mulberry32(iter * 15485867 + 11);
      const path = `${home.testPath}-chain-${iter}`;
      let content = randContent(rnd);
      let hashes = await lineHashes(content, path);
      let edited = 0;
      for (let step = 0; step < 8 && edited < 6; step++) {
        const state = await runStep(content, hashes, path, rnd);
        if (!state) continue;
        if (state.autofixed) autofixed++;
        if (state.content !== content) edited++;
        content = state.content;
        hashes = state.hashes;
      }
      if (edited >= 2) {
        const reloaded = await lineHashes(content, path);
        expect(reloaded).toEqual(hashes);
      }
    }
    expect(autofixed).toBe(0);
  }, 120_000);
});
