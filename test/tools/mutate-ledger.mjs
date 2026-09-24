#!/usr/bin/env node
/**
 * T3h mutation-ledger applier + runner.
 *
 * Makes ADR-0018 `## Reproduce` re-derivable from the committed tree: it archives HEAD into a temp
 * tree, applies one mutation to the COPY (the worktree is never written to), runs vitest there, and
 * compares the failing cells against the expected RED set recorded in the ADR.
 *
 * Usage:
 *   node test/tools/mutate-ledger.mjs --list
 *   node test/tools/mutate-ledger.mjs <id> [--full] [--keep] [--expect-rev=<sha>]
 *
 * Contract:
 *   - prints `git rev-parse HEAD` and refuses to run when `git status --porcelain -- src test docs`
 *     is non-empty (ignored handoff/scratch paths are not the artifact, so they are out of scope);
 *   - `--expect-rev=<sha>` additionally asserts the revision the recipe was verified at;
 *   - asserts each anchor occurs exactly once (a drifted tree fails loudly here);
 *   - prints `applied <id>`, then greps the inserted line back out of the mutated file, so mutant
 *     presence is recorded rather than inferred;
 *   - prints both vitest summary lines and the failing cell titles, then `RED SET MATCH` or
 *     `MISMATCH` + the missing/extra diff; exits non-zero on mismatch.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE = "src/mutation/engine.ts";
const ANCHOR_PIPELINE = "src/hashline/anchor-pipeline.ts";
const CONTRACT = "test/core/serve-leases.test.ts";
const DOMAIN_ERRORS = "src/domain-errors.ts";

/**
 * Revisions the expected RED sets below were measured at:
 *  - T3h (`M1`/`M2`/`M4`/`N1`/`Z3b`, contract file): see ADR-0018's T3h subsection.
 *  - T4 (`T4M1`–`T4M5`, full suite): see ADR-0018's "T4 ledger" subsection.
 * The T4 ids are prefixed because the T3h ledger already owns `M1`/`M2`/`M4`.
 */
const VERIFIED_AT = "ba430557912b8b2934261654d3e09034188d8571";
/** T4 (T4M1–T4M5) expected RED sets were measured at this revision. */
const T4_VERIFIED_AT = "ddce82b333a2c6cc5854823de92264971f5e84f2";

const T = {
  twinRecords: "twin rejection records nothing — served rows byte-identical before/after",
  twinGrants: "twin rejection grants nothing — no grant field changes, no new lease appears",
  twinReadEquiv: "twin rejection → fresh read ≡ control (0 duplicates, no shifted labels)",
  insertOnly: "non-twin insert-only exterior change → rejection → fresh read ≡ control",
  windowed:
    "non-twin windowed read + change outside the served span → rejection → fresh read ≡ control",
  consecutive:
    "consecutive rejections compose — reject → reject leaves served rows and grants byte-identical",
  batchAbort:
    "batch abort (one part rejecting) records nothing — served rows and grants byte-identical",
  noopLoop:
    "noop-loop rejection records nothing — served rows and grants byte-identical, next read ≡ control",
  malformed: "malformed anchor on an existing file rejects E_BATCH_ABORT and writes nothing",
};

/** T4 CP1-r2 cell titles (ADR-0018 "T4 ledger" / ADR-0013 "Reproduce"). */
const T4 = {
  spanLength: "span-length rejection offers no dead retry (C1)",
  unservedInterior: "unserved-interior rejection offers no dead retry (C2)",
  staleAnchorReread: "stale-anchor rejection recovers only by re-read (C3)",
  contextRows: "stale-anchor with context rows states the arm-dependent truth (C4)",
  unservedRule: "E_UNSERVED_RANGE obeys the same reread rule as E_STALE_RANGE (T4 C5)",
  archSites: "every E_STALE_RANGE/E_UNSERVED_RANGE arm sets reread: true",
  archFields: "both range payload-map entries declare reread?: boolean",
};

/** Shared pre-edit for the three `recordServed` mutants. */
const SESS_IMPORT = {
  file: ENGINE,
  old: '  retireAnchors,\n} from "../session-view.js";',
  new: '  retireAnchors,\n  recordServed,\n} from "../session-view.js";',
};

const M1_TITLES = [
  T.twinRecords,
  T.twinGrants,
  T.twinReadEquiv,
  T.insertOnly,
  T.windowed,
  T.consecutive,
  T.batchAbort,
];

