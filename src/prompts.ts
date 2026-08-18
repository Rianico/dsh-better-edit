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

export const EDIT_GUIDANCE = [
	'`edit`: remove_from and remove_to take the bare 3-char hash only — copy it from the leftmost column of a read row (row `ve7│function hello() {` means `"remove_from": "ve7"`). Never pass line content, a code line, a paragraph, or a whole `HASH│content` row.',
	'`edit`: the range marks the exact lines REMOVED; replacement_text is their complete replacement, applied in order. Nothing outside the range changes; every line inside it that replacement_text does not reproduce byte-exact is deleted. Anchor only the first and last line that change — never a whole function, class, or import block when part of it changes. A single line takes the same hash in both fields.',
	'`edit`: mirror whitespace exactly. Keep the leading whitespace of every copied line; every `\\n` in replacement_text is a line break, so a range ending on a blank line must end replacement_text with `\\n` and a non-blank last line must not. A blank line is written as `\\n`; an explicit trailing empty line adds one.',
	'`edit`: the post-edit diff rows carry the fresh anchors — `+HASH│` and ` HASH│` rows have current hashes and unchanged lines keep theirs, so follow-up edits anchor on the diff without re-reading.',
	'`edit`: every line of the range is verified against what the tool served. A stale or never-served line rejects the edit hard — `[E_RANGE_STALE]` or `[E_RANGE_UNSERVED]` names the first offending line and echoes the current range as fresh `HASH│content` rows; copy the anchors from those rows and retry, since the rows count as serves. Only tool-delivered rows count as serves — content seen through bash or another channel is never served, and nothing waives that check.',
	'`edit`: for multiple edits to one file in a single message, use batch_edit — it validates every edit before writing, applies the batch all-or-nothing, and returns one combined diff per file.',
]

export const READ_DESCRIPTION =
	'Read a text file; each line returned as HASH│content with a 3-char alphanumeric hash. ' +
	'No line numbers — use the HASH as the anchor in edit calls. Binary/directory → rejected; ' +
	'empty → HASH│ (edit to insert); pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.'

export const READ_SNIPPET =
	'Read a file; each line returned as HASH│content'

export const READ_GUIDANCE = [
	'`read`: call it only for content the tools never served — a page you never saw, or lines past the post-edit diff.',
	'`read`: post-edit diff rows from edit/undo and drift-notice rows carry fresh anchors for the lines they show.',
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

export const BATCH_EDIT_GUIDANCE = [
	'batch_edit: each item takes edit\u2019s fields — { path?, remove_from, remove_to, replacement_text } — with bare 3-char hash anchors from read/diff output, never line content.',
	'batch_edit: items apply in order. Same-file ranges must not overlap — an item whose range an earlier item changed is rejected.',
	'batch_edit: the batch is all-or-nothing. Any failing item — stale or ambiguous anchor, changed range interior, never-served line — writes nothing anywhere, and its current range is echoed as fresh `HASH│content` rows that count as serves.',
	'batch_edit: a noop item (the range already contains the replacement) is reported without failing the batch; an all-noop batch reports no changes.',
	'batch_edit: the result is one combined diff per file with fresh anchors — anchor follow-up edits on those rows without re-reading.',
]

export const UNDO_DESCRIPTION =
	'Undo the last edit on a file, reverting it to its previous state. Use when an edit produced ' +
	'incorrect results (e.g., wrong content, duplicated lines, broken syntax).'

export const UNDO_GUIDANCE = [
	'`undo_last_edit`: reverts only the most recent edit on the file — any write clears the undo history, so call it immediately after a bad edit. An edit is bad when its post-edit diff shows `-HASH│` rows for lines you meant to keep (a closing brace, import, or declaration).',
	'`undo_last_edit`: the restored diff\u2019s `+HASH│` and ` HASH│` rows are the fresh anchors for follow-up edits.',
]
