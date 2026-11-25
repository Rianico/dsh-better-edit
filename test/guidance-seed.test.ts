import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  SEED_VERSION,
  decideSeededFile,
  projectSeededBytes,
  seedHash,
  type SeedDecision,
} from "../src/guidance/seed.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const DECISIONS: readonly SeedDecision[] = [
  "current",
  "refresh",
  "preserve",
  "deliberate-blank",
  "malformed",
];

const DEFAULT_EDIT = "---\norder: 1300\n---\n\n- read the file\n- edit it\n";

const CUSTOM_EDIT = "---\norder: 1300\n---\n\n- my own guidance\n";

function input(overrides: {
  content: string;
  recorded?: string;
  currentDefault?: string;
  historical?: readonly string[];
}) {
  return {
    content: overrides.content,
    recorded: overrides.recorded,
    currentDefault: overrides.currentDefault ?? DEFAULT_EDIT,
    historical: overrides.historical ?? [],
  };
}

describe("SEED_VERSION", () => {
  it("is 1", () => {
    expect(SEED_VERSION).toBe(1);
  });
});

describe("projectSeededBytes", () => {
  it("strips a leading BOM", () => {
    expect(projectSeededBytes("\uFEFFbody\n")).toBe("body");
  });

  it("strips every leading BOM", () => {
    expect(projectSeededBytes("\uFEFF\uFEFFbody")).toBe("body");
  });

  it("is idempotent over a double-BOM + CRLF + trailing-blank fixture", () => {
    const once = projectSeededBytes("\uFEFF\uFEFFa\r\nb\r\n\r\n");
    expect(once).toBe("a\nb");
    expect(projectSeededBytes(once)).toBe(once);
  });

  it("normalizes CRLF to LF", () => {
    expect(projectSeededBytes("a\r\nb\r\n")).toBe("a\nb");
  });

  it("normalizes a lone CR to LF", () => {
    expect(projectSeededBytes("a\rb")).toBe("a\nb");
  });

  it("normalizes a mixture of CRLF and lone CR", () => {
    expect(projectSeededBytes("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips trailing newlines", () => {
    expect(projectSeededBytes("body\n\n\n")).toBe("body");
  });

  it("strips trailing whitespace-only lines", () => {
    expect(projectSeededBytes("body\n \n\t\n   ")).toBe("body");
  });

  it("preserves interior lines verbatim, including their trailing spaces", () => {
    expect(projectSeededBytes("a\n  b  \n\tc\n\n")).toBe("a\n  b  \n\tc");
  });

  it("preserves trailing spaces on a content-bearing final line", () => {
    expect(projectSeededBytes("body   \n")).toBe("body   ");
  });

  it("projects an empty string to an empty string", () => {
    expect(projectSeededBytes("")).toBe("");
  });

  it("projects a whitespace/newline-only string to an empty string", () => {
    expect(projectSeededBytes("\n\n \r\n\t\r")).toBe("");
  });

  it("is idempotent over a mixed BOM + CRLF + trailing-blank fixture", () => {
    const once = projectSeededBytes("\uFEFFa\r\nb\r\n\r\n  \r\n");
    expect(once).toBe("a\nb");
    expect(projectSeededBytes(once)).toBe(once);
  });
});

describe("seedHash", () => {
  it("is 64 lowercase hex characters", () => {
    expect(seedHash("body")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("equals the sha256 of the projected bytes", () => {
    const content = "\uFEFFline one\r\nline two\r\n\r\n";
    expect(seedHash(content)).toBe(sha256(projectSeededBytes(content)));
  });

  it("matches across BOM, CRLF, and trailing-blank variants of the same content", () => {
    const base = seedHash("line one\nline two");
    expect(seedHash("\uFEFFline one\nline two")).toBe(base);
    expect(seedHash("line one\r\nline two\r\n")).toBe(base);
    expect(seedHash("line one\nline two\n\n   \n")).toBe(base);
  });

  it("flips on a one-character body change", () => {
    expect(seedHash("alpha\n")).not.toBe(seedHash("alphb\n"));
  });
});

describe("decideSeededFile — current", () => {
  it("reports the exact default as current", () => {
    expect(decideSeededFile(input({ content: DEFAULT_EDIT }))).toBe("current");
  });

  it("reports a BOM/CRLF/trailing-blank variant of the default as current", () => {
    const variant = `\uFEFF${DEFAULT_EDIT.replaceAll("\n", "\r\n")}\r\n \r\n`;
    expect(decideSeededFile(input({ content: variant }))).toBe("current");
  });

  it("wins over recorded and historical matches", () => {
    const decision = decideSeededFile(
      input({
        content: DEFAULT_EDIT,
        recorded: seedHash(DEFAULT_EDIT),
        historical: [seedHash(DEFAULT_EDIT)],
      }),
    );
    expect(decision).toBe("current");
  });
});

describe("decideSeededFile — refresh", () => {
  it("reports a previously recorded seed as refresh", () => {
    expect(decideSeededFile(input({ content: CUSTOM_EDIT, recorded: seedHash(CUSTOM_EDIT) }))).toBe(
      "refresh",
    );
  });

  it("reports a historically seeded body as refresh", () => {
    expect(
      decideSeededFile(input({ content: CUSTOM_EDIT, historical: [seedHash(CUSTOM_EDIT)] })),
    ).toBe("refresh");
  });

  it("compares through the projection, so a CRLF-variant recorded body still refreshes", () => {
    const content = CUSTOM_EDIT.replaceAll("\n", "\r\n");
    expect(decideSeededFile(input({ content, recorded: seedHash(CUSTOM_EDIT) }))).toBe("refresh");
  });

  it("does not refresh when recorded is a different hash", () => {
    expect(
      decideSeededFile(input({ content: CUSTOM_EDIT, recorded: seedHash("something else") })),
    ).toBe("preserve");
  });

  it("does not refresh when historical holds different hashes", () => {
    expect(
      decideSeededFile(input({ content: CUSTOM_EDIT, historical: [seedHash("older seed")] })),
    ).toBe("preserve");
  });
});

describe("decideSeededFile — preserve", () => {
  it("preserves a genuine customization with no recorded hash", () => {
    expect(decideSeededFile(input({ content: CUSTOM_EDIT, recorded: undefined }))).toBe("preserve");
  });

  it("preserves a bare blank file (the materializer's healBlankOverride owns that policy)", () => {
    expect(decideSeededFile(input({ content: "  \n\t\n " }))).toBe("preserve");
  });

  it("preserves an empty file", () => {
    expect(decideSeededFile(input({ content: "" }))).toBe("preserve");
  });

  it("preserves a newline-only file", () => {
    expect(decideSeededFile(input({ content: "\n\n\r\n" }))).toBe("preserve");
  });
});

describe("decideSeededFile — deliberate-blank", () => {
  it("reports a keyless empty fence as deliberate-blank", () => {
    expect(decideSeededFile(input({ content: "---\n---\n" }))).toBe("deliberate-blank");
  });

  it("reports an order-only fence as deliberate-blank", () => {
    expect(decideSeededFile(input({ content: "---\norder: 1100\n---\n" }))).toBe(
      "deliberate-blank",
    );
  });

  it("reports a whitespace-only body under a fence as deliberate-blank", () => {
    expect(decideSeededFile(input({ content: "---\n---\n\n  \n" }))).toBe("deliberate-blank");
  });

  it("reports a CRLF fence as deliberate-blank", () => {
    expect(decideSeededFile(input({ content: "---\r\n---\r\n" }))).toBe("deliberate-blank");
  });

  it("wins over recorded and historical matches", () => {
    const content = "---\n---\n";
    expect(
      decideSeededFile(
        input({
          content,
          recorded: seedHash(content),
          historical: [seedHash(content)],
        }),
      ),
    ).toBe("deliberate-blank");
  });
});

describe("decideSeededFile — malformed", () => {
  it("reports a missing closing fence as malformed", () => {
    expect(decideSeededFile(input({ content: "---\norder: 150\nbody then" }))).toBe("malformed");
  });

  it("reports a non-integer order as malformed", () => {
    expect(decideSeededFile(input({ content: "---\norder: abc\n---\nbody" }))).toBe("malformed");
  });

  it("wins over blank and hash rules", () => {
    const content = "---\n   \n";
    expect(
      decideSeededFile(
        input({
          content,
          recorded: seedHash(content),
          historical: [seedHash(content)],
        }),
      ),
    ).toBe("malformed");
  });

  it("reports an order-only whitespace-body fence as deliberate-blank despite a recorded match", () => {
    const content = "---\norder: 1100\n---\n   \n";
    expect(decideSeededFile(input({ content, recorded: seedHash(content) }))).toBe(
      "deliberate-blank",
    );
  });

  it("reports an order-only whitespace-body fence with an invalid order as malformed", () => {
    expect(decideSeededFile(input({ content: "---\norder: nope\n---\n   \n" }))).toBe("malformed");
  });
});

describe("decideSeededFile — purity and totality", () => {
  const weird: readonly string[] = [
    "\uFEFF\r\n\r\n",
    "\uFEFF",
    "\r",
    "\r\n\r\n",
    "---",
    "---\r\n",
    "\u0000",
    "---\n---",
    "\uFEFF---\n---\n",
  ];

  it("never throws and always returns a known decision", () => {
    for (const content of weird) {
      expect(() => decideSeededFile(input({ content }))).not.toThrow();
      expect(DECISIONS).toContain(decideSeededFile(input({ content })));
    }
  });

  it("preserves a BOM + CRLF + blank fixture", () => {
    expect(decideSeededFile(input({ content: "\uFEFF\r\n\r\n" }))).toBe("preserve");
  });
});
