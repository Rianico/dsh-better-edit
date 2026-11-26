/**
 * Settled comment grammar, in one module, for every consumer: the gate and the baseline generator
 * each adapt their own parser into the same `AstFacts`, and the classification below is shared, so
 * the suppression file and the rule that reads it cannot drift.
 *
 * Provenance: docs/adr/0056-comment-gate-ratchet.md. Baseline key (`baselineKey`):
 * `(path, text, occurrence)` — repo-relative path, the comment's raw `value`, and the 0-based
 * index of that exact text among the file's VIOLATIONS, so a key stays stable when an allowed
 * duplicate with the same text sits beside a rejected one.
 */

/**
 * Tags that make a `//` or `/* *\/` comment carry a reason instead of prose. ANCHORED: the tag must
 * OPEN the text it is matched against, because an unanchored alternation let a tag anywhere in a
 * sentence satisfy the gate — a mid-sentence `(why: never break the view)` passed without being a
 * reason, which is the whole failure this gate exists to prevent.
 *
 * `Ref:` is the SOLE source-citation tag, and it takes a resolvable target: a repo-relative doc or
 * record path, or an absolute `http(s)` link. The two old tag words, the bare ADR-citation prefix
 * and the URL-prefix citation are gone by owner decision (the regex below is the exact list): a
 * reason that needs a tag needs a citation a reader can follow, and a bare tag was the shape that
 * let unreviewable prose through.
 */
export const ALLOWLIST_RE =
  /^(?:SAFETY:|TODO\(#\d+\):|HACK:|Ref: (?:docs\/[\w./-]+|https?:\/\/\S+))/;

/**
 * A `/** *\/` block carrying a retired tag as TEXT. Containment, not anchoring, and on purpose: a
 * docblock has no tag position to anchor to, and a retired token inside one is precisely the escape
 * hatch the `//` rule closes — without this arm a block would become the place a stolen reason goes
 * to live. All four retired forms are listed, not only the two shaped like a tag: the old ADR
 * prefix and the old URL prefix were citations a reader could follow, so `Ref:` is the only
 * surviving citation form. The fix is the same either way (delete the token, or cite a record
 * with `Ref:`), so it shares the `prose` key instead of adding a rule kind.
 */
export const RETIRED_TAG_RE = /(?:WHY:|Invariant:|See ADR-|via https:\/\/)/;

/**
 * Directive comments whose keyword must open the line for its tool to honour it, with the
 * justification after a `--` separator. Anchoring alone would force these to choose between being
 * honoured and being explained, so the reason lives in the remainder. The reason is free-form prose:
 * the directive already names the rule it suppresses, so the only thing left to require is that a
 * reason EXISTS — an unexplained suppression is the debt this gate exists to make visible.
 *
 * Only `eslint-disable*` and `oxlint-disable*` are honoured here. There is no pi-lens bridge in
 * this repo, so a `pi-lens-ignore` line would silence nothing and is prose like any other comment.
 */
export const DIRECTIVE_PREFIX_RE =
  /^(?:eslint-disable(?:-next-line|-line)?|oxlint-disable(?:-next-line|-line)?)(?::\s*[\w@./-]+)?(?:\s+[\w@./-]+)*\s+--\s+/;

/**
 * Does this text state a reason — an allowlisted tag at its start, or a tool directive followed by a
 * `--` and something to say? The directive's reason is not held to the tag vocabulary (see
 * `DIRECTIVE_PREFIX_RE`); a directive whose `--` carries nothing is prose.
 * @param {string} text trimmed comment value
 */
export function hasStatedReason(text) {
  if (ALLOWLIST_RE.test(text)) return true;
  const directive = DIRECTIVE_PREFIX_RE.exec(text);
  if (directive === null) return false;
  return text.slice(directive[0].length).trim() !== "";
}

/** Gherkin steps: Title Case keyword plus a mandatory trailing space. Case-sensitive. */
export const GHERKIN_STEP_RE = /^(Given|When|Then|And|But) /;

/** Gherkin headings: Title Case keyword plus a colon. `Background`/`Scenario Outline` are out. */
export const GHERKIN_HEADING_RE = /^(Feature|Scenario):/;

/** A `/** *\/` block longer than this many lines must become an ADR plus one `// Ref:` line. */
export const MAX_BLOCK_LINES = 12;

/**
 * Function node types that own a body, spelled for BOTH parsers. oxlint spells a class or object
 * method as `MethodDefinition` holding a `FunctionExpression`; Babel spells them `ClassMethod` and
 * `ObjectMethod`. The union is required: the plugin never emits the last two, but the generator's
 * parser would miss a docblock inside a method body without them, and the arch suite's parity
 * corpus caught exactly that divergence before this comment existed.
 */
export const FUNCTION_KINDS = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassMethod",
  "ObjectMethod",
];
/**
 * The only node kinds a `// SAFETY:` run may guard. There is deliberately no
 * callee-name arm: no live site needs one, and a name list would be guessed from
 * comment text rather than derived from the AST.
 */
export const GUARD_KINDS = ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression"];

/** Repo-relative location of the suppression file. */
export const BASELINE_PATH = "test/arch/comment-gate-baseline.json";

/** The command that regenerates the suppression file. Named in the missing-baseline error. */
export const BASELINE_COMMAND = "node scripts/comment-gate-baseline.mjs --update";

/** Violation keys. The plugin maps each to a message; the generator writes them as data. */
export const RULE = {
  prose: "prose",
  bodyDoc: "bodyDoc",
  blockCap: "blockCap",
  safetyPosition: "safetyPosition",
};

/**
 * A `/** *\/` block: oxlint reports `type: "Block"` and the value keeps the second star,
 * so every JSDoc value starts with `*`.
 * @param {{ type: string, value: string }} comment
 */
export function isJSDoc(comment) {
  return comment.type === "Block" && comment.value.startsWith("*");
}

/**
 * Tag, reference or Gherkin? The value is trimmed at the start only: every `//` comment
 * value begins with the space after the slashes, and Gherkin's mandatory trailing space
 * is the point being enforced.
 * @param {string} rawValue
 */
export function isAllowedText(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === "") return true;
  if (hasStatedReason(trimmed)) return true;
  return GHERKIN_STEP_RE.test(trimmed) || GHERKIN_HEADING_RE.test(trimmed);
}

