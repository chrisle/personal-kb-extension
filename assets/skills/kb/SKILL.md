---
name: kb
description: "Search the knowledge base and answer questions from its contents"
trigger: /kb
---

Search the knowledge base and answer the user's question.

1. Call the `kb_query` tool with the user's input as the `query` parameter. Do not browse `wiki/` by listing folders — query is the primary discovery path.
2. Read the returned snippets. If a domain is implied, also read `wiki/index/<domain>.md` for the catalog of pages in that domain.
3. Open 3–5 most relevant pages via `vault_read`. Stop at 5 — broader context comes from kb_query, not from reading more pages.
4. Synthesize a clear, structured answer — use headings and bullets where appropriate.
5. For each key fact, cite the page it came from (e.g. "per `wiki/concepts/clearance/risk-rating.md`").
6. If no results match, say so and suggest a rephrased query or related domain (browse `wiki/index.md` for the domain list).

If the user didn't provide a query, ask what they want to look up.
