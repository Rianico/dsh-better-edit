/**
 * One module owns the request shapes for the hashline tools — edit,
 * read, undo_last_edit — plus their validation. Field sets are
 * declared once here; every tool validates through these asserts, and the
 * E_BAD_PAYLOAD vocabulary is shared instead of re-implemented per tool.
 *
 * Contract mirrors upstream ADR-0015: {file: string, edits: [{anchor_from, anchor_to, replace_with},...]} named-object payload
 * (plus legacy tuple items and legacy key spellings folded pre-validation), single-file, atomic. batch_edit is removed.
 * @module dsh-better-edit/contract
 */

import { EDITS_MAX_ITEMS } from "./constants.js";
import { isEncodingMigrationConsent } from "./encoding-consent.js";
import type { EncodingMigrationConsent } from "./encoding-consent.js";
import type { ReadWindow } from "./file-view.js";
import type { EditMode } from "./edit-mode.js";
import { isRec, normalizeFilePath, rejectUnknownFields } from "./utils.js";
import { DomainError } from "./domain-errors.js";

// ---- request shapes --------------------------------------------------------

// Declared in the edit-mode leaf; re-exported here so the contract's consumers are
// unchanged (ADR-0037 — the write pipeline imports the leaf, never this module).
export type { EditMode };

export type EditItem = {
  anchor_from: string;
  anchor_to: string;
  replace_with: string;
};

export type EditRequest = {
  file: string;
  edits: EditItem[];
  /**
   * "general" (default) refuses bytes reproducing served rows;
   * "literal" declares them as intended file content (W_LITERAL_BYPASS).
   */
  mode?: EditMode;
  /**
   * true = preview only: validate anchors and leases and compute the diff without
   * writing to disk, recording undo, or updating leases. Absent or null means false.
   */
  dry_run?: boolean;
  /**
   * Per-call encoding-migration consent for this edit: `"refuse"` never converts the file,
   * `"utf8"` / `"utf8bom"` convert it to UTF-8 without / with a BOM. Absent delegates to the
   * config ladder (`allowEncodingMigration` > legacy `normalizeToUtf8` > `"refuse"`); a present
   * value outside the enum (including `null`) is refused at admission.
   */
  allow_encoding_migration?: EncodingMigrationConsent;
};

// legacy single-edit shape retained for mutation.ts internal API (renamed with the payload)
export interface EditParams {
  file: string;
  anchor_from: string;
  anchor_to: string;
  replace_with: string;
  /** Legacy single-edit path: literal bypasses the served-echo guard. */
  mode?: EditMode;
}

export interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
  encoding?: string;
  /**
   * Multi-window read — disjoint line ranges served in one call. Shape and count
   * (max MAX_READ_WINDOWS) are validated in file-view's normWindows.
   */
  windows?: ReadWindow[];
}

export interface UndoParams {
  path: string;
}

// ---- normalized marker -----------------------------------------------------

export const normalizedEdit = Symbol("normalizedEdit");

export type NormalizedEditRequest = EditRequest & {
  [normalizedEdit]?: true;
};

export function isNormalizedEdit(input: unknown): input is NormalizedEditRequest {
  return isRec(input) && (input as Record<string | symbol, unknown>)[normalizedEdit] === true;
}

export function itemFromTuple(value: unknown): EditItem | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [anchor_from, anchor_to, replace_with] = value as unknown[];
  if (
    typeof anchor_from !== "string" ||
    typeof anchor_to !== "string" ||
    typeof replace_with !== "string"
  )
    return undefined;
  return { anchor_from, anchor_to, replace_with };
}

/**
 * Accept the named-object form ({ anchor_from, anchor_to, replace_with }),
 * the legacy tuple form ([a, b, t]), and the legacy-key form
 * (legacy spelling) per edits entry — all fold
 * to the named triple. Mixed old/new keys, extra keys, and 2-/4-position
 * tuples still return undefined so the caller rejects with E_BAD_PAYLOAD.
 */
