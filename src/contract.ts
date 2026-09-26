/**
 * One module owns the request shapes for the hashline tools — edit,
 * read, undo_last_edit — plus their validation. Field sets are
 * declared once here; every tool validates through these asserts, and the
 * E_BAD_PAYLOAD vocabulary is shared instead of re-implemented per tool.
 *
 * Contract mirrors upstream ADR-0015: {file: string|null, edits: [{anchor_from, anchor_to, replace_with},...]} named-object payload
 * (plus legacy tuple items and legacy key spellings folded pre-validation), single-file, atomic. batch_edit is removed.
 * @module dsh-better-edit/contract
 */

import { EDITS_MAX_ITEMS } from "./constants.js";
import type { ReadWindow } from "./file-view.js";
import { isRec, normalizeFilePath, rejectUnknownFields } from "./utils.js";
import { DomainError } from "./domain-errors.js";

// ---- request shapes --------------------------------------------------------

export type EditMode = "general" | "literal";

export type EditItem = {
  anchor_from: string;
  anchor_to: string;
  replace_with: string;
};

export type EditRequest = {
  file: string | null;
  edits: EditItem[];
  /**
   * "general" (default) refuses bytes reproducing served rows;
   * "literal" declares them as intended file content (W_LITERAL_BYPASS).
   */
  mode?: EditMode;
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
   * FU-6 (port of pi-better-edit@2334352): multi-window read — disjoint line ranges served in
   * one call. Shape and count (max MAX_READ_WINDOWS) are validated in file-view's normWindows.
   */
  windows?: ReadWindow[];
}

export interface UndoParams {
  path: string;
}

// legacy batch types removed — kept as type alias for test shims (never used at runtime)
export interface BatchItemParams {
  file?: string;
  anchor_from: string;
  anchor_to: string;
  replace_with: string;
}
export interface BatchEditParams {
  edits: BatchItemParams[];
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
  "sandbox_permissions",
  "justification",
]);

export function editRequestFrom(input: unknown): NormalizedEditRequest | undefined {
  if (!isRec(input)) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ROOT_INPUT_KS.has(key)) return undefined;
  }
  const { file, file_path, path, edits, mode } = rec as {
    file?: unknown;
    file_path?: unknown;
    path?: unknown;
    edits?: unknown;
    mode?: unknown;
  };
  // file preferred; legacy path/file_path fold (sanitized). null stays null:
  // the undocumented anchor-inference seam (resolveNullPath) still resolves it.
  let effectiveFile: unknown;
  if (file !== undefined) effectiveFile = file;
  else if (path !== undefined) effectiveFile = path;
  else if (file_path !== undefined) effectiveFile = file_path;
  else return undefined;
  let effectivePath: string | null;
  if (typeof effectiveFile === "string") {
    const sanitized = sanitizePath(effectiveFile);
    if (sanitized === null) return undefined;
    effectivePath = sanitized;
  } else if (effectiveFile === null) {
    effectivePath = null;
  } else {
    return undefined;
  }
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
  return { file: effectivePath, edits: items, mode: effectiveMode };
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
  '{"file": file, "edits": [{ "anchor_from": anchor_from, "anchor_to": anchor_to, "replace_with": replace_with }, ...], "mode"?: "general" | "literal"}: ' +
  '"file" is the text file to edit (a non-empty string, never a directory); each item names ' +
  "two inclusive bare-3-char anchors and the full replacement " +
  '(an empty string deletes the range); optional "mode" is "general" (default, reproduced served rows are refused) or "literal" (declared literal content). ' +
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

const EDIT_KS = new Set(["file", "edits", "mode", "sandbox_permissions", "justification"]);
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
    return { file: valid.file, edits: valid.edits, mode: valid.mode };
  }
  throw new DomainError("E_BAD_PAYLOAD", {
    message: `${EDIT_PAYLOAD_HINT} ${describeReceived(args)}`,
  });
}

// ---- assertions ---------------------------------------------------------------

export function assertEditRequest(request: unknown): asserts request is NormalizedEditRequest {
  if (!isNormalizedEdit(request)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message:
        'Edit request must be exactly { file, edits: [{ anchor_from, anchor_to, replace_with }, ...], mode?: "general" | "literal" }. ' +
        EDIT_PAYLOAD_HINT,
    });
  }
  rejectUnknownFields(request as Record<string, unknown>, EDIT_KS, "Edit request");
  const req = request as NormalizedEditRequest;
  if (req.file !== null && (typeof req.file !== "string" || req.file.length === 0)) {
    throw new DomainError("E_BAD_PAYLOAD", {
      message: "Edit request file must be a non-empty string or null.",
    });
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

// legacy — now always fails with new shape message (batch_edit removed)
export function assertBatchEditRequest(_request: unknown): asserts _request is BatchEditParams {
  throw new DomainError("E_BAD_PAYLOAD", {
    message:
      "batch_edit has been removed. Use edit with { file, edits: [{ anchor_from, anchor_to, replace_with }, ...] }.",
  });
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
  description: "File path; null infers it from anchors",
} as const;

export const editPathSchema = {
  anyOf: [
    { type: "string", minLength: 1, description: "File path; null infers it from anchors" },
    { type: "null", description: "null infers path from anchors" },
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
  },
} as const;