/**
 * A thrown value's message, for a failure `reason` string. `String` covers the non-`Error` throw,
 * which the previous inline annotation reported as `undefined`.
 * @param {unknown} error
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `#!` line on line 1 is the interpreter directive, not a comment. Babel records it as
 * `interpreter`; oxlint surfaces it as a `Shebang` comment (or as a line comment carrying the `!`),
 * so without this the two layers would disagree about the first line of every executable script.
 * @param {{ type: string, value: string, loc: { start: { line: number } } }} comment
 */
function isShebang(comment) {
  if (comment.type === "Shebang") return true;
  return comment.type === "Line" && comment.loc.start.line === 1 && comment.value.startsWith("!");
}

/** @param {{ type: string, value: string }} comment */
function isSafetyLine(comment) {
  return comment.type === "Line" && /SAFETY:/.test(comment.value);
}

/**
 * How many of a `// SAFETY:` run's next NON-BLANK lines may carry the guard. One was the shipped
 * bound (the immediately following line only); Tranche 2A proved that bound cannot express an
 * honest placement whenever the guard sits inside a multi-line expression, so a run may now sit
 * above one intervening statement. Three non-blank lines between the run and its cast means the
 * comment no longer points at the claim, which is the failure this bound exists to catch.
 */
export const SAFETY_GUARD_LOOKAHEAD = 2;

/**
 * The next `count` non-blank source lines strictly after `line`, in source order. Shorter than
 * `count` at end of file.
 * @param {ReadonlyArray<string>} sourceLines 1-indexed by `line - 1`
 * @param {number} line
 * @param {number} count defaults to the shipped guard lookahead
 * @returns {number[]}
 */
export function nextNonBlankLines(sourceLines, line, count = SAFETY_GUARD_LOOKAHEAD) {
  const found = [];
  for (
    let candidate = line + 1;
    candidate <= sourceLines.length && found.length < count;
    candidate += 1
  ) {
    const text = sourceLines[candidate - 1] ?? "";
    if (text.trim() !== "") found.push(candidate);
  }
  return found;
}

/**
 * The last line of the `// SAFETY:` run that starts at or contains `line`.
 * @param {ReadonlySet<number>} safetyLines
 * @param {number} line
 */
function safetyRunEnd(safetyLines, line) {
  let end = line;
  while (safetyLines.has(end + 1)) end += 1;
  return end;
}

/** @param {readonly [number, number]} body @param {{ loc: { start: { line: number }, end: { line: number } } }} comment */
function overlapsBody(body, comment) {
  return comment.loc.start.line <= body[1] && comment.loc.end.line >= body[0];
}