export function itemFromEntry(value: unknown): EditItem | undefined {
  if (Array.isArray(value)) return itemFromTuple(value);
  if (isRec(value)) {
    const rec = value as Record<string, unknown>;
    const keys = new Set(Object.keys(rec));
    const useLegacy =
      keys.size === LEGACY_ITEM_KS.size && [...LEGACY_ITEM_KS].every((k) => keys.has(k));
    const useNamed = keys.size === ITEM_KS.size && [...ITEM_KS].every((k) => keys.has(k));
    if (!useNamed && !useLegacy) return undefined;
    const from = useNamed ? rec.anchor_from : rec.remove_from;
    const to = useNamed ? rec.anchor_to : rec.remove_to;
    const text = useNamed ? rec.replace_with : rec.replacement_text;
    if (typeof from !== "string" || typeof to !== "string" || typeof text !== "string")
      return undefined;
    return { anchor_from: from, anchor_to: to, replace_with: text };
  }
  return undefined;
}

const ROOT_INPUT_KS = new Set([
  "file",
  "file_path",
  "path",
  "edits",
  "mode",
  "dry_run",
  "allow_encoding_migration",
  "sandbox_permissions",
  "justification",
]);

export function editRequestFrom(input: unknown): NormalizedEditRequest | undefined {
  if (!isRec(input)) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ROOT_INPUT_KS.has(key)) return undefined;
  }
  const { file, file_path, path, edits, mode, dry_run, allow_encoding_migration } = rec as {
    file?: unknown;
    file_path?: unknown;
    path?: unknown;
    edits?: unknown;
    mode?: unknown;
    dry_run?: unknown;
    allow_encoding_migration?: unknown;
  };
  // file preferred; legacy path/file_path fold (sanitized). #117: a null or
  // absent file is an admission error — the anchor-inference seam is retired.
  let effectiveFile: unknown;
  if (file !== undefined) effectiveFile = file;
  else if (path !== undefined) effectiveFile = path;
  else if (file_path !== undefined) effectiveFile = file_path;
  else return undefined;
  if (typeof effectiveFile !== "string") return undefined;
  const effectivePath = sanitizePath(effectiveFile);
  if (effectivePath === null) return undefined;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const items: EditItem[] = [];
  for (const item of edits) {
    const normalized = itemFromEntry(item);
    if (!normalized) return undefined;
    items.push(normalized);
  }
  let effectiveMode: EditMode = "general";
  if (mode !== undefined) {
    if (mode !== "general" && mode !== "literal") return undefined;
    effectiveMode = mode;
  }
  let effectiveDryRun = false;
  if (dry_run !== undefined && dry_run !== null) {
    if (typeof dry_run !== "boolean") return undefined;
    effectiveDryRun = dry_run;
  }
  // Omission is the only spelling of "the config decides": a present value — `null` included —
  // must be a consent, so anything else fails the fold (refused by name in assertEditRequest).
  let effectiveConsent: EncodingMigrationConsent | undefined;
  if (allow_encoding_migration !== undefined) {
    if (!isEncodingMigrationConsent(allow_encoding_migration)) return undefined;
    effectiveConsent = allow_encoding_migration;
  }
  return {
    file: effectivePath,
    edits: items,
    mode: effectiveMode,
    dry_run: effectiveDryRun,
    // Absent stays absent: the config ladder must not see a materialized "refuse" here.
    ...(effectiveConsent === undefined ? {} : { allow_encoding_migration: effectiveConsent }),
  };
}

/**
 * Strip Gemma-4 tool-call bleed wrappers from a path string: `<|>`, `\u2502`, `|`
 * pairs plus surrounding quotes/backticks, applied iteratively. Returns the
 * cleaned path, or null when nothing usable remains (caller rejects).
 */
/** Paired/single bleed wrappers, longest-token first. Each entry strips one layer. */
const PATH_WRAPPERS: ReadonlyArray<{
  open: string;
  close: string;
  /** Minimum surviving length guard (keeps `"<|>"` alone from vanishing mid-loop). */
  minLen: number;
  pairOnly: boolean;
}> = [
  { open: "<|>", close: "<|>", minLen: 6, pairOnly: false },
  { open: "\u2502", close: "\u2502", minLen: 2, pairOnly: true },
  { open: "|", close: "|", minLen: 2, pairOnly: true },
  { open: '"', close: '"', minLen: 0, pairOnly: true },
  { open: "'", close: "'", minLen: 0, pairOnly: true },
  { open: "`", close: "`", minLen: 0, pairOnly: true },
];