const MUTANTS = {
  M1: {
    what: "full write at collectAbortPart (rows + snapshot context)",
    scope: [CONTRACT],
    expected: M1_TITLES,
    edits: [
      SESS_IMPORT,
      {
        file: ENGINE,
        old: "        : undefined;\n  const originalLines = splitLines(opts.originalNormalized);",
        new:
          "        : undefined;\n" +
          "  await recordServed(opts.sessionKey, opts.absolutePath, echoRows ?? [], opts.originalHashes.length, {\n" +
          "    content: opts.originalNormalized,\n" +
          "    hashes: opts.originalHashes,\n" +
          "  });\n" +
          "  const originalLines = splitLines(opts.originalNormalized);",
      },
    ],
  },
  M2: {
    what: "same site, rows only — no snapshot context",
    scope: [CONTRACT],
    expected: M1_TITLES.filter((t) => t !== T.twinGrants),
    edits: [
      SESS_IMPORT,
      {
        file: ENGINE,
        old: "        : undefined;\n  const originalLines = splitLines(opts.originalNormalized);",
        new:
          "        : undefined;\n" +
          "  await recordServed(opts.sessionKey, opts.absolutePath, echoRows ?? [], opts.originalHashes.length);\n" +
          "  const originalLines = splitLines(opts.originalNormalized);",
      },
    ],
  },
  M4: {
    what: "full write at the batch noop guard's call site",
    scope: [CONTRACT],
    expected: [T.noopLoop],
    edits: [
      SESS_IMPORT,
      {
        file: ENGINE,
        old: "      const notice = await enforceNoopLoop({",
        new:
          "      await recordServed(opts.sessionKey, absolutePath, echoRowsForItem(applied.edit, originalHashes) ?? [], originalHashes.length, {\n" +
          "        content: originalNormalized,\n" +
          "        hashes: originalHashes,\n" +
          "      });\n" +
          "      const notice = await enforceNoopLoop({",
      },
    ],
  },
  N1: {
    what: "anchor parser accepts a malformed token",
    scope: [CONTRACT],
    expected: [T.malformed],
    caveat:
      "the RED is the cause assertion (contract :759); the envelope assertion (:758) passes because " +
      "the E_BATCH_ABORT envelope survives, and the two nothing-written asserts (:760-761) are NOT reached",
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old: "if (trimmed.length === ANCHOR_LEN && ALPH_RE.test(trimmed)) {",
        new: "if (trimmed.length === ANCHOR_LEN || ALPH_RE.test(trimmed)) {",
      },
    ],
  },
  Z3b: {
    what: "throw in enforceNoopLoop's batch branch",
    scope: null, // full suite
    expected: [
      "batch_edit rejects repeated noop edits at the loop threshold",
      T.noopLoop,
      "second identical no-op warns applied, third rejects E_NOOP_LOOP, file untouched",
      "batch: throws at threshold and notice at 2",
      "batch reject renders the on-disk heading exactly once",
      "batch without echoRows still throws",
    ],
    edits: [
      {
        file: ENGINE,
        old: "  if (count >= NOOP_LOOP_THRESHOLD) {\n    const originalLines = splitLines(opts.originalNormalized);",
        new: '  if (count >= NOOP_LOOP_THRESHOLD) {\n    throw new Error("Z3b");\n    const originalLines = splitLines(opts.originalNormalized);',
      },
    ],
  },
  T4M1: {
    what: "drop the retry signal at the span-length arm (CP0 G3, SR@802)",
    scope: null, // full suite
    expected: [T4.spanLength, T4.archSites],
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old:
          "      headline: `served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}. Re-read.`,\n" +
          "      servedBlock: echo,\n" +
          "      reread: true,",
        new:
          "      headline: `served span (${servedLen} lines) no longer matches current range (${currentLen} lines)${where}. Re-read.`,\n" +
          "      servedBlock: echo,\n" +
          "      reread: false,",
      },
    ],
  },
  T4M2: {
    what: "drop the retry signal at the unserved-interior arm (CP0 H1, SR@790)",
    scope: null, // full suite
    expected: [T4.unservedInterior, T4.archSites],
    edits: [
      {
        file: ANCHOR_PIPELINE,
        old:
          "        headline: `line ${i + 1}${where} was never served.`,\n" +
          "        servedBlock: echo,\n" +
          "        reread: true,",
        new:
          "        headline: `line ${i + 1}${where} was never served.`,\n" +
          "        servedBlock: echo,\n" +
          "        reread: false,",
      },
    ],
  },
  T4M3: {
    what: "unservedRangeFormat renders the retry hint unconditionally again",
    scope: null, // full suite
    expected: [T4.unservedRule, T4.unservedInterior],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old:
          'function unservedRangeFormat(payload: ErrorPayloadMap["E_UNSERVED_RANGE"]): string {\n' +
          "  // F7 + T4: heading only when rows exist (all current producers carry a block);\n" +
          "  // the retry hint obeys `payload.reread` exactly as `staleRangeFormat` does —\n" +
          "  // one rule for both range codes.\n" +
          "  if (!payload.servedBlock) return payload.headline;\n" +
          "  const base = `${payload.headline}\\nCurrent range:\\n${payload.servedBlock}`;\n" +
          "  return payload.reread === true ? base : `${base}\\n${RETRY_HINT}`;",
        new:
          'function unservedRangeFormat(payload: ErrorPayloadMap["E_UNSERVED_RANGE"]): string {\n' +
          "  // F7 + T4: heading only when rows exist (all current producers carry a block);\n" +
          "  // the retry hint obeys `payload.reread` exactly as `staleRangeFormat` does —\n" +
          "  // one rule for both range codes.\n" +
          "  if (!payload.servedBlock) return payload.headline;\n" +
          "  return `${payload.headline}\\nCurrent range:\\n${payload.servedBlock}\\n${RETRY_HINT}`;",
      },
    ],
  },
  T4M4: {
    what: "restore the read-free E_STALE_ANCHOR remedy string",
    scope: null, // full suite
    expected: [T4.staleAnchorReread],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old: '    remedy: "Read the file again for fresh anchors, then retry.",',
        new: '    remedy: "Retry with the served rows; no read is needed.",',
      },
    ],
  },
  T4M5: {
    what: "remove reread?: boolean from ErrorPayloadMap.E_UNSERVED_RANGE only",
    scope: null, // full suite
    expected: [T4.archFields],
    edits: [
      {
        file: DOMAIN_ERRORS,
        old:
          "    /** Same rule as `E_STALE_RANGE.reread`: true omits the retry hint. */\n" +
          "    reread?: boolean;\n" +
          '    unservedKind: "boundary" | "interior";',
        new:
          "    /** Same rule as `E_STALE_RANGE.reread`: true omits the retry hint. */\n" +
          "    rereadRemoved?: boolean;\n" +
          '    unservedKind: "boundary" | "interior";',
      },
    ],
  },
};

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function fail(message) {
  console.error(`mutate-ledger: ${message}`);
  process.exit(1);
}

