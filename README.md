# Claude + Obsidian (Accenture)

A Claude Desktop extension that turns one or more Obsidian vaults into a persistent, structured wiki that Claude builds and maintains for you in chat. The wiki is the product; chat is just the interface.

## The idea — LLM Wiki

Based on [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). The core insight: RAG re-derives knowledge from scratch on every query — nothing compounds. A wiki, by contrast, is a **persistent, compounding artifact**. Cross-references are already there. Contradictions have already been flagged. Synthesis already reflects everything that has been read.

> "The tedious part of maintaining a knowledge base is not the reading or thinking — it's the bookkeeping." — Karpathy

You curate sources and ask questions. Claude does the summarizing, filing, cross-referencing, and lint — the friction-filled upkeep that gets abandoned otherwise. A single ingest typically touches 8–15 wiki pages: a source summary, updated entity pages, new concept pages, open-question pages, a domain hub revision, a hot-cache update, a log entry, and a fan-out of bidirectional `[[wikilinks]]`.

The vault is plain markdown on your disk. You can open it in Obsidian for the graph view, edit pages by hand, drop it into git — nothing is locked behind this extension.

## Why use it

- Drop files into a folder; the wiki updates itself.
- Every new source enriches existing pages instead of producing a throwaway answer.
- Query in natural language ("what do I have on X?") or browse the Obsidian graph.
- Works across multiple vaults from one install.
- You own the data. Plain markdown, on your disk, optionally in git.

## What's in this build

