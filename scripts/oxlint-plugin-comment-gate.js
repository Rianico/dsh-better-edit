/**
 * `harness/no-comments` — the settled comment grammar, as a deterministic CI gate.
 *
 * Grammar and baseline keying live in `scripts/comment-gate-predicate.mjs`, shared with the baseline
 * generator so the rule and its suppression file cannot drift.
 *
 * Allowed: SAFETY:, TODO(#<issue>):, HACK:, `Ref: docs/<repo-path>` or `Ref: <link>`, strict Gherkin,
 * and `/** *\/` documentation at module scope within 12 lines. `Ref:` is the only citation tag and it
 * takes a target; a block carrying a retired token is prose, as are an in-body block, an over-cap
 * block, and a `SAFETY:` run that guards nothing.
 * Provenance: docs/agents/comment-grammar.md; decision: docs/adr/0056-comment-gate-ratchet.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_COMMAND,
  BASELINE_PATH,
  FUNCTION_KINDS,
  GUARD_KINDS,
  RULE,
  baselineKey,
  collectViolations,
  parseBaseline,
} from "./comment-gate-predicate.mjs";

const MESSAGES = {
  [RULE.prose]:
    "Comment carries no allowlisted tag. Prefix it with SAFETY:, TODO(#<issue>):, HACK:, Ref: docs/<repo-path> or Ref: https://<link>; a tool directive (eslint-disable*, oxlint-disable*) is allowed when a `--` follows it with a stated reason; a Gherkin step is Given /When /Then /And /But (capitalized, trailing space) or a Feature:/Scenario: heading. A `/** */` block that carries a WHY:, Invariant:, See ADR- or via https:// token is prose too. Prefer deleting the comment until the code explains itself.",
  [RULE.bodyDoc]:
    "`/** */` block sits inside a function body (the body starts at line {{line}}). Documentation belongs at module scope, on the declaration it describes: rename or extract until the code explains itself, and put the reason in a `//` tag comment.",
  [RULE.blockCap]:
    "`/** */` block spans {{lines}} lines, over the {{max}}-line cap. Move the rationale into an ADR under docs/adr/ and cite it on one line: `// Ref: docs/adr/<NNNN>-<slug>.md`.",
  [RULE.safetyPosition]:
    "`SAFETY:` guards nothing: the next non-blank line ({{line}}) is not a TSAsExpression, TSTypeAssertion or TSNonNullExpression. Move the comment directly above the cast or non-null assertion it justifies, or delete it when it explains a reason rather than an unchecked byte-level claim.",
  baselineMissing:
    "Comment gate baseline is {{reason}} at {{path}}, so no violation can be classified. Regenerate it with: {{command}}",
};

/** Walk up from the plugin file to the package root, so the baseline path is cwd-independent. */
function findRepoRoot(startDirectory) {
  let directory = startDirectory;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return startDirectory;
    directory = parent;
  }
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** Loaded once per process: the suppression file is one small read, not one per linted file. */
let baselineLoad;

function loadBaseline() {
  if (baselineLoad !== undefined) return baselineLoad;
  const absolute = join(REPO_ROOT, BASELINE_PATH);
  let raw;
  try {
    raw = readFileSync(absolute, "utf-8");
  } catch {
    baselineLoad = { ok: false, reason: "unreadable" };
    return baselineLoad;
  }
  baselineLoad = parseBaseline(raw);
  return baselineLoad;
}

/** Reporter for the one baseline error: once per process, never once per file. */
let baselineErrorReported = false;

/** @param {string} filename */
function relativePath(filename) {
  return relative(REPO_ROOT, filename).split(sep).join("/");
}

/** @param {any} sourceCode */
function sourceLinesOf(sourceCode) {
  if (typeof sourceCode.getLines === "function") return sourceCode.getLines();
  const text = typeof sourceCode.text === "string" ? sourceCode.text : "";
  return text.split(/\r\n|[\r\n\u2028\u2029]/u);
}

/**
 * The rule's contract: a JSDoc type rather than an inline assertion, because this file must
 * load as plain ESM with no build step while consumers (and the arch suite) need oxlint's
 * `Rule` type instead of a widened object literal.
 * @type {import("oxlint/plugins-dev").Rule}
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "enforce the settled comment grammar (docs/agents/comment-grammar.md)",
      url: "https://github.com/Rianico/dsh-better-edit/blob/main/docs/agents/comment-grammar.md",
    },
    schema: [],
    messages: MESSAGES,
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode?.();
    const filename = context.filename ?? context.physicalFilename ?? context.getFilename?.() ?? "";
    const functionBodies = [];
    const guardLines = [];

    const visitors = {
      "Program:exit"() {
        const allComments =
          typeof sourceCode.getAllComments === "function" ? sourceCode.getAllComments() : [];
        const facts = { functionBodies, guardLines, sourceLines: sourceLinesOf(sourceCode) };
        const violations = collectViolations(allComments, facts);

        const baseline = loadBaseline();
        if (!baseline.ok) {
          if (baselineErrorReported) return;
          baselineErrorReported = true;
          context.report({
            loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
            messageId: "baselineMissing",
            data: {
              reason: baseline.reason,
              path: BASELINE_PATH,
              command: BASELINE_COMMAND,
            },
          });
          return;
        }

        const path = relativePath(filename);
        for (const violation of violations) {
          const key = baselineKey(path, violation.text, violation.occurrence);
          if (baseline.keys.has(key)) continue;
          context.report({
            loc: violation.comment.loc,
            messageId: violation.rule,
            data: violation.data,
          });
        }
      },
    };

    for (const kind of FUNCTION_KINDS) {
      visitors[kind] = (node) => {
        const body = node.body;
        if (body?.type === "BlockStatement" && body.loc) {
          functionBodies.push([body.loc.start.line, body.loc.end.line]);
        }
      };
    }
    for (const kind of GUARD_KINDS) {
      visitors[kind] = (node) => {
        if (node.loc) guardLines.push(node.loc.start.line);
      };
    }

    return visitors;
  },
};

const plugin = {
  meta: { name: "harness" },
  rules: { "no-comments": rule },
};

export default plugin;
