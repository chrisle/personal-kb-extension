---
name: kb-view
description: "Browse the knowledge base interactively — explore domains and read pages"
trigger: /kb-view
---

Browse the knowledge base like Wikipedia.

1. Read `wiki/index.md` via `vault_read`. Show the domain list with page counts as a numbered list.
2. Ask the user: pick a domain number to explore, type a page name to jump straight to it, or type **S: <query>** to search.
3. When a domain is selected:
   - Read `wiki/index/<domain>.md` via `vault_read`
   - Display pages grouped by type (Concepts, Entities, Sources, etc.) as a numbered list
   - Options: pick a page, **[B]ack** to domains, **S: <query>** to search
4. When a page is selected:
   - Read it via `vault_read`
   - Display the full content using the `title` frontmatter field as the heading
   - Extract `[[wikilinks]]` from the body and list them as **Related** options
   - Options: open a related page by number, **[B]ack** to domain index, **[H]ome** to domain list, **S: <query>** to search
5. When user searches (**S: <query>**):
   - Call `kb_search` with the query
   - Display results as a numbered list: **Title** — path — snippet
   - User picks a result number to open that page
   - After viewing, return to the search results or offer navigation options
6. Hold navigation state in the conversation — don't re-read index.md on every step unless the user asks to refresh.
