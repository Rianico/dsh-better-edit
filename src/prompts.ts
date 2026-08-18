/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. Each tool's schema `description` is short;
 * the `tool:*` system-prompt sections carry the brief guidance the model
 * reads when the tools are presented. Guidance is uniform: a one-line opener
 * followed by tight bullets.
 * @module dsh-better-edit/prompts
 */

/**
 * One tool's guidance: a brief opener plus concise bullets. The `intro` is
 * shown above the bullets; it does not duplicate the tool-schema `description`
 * (that already reaches the model through the tool catalog).
 */
export interface ToolGuidance {
	/** One-line lead shown above the bullets. */
	intro: string;
	/** Concise bullets; each is self-contained within its section. */
	lines: readonly string[];
}

export const EDIT_DESCRIPTION =
	'Edit a range of lines in a text file, targeted by the 3-char HASH anchors from read output. ' +
	'remove_from and remove_to must each be a BARE 3-character hash: copy only the hash from the ' +
	'leftmost column of a read row (row `ve7│function hello() {` means `"remove_from": "ve7"`). ' +
	'Never pass the line content, a code line, or a paragraph into these fields.'

export const EDIT_GUIDANCE: ToolGuidance = {
	intro:
		'Edit a range of lines via a bare 3-char HASH anchor from read output — never by line content.',
	lines: [
		'`edit`: anchor the exact first and last lines that change by their stripped hash (`ve7`, not `ve7│function…`). A single line uses the same hash in both fields; never anchor a whole function or import block when part of it changes.',
		'`edit`: replacement_text is byte-exact for the whole range — every line inside it you do not reproduce byte-exact is deleted, and leading whitespace is preserved exactly.',
		'`edit`: `\\n` is a line break, so a range ending on a blank line must end replacement_text with `\\n` and a non-blank last line must not; a blank-line run is one `\\n` per blank line.',
		'`edit`: the post-edit diff rows carry fresh anchors for follow-ups. A stale or never-served range is hard-rejected (`[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`); copy the echoed rows and retry — only tool-served rows count.',
		'`edit`: for multiple edits to one file, use batch_edit — it validates every item before writing and applies them all-or-nothing.',
	],
};

export const READ_DESCRIPTION =
	'Read a text file; each line returned as HASH│content with a 3-char alphanumeric hash. ' +
	'No line numbers — use the HASH as the anchor in edit calls. Binary/directory → rejected; ' +
	'empty → HASH│ (edit to insert); pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.'

export const READ_GUIDANCE: ToolGuidance = {
	intro:
		'Use read, not shell commands, to inspect text files and obtain the HASH anchors the editing tools require.',
	lines: [
		'`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.',
		'`read`: each row is `HASH│content`; the HASH is the anchor (no line numbers). Rejection echoes return fresh rows that count as serves.',
		'`read`: binary/directory rejects; page large files with offset/limit.',
	],
};

export const BATCH_EDIT_DESCRIPTION =
	'Apply several edits in one atomic call. Each item is exactly like the edit tool: ' +
	'{ path?, remove_from, remove_to, replacement_text }, where remove_from and remove_to are ' +
	'bare 3-char hashes from read or diff output. Items targeting the same file are applied in order. ' +
	'Every item is verified against what the tool served you before ANYTHING is written: if any item ' +
	'fails — stale or ambiguous anchor, changed range interior, never-served line — the whole batch ' +
	'is rejected and no file changes. The failing item\u2019s current range is served back as fresh ' +
	'HASH│content rows so you can retry without a read. Use batch_edit whenever you have multiple ' +
	'edits; do not issue several edit calls in one message.'

export const BATCH_EDIT_GUIDANCE: ToolGuidance = {
	intro: 'Apply several edits in one atomic call.',
	lines: [
		'`batch_edit`: each item is edit\u2019s shape — { path?, remove_from, remove_to, replacement_text } — with bare hash anchors; items apply in order, and same-file ranges must not overlap.',
		'`batch_edit`: all-or-nothing — any failing item writes nothing anywhere and echoes its current range as fresh rows that count as serves.',
		'`batch_edit`: a no-op item is reported without failing; the result is one combined diff per file with fresh anchors.',
	],
};

export const UNDO_DESCRIPTION =
	'Undo the last edit on a file, reverting it to its previous state. Use when an edit produced ' +
	'incorrect results (e.g., wrong content, duplicated lines, broken syntax).'

export const UNDO_GUIDANCE: ToolGuidance = {
	intro: 'Revert the last edit on a file.',
	lines: [
		'`undo_last_edit`: reverts only the most recent edit — any write clears history, so call it immediately after a bad edit.',
		'`undo_last_edit`: the restored diff\u2019s `+HASH│` and ` HASH│` rows are fresh anchors for follow-up edits.',
	],
};
