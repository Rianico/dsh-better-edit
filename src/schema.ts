/**
 * Shared model-facing parameter schemas for the hashline tools, expressed in
 * the dsh schema DSL (not TypeBox). `path` is deliberately NOT `required` at
 * the schema level: the tools accept the built-in `file_path` spelling too
 * (the implicit parameter root stays open), and enforce path presence in
 * `assertEditRequest` after `normalizeFilePath` aliasing.
 * @module dsh-better-edit/schema
 */

export const replacementTextSchema = {
	type: 'string',
	description:
		'Replacement text as a single string with \\n line separators; every \\n separates lines, so a trailing \\n adds a final empty line. Mirror the removed lines exactly, blank lines included. A replacement that is only blank lines is written as one \\n per blank line. Use "" to delete the range.',
} as const

export const removeFromSchema = {
	type: 'string',
	description:
		'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the FIRST line to remove (inclusive)',
} as const

export const removeToSchema = {
	type: 'string',
	description:
		'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the LAST line to remove (inclusive)',
} as const

export const pathSchema = {
	type: 'string',
	description:
		'Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchors as a fallback when omitted by mistake.',
} as const

export type {
	EditParams,
	BatchItemParams,
	BatchEditParams,
} from "./contract.js";