/**
 * Classify one comment.
 *
 * @param {GateComment} comment
 * @param {AstFacts} facts
 * @param {ReadonlySet<number>} safetyLines lines holding a `// SAFETY:` comment
 * @returns {{ rule: string, data?: Record<string, string | number> } | null} null when allowed
 */
export function classifyComment(comment, facts, safetyLines) {
  if (isJSDoc(comment)) {
    if (RETIRED_TAG_RE.test(comment.value)) return { rule: RULE.prose };
    const body = facts.functionBodies.find((range) => overlapsBody(range, comment));
    if (body !== undefined) return { rule: RULE.bodyDoc, data: { line: body[0] } };
    const lines = comment.loc.end.line - comment.loc.start.line + 1;
    if (lines > MAX_BLOCK_LINES) {
      return { rule: RULE.blockCap, data: { lines, max: MAX_BLOCK_LINES } };
    }
    return null;
  }

  if (!isAllowedText(comment.value)) return { rule: RULE.prose };

  if (isSafetyLine(comment)) {
    const runEnd = safetyRunEnd(safetyLines, comment.loc.start.line);
    const candidates = nextNonBlankLines(facts.sourceLines, runEnd);
    if (!candidates.some((line) => facts.guardLines.includes(line))) {
      return {
        rule: RULE.safetyPosition,
        data: { line: candidates[0] ?? "end of file" },
      };
    }
  }

  return null;
}

/**
 * Every violation in one file, in source order, each carrying its canonical baseline
 * occurrence index. `text` and `path` stay on the record so a caller can key it without
 * re-deriving the counting rule.
 *
 * @param {ReadonlyArray<GateComment>} comments
 * @param {AstFacts} facts
 * @returns {Array<{ comment: GateComment, rule: string, data: Record<string, string | number>, text: string, occurrence: number }>}
 */
export function collectViolations(comments, facts) {
  const safetyLines = new Set(
    comments.filter(isSafetyLine).map((comment) => comment.loc.start.line),
  );
  const occurrences = new Map();
  const violations = [];
  for (const comment of comments) {
    if (isShebang(comment)) continue;
    const verdict = classifyComment(comment, facts, safetyLines);
    if (verdict === null) continue;
    const text = comment.value;
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    violations.push({ comment, rule: verdict.rule, data: verdict.data ?? {}, text, occurrence });
  }
  return violations;
}

/**
 * The canonical suppression key. `\u0000` cannot appear in a comment value or a path,
 * so the join is unambiguous.
 * @param {string} path repo-relative POSIX path
 * @param {string} text raw comment `value`
 * @param {number} occurrence
 */
export function baselineKey(path, text, occurrence) {
  return `${path}\u0000${text}\u0000${occurrence}`;
}

/**
 * Parse a suppression file into its validated entries. The generator needs the entries (to diff
 * and rewrite them); the plugin needs only the keys, and `parseBaseline` derives those from here
 * so both consumers accept exactly the same bytes.
 *
 * @param {string} raw file contents
 * @returns {{ ok: true, entries: BaselineEntry[] } | { ok: false, reason: string }}
 */
export function parseBaselineEntries(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `not valid JSON (${messageOf(error)})` };
  }
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, reason: 'no "entries" array' };
  }
  for (const entry of entries) {
    const { path, text, occurrence } = entry ?? {};
    if (typeof path !== "string" || typeof text !== "string" || typeof occurrence !== "number") {
      return {
        ok: false,
        reason: "an entry is missing a string path/text or a numeric occurrence",
      };
    }
  }
  return { ok: true, entries };
}

/**
 * Parse a suppression file into its key set.
 *
 * @param {string} raw file contents
 * @returns {{ ok: true, keys: Set<string> } | { ok: false, reason: string }}
 */
export function parseBaseline(raw) {
  const parsed = parseBaselineEntries(raw);
  if (!parsed.ok) return parsed;
  const keys = new Set();
  for (const { path, text, occurrence } of parsed.entries) {
    keys.add(baselineKey(path, text, occurrence));
  }
  return { ok: true, keys };
}

/**
 * @typedef {{ type: string, value: string, loc: { start: { line: number, column?: number }, end: { line: number, column?: number } } }} GateComment
 * @typedef {{ functionBodies: ReadonlyArray<readonly [number, number]>, guardLines: ReadonlyArray<number>, sourceLines: ReadonlyArray<string> }} AstFacts
 * @typedef {{ path: string, text: string, occurrence: number }} BaselineEntry
 */
