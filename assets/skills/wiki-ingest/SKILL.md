---
name: wiki-ingest
description: "Manually ingest a source document into the Obsidian knowledge base wiki"
trigger: /wiki-ingest
---

Ingest a source document into the knowledge base wiki.

1. If the user provided a file path, call `wiki_ingest` with it as the `source` parameter
2. If no file was specified, ask the user which file to ingest
3. After the tool returns the document content, create or update wiki pages based on what you read
4. Follow the same wiki schema as existing pages — use frontmatter with type/title/tags, add citations, update wiki/index.md and wiki/log.md
5. Report which pages were created or updated and summarize what was captured
