---
order: 133
---

Revert the last edit on a file.

- `undo_last_edit`: reverts only the most recent edit — any write clears history, so call it immediately after a bad edit.
- `undo_last_edit`: the restored diff’s `+HASH│` and ` HASH│` rows are fresh anchors for follow-up edits — unless the result says the rows were NOT recorded as served, then re-read.