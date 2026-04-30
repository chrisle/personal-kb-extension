---
name: kb-lint
description: "Audit the knowledge base for broken links, orphaned pages, and structural issues"
trigger: /kb-lint
---

Audit the knowledge base for structural issues.

1. Call the `kb_lint` tool
2. Report the results clearly:
   - Total page count
   - Orphaned pages (no backlinks) — list them with suggested fix (link from a domain hub or delete)
   - Broken links — list the source page and the missing target
3. Prioritize issues: broken links first, then orphans
4. Suggest specific actions for each issue — be concrete (e.g. "add `[[risk-rating]]` to `wiki/domains/clearance.md` under Concepts")
5. After fixing anything that affects file placement or frontmatter, recommend running `kb_reindex` to refresh the indexes.
