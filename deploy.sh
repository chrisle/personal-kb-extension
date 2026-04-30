#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALLED="$HOME/Library/Application Support/Claude/Claude Extensions/local.unpacked.christopher-le.obsidian-claude-accenture/server"
SRC="$ROOT/server"

echo "Building..."
cd "$SRC" && npm run build

echo "Syncing bundle..."
mkdir -p "$INSTALLED/dist"
cp "$SRC/dist/index.js" "$INSTALLED/dist/index.js"
cp "$ROOT/manifest.json" "$INSTALLED/../manifest.json"
rsync -a --delete "$ROOT/assets/skills/" "$INSTALLED/../assets/skills/"
echo "Done. Restart Claude Desktop to pick up changes."
