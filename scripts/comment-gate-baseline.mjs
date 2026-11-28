/**
 * Baseline generator for the comment gate (docs/agents/comment-grammar.md; decision: docs/adr/0056).
 *
 * `--check` recomputes every violation and reports the delta against
 * `test/arch/comment-gate-baseline.json`; `--update` rewrites that file from source. Growth is
 * impossible by construction, not by comparison: this CLI writes only the `entries` array, never
 * reads or writes the test file, and the ceiling lives there as a literal, so `--update` cannot
 * raise it. Classification is the shared predicate; only the structural facts come from a second
 * parser, and the arch suite pins that both layers classify one fixture corpus identically.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import {
  BASELINE_PATH,
  FUNCTION_KINDS,
  GUARD_KINDS,
  baselineKey,
  collectViolations,
  parseBaselineEntries,
} from "./comment-gate-predicate.mjs";

/**
 * Empty collectors and entry lists, typed at module scope: an inline `@type` inside a function body
 * would itself be a `bodyDoc` violation, which is this file's own rule.
 * @returns {Array<readonly [number, number]>}
 */
function emptyRanges() {
  return [];
}

/** @returns {number[]} */
function emptyLines() {
  return [];
}

/** @returns {Array<{ path: string, text: string, occurrence: number }>} */
function emptyEntries() {
  return [];
}

/** Repo root, derived from this file's own location so the CLI is cwd-independent. */
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The canonical scan scope: the files `.oxlintrc.json` actually runs the rule on, and nothing
 * else. That is every root-level source file plus `src/**`, `test/**` and `scripts/**` — the rule
 * covers the tests and the gate's own tooling too, so a comment there answers to the same grammar
 * as a comment in `src/`. `benchmark/` is out of scope by owner ruling (it is a measurement
 * harness, not shipped code) and so is gitignored build output. The arch suite recomputes through
 * this same constant; never change one alone.
 */
export const SCAN_PATTERNS = [
  "*.{ts,tsx,mjs,js}",
  "src/**/*.{ts,tsx,mjs,js}",
  "test/**/*.{ts,tsx,mjs,js}",
  "scripts/**/*.{ts,mjs,js}",
];

/** Extensions the rule runs on. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

/** Directories never descended into, even inside the scan root. */
export const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);

/** Babel plugins per extension: only the language the file is written in. */
function parserPlugins(path) {
  if (path.endsWith(".tsx")) return ["typescript", "jsx"];
  if (path.endsWith(".ts")) return ["typescript"];
  return [];
}

/** @param {string} name */
function hasSourceExtension(name) {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** @param {string} directory @param {string} prefix @param {string[]} files */
function walkDirectory(directory, prefix, files) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        walkDirectory(join(directory, entry.name), path, files);
    } else if (hasSourceExtension(entry.name)) {
      files.push(path);
    }
  }
}

/**
 * Repo-relative POSIX paths of every file the gate lints, in stable order.
 * @param {string} root
 * @returns {string[]}
 */
export function collectSourceFiles(root = REPO_ROOT) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && hasSourceExtension(entry.name)) files.push(entry.name);
  }
  for (const directory of ["src", "test", "scripts"])
    walkDirectory(join(root, directory), directory, files);
  return files.sort(compareText);
}

/** @param {unknown} node @param {(node: any) => void} visit */
function walkAst(node, visit) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (typeof current.type !== "string") continue;
    visit(current);
    for (const [key, value] of Object.entries(current)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "range")
        continue;
      if (key.endsWith("Comments") || key === "comments") continue;
      if (value !== null && typeof value === "object") stack.push(value);
    }
  }
}

/**
 * Structural facts plus comments for one file, in the shape the shared predicate expects.
 * Babel is the second parser: the plugin sees oxlint's AST, this sees Babel's, and the arch
 * suite asserts the two agree on one corpus.
 *
 * @param {string} code
 * @param {string} path repo-relative POSIX path, used only to pick the parser plugins
 * @returns {{ facts: any, comments: any[] }}
 */
export function analysisFor(code, path) {
  const ast = parse(code, { sourceType: "module", plugins: parserPlugins(path) });
  const functionBodies = emptyRanges();
  const guardLines = emptyLines();
  walkAst(ast, (node) => {
    if (FUNCTION_KINDS.includes(node.type)) {
      const body = node.body;
      if (body?.type === "BlockStatement" && body.loc) {
        functionBodies.push([body.loc.start.line, body.loc.end.line]);
      }
      return;
    }
    if (GUARD_KINDS.includes(node.type) && node.loc) guardLines.push(node.loc.start.line);
  });
  const comments = (ast.comments ?? []).map((comment) => ({
    type: comment.type === "CommentLine" ? "Line" : "Block",
    value: comment.value,
    loc: comment.loc,
  }));
  return {
    facts: { functionBodies, guardLines, sourceLines: code.split(/\r\n|[\r\n\u2028\u2029]/u) },
    comments,
  };
}

/** @param {string} a @param {string} b */
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Every violation in the canonical scope, in file order then source order.
 * @param {string} root
 * @returns {Array<{ path: string, text: string, occurrence: number, rule: string, line: number }>}
 */
export function collectCurrentViolations(root = REPO_ROOT) {
  const violations = [];
  for (const path of collectSourceFiles(root)) {
    const code = readFileSync(join(root, path), "utf-8");
    const { facts, comments } = analysisFor(code, path);
    for (const violation of collectViolations(comments, facts)) {
      violations.push({
        path,
        text: violation.text,
        occurrence: violation.occurrence,
        rule: violation.rule,
        line: violation.comment.loc.start.line,
      });
    }
  }
  return violations;
}

