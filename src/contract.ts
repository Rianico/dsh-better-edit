/**
 * One module owns the request shapes for the hashline tools — edit,
 * batch_edit, read, undo_last_edit — plus their validation. Field sets are
 * declared once here; every tool validates through these asserts, and the
 * [E_BAD_SHAPE] vocabulary is shared instead of re-implemented per tool.
 *
 * Note: `resolve.ts` keeps its own internal item check (content-only fields,
 * no path) — that is the hashline-internal edit-item shape, deliberately
 * decoupled from the tool-layer request contract so the hashline module does
 * not depend on this one.
 * @module dsh-better-edit/contract
 */

import { BATCH_EDIT_MAX_ITEMS } from "./constants.js";
import { isRec, normalizeFilePath, rejectUnknownFields } from "./utils.js";

// ---- request shapes --------------------------------------------------------

export interface EditParams {
	path: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
}

export interface BatchItemParams {
	path?: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
}

export interface BatchEditParams {
	edits: BatchItemParams[];
}

export interface ReadParams {
	path: string;
	offset?: number;
	limit?: number;
}

export interface UndoParams {
	path: string;
}

// ---- field sets (declared once) ---------------------------------------------

const EDIT_KS = new Set([
	"path",
	"remove_from",
	"remove_to",
	"replacement_text",
	"sandbox_permissions",
	"justification",
]);

const BATCH_ROOT_KS = new Set([
	"edits",
	"sandbox_permissions",
	"justification",
]);

const BATCH_ITEM_KS = new Set([
	"path",
	"remove_from",
	"remove_to",
	"replacement_text",
]);

const READ_KS = new Set(["path", "offset", "limit"]);

// ---- assertions ---------------------------------------------------------------

export function assertEditRequest(
	request: unknown,
): asserts request is EditParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	rejectUnknownFields(request, EDIT_KS, "Edit request");

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires a non-empty "path" string.',
		);
	}

	if (
		typeof request.remove_from !== "string" ||
		typeof request.remove_to !== "string" ||
		typeof request.replacement_text !== "string"
	) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_text" at the top level.',
		);
	}
}

export function assertBatchEditRequest(
	request: unknown,
): asserts request is BatchEditParams {
	if (!isRec(request)) {
		throw new Error(
			'[E_BAD_SHAPE] batch_edit request must be an object with an "edits" array.',
		);
	}
	rejectUnknownFields(request, BATCH_ROOT_KS, "batch_edit request");
	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] batch_edit request requires a non-empty "edits" array.',
		);
	}
	if (request.edits.length > BATCH_EDIT_MAX_ITEMS) {
		throw new Error(
			`[E_BAD_SHAPE] batch_edit accepts at most ${BATCH_EDIT_MAX_ITEMS} edits; got ${request.edits.length}. Split the batch.`,
		);
	}
	request.edits.forEach((item, index) => {
		if (!isRec(item)) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] must be an object with remove_from, remove_to, and replacement_text.`,
			);
		}
		rejectUnknownFields(item, BATCH_ITEM_KS, `edits[${index}]`);
		if (
			typeof item.remove_from !== "string" ||
			typeof item.remove_to !== "string" ||
			typeof item.replacement_text !== "string"
		) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}] requires "remove_from", "remove_to", and "replacement_text" strings.`,
			);
		}
		if (
			item.path !== undefined &&
			(typeof item.path !== "string" || item.path.length === 0)
		) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].path must be a non-empty string.`,
			);
		}
	});
}

export function assertReadRequest(
	request: unknown,
): asserts request is ReadParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Read request must be an object.");
	}
	rejectUnknownFields(request, READ_KS, "Read request");
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Read request requires a non-empty "path" string.',
		);
	}
}

export function assertUndoRequest(
	request: unknown,
): asserts request is UndoParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] undo_last_edit request must be an object.");
	}
	normalizeFilePath(request);
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] undo_last_edit request requires a non-empty "path" string.',
		);
	}
}
