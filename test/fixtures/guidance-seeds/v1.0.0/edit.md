---
order: 131
---

Edit a range of lines via a bare 3-char HASH anchor — payload is { file, edits: [{anchor_from, anchor_to, replace_with}] } (single-file atomic; legacy tuples still fold pre-validation).

- `edit`: `HASH` vs `HASH│content` — `HASH` is the bare 3-char (e.g. "wUp"), `HASH│content` is the full line from `read`/`diff` (e.g. `wUp│    "site": {`); never mix them.
- `edit`: get `anchor_from`/`anchor_to` by copying only the 3 chars before `│` from `read` output — never include `│` or content after it.
- `edit`: `replace_with` is plain file content without `HASH│` — e.g. "    \"site\": {\n        \"class\": SiteScraper," — never prefix lines with `HASH│`.
- `edit`: every `\n` in `replace_with` separates lines; mirror trailing blank lines explicitly (use "" to delete a range).
- `edit`: `edits` entries are objects `{anchor_from, anchor_to, replace_with}` — legacy tuples still fold pre-validation; unknown fields are rejected.
- `edit`: after an edit whose serve landed, the returned diff shows fresh anchors (`HASH│content`) — copy new `HASH` values from there for the next edit; if the result says the rows were NOT recorded as served, re-read instead.
- `edit`: `anchor_from`/`anchor_to` are inclusive; batch multiple edits to the same file only when independent — they apply atomically (fail → nothing written).
- `edit`: `[TO MODEL]` errors (e.g. `E_STALE_*`, `E_UNSERVED_*`, `E_BAD_PAYLOAD`, `E_SUSPICIOUS_TEXT`) need a retry — `[USER]` warnings/`drift:` notices are human-only.
- `edit`: on `E_STALE_ANCHOR` re-read for fresh anchors; on `E_STALE_RANGE`/`E_UNSERVED_RANGE` the echoed rows are the file's current anchors, NOT serves — re-read before retrying.