/**
 * #108 property: no `E_MALFORMED_ANCHOR` reason may quote an unverified anchor.
 *
 * The tool's side of the model–tool boundary (GLOSSARY: `model–tool boundary`) is that it never
 * names a coordinate it has not verified against served state. A quoted 3-char anchor-shaped token
 * inside a refusal READS as such a coordinate — that is exactly how the deleted T1/T2 hints
 * ("use bare \"set\" next time", "use only the first hash \"wUp\" … \"AU6\"") steered a model into
 * an unrelated line. This file holds the runtime half; the source half is
 * `test/arch/unverified-anchor-hints.test.ts`.
 *
 * Refutability: the corpus below reproduces each defect shape (a paste whose first alnum run is a
 * real anchor, a fabricated pair, a no-alnum block). On `009b922` the same corpus produced quoted
 * `set` / `x` / `wUp` / `AU6` tokens and this property fails; the canned pre-fix control proves the
 * checker flags that string regardless of the current `src/` state.
 *
 * @module dsh-better-edit/test/anchor-hint-quoted-tokens
 */
import { describe, expect, it, beforeAll } from "vitest";
import { DomainError } from "../../src/domain-errors.js";
import { parseHashRef, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { initHasher } from "../../src/hashline/hasher.js";

/**
 * The only anchor-shaped literals a refusal may quote: the examples the messages themselves
 * document. `"aB3"` is the codebase's single documented example (`Expected a 3-char alphanumeric
 * anchor (e.g. "aB3")` / `Use the hash alone (e.g. "aB3")`) — it teaches shape, not a coordinate
 * of any file. Keep this set minimal: a token added here is a token the tool may pretend to know.
 */
const DOCUMENTED_EXAMPLE_ALLOWLIST: ReadonlySet<string> = new Set(["aB3"]);

/** Every double-quoted span in a refusal reason, verbatim. */
function quotedTokens(reason: string): string[] {
  return [...reason.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

function isAnchorShaped(token: string): boolean {
  return /^[A-Za-z0-9]{3}$/.test(token);
}

/** Quoted tokens that look like a coordinate but are not a documented shape example. */
function offendingTokens(reason: string): string[] {
  return quotedTokens(reason).filter(
    (token) => isAnchorShaped(token) && !DOCUMENTED_EXAMPLE_ALLOWLIST.has(token),
  );
}

type Refusal = { ref: string; via: "resEdit" | "parseHashRef"; reason: string };

function reasonOf(error: unknown): string {
  if (!(error instanceof DomainError)) throw error;
  expect(error.code).toBe("E_MALFORMED_ANCHOR");
  const payload = error.payload as { reason?: unknown };
  if (typeof payload.reason !== "string")
    throw new Error("E_MALFORMED_ANCHOR payload has no reason");
  return payload.reason;
}

function collect(ref: string, via: Refusal["via"]): Refusal | undefined {
  try {
    if (via === "resEdit") {
      resEdit({ anchor_from: ref, anchor_to: "aB3", replace_with: "new" });
    } else {
      parseHashRef(ref);
    }
    return undefined;
  } catch (error) {
    return { ref, via, reason: reasonOf(error) };
  }
}

/**
 * Each entry is a defect shape from issue #108, not a random string:
 * pastes whose first alnum run is a real anchor of another line, fabricated pairs, no-alnum
 * blocks, and the single-line shapes that reach `diagRef`.
 */
const CORPUS: string[] = [
  // The T1 reproduction: `settlementStatus` yielded the pseudo-anchor "set".
  "settlementStatus: '',\n      remark: ''\n    })\n  })",
  // Collision: the first 3-char run is a real hash (`wUp` = `"site": {`, `AU6` = `}` in src/).
  'wUp│  "site": {\nconst beta = 2;',
  "AU6│}\nconst gamma = 3;",
  // No 3-char alnum run anywhere — the deleted extractor's `undefined` arm, then the raw tail.
  '— —"\n"││"',
  "│\n│",
  // Fabricated pairs: a plausible-looking hash on each side of the newline.
  "x│y\nz│w",
  "abc│a\ndef│b",
  "1│2\n3│4",
  // Documented example masquerading as a block.
  "aB3\nxyz",
  // The T1 redaction fixture, with a trailing blank line.
  "const a = 1;\nconst b = 2;\n",
  // Single-line shapes that reach `diagRef` (the T2 seam).
  "abc│content",
  "x│y",
  "+abc│x",
  "-abc│x",
  "123abc",
  "abcd",
  "ab",
  "",
  "   ",
];

/** Deterministic PRNG so a failure is reproducible. */
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

const FUZZ_ALPHABET = 'ab3X09││\n\n+-" *_/{}()';

beforeAll(async () => {
  await initHasher();
});

describe("#108 no refusal quotes an unverified anchor", () => {
  it("the checker is refutable: the canned pre-fix hint is flagged", () => {
    // Verbatim shape of the deleted T1 message; independent of the current `src/`.
    const preFix = 'extracted first hash "set" from 4-line block — use bare "set" next time';
    expect(offendingTokens(preFix)).toEqual(["set", "set"]);
    // ... and the T2 shape.
    const preFixPipe =
      'Received 2 lines starting "abc│line one…" — use only the first hash "wUp" as anchor_from and "AU6" as anchor_to';
    expect(offendingTokens(preFixPipe)).toEqual(["wUp", "AU6"]);
    // The documented example is the one allowlisted literal.
    expect(offendingTokens('Expected a 3-char alphanumeric anchor (e.g. "aB3").')).toEqual([]);
  });

  it("the corpus refuses and leaks nothing (both entry points)", () => {
    const refusals = [
      ...CORPUS.map((ref) => collect(ref, "resEdit")),
      ...CORPUS.map((ref) => collect(ref, "parseHashRef")),
    ].filter((refusal): refusal is Refusal => refusal !== undefined);

    // Guard against a vacuous pass: the corpus must actually produce refusals.
    expect(refusals.length).toBeGreaterThanOrEqual(CORPUS.length);
    expect(offendingTokens(refusals.map((r) => r.reason).join("\n"))).toEqual([]);
    // Positive reach: the allowlist is exercised, not merely declared.
    expect(refusals.some((r) => quotedTokens(r.reason).includes("aB3"))).toBe(true);
  });

  it("fuzz: 300 block-shaped and anchor-shaped inputs leak nothing", () => {
    const rand = mulberry32(0x108);
    const samples: string[] = [];
    for (let i = 0; i < 300; i++) {
      const length = Math.floor(rand() * 25);
      let sample = "";
      for (let j = 0; j < length; j++) {
        sample += FUZZ_ALPHABET[Math.floor(rand() * FUZZ_ALPHABET.length)]!;
      }
      samples.push(sample);
    }

    const refusals = [
      ...samples.map((ref) => collect(ref, "resEdit")),
      ...samples.map((ref) => collect(ref, "parseHashRef")),
    ].filter((refusal): refusal is Refusal => refusal !== undefined);

    expect(refusals.length).toBeGreaterThan(300);
    expect(offendingTokens(refusals.map((r) => r.reason).join("\n"))).toEqual([]);
  });
});
