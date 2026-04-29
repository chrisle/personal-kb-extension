import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function autoresearchPrompt(_cfg: VaultConfig, args: Record<string, string>): Promise<GetPromptResult> {
  const topic = (args.topic ?? "").trim();

  return userMessage(`# /autoresearch — Autonomous research loop

${topic ? `Topic: **${topic}**` : "No topic given — ask: 'What topic should I research?' before proceeding."}

## What to do

1. **Confirm vault**: \`vault_active\`. If none, instruct user to add one and stop.
2. **Frame the question**: re-state the topic in 1-2 sentences. List the sub-questions you'll explore (3-7).
3. **Search** using Claude Desktop's native web search:
   - Find authoritative sources (primary docs, papers, official sites)
   - For each source, capture: URL, title, author, date, key claims
4. **Cross-check**: where sources disagree, flag the contradiction explicitly.
5. **Pick a domain slug** for this research (e.g. the topic kebab-cased). All pages produced get the same \`domain\` in frontmatter.
6. **Synthesize and file**: for each major finding, create a wiki page via **vault_write** at \`wiki/<type-folder>/<domain>/<slug>.md\`:
   - One \`wiki/sources/<domain>/<source-slug>.md\` per source (summary + link + frontmatter)
   - One \`wiki/concepts/<domain>/<concept-slug>.md\` per distinct concept the research surfaced
   - One \`wiki/questions/<domain>/<question-slug>.md\` if there's an open question
   - Cross-link with \`[[stem]]\` wikilinks (no paths)
7. **Update**:
   - \`wiki/log.md\` — TOP of file, one-line entry: \`YYYY-MM-DD — autoresearch: <topic> (<N> sources, <M> pages, domain: <slug>)\`
   - \`wiki/hot.md\` — overwrite with the new recent context (≤ 500 words)
8. **Run kb_reindex** to rebuild master and per-domain indexes.
9. **Report**: pages created, domain, key findings, open questions, source count.

## Constraints
- Every page must have YAML frontmatter (type, title, domain, status, created, updated, tags)
- Cite sources with \`[Title](URL)\` markdown links inside source pages
- Do not fabricate sources. If a search returns nothing useful, say so and stop.
- Stay within the configured vault. All writes via \`vault_write\` to relative paths.
- vault_write rejects writes to \`wiki/<file>.md\` at root — every page goes under \`wiki/<type>/<domain>/\`.

Proceed.`);
}