function usage() {
  console.log("usage: node test/tools/mutate-ledger.mjs --list");
  console.log(
    "       node test/tools/mutate-ledger.mjs <id> [--full] [--keep] [--expect-rev=<sha>]",
  );
  console.log("");
  console.log(`ids: ${Object.keys(MUTANTS).join(", ")}`);
  console.log("");
  console.log(`T3h expected RED sets measured at ${VERIFIED_AT}; T4 (T4M*) at ${T4_VERIFIED_AT};`);
  console.log("so a drifted tree fails at the anchor check rather than silently mis-running.");
}

function listMutants() {
  const width = Math.max(...Object.keys(MUTANTS).map((id) => id.length));
  console.log(`T3h ledger measured at ${VERIFIED_AT}`);
  console.log(`T4 ledger measured at ${T4_VERIFIED_AT}`);
  for (const [id, m] of Object.entries(MUTANTS)) {
    const scope = m.scope ? m.scope.join(",") : "--full (full suite)";
    console.log(`${id.padEnd(width)}  RED=${m.expected.length}  scope=${scope}  ${m.what}`);
  }
}

function assertCleanAndGetRevision(expectRev) {
  const rev = run("git", ["-C", REPO, "rev-parse", "HEAD"]).stdout.trim();
  console.log(`revision ${rev}`);
  if (expectRev && expectRev !== rev) {
    fail(`--expect-rev=${expectRev} but HEAD is ${rev}`);
  }
  const status = run("git", [
    "-C",
    REPO,
    "status",
    "--porcelain",
    "--",
    "src",
    "test",
    "docs",
  ]).stdout.trim();
  if (status !== "") {
    fail(`refusing to run: src/test/docs is dirty\n${status}`);
  }
  console.log("worktree clean (src test docs)");
  return rev;
}

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "mutate-ledger-"));
  const tree = join(base, "tree");
  const tar = join(base, "head.tar");
  const archive = run("git", ["-C", REPO, "archive", "HEAD", "-o", tar]);
  if (archive.status !== 0) fail(`git archive failed: ${archive.stderr}`);
  const extract = run("mkdir", ["-p", tree]);
  if (extract.status !== 0) fail(`mkdir failed: ${extract.stderr}`);
  const untar = run("tar", ["-xf", tar, "-C", tree]);
  if (untar.status !== 0) fail(`tar failed: ${untar.stderr}`);
  symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
  console.log(`archived HEAD -> ${tree}`);
  return { base, tree };
}

