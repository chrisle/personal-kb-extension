# Advanced Configuration

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_ACTIVE_VAULT` | first folder | Default vault (folder name, not full path) |
| `OBSIDIAN_AUTO_COMMIT` | `true` | Git-commit every wiki write (vault must be a git repo) |
| `OBSIDIAN_AUTO_WATCH` | `false` | Watch for file changes and ingest automatically |
| `OBSIDIAN_AUTO_LINT` | `false` | Periodically fix broken links and orphan pages |
| `OBSIDIAN_AUTO_LINT_INTERVAL_HOURS` | `6` | How often to run auto-lint (hours, minimum 1) |
| `OBSIDIAN_INGEST_MODEL` | `claude-sonnet-4-6` | Model used for ingestion, lint, and search |
| `OBSIDIAN_DASHBOARD_PORT` | `3737` | Port for the wiki viewer and ingest dashboard |

## All slash commands

| Command | What it does |
|---|---|
| `/kb-query` | Ask any question — Claude searches the knowledge base and synthesizes an answer |
| `/kb-view` | Browse the knowledge base interactively (Wikipedia-style, with search) |
| `/save` | File the current conversation as a wiki page |
| `/kb` | Set up a new vault or check status of an existing one |
| `/kb-ingest` | Manually ingest a file from the `.raw/` source folder |
| `/kb-lint` | Audit the knowledge base for broken links and orphaned pages |
| `/kb-reindex` | Rebuild the domain index after manually editing or moving pages |

## Multi-vault

One extension instance manages multiple vaults. Each chat defaults to the active vault. Switch mid-session:

```
/vault-use <name>
```

All tools accept an explicit `vault` argument to target a specific vault without switching.

## Auto-watch

When `OBSIDIAN_AUTO_WATCH=true`, the extension watches each vault folder and ingests new or changed files automatically. Up to 5 ingests run concurrently. Files already ingested are skipped based on mtime.

Excluded from watching: `wiki/`, `.git/`, `.obsidian/`, `.raw/`, `.vault-meta/`, `.trash/`, `_templates/`, `node_modules/`, hidden directories.

## Auto-lint

When `OBSIDIAN_AUTO_LINT=true`, the extension checks every `OBSIDIAN_AUTO_LINT_INTERVAL_HOURS` hours whether any wiki pages have changed since the last lint run. If yes, it spawns a Claude session to fix broken links, connect orphaned pages, and reindex.

## Dashboard

The live dashboard at `http://localhost:3737` shows:
- **Wiki** — browse and search the knowledge base in a browser
- **Queue** — files currently being ingested (active, queued, recently completed)
- **Logs** — live server log stream

## Lineage

- **Concept** — Andrej Karpathy, [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- **Wiki implementation + skills** — [`AgriciDaniel/claude-obsidian`](https://github.com/AgriciDaniel/claude-obsidian)
