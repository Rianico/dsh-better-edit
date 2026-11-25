---
order: 131
---

Edit a range of lines via a bare 3-char HASH anchor — payload is { path, edits: [[hash,hash,text]] } (single-file atomic, null path infers).

- `edit`: payload is { "path": "file.ts"|null, "edits": [[remove_from, remove_to, replacement_text], ...] } — path at root, each item is a 3-position tuple with bare hashes (`ve7`, not `ve7│function…`). A single line uses the same hash in both fields.
- `edit`: replacement_text is byte-exact for the whole range — every line inside it you do not reproduce byte-exact is deleted, and leading whitespace is preserved exactly.
- `edit`: `\n` is a line break, so a range ending on a blank line must end replacement_text with `\n` and a non-blank last line must not; a blank-line run is one `\n` per blank line.
- `edit`: the post-edit diff rows carry fresh anchors for follow-ups. A stale or never-served range is hard-rejected (`[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`); copy the echoed rows and retry — only tool-served rows count.
- `edit`: multiple edits to the same file in one call are atomic (all-or-nothing): if any tuple fails — stale, ambiguous, never-served — nothing is written and the failing tuple's current range is served back. Prefer one edit per call unless you have independent ranges.