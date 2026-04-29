---
name: kb-reindex
description: "Rebuild wiki/index.md and per-domain wiki/index/<domain>.md from frontmatter"
trigger: /kb-reindex
---

Rebuild the knowledge base indexes from frontmatter.

1. Call `kb_reindex` (no arguments — it scans the active vault).
2. Report: total page count, number of domains, and per-domain page counts.
3. If any pages were skipped (missing `type` or `type: meta`), note them — they won't appear in any index.

The reindex is idempotent. Run it whenever pages are created, moved, renamed, or deleted, or when you suspect the indexes are stale.
