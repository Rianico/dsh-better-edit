/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. Each tool's schema `description` is short;
 * the `tool:*` system-prompt sections carry the brief guidance the model
 * reads when the tools are presented. Guidance is uniform: a one-line opener
 * followed by tight bullets.
 * @module dsh-better-edit/prompts
 */

export interface ToolGuidance {
  intro: string;
  lines: readonly string[];
}

export const EDIT_DESCRIPTION =
  "Edit a range of lines in a text file, targeted by the 3-char HASH anchors from read output. " +
  'Use { "path": "file.ts", "edits": [[remove_from, remove_to, replacement_text], ...] } — path is the file to edit (or null to infer from anchors), edits is an array of [remove_from, remove_to, replacement_text] tuples. ' +
  "remove_from and remove_to must each be a BARE 3-character hash: copy only the hash from the " +
  'leftmost column of a read row (row `ve7│function hello() {` means `"remove_from": "ve7"`). ' +
  "Never pass the line content, a code line, or a paragraph into these fields. The path is hoisted to the payload root so every edit in one call targets the same file; a length-1 edits array is a single edit.";

export const EDIT_GUIDANCE: ToolGuidance = {
  intro: "Edit a range of lines via a bare 3-char HASH anchor — payload is { path, edits: [[hash,hash,text]] } (single-file atomic, null path infers).",
  lines: [
    "`edit`: payload is { \"path\": \"file.ts\"|null, \"edits\": [[remove_from, remove_to, replacement_text], ...] } — path at root, each item is a 3-position tuple with bare hashes (`ve7`, not `ve7│function…`). A single line uses the same hash in both fields.",
    "`edit`: replacement_text is byte-exact for the whole range — every line inside it you do not reproduce byte-exact is deleted, and leading whitespace is preserved exactly.",
    "`edit`: `\\n` is a line break, so a range ending on a blank line must end replacement_text with `\\n` and a non-blank last line must not; a blank-line run is one `\\n` per blank line.",
    "`edit`: the post-edit diff rows carry fresh anchors for follow-ups. A stale or never-served range is hard-rejected (`[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`); copy the echoed rows and retry — only tool-served rows count.",
    "`edit`: multiple edits to the same file in one call are atomic (all-or-nothing): if any tuple fails — stale, ambiguous, never-served — nothing is written and the failing tuple's current range is served back. Prefer one edit per call unless you have independent ranges.",
  ],
};

export const READ_DESCRIPTION =
  "Read a text file; each line returned as HASH│content with a 3-char alphanumeric hash. " +
  "No line numbers — use the HASH as the anchor in edit calls. Binary/directory → rejected; " +
  "empty → HASH│ (edit to insert); pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.";

export const READ_GUIDANCE: ToolGuidance = {
  intro: "Use read, not shell commands, to inspect text files and obtain the HASH anchors the editing tools require.",
  lines: [
    "`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
    "`read`: each row is `HASH│content`; the HASH is the anchor (no line numbers). Rejection echoes return fresh rows that count as serves.",
    "`read`: binary/directory rejects; page large files with offset/limit.",
  ],
};

export const UNDO_DESCRIPTION =
  "Undo the last edit on a file, reverting it to its previous state. Use when an edit produced " +
  "incorrect results (e.g., wrong content, duplicated lines, broken syntax).";

export const UNDO_GUIDANCE: ToolGuidance = {
  intro: "Revert the last edit on a file.",
  lines: [
    "`undo_last_edit`: reverts only the most recent edit — any write clears history, so call it immediately after a bad edit.",
    "`undo_last_edit`: the restored diff\u2019s `+HASH│` and ` HASH│` rows are fresh anchors for follow-up edits.",
  ],
};

/**
 * @deprecated batch_edit guidance seam was removed with ADR-0003 (payload contract
 * merged batch_edit into edit's {path, edits:[[hash,hash,text]]} arity). This alias
 * is kept for backwards compat — use EDIT_DESCRIPTION. The guidance system no
 * longer includes tool:batch_edit.
 */
export const BATCH_EDIT_DESCRIPTION = EDIT_DESCRIPTION;
/** @deprecated see BATCH_EDIT_DESCRIPTION — use EDIT_GUIDANCE */
export const BATCH_EDIT_GUIDANCE: ToolGuidance = EDIT_GUIDANCE;