Packaged as an MCPB (`.mcpb`) extension for Claude Desktop — drag-and-drop install, no marketplace required. The wiki schema (`WIKI.md`), the skills set, and the slash-command shape come from [`AgriciDaniel/claude-obsidian`](https://github.com/AgriciDaniel/claude-obsidian); that project's [`bin/setup-multi-agent.sh`](https://github.com/AgriciDaniel/claude-obsidian/blob/main/bin/setup-multi-agent.sh) inspired the auto-install-into-vault skill distribution model.

### Slash commands

`/kb` bootstrap or check vault · `/save` file the current conversation · `/autoresearch topic="…"` autonomous research loop · `/canvas` visual board · `/hot-update` refresh rolling context cache · `/vault-use <name>` switch active vault

### Tools the model can call

| Tool | What it does |
|---|---|
| `vault_read` / `vault_write` / `vault_list` / `vault_search` / `vault_active` | File IO inside the configured vault(s), with path-escape guards |
| `kb_ingest` | Read a source from `.raw/`, return content for the model to extract from |
| `kb_query` | Substring search across `wiki/`, returns line-level snippets |
| `kb_lint` | Orphan pages, broken `[[wikilinks]]`, inbound/outbound link counts |
| `kb_reindex` | Rebuild the slim master + per-domain sub-indexes from a frontmatter scan |
| `canvas_create` / `canvas_add_node` / `canvas_list` | Obsidian `.canvas` file manipulation |
| `git_commit` | Stage and commit changes if the vault is a git repo |

### Auto-watcher with concurrent queue

Drop a file into the vault and the extension spawns `claude -p kb-ingest …` from the vault directory to process it. Up to 5 ingests run concurrently. mtime-based dedup means re-running on already-ingested files is cheap. Supported formats: `.md`, `.txt`, `.csv`, `.canvas`, `.docx`, `.pptx`, `.xlsx`, `.pdf`, `.png`, `.jpg/.jpeg`, `.webp`, `.gif`. The watcher honors a `_global` set of excluded paths (`wiki/`, `.git/`, `.obsidian/`, `.raw/`, `.vault-meta/`, `.trash/`, `_templates/`, `node_modules/`, hidden dirs).

### Vision-mode image ingest

Images go through a dedicated branch. Claude Code's Read tool accepts images natively — no OCR dependency. The model is told to transcribe all readable text verbatim, emit fenced `mermaid` blocks for anything that fits a Mermaid diagram type (flowchart, sequence, class, ER, state, gantt, pie, mindmap, gitGraph) using exact node labels from the image, and describe the rest in detailed prose. The image becomes a `wiki/sources/<domain>/<slug>.md` page; concept/entity/question pages are extracted from it like any other source.

### Path policy enforced at the tool layer

Earlier versions told the model where to write but the model freelanced and piled content pages into `wiki/` root, which would have hurt LLM context as vaults grew. `vault_write` now refuses single-segment writes under `wiki/` and returns a structured error pointing at the correct path. Every page lives at `wiki/<type>/<domain>/<slug>.md` (e.g. `wiki/concepts/clearance/risk-rating.md`). Only `index.md`, `log.md`, `hot.md`, `overview.md`, `README.md` are permitted at the `wiki/` root. Domain hub pages live at `wiki/domains/<slug>.md`.

### Hierarchical lazy-loaded indexes

`wiki/index.md` is a **slim master** — it lists domains only, regardless of vault size, so it can always sit in the model's context. Each domain has its own `wiki/index/<domain>.md` listing pages grouped by type (concept, entity, source, comparison, question, domain), loaded only when the model is working in that domain. Both files are **generated** by `kb_reindex` from a frontmatter scan — they are not hand-edited.

### Query-then-link discovery (bidirectional)

Before writing any new page, the ingest model extracts the 3–7 main topics from the source, calls `kb_query` for each, and adds `[[stem]]` wikilinks to existing matches inline or under a `## Related` section. For every new → existing link, it also appends a backlink under the existing page's `## Related` section. The result is a dense, bidirectional graph instead of a fan of orphans hoping the model remembers prior pages. Costs ~3–7 extra `kb_query` calls per ingest.

### Live ingest dashboard

A small Next.js dashboard served on `http://localhost:3737` (port configurable) shows the queue: files currently being processed, queued, and recently completed, with status, exit codes, and timing. State is streamed over SSE — open the page and watch ingests in real time.

### Multi-vault

One extension instance manages N Obsidian vaults. Each chat defaults to the active vault; tools accept an explicit `vault` arg per call. Switch mid-session with `/vault-use <name>`.

### Auto-installed skills + CLAUDE.md awareness

On first run in a new vault, the extension scaffolds `wiki/`, `wiki/index/`, `.raw/`, `.vault-meta/`, and seeds `WIKI.md`, `wiki/index.md`, `wiki/hot.md`. It copies bundled skills (`/kb`, `/kb-ingest`, `/kb-lint`, `/kb-reindex`) into the vault's `.claude/skills/` so Claude Code finds them when spawned from the vault directory. It also upserts a `Wiki Knowledge Base` block into the vault's `CLAUDE.md` instructing Claude to read `wiki/hot.md` → `wiki/index.md` → `wiki/index/<domain>.md` at session start, and to use `kb_query` for specific pages instead of browsing the tree.

### Optional auto-commit

If a vault is a git repo, every wiki write produces a git snapshot. Gives you history and rollback for free.

## Install (for coworkers)

1. Download `obsidian-claude-accenture.mcpb` from the internal share link.
2. Open Claude Desktop → **Settings → Extensions**.
3. Drag the `.mcpb` file into the Extensions window. It will appear as **Obsidian Knowledge Base (Accenture)**.
4. Click the extension to open its settings. Configure:
   - **Knowledge folders** — add one directory per Obsidian vault you want managed. New vault directories are fine; the extension scaffolds them on first run.
   - **Default folder** (optional) — folder name of the default vault. Leave empty to use the first one.
   - **Auto-snapshot changes (git)** — recommended on if your vaults are git repos.
   - **Auto watch** — when on, the extension watches each vault and ingests added/changed/removed files automatically, using the Claude Code CLI bundled inside Claude Desktop (`<data-dir>/claude-code/<version>/...`); falls back to `claude` on `PATH` if the bundled copy isn't found.
   - **Ingest model** — `claude-sonnet-4-6` (default), `claude-haiku-4-5-20251001` (faster, cheaper), or `claude-opus-4-7` (highest quality).
   - **Dashboard port** — port for the live ingest queue dashboard. Default `3737`.
5. Toggle the extension **on**. Open a new chat. Type `/` and confirm `/kb`, `/save`, `/autoresearch`, `/canvas`, `/hot-update`, `/vault-use` appear. Open `http://localhost:3737` to see the live ingest dashboard.

## First-time vault setup

In a new chat:

```
/kb
```

Claude will:
1. Check the active vault.
2. If empty, run `vault_scaffold` (copies bundled `WIKI.md`, `_templates/`, `.obsidian/` into the vault).
3. Ask **"What is this vault for?"** Answer in one sentence.
4. Build the structure — domain folders, index, log, hot cache, overview.
5. Show what was created and ask if you want to adjust.

## Day-to-day

| Want to… | Do |
|---|---|
| File this conversation | `/save` (or `/save title="My Note" kind=concept`) |
| Research a topic and file findings | `/autoresearch topic="…"` |
| Drop a source for ingestion | Save the file anywhere in the vault — the watcher picks it up |
| Ask the knowledge base | "What do I have on X?" — Claude uses `kb_query` |
| Health-check the vault | "Lint the knowledge base" — Claude uses `kb_lint` |
| Rebuild indexes after manual edits | "Reindex" — Claude uses `kb_reindex` |
| Visual board | `/canvas` |
| Refresh recent-context cache | `/hot-update` (run at end of session) |
| Switch vaults mid-session | `/vault-use <name>` |

## Multi-project workflow

Each Obsidian vault is its own project. Add all of them to the **Knowledge folders** list in extension settings. In any chat, the extension defaults to the active vault; use `/vault-use <name>` to switch. Tools also accept an explicit `vault` argument per call.

For best results, create one Claude Desktop **Project** per vault and paste the contents of `PROJECT_INSTRUCTIONS.md` into the project's custom instructions. This tells Claude to read `vault://hot.md` at the start of each session.

## What this does not do

- **No multi-agent fan-out** — upstream `claude-obsidian` ships a `setup-multi-agent.sh` that symlinks the skills directory into Codex / Gemini / Cursor / Windsurf install paths so the same skills work across CLIs. This DXT only targets Claude Desktop + the bundled Claude Code CLI; skills are auto-installed into the vault's `.claude/skills/` for that pipeline.
- **No semantic retrieval** — `kb_query` is plain substring search. Linking and topic association rely on the ingest model's query-then-link pass plus `domain` frontmatter, not embeddings.
- **No SessionStart/Stop hooks** — Claude Desktop has no hook surface. Hot-cache restore is a `vault://hot.md` resource the model reads on demand; the session-end summary is the manual `/hot-update` prompt. The auto-upserted `CLAUDE.md` block makes the read-on-start side seamless.

## Building from source

Requires Node 18+ and `npm`.

```sh
# 1. Build the MCP server
cd server && npm install && npm run build && cd ..

# 2. Build the dashboard (Next.js static export → dashboard/out/)
cd dashboard && npm install && npm run build && cd ..

# 3. Prune server dev deps so they don't get bundled
cd server && npm prune --omit=dev && cd ..

# 4. Install the packer in a tmp dir (avoids ancestor package.json conflicts)
mkdir -p /tmp/mcpb-tools && (cd /tmp/mcpb-tools && npm init -y >/dev/null && npm install @anthropic-ai/mcpb)

# 5. Pack (.mcpbignore excludes dashboard source/node_modules; only dashboard/out/ ships)
/tmp/mcpb-tools/node_modules/.bin/mcpb pack . obsidian-claude-accenture.mcpb

# 6. Restore server dev deps for next build
cd server && npm install && cd ..
```

This produces `obsidian-claude-accenture.mcpb` at the project root (~4MB). Drag it into Claude Desktop to install.

To inspect a built bundle:

```sh
/tmp/mcpb-tools/node_modules/.bin/mcpb info obsidian-claude-accenture.mcpb
```

## Distribution (internal)

Drop the built `.mcpb` on Confluence / SharePoint / a Teams channel. Coworkers download and drag-drop. Updates are manual: bump `version` in `manifest.json` and `server/package.json`, rebuild, share again.

If you want a pinned location for releases, use an internal GitHub repo and attach `.mcpb` files to tagged releases. Note that for Claude **Code** plugin distribution (a separate pipeline), the marketplace must be on the Accenture allowlist in `~/.claude/remote-settings.json` (`strictKnownMarketplaces`); this DXT path bypasses that constraint entirely.

## Lineage

- **Concept** — Andrej Karpathy, [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). The schema (`WIKI.md`), the three-layer architecture (raw / wiki / governance), the hot-cache pattern, the lint discipline, the bookkeeping-is-the-bottleneck framing.
- **Wiki implementation + skills** — [`AgriciDaniel/claude-obsidian`](https://github.com/AgriciDaniel/claude-obsidian). The skill set, the slash-command shape, the auto-distribute-skills-to-agents idea (their `setup-multi-agent.sh`).
- **This build** — packaged as a Claude Desktop MCPB extension; tool-layer path policy; slim-master + per-domain hierarchical indexes via `kb_reindex`; vision-mode image ingest with Mermaid extraction; concurrent ingest queue with mtime dedup and configurable model; live SSE ingest dashboard; query-then-link bidirectional discovery; auto-upsert of wiki-awareness into vault `CLAUDE.md`; multi-vault from a single install.

## License

MIT — see [LICENSE](LICENSE). See [ATTRIBUTION.md](ATTRIBUTION.md) for upstream credits.
