import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { listVaults, type VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function wikiPrompt(cfg: VaultConfig, _args: Record<string, string>): Promise<GetPromptResult> {
  const vaults = listVaults(cfg);
  const vaultList = vaults.map((v) => `- ${v.name} (${v.path})${v.active ? " [active]" : ""}`).join("\n") || "(none configured yet)";

  return userMessage(`# /wiki — Claude + Obsidian setup or status

Configured vaults:
${vaultList}

You are a knowledge architect. Your job is to bootstrap and maintain a persistent wiki inside an Obsidian vault. The wiki is the product; chat is the interface.

## Decide what to do

1. If no vaults are configured: tell the user to add a vault directory in **Claude Desktop → Settings → Extensions → Claude + Obsidian**, then re-run /wiki.
2. If the active vault has no \`WIKI.md\` and no \`wiki/\` folder: it's empty. Run **vault_scaffold** to copy bundled assets, then continue with step 4.
3. If the active vault is already scaffolded: read \`vault://hot.md\` to restore recent context, list \`wiki/\` contents, and report current state.
4. Ask exactly ONE question: **"What is this vault for?"** Examples:
   - "Map the architecture of github.com/org/repo"
   - "Track my SaaS — product, customers, metrics, roadmap"
   - "Research project on [topic] — papers, concepts, open questions"
   - "Personal second brain — health, goals, learning, projects"
5. Based on the answer, populate \`wiki/index.md\`, \`wiki/log.md\`, \`wiki/overview.md\`, and create domain folders (e.g. \`wiki/concepts/\`, \`wiki/entities/\`, \`wiki/sources/\`, \`wiki/questions/\`) with \`_index.md\` files. Use **vault_write** for each.
6. Show a tree of what was created and ask: "Want to adjust anything before we start?"

## Conventions

- Every note has YAML frontmatter: \`type\`, \`status\`, \`created\`, \`updated\`, \`tags\`
- Wikilinks use \`[[Note Name]]\` (filenames unique, no paths)
- \`.raw/\` is immutable source documents — never modify
- \`wiki/index.md\` is the master catalog — update on every ingest
- \`wiki/log.md\` is append-only chronological history; new entries go at the TOP
- \`wiki/hot.md\` is a ~500-word rolling cache, overwritten each session — invoke /hot-update to refresh

## Tools to use
- \`vault_active\` — confirm/switch active vault
- \`vault_scaffold\` — copy bundled WIKI.md, _templates/, obsidian/ into the vault
- \`vault_read\`, \`vault_write\`, \`vault_list\`, \`vault_search\` — file IO
- \`wiki_query\` — find existing pages before creating new ones (avoid duplicates)
- \`wiki_lint\` — health check on demand

Proceed.`);
}
