---
order: 130
---

Use read, not shell commands, to inspect text files and obtain the HASH anchors the editing tools require.

- `read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.
- `read`: each row is `HASH│content`; the HASH is the anchor (no line numbers). Rejection echoes return fresh rows that count as serves.
- `read`: binary/directory rejects; page large files with offset/limit.