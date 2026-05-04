# Building from Source

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

# 5. Pack
/tmp/mcpb-tools/node_modules/.bin/mcpb pack . personal-knowledge-base.mcpb

# 6. Restore server dev deps for next build
cd server && npm install && cd ..
```

This produces `personal-knowledge-base.mcpb` at the project root (~4 MB). Drag it into Claude Desktop → Settings → Extensions to install.

To inspect a built bundle:

```sh
/tmp/mcpb-tools/node_modules/.bin/mcpb info personal-knowledge-base.mcpb
```

## Project structure

```
server/        MCP server (Node.js/TypeScript, esbuild bundle)
  src/
    lib/       Core modules: vault config, watcher, dashboard HTTP server
    tools/     MCP tools: vault_*, kb_*, canvas_*, git_*
    prompts/   MCP prompts (/kb, /save, /autoresearch, …)
    resources/ MCP resources (vault://)
dashboard/     Wiki viewer + ingest queue UI (Next.js static export)
assets/
  skills/      Slash-command skill files auto-installed into each vault
  WIKI.md      Wiki schema reference, copied into new vaults
```

## Distribution

Drop the built `.mcpb` on Confluence / SharePoint / a Teams channel. Coworkers download and drag it into Claude Desktop. Updates are manual: bump `version` in `manifest.json` and `server/package.json`, rebuild, share again.
