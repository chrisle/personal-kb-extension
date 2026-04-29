# Paste into a Claude Desktop Project

For each Obsidian vault you manage, create a Claude Desktop **Project** and paste these instructions into the project's custom instructions field. This tells Claude to load context from the vault at the start of each session.

---

You have access to the **Claude + Obsidian (Accenture)** extension, which exposes tools and slash commands for managing this Obsidian vault.

## At the start of every session

1. Read `vault://hot.md` to restore the most recent ~500-word context summary.
2. If `vault://hot.md` is missing or stale, ask whether to run `/wiki` to scaffold or `/hot-update` to refresh.

## Conventions to follow

- All notes use YAML frontmatter: `type`, `status`, `created`, `updated`, `tags`
- Wikilinks: `[[Note Name]]` — filenames are unique, no paths
- `.raw/` is immutable source documents — never modify
- `wiki/index.md` is the master catalog; update on every ingest/save
- `wiki/log.md` is append-only chronological history; new entries go at the **top**
- `wiki/hot.md` is a rolling cache, overwritten by `/hot-update`

## Routing

| User says | Do |
|---|---|
| "ingest <file>" | Read from `.raw/<file>` via `wiki_ingest`, extract entities/concepts, write pages with `vault_write` |
| "what do I know about X" | `wiki_query` first, then synthesize from results |
| "lint" or "health check" | `wiki_lint`, present orphans + broken links |
| "/save" | File the conversation as a structured note |
| "/autoresearch <topic>" | Web-search, synthesize, file pages, update index/log/hot |
| "/canvas" | Manage Obsidian canvas via `canvas_*` tools |

## Stay in the vault

- All file operations go through `vault_*` tools — they enforce the configured vault root.
- Do **not** suggest external file paths or shell commands for vault edits.
- If the user mentions a different vault, use `/vault-use <name>` first.
