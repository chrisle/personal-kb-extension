# Claude + Obsidian (Accenture)

A Claude Desktop extension that turns one or more Obsidian vaults into a persistent, structured wiki you build with Claude in chat. Adapted from [`AgriciDaniel/claude-obsidian`](https://github.com/AgriciDaniel/claude-obsidian) and packaged for Accenture sideloading (no marketplace required).

## What you get

- **Slash commands** in Claude Desktop: `/wiki`, `/save`, `/autoresearch`, `/canvas`, `/hot-update`, `/vault-use`
- **Tools** for vault file IO, wiki ingest/query/lint, Obsidian canvas manipulation, optional auto-commit
- **Resources** so the model can pull recent context (`vault://hot.md`), the schema (`vault://WIKI.md`), or the index (`vault://wiki/index.md`) on demand
- **Multi-vault**: one install manages N Obsidian vaults; switch with `/vault-use`
- **Live ingest dashboard**: a small web page on `http://localhost:<port>` shows files currently being processed, queued, and recently completed. Default port is `3737`; configurable in extension settings.

## Install (for coworkers)

1. Download `obsidian-claude-accenture.mcpb` from the internal share link.
2. Open Claude Desktop → **Settings → Extensions**.
3. Drag the `.mcpb` file into the Extensions window. It will appear as **Claude + Obsidian (Accenture)**.
4. Click the extension to open its settings. Configure:
   - **Obsidian Vaults** — add one directory per Obsidian vault you want managed. New vault directories are fine; the extension will scaffold them on first run.
   - **Active vault** (optional) — folder name of the default vault. Leave empty to use the first one.
   - **Auto-commit on write** — recommended on if your vaults are git repos.
   - **Auto-ingest on file change** — when enabled, the extension watches each vault and runs `claude -p "wiki-ingest <relpath>"` from the vault directory whenever a file is added, changed, or removed. Skips `wiki/`, `.obsidian/`, `.git/`, `.vault-meta/`, `.trash/`, `_templates/`, `node_modules/`. Uses the Claude Code CLI bundled inside Claude Desktop (`<data-dir>/claude-code/<version>/...`); falls back to `claude` on `PATH` if the bundled copy isn't found.
   - **Dashboard port** — port for the live ingest queue dashboard. Open `http://localhost:<port>` in any browser to watch files being processed in real time. Default `3737`.
5. Toggle the extension **on**. Open a new chat. Type `/` and confirm `/wiki`, `/save`, `/autoresearch`, `/canvas`, `/hot-update`, `/vault-use` appear. Open `http://localhost:3737` to see the live ingest dashboard.

## First-time vault setup

In a new chat:

```
/wiki
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
| Drop a source for ingestion | Save the file to `<vault>/.raw/`, then ask Claude to "ingest <filename>" |
| Ask the wiki | "What do I have on X?" — Claude uses `wiki_query` |
| Health-check the vault | "Lint the wiki" — Claude uses `wiki_lint` |
| Visual board | `/canvas` |
| Refresh recent-context cache | `/hot-update` (run at end of session) |
| Switch vaults mid-session | `/vault-use <name>` |

## Multi-project workflow

Each Obsidian vault is its own project. Add all of them to the **Obsidian Vaults** list in extension settings. In any chat, the extension defaults to the active vault; use `/vault-use <name>` to switch. Tools also accept an explicit `vault` argument per call.

For best results, create one Claude Desktop **Project** per vault and paste the contents of `PROJECT_INSTRUCTIONS.md` into the project's custom instructions. This tells Claude to read `vault://hot.md` at the start of each session.

## What this does not do

- **No subagents** — Claude Desktop has no parallel-thread primitive. Multi-source ingest runs sequentially. The upstream Claude Code plugin is faster for batch ingest.
- **No automatic hooks** — Claude Desktop has no SessionStart/Stop hooks. The hot-cache restore is a `vault://hot.md` resource the model reads on demand; the session-end summary is the manual `/hot-update` prompt. Adding the suggested project instructions makes this seamless.

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

## License

MIT — see [LICENSE](LICENSE). Built on top of `claude-obsidian` (MIT, AgriciDaniel) and the LLM Wiki pattern by Andrej Karpathy. See [ATTRIBUTION.md](ATTRIBUTION.md).
