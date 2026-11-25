/**
 * Pure seed-identity seam: zero IO. Owns the projection, the hashing, and the
 * decision matrix that classify an override file against the seed ledger;
 * the materializer wires the ledger and writes.
 * @module dsh-better-edit/guidance/seed
 */
import { createHash } from "node:crypto";

import { parseSectionFile } from "./parse.js";

/** Manifest schema version for the seeded-file ledger. */
export const SEED_VERSION = 1;

/**
 * Guidance override file key `<preset>/<section file>`, e.g. `standard/edit.md`.
 * Matches the future `.seeded.json` manifest key shape.
 */
export type GuidanceFile = `${string}/${string}`;

/**
 * Seed-identity verdict for one override file.
 * - `current`: the file still carries the compiled default.
 * - `refresh`: the file carries a seed this ledger wrote earlier (or an older
 *   seed body) and may be re-seeded with the new default.
 * - `preserve`: user intent that must survive untouched.
 * - `deliberate-blank`: the user disabled the section with a valid empty fence.
 * - `malformed`: the front-matter fence does not parse; never rewrite.
 */
export type SeedDecision = "current" | "refresh" | "preserve" | "deliberate-blank" | "malformed";

const BOM_RUN = /^\uFEFF+/;

function stripLeadingBoms(content: string): string {
  return content.replace(BOM_RUN, "");
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * True when the first line of `content` is a `---` fence opener. parse.ts keeps
 * its own unexported copy; this seam re-states it rather than widen that module.
 */
function startsWithFenceLine(content: string): boolean {
  const first = content.split("\n", 1)[0] ?? "";
  return stripCR(first) === "---";
}

/**
 * Canonical seed bytes: leading BOM(s) dropped, CRLF and lone CR normalized to
 * LF, then trailing whitespace-only lines removed. Interior lines and trailing
 * spaces on a content-bearing final line are preserved. Idempotent; `""`
 * projects to `""`.
 */
export function projectSeededBytes(content: string): string {
  const lines = stripLeadingBoms(content).replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

/**
 * Identity of a seed body: sha256 (hex) over its projected bytes, so BOM,
 * EOL, and trailing-blank differences never fork the hash.
 */
export function seedHash(content: string): string {
  return createHash("sha256").update(projectSeededBytes(content), "utf8").digest("hex");
}

/** One override file's seed-identity inputs. */
export interface SeededFileInput {
  /** Current file bytes as stored on disk. */
  content: string;
  /** Hash recorded when the ledger last seeded this file, if any. */
  recorded: string | undefined;
  /** The compiled default the plugin would seed today. */
  currentDefault: string;
  /** Every hash this ledger has ever written for this file. */
  historical: readonly string[];
}

/**
 * Classify one override file. Total: never throws on any string input; the
 * decision order is malformed → blank → hash-based.
 *
 * Blank split, deliberately: a fenced blank (valid `---` opener, whitespace-only
 * body) is a deliberate "disable this section" choice and reports
 * `"deliberate-blank"`. A bare blank (whitespace-only content with no fence) is
 * a "use the default" choice owned by the materializer's existing
 * `healBlankOverride` pass, so this seam returns `"preserve"` and does not
 * claim that policy — an empty file therefore reports `"preserve"`.
 */
export function decideSeededFile(input: SeededFileInput): SeedDecision {
  const stripped = stripLeadingBoms(input.content);
  const parsed = parseSectionFile(stripped);
  if (parsed.malformed === true) return "malformed";
  if (parsed.text.trim() === "" && startsWithFenceLine(stripped)) return "deliberate-blank";
  if (parsed.text.trim() === "") return "preserve";
  const hash = seedHash(stripped);
  if (hash === seedHash(input.currentDefault)) return "current";
  if (input.recorded !== undefined && hash === input.recorded) return "refresh";
  if (input.historical.includes(hash)) return "refresh";
  return "preserve";
}