export function sanitizePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let cleaned = value.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of PATH_WRAPPERS) {
      if (cleaned.length > w.minLen && cleaned.startsWith(w.open) && cleaned.endsWith(w.close)) {
        cleaned = cleaned.slice(w.open.length, -w.close.length).trim();
        changed = true;
      } else if (!w.pairOnly) {
        if (cleaned.startsWith(w.open)) {
          cleaned = cleaned.slice(w.open.length).trim();
          changed = true;
        } else if (cleaned.endsWith(w.close)) {
          cleaned = cleaned.slice(0, -w.close.length).trim();
          changed = true;
        }
      }
    }
  }
  return cleaned.length > 0 ? cleaned : null;
}

export const EDIT_PAYLOAD_HINT =
  "Edit must be called with exactly one payload. Use the canonical payload " +
  '{"file": file, "edits": [{ "anchor_from": anchor_from, "anchor_to": anchor_to, "replace_with": replace_with }, ...], "mode"?: "general" | "literal", "dry_run"?: boolean, "allow_encoding_migration"?: "refuse" | "utf8" | "utf8bom"}: ' +
  '"file" is the text file to edit (a non-empty string, never a directory); each item names ' +
  "two inclusive bare-3-char anchors and the full replacement " +
  '(an empty string deletes the range); optional "mode" is "general" (default, reproduced served rows are refused) or "literal" (declared literal content); optional "dry_run" is boolean (omitted or null means false — a live edit); optional "allow_encoding_migration" consents to converting this file to UTF-8 on this write — "refuse" (never convert), "utf8" (no BOM) or "utf8bom" (with BOM) — and omitted means the config decides. ' +
  "Legacy tuple items and legacy key spellings still fold; do not mix old and new key spellings.";

function describeReceived(input: unknown): string {
  if (input === undefined) return "Received no arguments.";
  if (input === null) return "Received null.";
  if (typeof input === "string") return `Received a bare string (${JSON.stringify(input)}).`;
  const json = JSON.stringify(input);
  const preview = typeof json === "string" && json.length > 160 ? `${json.slice(0, 160)}…` : json;
  return `Received: ${preview}`;
}

// ---- filed sets (declared once) ---------------------------------------------

const EDIT_KS = new Set([
  "file",
  "edits",
  "mode",
  "dry_run",
  "allow_encoding_migration",
  "sandbox_permissions",
  "justification",
]);
const READ_KS = new Set(["path", "offset", "limit", "encoding", "windows"]);
const ITEM_KS = new Set(["anchor_from", "anchor_to", "replace_with"]);
const LEGACY_ITEM_KS = new Set(["remove_from", "remove_to", "replacement_text"]);

// ---- normalization -----------------------------------------------------------

/**
 * Normalize `file_path` → `path` alias on the request record and tuple edits → objects.
 * Returns the input unchanged when not a record; otherwise returns a shallow copy with
 * the alias applied so callers never mutate the original `args` object.
 */
export function normalizeRequest(input: unknown): unknown {
  if (!isRec(input)) return input;
  const record: Record<string, unknown> = { ...input };
  normalizeFilePath(record);
  // also normalize file_path inside edits if they were objects (legacy) — not needed for tuple but harmless
  if (Array.isArray(record.edits)) {
    // keep tuple as-is; editRequestFrom will handle
  }
  const valid = editRequestFrom(record);
  if (!valid) return record;
  const normalized: Record<string, unknown> = {
    file: valid.file,
    edits: valid.edits,
    mode: valid.mode,
    dry_run: valid.dry_run,
    // Carried only when the caller named it: a materialized "refuse" would outrank the config.
    ...(valid.allow_encoding_migration === undefined
      ? {}
      : { allow_encoding_migration: valid.allow_encoding_migration }),
  };
  // preserve non-standard fields like sandbox_permissions/justification for later reject check? but we strip to valid fields and re-add them?
  for (const k of ["sandbox_permissions", "justification"]) {
    if (k in record) (normalized as Record<string, unknown>)[k] = record[k];
  }
  Object.defineProperty(normalized, normalizedEdit, { value: true, enumerable: false });
  return normalized;
}

/** @deprecated use normalizeRequest — kept as alias for migration */
export const normReq = normalizeRequest;

export function prepareEditArguments(args: unknown): Record<string, unknown> {
  const valid = editRequestFrom(args as unknown);
  if (valid) {
    // F10.1: preserve mode like normalizeRequest — the two normalizers agree.
    // prepareEditArguments returns schema-ready folded objects (named triple).
    return {
      file: valid.file,
      edits: valid.edits,
      mode: valid.mode,
      dry_run: valid.dry_run,
      ...(valid.allow_encoding_migration === undefined
        ? {}
        : { allow_encoding_migration: valid.allow_encoding_migration }),
    };
  }
  throw new DomainError("E_BAD_PAYLOAD", {
    message: `${EDIT_PAYLOAD_HINT} ${describeReceived(args)}`,
  });
}

