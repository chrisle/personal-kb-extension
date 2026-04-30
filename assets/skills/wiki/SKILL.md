---
name: wiki
description: "Search the Obsidian knowledge base wiki and answer questions from its contents"
trigger: /wiki
---

Search the knowledge base wiki and answer the user's question.

1. Call the `wiki_query` tool with the user's input as the `query` parameter
2. Read all returned page snippets carefully
3. Synthesize a clear, structured answer — use headings and bullets where appropriate
4. For each key fact, cite the wiki page it came from (e.g. "per `wiki/clearance-overview.md`")
5. If no results match, say so clearly and suggest a rephrased query or related topic

If the user didn't provide a query, ask what they want to look up.
