/**
 * One module owns the request shapes for the hashline tools — edit,
 * read, undo_last_edit — plus their validation. Field sets are
 * declared once here; every tool validates through these asserts, and the
 * [E_BAD_SHAPE] vocabulary is shared instead of re-implemented per tool.
 *
 * Contract now mirrors upstream ADR-0007: {path: string|null, edits: [[remove_from,remove_to,replacement_text],...]} tuple payload,
 * single-file, atomic. batch_edit is removed.
 * @module dsh-better-edit/contract
 */

import { EDITS_MAX_ITEMS } from "./constants.js";
import { isRec, normalizeFilePath, rejectUnknownFields } from "./utils.js";

// ---- request shapes --------------------------------------------------------

export type EditItem = {
  remove_from: string;
  remove_to: string;
  replacement_text: string;
};

export type EditRequest = {
  path: string | null;
  edits: EditItem[];
};

// legacy single-edit shape retained for mutation.ts internal API
export interface EditParams {
  path: string;
  remove_from: string;
  remove_to: string;
  replacement_text: string;
}

export interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
  encoding?: string;
}

export interface UndoParams {
  path: string;
}

// legacy batch types removed — kept as type alias for test shims (never used at runtime)
export interface BatchItemParams {
  path?: string;
  remove_from: string;
  remove_to: string;
  replacement_text: string;
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
  const [remove_from, remove_to, replacement_text] = value as unknown[];
  if (typeof remove_from !== "string" || typeof remove_to !== "string" || typeof replacement_text !== "string") return undefined;
  return { remove_from, remove_to, replacement_text };
}

export function editRequestFrom(input: unknown): NormalizedEditRequest | undefined {
  if (!isRec(input) || !("path" in input) || !("edits" in input)) return undefined;
  const rec = input as Record<string, unknown>;
  // handle file_path alias before checking
  if (typeof rec.path !== "string" && typeof rec.file_path === "string") {
    // alias will be normalized by normalizeFilePath before editRequestFrom in normReq path,
    // but handle here for direct calls
  }
  const { path, edits } = rec as { path?: unknown; edits?: unknown };
  if (path !== null && (typeof path !== "string" || (path as string).length === 0)) return undefined;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const items: EditItem[] = [];
  for (const item of edits) {
    const normalized = itemFromTuple(item);
    if (!normalized) return undefined;
    items.push(normalized);
  }
  return { path: path as string | null, edits: items };
}

export const EDIT_TUPLE_HINT =
  "Edit must be called with exactly one payload. Use the canonical payload " +
  '{"path": path, "edits": [[remove_from, remove_to, replacement_text], ...]}: ' +
  "path is a non-empty string (or null to infer from anchors), each item is a " +
  "fixed 3-position array of two inclusive bare-3-char anchors and the full " +
  "replacement (an empty string deletes the range).";

function describeReceived(input: unknown): string {
  if (input === undefined) return "Received no arguments.";
  if (input === null) return "Received null.";
  if (typeof input === "string") return `Received a bare string (${JSON.stringify(input)}).`;
  const json = JSON.stringify(input);
  const preview = typeof json === "string" && json.length > 160 ? `${json.slice(0, 160)}…` : json;
  return `Received: ${preview}`;
}

// ---- filed sets (declared once) ---------------------------------------------

const EDIT_KS = new Set(["path", "edits", "sandbox_permissions", "justification"]);
const READ_KS = new Set(["path", "offset", "limit", "encoding"]);

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
  const normalized: Record<string, unknown> = { path: valid.path, edits: valid.edits };
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
    return { path: valid.path, edits: (args as Record<string, unknown>).edits };
  }
  throw new Error(`[E_BAD_SHAPE] ${EDIT_TUPLE_HINT} ${describeReceived(args)}`);
}

// ---- assertions ---------------------------------------------------------------

export function assertEditRequest(request: unknown): asserts request is NormalizedEditRequest {
  if (!isNormalizedEdit(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be exactly { path, edits: [[remove_from, remove_to, replacement_text], ...] }.");
  }
  rejectUnknownFields(request as Record<string, unknown>, EDIT_KS, "Edit request");
  const req = request as NormalizedEditRequest;
  if (req.path !== null && (typeof req.path !== "string" || req.path.length === 0)) {
    throw new Error('[E_BAD_SHAPE] Edit request path must be a non-empty string or null.');
  }
  if (!Array.isArray(req.edits) || req.edits.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "edits" array.');
  }
  if (req.edits.length > EDITS_MAX_ITEMS) {
    throw new Error(`[E_BAD_SHAPE] edit accepts at most ${EDITS_MAX_ITEMS} edits; got ${req.edits.length}. Split the batch.`);
  }
  for (let index = 0; index < req.edits.length; index++) {
    const item = req.edits[index]!;
    if (typeof item.remove_from !== "string" || typeof item.remove_to !== "string" || typeof item.replacement_text !== "string") {
      throw new Error(`[E_BAD_SHAPE] Edit request edits[${index}] must be a three-position array [remove_from, remove_to, replacement_text].`);
    }
  }
}

// legacy — now always fails with new shape message (batch_edit removed)
export function assertBatchEditRequest(_request: unknown): asserts _request is BatchEditParams {
  throw new Error("[E_BAD_SHAPE] batch_edit has been removed. Use edit with { path, edits: [[remove_from, remove_to, replacement_text], ...] }.");
}

export function assertReadRequest(request: unknown): asserts request is ReadParams {
  if (!isRec(request)) throw new Error("[E_BAD_SHAPE] Read request must be an object.");
  rejectUnknownFields(request, READ_KS, "Read request");
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Read request requires a non-empty "path" string.');
  }
}

export function assertUndoRequest(request: unknown): asserts request is UndoParams {
  if (!isRec(request)) throw new Error("[E_BAD_SHAPE] undo_last_edit request must be an object.");
  normalizeFilePath(request);
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] undo_last_edit request requires a non-empty "path" string.');
  }
}

// ---- shared JSON Schema literals (co-located with field sets) ---------------

export const replacementTextSchema = {
  type: 'string',
  description: 'Complete replacement for the range; use "" to delete',
} as const

export const removeFromSchema = {
  type: 'string',
  description: "First line to remove (inclusive)",
} as const

export const removeToSchema = {
  type: 'string',
  description: "Last line to remove (inclusive)",
} as const

export const pathSchema = {
  type: 'string',
  description: "File path; null infers it from anchors",
} as const

export const editPathSchema = {
  anyOf: [
    { type: 'string', minLength: 1, description: "File path; null infers it from anchors" },
    { type: 'null', description: "null infers path from anchors" },
  ],
} as const

export const editTupleSchema = {
  type: 'array',
  prefixItems: [removeFromSchema, removeToSchema, replacementTextSchema],
  minItems: 3,
  maxItems: 3,
  description: "[remove_from, remove_to, replacement_text]",
} as const

export const editToolSchema = {
  type: 'object',
  additionalProperties: false,
  required: ["path", "edits"] as const,
  properties: {
    path: editPathSchema,
    edits: {
      type: 'array',
      description: "Ordered list of edit tuples",
      minItems: 1,
      maxItems: EDITS_MAX_ITEMS,
      items: editTupleSchema,
    },
  },
} as const
