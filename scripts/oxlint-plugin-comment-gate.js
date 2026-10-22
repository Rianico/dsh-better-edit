// harness/no-comments — curated allowlist per ADR-0014 (harness AI engineering)
// Deterministic CI gate: only allow high-signal comments. Everything else is error.
// Allowlist: SAFETY:|WHY:|Invariant:|See ADR-|via https://|TODO(#\d+):|HACK:|GHERKIN
// GHERKIN = ^\s*(Given|When|Then|And|But|Feature|Scenario|Background|Scenario Outline|Examples)\b/i
// Legal /** JSDoc header remains separate — allowed regardless of tag.

const ALLOWLIST_RE = /SAFETY:|WHY:|Invariant:|See ADR-|via https:\/\/|TODO\(#\d+\):|HACK:/;
const GHERKIN_RE =
  /^\s*(Given|When|Then|And|But|Feature|Scenario|Background|Scenario Outline|Examples)\b/i;

function isAllowed(rawValue) {
  if (!rawValue || !rawValue.trim()) return true; // empty comment
  const trimmed = rawValue.trim();
  // Legal /** JSDoc header: block value starts with '*' — allow regardless (ADR says separate)
  if (trimmed.startsWith("*")) return true;
  if (ALLOWLIST_RE.test(rawValue)) return true;
  if (GHERKIN_RE.test(trimmed)) return true;
  return false;
}

const MESSAGE =
  "Comments must use allowlist prefix: SAFETY:, WHY:, Invariant:, See ADR-, via https://, TODO(#<digits>):, HACK:, or Gherkin (Given/When/Then/And/But/Feature/Scenario). " +
  "Prefer extraction/rename until code explains what/how; use tag only for why/invariant/warning/regex/hack/ADR link with provenance. " +
  "Examples: // SAFETY: cast validated by ... | // WHY: tombstone union needed for ... | // See ADR-0013 | // TODO(#123):. " +
  "Otherwise fix code. Files with 50+ hits use overrides to disable rule per ADR ladder (shrink-only).";

const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "enforce curated comment allowlist (ADR-0014)",
      url: "https://github.com/Rianico/pi-better-edit/blob/main/docs/adr/0001-served-state-range-verification.md",
    },
    messages: {
      disallowed: MESSAGE,
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program() {
        let comments = [];
        if (sourceCode.getAllComments) {
          try {
            comments = sourceCode.getAllComments();
          } catch {}
        }
        // fallback for oxlint: ast.comments or getComments()
        if (!comments || comments.length === 0) {
          if (sourceCode.ast && sourceCode.ast.comments) comments = sourceCode.ast.comments;
          else if (context.sourceCode.text !== undefined) {
            // no comments API — skip
            comments = [];
          }
        }

        for (const c of comments) {
          const value = c.value ?? "";
          if (isAllowed(value)) continue;

          // Report at comment location; eslint supports loc, oxlint supports node+loc
          const loc = c.loc;
          if (loc) {
            context.report({ loc, message: MESSAGE });
          } else if (c.range) {
            // fallback: report on Program with range-derived loc not available — use Program node
            context.report({ node: c, message: MESSAGE });
          } else {
            // last resort: report on Program
            const program = sourceCode.ast && sourceCode.ast.body ? sourceCode.ast.body[0] : null;
            context.report({ node: program || { type: "Program" }, message: MESSAGE });
          }
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "harness" },
  rules: { "no-comments": rule },
};

export default plugin;
