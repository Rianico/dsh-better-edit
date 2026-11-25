---
order: 131
---

Edit a range of lines via a bare 3-char HASH anchor — payload is { path, edits: [[hash,hash,text]] } or { path, edits: [{remove_from, remove_to, replacement_text}] } (single-file atomic, null path infers; tuple and object forms are equivalent, mixed batches allowed).

- `edit`: `HASH` vs `HASH│content` — `HASH` is the bare 3-char (e.g. "wUp"), `HASH│content` is the full line from `read`/`diff` (e.g. `wUp│    "site": {`); never mix them.
- `edit`: get `remove_from`/`remove_to` by copying only the 3 chars before `│` from `read` output — never include `│` or content after it.
- `edit`: `replacement_text` is plain file content without `HASH│` — e.g. "    \"site\": {\n        \"class\": SiteScraper," — never prefix lines with `HASH│`.
- `edit`: every `\n` in `replacement_text` separates lines; mirror trailing blank lines explicitly (use "" to delete a range).
- `edit`: `edits` entries accept either tuple `[remove_from, remove_to, replacement_text]` or object `{remove_from, remove_to, replacement_text}` — mixed batches allowed, each entry normalizes independently; unknown fields (e.g. stray `path`) are rejected.
- `edit`: after a successful edit the returned diff shows fresh anchors (`HASH│content`) — copy new `HASH` values from there for the next edit; no need to re-read.
- `edit`: `remove_from`/`remove_to` are inclusive; batch multiple edits to the same file only when independent — they apply atomically (fail → nothing written).
- `edit`: `[MODEL]` errors (e.g. `E_STALE_*`, `E_UNSERVED_*`, `E_BAD_PAYLOAD`, `E_SERVED_ECHO`) need a retry — `[USER]` warnings/`drift:` notices are human-only.
- `edit`: on `E_STALE_RANGE`/`E_UNSERVED_RANGE` retry from the echoed fresh anchors (no re-read needed); on `E_STALE_ANCHOR` re-read.