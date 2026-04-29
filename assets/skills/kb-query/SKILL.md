---
name: kb-query
description: "Ask any question about your knowledge base"
trigger: /kb-query
---

Answer the user's question from the knowledge base.

1. Call `kb_query` with the user's question (or the key terms from it) as the query.
2. Read the returned snippets. If a domain is implied, also read `wiki/index/<domain>.md` for the full page catalog in that domain.
3. Open 3–5 most relevant pages via `vault_read`. Stop at 5.
4. Synthesize a clear, structured answer. Use headings and bullets where helpful.
5. Cite the source page for each key fact (e.g. "per `wiki/concepts/clearance/risk-rating.md`").
6. If nothing matches, say so and suggest rephrasing or browsing with `/kb-view`.

If no question was provided, ask what the user wants to know.
