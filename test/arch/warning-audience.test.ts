import { describe, expect, it } from "vitest";

import {
  WARNING_REGISTRY,
  formatWarning,
  type Audience,
  type DomainWarningCode,
  type WarningPayloadMap,
} from "../../src/domain-errors.js";

/**
 * Audience oracle for the warning registry (issue #116).
 *
 * The defect this guards: `W_NOOP` was routed USER while its text carried
 * "Resend will reject" — a prediction addressed to the model. The party that
 * would resend never acted on it, and the next resend tripped `E_NOOP_LOOP`.
 * Audience names the actor, not the channel: a warning rendered into model
 * content with a model-directed sentence is mislabelled when it says USER.
 */

/** Retry directives and rejection predictions addressed to the model. */
const MODEL_DIRECTED_RE = /\b(?:re-?send|re-?try|re-?read)\b|\bwill reject\b/i;

type WarningFixtures = { [K in DomainWarningCode]: WarningPayloadMap[K][] };

const FIXTURES: WarningFixtures = {
  W_NEVER_SERVED_SHAPE: [{ count: 1 }, { count: 3 }],
  W_SERVED_PREFIX_MISMATCH: [{ k: 2, anchor: "aB3", servedLine: 7 }],
  W_REVERSED_ANCHORS: [{ fromHash: "aB3", toHash: "Zz9" }],
  W_UNICODE_LITERAL: [{ line: 4 }],
  W_LITERAL_BYPASS: [{}],
  W_EOL_REWRITTEN: [
    { target: "CRLF", source: "file", changed: 1 },
    { target: "LF", source: "config", changed: 2 },
    { target: "CR", source: "env", changed: 3 },
    { target: "LF", source: "system", changed: 1 },
  ],
  W_NOOP: [
    { ref: "edits[0] (a.txt)", anchorFrom: "aB3", anchorTo: "Zz9", batch: true, count: 2 },
    { ref: "a.txt", anchorFrom: "aB3", anchorTo: "Zz9", batch: false, count: 2, path: "a.txt" },
    { ref: "a.txt", anchorFrom: "aB3", anchorTo: "Zz9", batch: false, count: 2 },
  ],
  W_UNSERVED_INTERIOR: [
    { unservedLines: [3, 4], replacedLineCount: 6 },
    { unservedLines: [7], replacedLineCount: 9 },
  ],
  W_ENCODING_MIGRATED: [
    { path: "u16.txt", encoding: "utf16le", hasBOM: true },
    { path: "cp.txt", encoding: "windows-1251", hasBOM: false },
  ],
};

type Rendered = { code: DomainWarningCode; audience: Audience; text: string };

function renderedFor<K extends DomainWarningCode>(code: K): Rendered[] {
  return FIXTURES[code].map((payload) => ({
    code,
    audience: WARNING_REGISTRY[code].audience,
    text: formatWarning(code, payload),
  }));
}

function renderedWarnings(): Rendered[] {
  return (Object.keys(WARNING_REGISTRY) as DomainWarningCode[]).flatMap((code) =>
    renderedFor(code),
  );
}

/** The violation predicate. Kept pure so the positive control can drive it. */
function userModelDirected(rendered: readonly Rendered[]): Rendered[] {
  return rendered.filter(
    (entry) => entry.audience === "USER" && MODEL_DIRECTED_RE.test(entry.text),
  );
}

describe("warning audience (issue #116)", () => {
  it("W_NOOP renders the header of the audience that must act, in every shape", () => {
    expect(WARNING_REGISTRY.W_NOOP.audience).toBe("MODEL");
    const rendered = renderedFor("W_NOOP");
    expect(rendered).toHaveLength(3);
    for (const { text } of rendered) {
      expect(text.startsWith("[MODEL] [W_NOOP] "), text).toBe(true);
      expect(text).toContain("Resend will reject");
    }
  });

  it("every warning has a fixture and renders a header", () => {
    for (const code of Object.keys(WARNING_REGISTRY) as DomainWarningCode[]) {
      expect(FIXTURES[code].length, `${code} has no fixture`).toBeGreaterThan(0);
    }
    for (const { code, text } of renderedWarnings()) {
      expect(text, code).toMatch(/^\[(?:MODEL|USER)\] \[W_[A-Z_]+\] /);
    }
  });

  it("no USER-routed warning renders a model-directed directive or prediction", () => {
    const violations = userModelDirected(renderedWarnings());
    expect(
      violations.map((entry) => `${entry.code}: ${entry.text}`),
      "a USER warning carries text addressed to the model — route it MODEL or rewrite it",
    ).toEqual([]);
  });

  it("positive control: the predicate fires on the retired W_NOOP text, not on a benign notice", () => {
    const planted: Rendered[] = [
      {
        code: "W_NOOP",
        audience: "USER",
        text: "[USER] [W_NOOP] Notice: identical edit no-op'd twice; range already has this text. Resend will reject.",
      },
      {
        code: "W_REVERSED_ANCHORS",
        audience: "USER",
        text: "[USER] [W_REVERSED_ANCHORS] anchor_from/anchor_to were reversed (aB3 after Zz9); healed and applied with the range swapped.",
      },
    ];
    expect(userModelDirected(planted).map((entry) => entry.code)).toEqual(["W_NOOP"]);
  });
});
