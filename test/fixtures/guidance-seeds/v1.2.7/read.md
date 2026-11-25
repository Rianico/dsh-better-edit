---
order: 1100
---

Use read, not shell commands, to inspect text files and obtain the HASH anchors the editing tools require.

- `read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.
- `read`: each row is `HASH│content`; the HASH is the anchor (no line numbers). Rejection echoes show the file's current rows and those rows are recorded as served — only a refusal that shows no rows needs a read.
- `read`: binary/directory rejects; page large files with offset/limit.