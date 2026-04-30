---
name: wiki-lint
description: "Audit the Obsidian knowledge base wiki for broken links, orphaned pages, and structural issues"
trigger: /wiki-lint
---

Audit the knowledge base wiki for structural issues.

1. Call the `wiki_lint` tool
2. Report the results clearly:
   - Total page count
   - Orphaned pages (no backlinks) — list them with suggested fix (add to index or delete)
   - Broken links — list the source page and the missing target
3. Prioritize issues: broken links first, then orphans
4. Suggest specific actions for each issue — be concrete (e.g. "add [[clearance-overview]] to wiki/index.md under Clearance domain")
