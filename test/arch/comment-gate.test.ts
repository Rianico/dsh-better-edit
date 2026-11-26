import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import { afterEach, describe, expect, it, vi } from "vitest";
import gate from "../../scripts/oxlint-plugin-comment-gate.js";
import {
  BASELINE_PATH,
  baselineKey,
  collectViolations,
  parseBaselineEntries,
} from "../../scripts/comment-gate-predicate.mjs";
import {
  REPO_ROOT,
  analysisFor,
  collectCurrentViolations,
  collectSourceFiles,
  main,
  serializeBaseline,
} from "../../scripts/comment-gate-baseline.mjs";

/**
 * The comment gate's ratchet: growth in the number of grandfathered comments is impossible by
 * construction. The ceiling is a literal HERE, never derived from the baseline JSON, and `--update`
 * cannot read or write this file — so raising it is a visible edit to this file that review can see.
 *
 * Three assertions, all required: every current violation is recorded in the baseline (a
 * violation the baseline does not know is new), the current count is at or under the ceiling,
 * and the baseline itself is at or under the ceiling (a bloated file cannot hide behind a
 * count that happens to match).
 */
const EXPECTED_MAX_LEGACY_COMMENTS = 2465;

type Shape = {
  shape: string;
  code: string;
  rules: readonly string[];
};

/** A `/** *\/` block of exactly `lines` source lines, for the cap boundary. */
function blockOfLines(lines: number): string {
  const body = Array.from({ length: lines - 2 }, (_, index) => ` * line ${index + 1}`);
  return ["/**", ...body, " */"].join("\n");
}

/**
 * One fixture per allowed and rejected shape. `rules` is the shared predicate's verdict —
 * empty means allowed — and the same table drives both the predicate control and the
 * parser-parity control below, so a divergence cannot pass as a fixture typo.
 */
