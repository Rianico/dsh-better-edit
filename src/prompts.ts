/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. Each tool's description is short; the
 * `tool:*` system-prompt sections carry the full usage guidance the model
 * reads when the tools are presented.
 * @module dsh-better-edit/prompts
 */

export const EDIT_DESCRIPTION =
	'Edit a range of lines in a text file, targeted by the 3-char HASH anchors from read output. ' +
	'remove_from and remove_to must each be a BARE 3-character hash: copy only the hash from the ' +
	'leftmost column of a read row (row `ve7│function hello() {` means `"remove_from": "ve7"`). ' +
	'Never pass the line content, a code line, or a paragraph into these fields.'

export const EDIT_SNIPPET =
	'Edit lines in a text file via bare 3-char HASH anchors from read — hash only, never line content; anchor exactly the lines that change; one edit per tool call'

export const EDIT_GUIDELINES = [
	'`edit`: remove_from and remove_to take ONLY the bare 3-char hash — read row `ve7│function hello() {` means `"remove_from": "ve7"`. Never paste the line content, a code line, a paragraph, or the whole `HASH│content` row into these fields.',
	'`edit`: remove_from and remove_to mark the exact lines that are REMOVED, and replacement_text is their complete replacement applied in order; nothing outside the range changes. Every line inside the range that is not reproduced byte-exact in replacement_text is deleted from the file.',
	'`edit`: keep the range as tight as the change — anchor only the first and last line that actually change, never a whole function, class, or import block when only part of it changes.',
	'`edit`: to edit a single line, set both remove_from and remove_to to the same hash: remove_from: "<HASH>", remove_to: "<HASH>".',
	'`edit`: when copying a line from read output, remove its HASH│ prefix and keep the leading whitespace exactly as shown.',
	'`edit`: every `\\n` in replacement_text separates lines, so a trailing `\\n` adds a final empty line. Mirror the removed lines exactly: a range that ends on a blank line must end replacement_text with `\\n` (e.g. `"code\\n"`), and a replacement whose last line is not blank must not end with `\\n`. To add a blank line after a line, end replacement_text with an explicit empty line after it (e.g. `"X\\n"` adds a blank after X). A replacement that is only blank lines is written as one `\\n` per blank line.',
	'`edit`: when the tool shows the post-edit diff, its rows are the fresh anchors for the new file — `+HASH│` and ` HASH│` rows carry current hashes and unchanged lines keep their previous hashes, so you can anchor follow-up edits on the diff.',
	'`edit`: the tool verifies every line of your range against what it served you. If the file changed since it was served, or a line was never served, the edit is hard-rejected — `[E_RANGE_STALE]` or `[E_RANGE_UNSERVED]` names the first offending line and echoes the current range as fresh `HASH│content` rows. Copy remove_from/remove_to from those echoed rows and retry — the rows count as serves.',
	'`edit`: only rows the tool delivered count as serves — read output, post-edit diffs, and rejection echoes. Content you saw through bash or another channel is not served state; a range over it is rejected as never-served or unverifiable, and there is no way to waive that check.',
	'`edit`: do not issue multiple edit calls on the same file in one message. Use `batch_edit` for multiple edits — it validates every edit before writing anything, applies the whole batch all-or-nothing, and returns one combined diff per file.',
]

export const READ_DESCRIPTION =
	'Read a text file; each line returned as HASH│content with a 3-char alphanumeric hash. ' +
	'No line numbers — use the HASH as the anchor in edit calls. Binary/directory → rejected; ' +
	'empty → HASH│ (edit to insert); pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.'

export const READ_SNIPPET =
	'Read a file; each line returned as HASH│content'

export const READ_GUIDELINES = [
	'`read`: call only when you need information the tool never served you — a page you never saw, content past the post-edit diff. `edit` verifies every line of your range against what the tool served; a rejection echoes the current range as fresh `HASH│content` rows to retry on.',
	'`read`: the post-edit diff rows from edit/undo and the drift-notice rows also carry fresh anchors for the lines they show.',
]

export const BATCH_EDIT_DESCRIPTION =
	'Apply several edits in one atomic call. Each item is exactly like the edit tool: ' +
	'{ path?, remove_from, remove_to, replacement_text }, where remove_from and remove_to are ' +
	'bare 3-char hashes from read or diff output. Items targeting the same file are applied in order. ' +
	'Every item is verified against what the tool served you before ANYTHING is written: if any item ' +
	'fails — stale or ambiguous anchor, changed range interior, never-served line — the whole batch ' +
	'is rejected and no file changes. The failing item\u2019s current range is served back as fresh ' +
	'HASH│content rows so you can retry without a read. Use batch_edit whenever you have multiple ' +
	'edits; do not issue several edit calls in one message.'

export const BATCH_EDIT_GUIDELINES = [
	'batch_edit: each item takes the same fields as edit — { path?, remove_from, remove_to, replacement_text }. remove_from and remove_to take ONLY the bare 3-char hash from read/diff output; never the line content.',
	'batch_edit: items are applied in order. Edits to the same file must not overlap — an item whose range was changed by an earlier item in the batch is rejected.',
	'batch_edit: the whole batch is all-or-nothing. If any item fails validation, nothing is written anywhere; the failing item\u2019s current range is echoed as fresh HASH│content rows that count as serves.',
	'batch_edit: every item is verified against what the tool served you — stale anchors, changed interiors, or never-served lines reject the batch.',
	'batch_edit: a noop item (the range already contains the replacement text) is reported without failing the batch; an all-noop batch reports no changes.',
	'batch_edit: the result is one combined diff per file with fresh anchors — anchor follow-up edits on those rows without re-reading.',
]

export const UNDO_DESCRIPTION =
	'Undo the last edit on a file, reverting it to its previous state. Use when an edit produced ' +
	'incorrect results (e.g., wrong content, duplicated lines, broken syntax).'

export const UNDO_GUIDELINES = [
	'`undo_last_edit`: reverts only the most recent edit on the file — any write to the file clears the undo history, so call it immediately after a bad edit. An edit is bad when its post-edit diff shows `-HASH│` rows for lines you meant to keep (a closing brace, import, or declaration).',
	'`undo_last_edit`: when the tool shows the post-edit diff, its `+HASH│` and ` HASH│` rows are the fresh anchors for the restored file, so follow-up edits can anchor on the diff.',
]