/**
 * Deterministic baseline bytes: entries sorted by `(path, occurrence)` with the raw text as the
 * tie-break, two-space JSON, one trailing newline.
 * @param {ReadonlyArray<{ path: string, text: string, occurrence: number }>} entries
 */
export function serializeBaseline(entries) {
  const sorted = [...entries].sort(
    (a, b) =>
      compareText(a.path, b.path) || a.occurrence - b.occurrence || compareText(a.text, b.text),
  );
  const projected = sorted.map(({ path, text, occurrence }) => ({ path, text, occurrence }));
  return `${JSON.stringify({ entries: projected }, null, 2)}\n`;
}

/** @param {ReadonlyArray<{ path: string, text: string, occurrence: number }>} entries */
function keysOf(entries) {
  return new Set(entries.map(({ path, text, occurrence }) => baselineKey(path, text, occurrence)));
}

/** @param {string} path @param {number} line @param {string} text */
function describe(path, line, text) {
  const trimmed = text.trim().replaceAll("\n", " ");
  const short = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
  return `${path}:${line} ${short}`;
}

/** @param {string} message @param {number} code */
function fail(message, code = 1) {
  console.error(message);
  return code;
}

/** @param {string} root */
function readBaseline(root) {
  try {
    return readFileSync(join(root, BASELINE_PATH), "utf-8");
  } catch {
    return null;
  }
}

/**
 * `--check`: the tree must not hold a violation the baseline does not record, and the baseline
 * must not hold an entry the tree no longer produces.
 * @param {string} root
 * @param {ReadonlyArray<{ path: string, text: string, occurrence: number, line: number }>} current
 */
function check(root, current) {
  const raw = readBaseline(root);
  if (raw === null) return fail(`baseline missing at ${BASELINE_PATH}; run with --update`);
  const parsed = parseBaselineEntries(raw);
  if (!parsed.ok)
    return fail(`baseline at ${BASELINE_PATH} is ${parsed.reason}; run with --update`);

  const recorded = new Set(
    parsed.entries.map(({ path, text, occurrence }) => baselineKey(path, text, occurrence)),
  );
  const unrecorded = current.filter(
    ({ path, text, occurrence }) => !recorded.has(baselineKey(path, text, occurrence)),
  );
  const currentKeys = keysOf(current);
  const stale = parsed.entries.filter(
    ({ path, text, occurrence }) => !currentKeys.has(baselineKey(path, text, occurrence)),
  );

  if (unrecorded.length === 0 && stale.length === 0) {
    console.log(`comment-gate-baseline: ${current.length} entries, tree matches the baseline`);
    return 0;
  }
  if (unrecorded.length > 0) {
    console.error(`comment-gate-baseline: ${unrecorded.length} violation(s) not in the baseline:`);
    for (const item of unrecorded.slice(0, 20))
      console.error(`  ${describe(item.path, item.line, item.text)}`);
    console.error("  fix the comment, or run --update and justify the ceiling bump in review");
  }
  if (stale.length > 0) {
    console.error(`comment-gate-baseline: ${stale.length} baseline entry no longer violates:`);
    for (const item of stale.slice(0, 20)) console.error(`  ${describe(item.path, 0, item.text)}`);
    console.error("  run --update to retire them");
  }
  return 1;
}

/**
 * `--update`: rewrite the entries from source and report the delta. It does not refuse growth:
 * a rewrite replaces texts, so a refusal on new texts would block every legitimate conversion —
 * the counterexample that retired the first version of this check. The ratchet is the ceiling
 * literal in the arch suite, which this file cannot read; a rise is announced here and then
 * fails there until someone edits that literal, visibly, in review.
 * @param {string} root
 * @param {ReadonlyArray<{ path: string, text: string, occurrence: number, rule: string, line: number }>} current
 */
function update(root, current) {
  const raw = readBaseline(root);
  let previous = emptyEntries();
  if (raw !== null) {
    const parsed = parseBaselineEntries(raw);
    if (!parsed.ok)
      return fail(`baseline at ${BASELINE_PATH} is ${parsed.reason}; cannot diff against it`);
    previous = parsed.entries;
  }

  writeFileSync(join(root, BASELINE_PATH), serializeBaseline(current));
  const byRule = new Map();
  for (const item of current) byRule.set(item.rule, (byRule.get(item.rule) ?? 0) + 1);
  const detail = [...byRule]
    .sort(([a], [b]) => compareText(a, b))
    .map(([rule, count]) => `${rule} ${count}`)
    .join(", ");
  console.log(`comment-gate-baseline: wrote ${current.length} entries (${detail})`);
  if (raw !== null) {
    const delta = current.length - previous.length;
    console.log(
      `comment-gate-baseline: ${previous.length} -> ${current.length} (${delta >= 0 ? "+" : ""}${delta})`,
    );
    if (delta > 0) {
      const ceiling = join("test", "arch", "comment-gate.test.ts");
      console.error(
        `comment-gate-baseline: the baseline grew by ${delta}; ${ceiling} still pins the ceiling, so raise EXPECTED_MAX_LEGACY_COMMENTS there or fix the new comment`,
      );
    }
  }
  return 0;
}

/**
 * CLI entry point. Returns the process exit code.
 * @param {string[]} argv
 * @param {string} root
 */
export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  const asked = argv.filter((argument) => argument.startsWith("--"));
  const unknown = asked.filter((argument) => argument !== "--update" && argument !== "--check");
  if (unknown.length > 0)
    return fail(`unknown option(s): ${unknown.join(", ")}; use --check or --update`);
  const current = collectCurrentViolations(root);
  return argv.includes("--update") ? update(root, current) : check(root, current);
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) process.exitCode = main();