const CORPUS: readonly Shape[] = [
  {
    shape: "WHY: tag is retired, so it is prose",
    code: "// WHY: the canon is the identity\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "SAFETY: above an `as` cast",
    code: "declare const raw: unknown;\n// SAFETY: the guard above narrowed it\nconst a = raw as string;\n",
    rules: [],
  },
  {
    shape: "SAFETY: above a non-null assertion",
    code: "declare const maybe: string | undefined;\n// SAFETY: the lookup throws before this point\nconst a = maybe!;\n",
    rules: [],
  },
  {
    shape: "SAFETY: above a type assertion",
    code: "declare const raw: unknown;\n// SAFETY: the caller validated the tag\nconst a = <string>raw;\n",
    rules: [],
  },
  {
    shape: "SAFETY: above a line whose guard starts mid-line (lenient reading)",
    code: "declare function take(value: string): void;\ndeclare const raw: unknown;\n// SAFETY: the callee checks the tag\n take(raw as string);\n",
    rules: [],
  },
  {
    shape: "SAFETY: above a multi-line call that closes in a cast (the pipeline.ts shape)",
    code: "declare function f(options: { a: number }): void;\n// SAFETY: the options object is typed by the internal parameter shape, which the caller never sees.\nf({\n  a: 1,\n} as unknown as { a: number });\n",
    rules: [],
  },
  {
    shape: "SAFETY: with one intervening statement before its cast",
    code: "declare const raw: unknown;\n// SAFETY: the marker below pins the order, the cast follows it\ndeclare const marker: number;\nconst a = raw as string;\n",
    rules: [],
  },
  {
    shape: "SAFETY: three non-blank lines above its cast (the lookahead bound holds)",
    code: "declare const raw: unknown;\n// SAFETY: too far from the cast to point at it\ndeclare const first: number;\ndeclare const second: number;\nconst a = raw as string;\n",
    rules: ["safetyPosition"],
  },
  {
    shape: "SAFETY: directly above the line that closes a multi-line cast (residual gap)",
    code: "declare const raw: unknown;\nexport const wrapped = (\n  raw\n  // SAFETY: the cast closes this expression, so the claim is about raw\n) as unknown as string;\nexport const after = 1;\n",
    rules: ["safetyPosition"],
  },
  {
    shape: "SAFETY: above a line with no guard at all",
    code: "// SAFETY: the invariant is obvious\nconst a = 1;\n",
    rules: ["safetyPosition"],
  },
  {
    shape: "SAFETY: above a blank line then no guard",
    code: "// SAFETY: the invariant is obvious\n\nconst a = 1;\n",
    rules: ["safetyPosition"],
  },
  {
    shape: "stacked SAFETY: run guarding a cast",
    code: "declare const raw: unknown;\n// SAFETY: first reason\n// SAFETY: second reason\nconst a = raw as string;\n",
    rules: [],
  },
  {
    shape: "Invariant: tag is retired, so it is prose",
    code: "// Invariant: anchors are unique per file\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "See ADR- tag is retired, so it is prose",
    code: "// See ADR-0013 for the canon\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "via https:// tag is retired, so it is prose",
    code: "// via https://example.com/spec\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "TODO(#N): tag",
    code: "// TODO(#196): add the liveness check\nconst a = 1;\n",
    rules: [],
  },
  {
    shape: "HACK: tag",
    code: "// HACK: sqlite has no partial index here\nconst a = 1;\n",
    rules: [],
  },
  {
    shape: "Ref: docs path",
    code: "// Ref: docs/adr/0056-comment-gate-ratchet.md\nconst a = 1;\n",
    rules: [],
  },
  {
    shape: "Ref: https link",
    code: "// Ref: https://nodejs.org/api/fs.html#filehandlesync\nconst a = 1;\n",
    rules: [],
  },
  {
    shape: "Ref: http link",
    code: "// Ref: http://man7.org/linux/man-pages/man2/rename.2.html\nconst a = 1;\n",
    rules: [],
  },
  {
    shape: "Ref: with no target is prose",
    code: "// Ref: the canon derivation\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "mid-sentence (WHY: …) is prose, not a tag",
    code: "// fall through to partial halt below (WHY: never break the view)\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "mid-sentence (See ADR-…) is prose, not a tag",
    code: "// the canon derivation stays stable (See ADR-0013)\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "leading-tag twin of the mid-sentence WHY is prose too",
    code: "// WHY: fall through to partial halt below, never breaking the view\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "directive with a Ref: reason after `--` is allowed",
    code: "// eslint-disable-next-line no-control-regex -- Ref: docs/adr/0056-comment-gate-ratchet.md\nconst probe = /\\u0000/u;\n",
    rules: [],
  },
  {
    shape: "directive with a free-form reason after `--` is allowed",
    code: "// eslint-disable-next-line no-control-regex -- these code points ARE the notice's subject.\nconst probe = /\\u0000/u;\n",
    rules: [],
  },
  {
    shape: "oxlint directive with a reason is allowed",
    code: "// oxlint-disable-next-line no-control-regex -- the NUL byte is the subject.\nconst probe = /\\u0000/u;\n",
    rules: [],
  },
  {
    shape: "pi-lens-ignore is not an accepted directive prefix",
    code: "// pi-lens-ignore no-control-regex -- these code points ARE the notice's subject.\nconst probe = /\\u0000/u;\n",
    rules: ["prose"],
  },
  {
    shape: "directive whose `--` carries nothing is prose",
    code: "// eslint-disable-next-line no-control-regex --\nconst probe = /\\u0000/u;\n",
    rules: ["prose"],
  },
  {
    shape: "directive with no reason is prose",
    code: "// eslint-disable-next-line no-control-regex\nconst probe = /\\u0000/u;\n",
    rules: ["prose"],
  },
  {
    shape: "bare ADR number is not the path form",
    code: "// Ref: ADR-0013\nconst a = 1;\n",
    rules: ["prose"],
  },
  { shape: "strict Given step", code: "// Given a served span\nexport const a = 1;\n", rules: [] },
  {
    shape: "strict Feature heading",
    code: "// Feature: hash-anchored edits\nexport const a = 1;\n",
    rules: [],
  },
  {
    shape: "strict Scenario heading",
    code: "// Scenario: a stale anchor is refused\nexport const a = 1;\n",
    rules: [],
  },
  {
    shape: "lowercase given is prose",
    code: "// given a served span\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "Background: is dropped",
    code: "// Background: setup\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "Scenario Outline: is dropped",
    code: "// Scenario Outline: many rows\nconst a = 1;\n",
    rules: ["prose"],
  },
  { shape: "Examples: is dropped", code: "// Examples: rows\nconst a = 1;\n", rules: ["prose"] },
  {
    shape: "Given: without a trailing space is prose",
    code: "// Given:a span\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "member JSDoc on an interface property",
    code: "export interface Served {\n  /** the anchor this row leases */\n  anchor?: string;\n}\n",
    rules: [],
  },
  {
    shape: "member JSDoc on a type-literal property",
    code: "export type Alias = {\n  /** a member doc */\n  field: number;\n};\n",
    rules: [],
  },
  {
    shape: "module-scope JSDoc on a non-exported declaration",
    code: "interface Internal {\n  value: number;\n}\nexport const a: Internal = { value: 1 };\n",
    rules: [],
  },
  {
    shape: "file-header JSDoc",
    code: `${blockOfLines(4)}\nexport const a = 1;\n`,
    rules: [],
  },
  {
    shape: "exactly-12-line block is allowed",
    code: `${blockOfLines(12)}\nexport const a = 1;\n`,
    rules: [],
  },
  {
    shape: "13-line block is over the cap",
    code: `${blockOfLines(13)}\nexport const a = 1;\n`,
    rules: ["blockCap"],
  },
  {
    shape: "in-body JSDoc in a function declaration",
    code: "export function f(value: unknown) {\n  /** belongs at module scope */\n  return value as string;\n}\n",
    rules: ["bodyDoc"],
  },
  {
    shape: "in-body JSDoc in an arrow function",
    code: "export const f = (value: number) => {\n  /** belongs at module scope */\n  return value as number;\n};\n",
    rules: ["bodyDoc"],
  },
  {
    shape: "in-body JSDoc in a class method",
    code: "export class K {\n  m() {\n    /** belongs at module scope */\n    return 1 as const;\n  }\n}\n",
    rules: ["bodyDoc"],
  },
  {
    shape: "in-body JSDoc in an object method",
    code: "export const o = {\n  m() {\n    /** belongs at module scope */\n    return 1 as const;\n  },\n};\n",
    rules: ["bodyDoc"],
  },
  {
    shape: "JSDoc above a method is module-scope-legal",
    code: "export class K {\n  /** the method doc */\n  m() {\n    return 1;\n  }\n}\n",
    rules: [],
  },
  {
    shape: "module-scope JSDoc carrying a WHY: tag is prose",
    code: "/**\n * WHY: the canon is the identity\n */\nexport const a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "module-scope JSDoc carrying an Invariant: tag is prose",
    code: "/**\n * Invariant: anchors are unique per file\n */\nexport const a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "module-scope JSDoc carrying a See ADR- token is prose",
    code: "/**\n * See ADR-0013 for the canon\n */\nexport const a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "module-scope JSDoc carrying a via https:// token is prose",
    code: "/**\n * via https://example.com/spec\n */\nexport const a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "in-body JSDoc carrying a WHY: tag is prose, not a body doc",
    code: "export function f(value: unknown) {\n  /** WHY: belongs at module scope */\n  return value as string;\n}\n",
    rules: ["prose"],
  },
  {
    shape: "module-scope JSDoc citing a record with Ref: is legal",
    code: "/**\n * Ref: docs/adr/0056-comment-gate-ratchet.md\n */\nexport const a = 1;\n",
    rules: [],
  },
  {
    shape: "a shebang is an interpreter directive, not a comment",
    code: "#!/usr/bin/env node\nconst a = 1;\n",
    rules: [],
  },
  {
    shape: "bare prose",
    code: "// plain prose that explains nothing\nconst a = 1;\n",
    rules: ["prose"],
  },
  {
    shape: "empty comment carries nothing to reject",
    code: "//\nconst a = 1;\n",
    rules: [],
  },
];

/** @param {string} code @returns {string[]} */
function ruleKeysFromPredicate(code: string): string[] {
  const { facts, comments } = analysisFor(code, "fixture.ts");
  return collectViolations(comments, facts).map((violation) => violation.rule);
}

describe("comment gate predicate", () => {
  for (const { shape, code, rules } of CORPUS) {
    it(`classifies ${shape}`, () => {
      expect(ruleKeysFromPredicate(code)).toEqual([...rules]);
    });
  }
});

/**
 * Parser parity: the plugin reads oxlint's AST, `analysisFor` reads Babel's. The same corpus
 * runs through the real rule, so a fixture the two parsers disagree about fails here instead
 * of drifting silently in the gate.
 */
describe("comment gate parser parity", () => {
  RuleTester.describe = (text: string, fn: () => void) => {
    describe(text, fn);
  };
  RuleTester.it = Object.assign(
    (text: string, fn: () => void) => {
      it(text, fn);
    },
    { only: (text: string, fn: () => void) => it.only(text, fn) },
  );

  const rule = gate.rules["no-comments"];
  const runner = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
  runner.run("no-comments", rule, {
    valid: CORPUS.filter(({ rules }) => rules.length === 0).map(({ code }) => ({ code })),
    invalid: CORPUS.filter(({ rules }) => rules.length > 0).map(({ code, rules }) => ({
      code,
      errors: rules.map((messageId) => ({ messageId })),
    })),
  });
});

/**
 * Expand–contract: the gate is armed with the legacy baseline and an exact ceiling, so every new
 * violation fails on the commit that introduces it while `src/` and `test/` drain over later work.
 */
describe("comment gate baseline", () => {
  const current = collectCurrentViolations();
  const raw = readFileSync(join(REPO_ROOT, BASELINE_PATH), "utf-8");

  it("records every current violation in the baseline", () => {
    const parsed = parseBaselineEntries(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const recorded = new Set(
      parsed.entries.map(({ path, text, occurrence }) => baselineKey(path, text, occurrence)),
    );
    const unrecorded = current
      .filter(({ path, text, occurrence }) => !recorded.has(baselineKey(path, text, occurrence)))
      .slice(0, 20)
      .map(({ path, line, text }) => `${path}:${line} ${text.trim()}`);
    expect(unrecorded).toEqual([]);
  });

  it("keeps the current violation count at or under the ceiling", () => {
    expect(current.length).toBeLessThanOrEqual(EXPECTED_MAX_LEGACY_COMMENTS);
  });

  it("keeps the baseline itself at or under the ceiling", () => {
    const parsed = parseBaselineEntries(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.length).toBeLessThanOrEqual(EXPECTED_MAX_LEGACY_COMMENTS);
  });

  it("treats a shebang as the interpreter directive, not a comment", () => {
    const facts = { functionBodies: [], guardLines: [], sourceLines: ["#!/usr/bin/env node"] };
    const typed = {
      type: "Shebang",
      value: "/usr/bin/env node",
      loc: { start: { line: 1 }, end: { line: 1 } },
    };
    expect(collectViolations([typed], facts)).toEqual([]);
    const folded = { ...typed, type: "Line", value: "!/usr/bin/env node" };
    expect(collectViolations([folded], facts)).toEqual([]);
  });

  it("writes exactly the bytes the committed file holds", () => {
    expect(serializeBaseline(current)).toBe(raw);
  });

  it("scans the files the rule actually runs on", () => {
    const files = collectSourceFiles();
    expect(files).toContain("vitest.config.ts");
    expect(files).toContain("commitlint.config.js");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("test/arch/comment-gate.test.ts");
    expect(files).toContain("scripts/comment-gate-baseline.mjs");
    expect(files.filter((path) => path.startsWith("node_modules/"))).toEqual([]);
    expect(files.filter((path) => path.startsWith("benchmark/"))).toEqual([]);
  });

  it("passes --check on the committed tree", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(main(["--check"])).toBe(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("refuses an unknown option instead of writing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(main(["--frobnicate"])).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});

/**
 * The ratchet exercised end to end on throwaway roots: `--update` writes only the entries,
 * `--check` refuses a violation the baseline does not record, a fixed comment retires its entry,
 * and `--update` reports growth that reuses a text the baseline already holds. The ceiling
 * itself is not reachable from here — it lives in this file, and the CLI cannot read this file.
 */
describe("comment gate ratchet", () => {
  const roots: string[] = [];

  function makeRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "comment-gate-"));
    roots.push(root);
    mkdirSync(join(root, "test", "arch"), { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    return root;
  }

  function quietly<T>(run: () => T): T {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return run();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  function entriesOf(root: string): unknown {
    const parsed = parseBaselineEntries(readFileSync(join(root, BASELINE_PATH), "utf-8"));
    return parsed.ok ? parsed.entries : parsed.reason;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates the baseline from source, then agrees with it", () => {
    const root = makeRoot({ "src/a.ts": "// prose one\nconst a = 1;\n" });
    expect(quietly(() => main(["--update"], root))).toBe(0);
    expect(entriesOf(root)).toEqual([{ path: "src/a.ts", text: " prose one", occurrence: 0 }]);
    expect(quietly(() => main(["--check"], root))).toBe(0);
  });

  it("refuses a violation the baseline does not record", () => {
    const root = makeRoot({ "src/a.ts": "// prose one\nconst a = 1;\n" });
    quietly(() => main(["--update"], root));
    writeFileSync(join(root, "src/a.ts"), "// prose one\n// prose two\nconst a = 1;\n");
    expect(quietly(() => main(["--check"], root))).toBe(1);
  });

  it("retires an entry once its comment stops violating", () => {
    const root = makeRoot({ "src/a.ts": "// prose one\nconst a = 1;\n" });
    quietly(() => main(["--update"], root));
    writeFileSync(
      join(root, "src/a.ts"),
      "// Ref: docs/adr/0056-comment-gate-ratchet.md\nconst a = 1;\n",
    );
    expect(quietly(() => main(["--check"], root))).toBe(1);
    expect(quietly(() => main(["--update"], root))).toBe(0);
    expect(entriesOf(root)).toEqual([]);
  });

  it("reports growth instead of blocking it, so the ceiling literal stays the only ratchet", () => {
    const root = makeRoot({ "src/a.ts": "// shared text\nconst a = 1;\n" });
    quietly(() => main(["--update"], root));
    writeFileSync(join(root, "src/a.ts"), "// shared text\n// shared text\nconst a = 1;\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(main(["--update"], root)).toBe(0);
      const announced = error.mock.calls.map((call) => String(call[0])).join("\n");
      expect(announced).toContain("EXPECTED_MAX_LEGACY_COMMENTS");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(entriesOf(root)).toHaveLength(2);
  });
});