function applyMutant(tree, id, mutant) {
  for (const edit of mutant.edits) {
    const target = join(tree, edit.file);
    const text = readFileSync(target, "utf8");
    const count = text.split(edit.old).length - 1;
    if (count !== 1) {
      fail(
        `${id} ${edit.file}: anchor count ${count} (expected exactly 1) — tree or recipe drifted`,
      );
    }
    writeFileSync(target, text.replace(edit.old, edit.new));
  }
  console.log(`applied ${id}`);

  for (const edit of mutant.edits) {
    const oldLines = edit.old.split("\n");
    const inserted = edit.new
      .split("\n")
      .filter((line) => line.trim() !== "" && !oldLines.includes(line));
    const marker = inserted[0] ?? edit.new.split("\n")[0];
    const hit = run("grep", ["-n", "-F", marker, join(tree, edit.file)]);
    const found = hit.stdout.trim().split("\n").filter(Boolean);
    if (found.length === 0) fail(`${id}: mutated line not found back in ${edit.file}`);
    for (const line of found) console.log(`mutated line ${edit.file}:${line}`);
  }
}

function vitestCommand(tree) {
  const local = join(tree, "node_modules", ".bin", "vitest");
  return existsSync(local) ? { cmd: local, prefix: [] } : { cmd: "npx", prefix: ["vitest"] };
}

function parseVitest(output) {
  const summary = { testFiles: null, tests: null };
  const failing = [];
  for (const raw of output.split("\n")) {
    const files = raw.match(/^\s*Test Files\s+(.*\S)\s*$/);
    if (files && summary.testFiles === null) summary.testFiles = files[1];
    const tests = raw.match(/^\s*Tests\s+(.*\S)\s*$/);
    if (tests && summary.tests === null) summary.tests = tests[1];
    const cell = raw.match(/^\s*[×✕]\s+(.*\S)$/);
    if (cell) {
      const body = cell[1].replace(/\s+\d+(?:\.\d+)?m?s$/, "");
      const segments = body.split(" > ");
      failing.push({ path: body, title: segments[segments.length - 1] });
    }
  }
  return { summary, failing };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) return usage();
  if (argv.includes("--list")) return listMutants();

  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) {
    usage();
    process.exit(2);
  }
  const mutant = MUTANTS[id];
  if (!mutant) fail(`unknown id "${id}" (known: ${Object.keys(MUTANTS).join(", ")})`);

  const expectRevArg = argv.find((a) => a.startsWith("--expect-rev="));
  const forceFull = argv.includes("--full");
  const keep = argv.includes("--keep");
  const scope = forceFull || mutant.scope === null ? [] : mutant.scope;

  assertCleanAndGetRevision(expectRevArg ? expectRevArg.split("=")[1] : null);

  const { base, tree } = makeTree();
  try {
    applyMutant(tree, id, mutant);

    const { cmd, prefix } = vitestCommand(tree);
    const args = [...prefix, "run", ...scope, "--reporter=verbose"];
    console.log(`running: ${cmd} ${args.join(" ")}   (cwd=${tree})`);
    const result = run(cmd, args, { cwd: tree, maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout}${result.stderr}`;
    if (result.stdout) writeFileSync(join(base, `log-${id}.txt`), output);

    const { summary, failing } = parseVitest(output);
    console.log(`summary Test Files: ${summary.testFiles ?? "(not parsed)"}`);
    console.log(`summary Tests: ${summary.tests ?? "(not parsed)"}`);
    console.log(`failing cells (${failing.length}):`);
    for (const cell of failing) console.log(`  - ${cell.title}`);

    const got = failing.map((cell) => cell.title);
    const missing = mutant.expected.filter((title) => !got.includes(title));
    const extra = got.filter((title) => !mutant.expected.includes(title));
    if (missing.length === 0 && extra.length === 0 && failing.length === mutant.expected.length) {
      console.log(`RED SET MATCH (${failing.length}/${mutant.expected.length})`);
      if (mutant.caveat) console.log(`caveat: ${mutant.caveat}`);
      return;
    }
    console.log(`RED SET MISMATCH (got ${failing.length}, expected ${mutant.expected.length})`);
    for (const title of missing) console.log(`  missing: ${title}`);
    for (const title of extra) console.log(`  unexpected: ${title}`);
    console.log(`log: ${join(base, `log-${id}.txt`)}`);
    process.exitCode = 1;
  } finally {
    if (!keep) {
      const link = join(tree, "node_modules");
      if (existsSync(link)) unlinkSync(link);
      rmSync(base, { recursive: true, force: true });
    } else {
      console.log(`kept ${base}`);
    }
  }
}

main();
