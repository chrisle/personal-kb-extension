---
name: kb-ingest
description: "Manually ingest a source document into the knowledge base"
trigger: /kb-ingest
---

Ingest a source document into the knowledge base.

1. If the user provided a file path, call `kb_ingest` with it as the `source` parameter. Otherwise ask which file to ingest.
2. Read the returned content. Identify the dominant **domain** (a short kebab slug — e.g. `clearance`, `ai-safety`, `accounting`). If the content is genuinely cross-cutting, use `_global`.
3. **Link discovery** (before writing): list the 3–7 main entities/concepts/topics in this source plus the page titles you plan to create. For each, call `kb_query` and note matches. When writing, add `[[stem]]` wikilinks to those matches inline or in a "## Related" section. For every existing page B you link from a new page A, also append `- [[A-stem]] — <why>` under B's "## Related" section (create if missing) — bidirectional links are what make the graph dense.
4. Create or update wiki pages, ALWAYS at `wiki/<type-folder>/<domain>/<slug>.md`:
   - one `source` page summarizing the document
   - `concept` pages for significant ideas
   - `entity` pages for named people / orgs / products / repos
   - `question` pages for open questions raised
   - update relevant `domain` hub page at `wiki/domains/<domain>.md` (create if missing)
5. Frontmatter on every page (required fields):
   ```yaml
   ---
   type: <concept|entity|source|domain|comparison|question>
   title: "Human Title"
   domain: <domain-slug>
   status: <seed|developing|mature|evergreen>
   created: <YYYY-MM-DD>
   updated: <YYYY-MM-DD>
   tags: [...]
   ---
   ```
6. Use `[[stem]]` wikilinks for cross-references — never paths. Stems must be unique vault-wide.
7. Append a single line at the TOP of `wiki/log.md`: `YYYY-MM-DD — ingest: [[source-stem]] (domain: <slug>, +N pages)`.
8. Call `kb_reindex` to rebuild `wiki/index.md` and `wiki/index/<domain>.md`.
9. Report: which pages were created or updated, the domain, key insight in one sentence.

## Path policy

`vault_write` rejects writes to `wiki/<file>.md` at root. Pages must be under `wiki/<type>/<domain>/`. Allowed at root: `index.md`, `log.md`, `hot.md`, `overview.md`, `README.md`. Domain hub pages live at `wiki/domains/<slug>.md` (two segments — that's fine, the policy only blocks single-segment writes).