// ---- assertions ---------------------------------------------------------------

/** The spellings a caller may name the target with, in payload precedence order. */
const FILE_SPELLINGS = ["file", "path", "file_path"] as const;

/** The exact refusal ADR-0031 quotes; one sentence, one owner. */
const FILE_REQUIRED_MESSAGE =
  "Edit request file must be a non-empty string; name the file to edit.";

/** The exact refusal for a non-boolean dry_run; one sentence, one owner. */
const DRY_RUN_TYPE_MESSAGE =
  'Edit request "dry_run" must be a boolean (absent or null means false — a live edit).';

/** The exact refusal for a bad encoding-migration consent; one sentence, one owner. */
const ENCODING_CONSENT_MESSAGE =
  'Edit request "allow_encoding_migration" must be "refuse", "utf8", or "utf8bom" (omit it to let the config decide).';

/**
 * #117: is this raw record an unnamed target rather than a malformed payload?
 *
 * `normalizeRequest` stamps its marker only when `editRequestFrom` succeeds, and
 * the fold rejects a null/absent file — so without this predicate the specific
 * refusal is unreachable and the caller only sees the generic hint. A spelling
 * that is present but wrongly typed is malformed, not unnamed, and stays generic.
 */
function namesNoFile(request: Record<string, unknown>): boolean {
  let seesUnnamed = false;
  for (const key of FILE_SPELLINGS) {
    if (!(key in request)) continue;
    const value = request[key];
    if (typeof value === "string") {
      if (sanitizePath(value) !== null) return false; // a usable name wins
      seesUnnamed = true;
      continue;
    }
    if (value === null || value === undefined) {
      seesUnnamed = true;
      continue;
    }
    return false; // present but wrongly typed: malformed payload
  }
  // No spelling at all is still unnamed when the record carries an edit payload;
  // a record naming nothing and carrying nothing keeps the generic hint.
  return seesUnnamed || Array.isArray(request.edits);
}

/**
 * #117 reachability: a non-boolean `dry_run` never normalizes, so without this
 * predicate the generic hint is the only message the caller sees.
 */
function hasUnusableDryRun(request: Record<string, unknown>): boolean {
  if (!("dry_run" in request)) return false;
  const value = request.dry_run;
  return value !== null && value !== undefined && typeof value !== "boolean";
}

/**
 * #209 reachability: an out-of-enum `allow_encoding_migration` never normalizes, so without this
 * predicate the generic hint is the only message the caller sees.
 */
function hasUnusableEncodingConsent(request: Record<string, unknown>): boolean {
  if (!("allow_encoding_migration" in request)) return false;
  const value = request.allow_encoding_migration;
  // `undefined` is the only absent spelling: `null` is a value outside the enum, refused by name.
  return value !== undefined && !isEncodingMigrationConsent(value);
}

export function assertEditRequest(request: unknown): asserts request is NormalizedEditRequest {
  // #117: the specific refusal must be reachable before the marker guard — a raw
  // record whose file is null/absent/empty never normalizes, so the generic hint
  // would otherwise be the only message the caller sees.
  if (isRec(request) && namesNoFile(request)) {
    throw new DomainError("E_BAD_PAYLOAD", { message: FILE_REQUIRED_MESSAGE });
  }

  if (isRec(request) && hasUnusableDryRun(request)) {
    throw new DomainError("E_BAD_PAYLOAD", { message: DRY_RUN_TYPE_MESSAGE });
  }
  if (isRec(request) && hasUnusableEncodingConsent(request)) {
    throw new DomainError("E_BAD_PAYLOAD", { message: ENCODING_CONSENT_MESSAGE });
  }
  if (!isNormalizedEdit(request)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'Edit request must be exactly { file, edits: [{ anchor_from, anchor_to, replace_with }, ...], mode?: "general" | "literal", dry_run?: boolean, allow_encoding_migration?: "refuse" | "utf8" | "utf8bom" }. ' +
        EDIT_PAYLOAD_HINT,
    });
  }
  rejectUnknownFields(request as Record<string, unknown>, EDIT_KS, "Edit request");
  const req = request as NormalizedEditRequest;
  if (typeof req.file !== "string" || req.file.length === 0) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: FILE_REQUIRED_MESSAGE,
    });
  }
  // Defence in depth: the pre-marker predicate reads the RAW record, so the marker-carrying
  // record is re-checked here (a forced value never folds, but a hand-built marker can).
  if (
    req.allow_encoding_migration !== undefined &&
    !isEncodingMigrationConsent(req.allow_encoding_migration)
  ) {
    throw new DomainError("E_BAD_PAYLOAD", { message: ENCODING_CONSENT_MESSAGE });
  }
  if (req.mode !== undefined && req.mode !== "general" && req.mode !== "literal") {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'Edit request "mode" must be "general" or "literal" (absent means "general"). Reproduced served rows are refused unless mode is "literal".',
    });
  }
  if (!Array.isArray(req.edits) || req.edits.length === 0) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: 'Edit request requires a non-empty "edits" array.',
    });
  }
  if (req.edits.length > EDITS_MAX_ITEMS) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: `edit accepts at most ${EDITS_MAX_ITEMS} edits; got ${req.edits.length}. Split the batch.`,
    });
  }
  for (let index = 0; index < req.edits.length; index++) {
    const item = req.edits[index]!;
    if (
      typeof item.anchor_from !== "string" ||
      typeof item.anchor_to !== "string" ||
      typeof item.replace_with !== "string"
    ) {
      throw new DomainError("E_BAD_PAYLOAD", {
        message: `Edit request edits[${index}] must be { anchor_from, anchor_to, replace_with }: two bare 3-char anchors and the replacement text.`,
      });
    }
  }
}

export function assertReadRequest(request: unknown): asserts request is ReadParams {
  if (!isRec(request))
    throw new DomainError("E_BAD_PAYLOAD", { message: "Read request must be an object." });
  rejectUnknownFields(request, READ_KS, "Read request");
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: 'Read request requires a non-empty "path" string.',
    });
  }
}

export function assertUndoRequest(request: unknown): asserts request is UndoParams {
  if (!isRec(request))
    throw new DomainError("E_BAD_PAYLOAD", {
      message: "undo_last_edit request must be an object.",
    });
  normalizeFilePath(request);
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: 'undo_last_edit request requires a non-empty "path" string.',
    });
  }
}

// ---- shared JSON Schema literals (co-located with field sets) ---------------

export const replaceWithSchema = {
  type: "string",
  description: 'Bare file content for the range; use "" to delete',
} as const;

export const anchorFromSchema = {
  type: "string",
  description: "Bare 3-char hash anchor of the first range line (inclusive)",
} as const;

export const anchorToSchema = {
  type: "string",
  description: "Bare 3-char hash anchor of the last range line (inclusive)",
} as const;
export const pathSchema = {
  type: "string",
  description: "File path",
} as const;

export const editPathSchema = {
  type: "string",
  minLength: 1,
  description: "Text file to edit (a file, never a directory)",
} as const;

/** One owner for the `dry_run` wire member: the live parameters and this literal both reference it. */
export const dryRunSchema = {
  oneOf: [
    {
      type: "boolean",
      description:
        "Optional preview: when true, validate anchors and leases and compute the diff without writing to disk, recording undo, or updating leases. Absent or null means false (a live edit).",
    },
    { type: "null" },
  ],
} as const;

export const editTupleSchema = {
  type: "array",
  prefixItems: [anchorFromSchema, anchorToSchema, replaceWithSchema],
  minItems: 3,
  maxItems: 3,
  description: "[anchor_from, anchor_to, replace_with] (legacy tuple form)",
} as const;

export const editObjectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["anchor_from", "anchor_to", "replace_with"] as const,
  properties: {
    anchor_from: anchorFromSchema,
    anchor_to: anchorToSchema,
    replace_with: replaceWithSchema,
  },
  description: "{anchor_from, anchor_to, replace_with}",
} as const;

export const editItemSchema = {
  anyOf: [editTupleSchema, editObjectSchema],
  description: "Edit entry — either tuple or object form (mixed batches allowed)",
} as const;

export const editToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "edits"] as const,
  properties: {
    file: editPathSchema,
    edits: {
      type: "array",
      description:
        "Ordered list of edit entries — each entry is a named object {anchor_from, anchor_to, replace_with} (legacy tuples still fold pre-validation)",
      minItems: 1,
      maxItems: EDITS_MAX_ITEMS,
      items: editItemSchema,
    },
    dry_run: dryRunSchema,
  },
} as const;
