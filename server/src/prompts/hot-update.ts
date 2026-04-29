import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function hotUpdatePrompt(_cfg: VaultConfig, _args: Record<string, string>): Promise<GetPromptResult> {
  return userMessage(`# /hot-update — Refresh wiki/hot.md

This replaces the upstream "Stop hook" behavior, which Claude Desktop has no equivalent for. Run this at the end of a working session, or any time \`wiki/hot.md\` feels stale.

## What to do

1. Confirm vault: \`vault_active\`.
2. Read the current \`wiki/hot.md\` via \`vault_read\` to see what's already there.
3. Read \`wiki/log.md\` (top 20 lines) and the most recently changed pages — \`vault_search\` or \`vault_list\` over \`wiki/\` to find them.
4. Synthesize a fresh hot cache. Format:

\`\`\`markdown
---
type: meta
title: "Hot Cache"
updated: <YYYY-MM-DDTHH:MM:SS>
---

# Recent Context

## Last Updated
YYYY-MM-DD — <one-line summary of latest session>

## Key Recent Facts
- <Most important takeaway>
- <Second>
- <Third>

## Recent Changes
- Created: [[Page A]], [[Page B]]
- Updated: [[Page C]] (added section on X)
- Flagged: contradiction between [[Page D]] and [[Page E]] on Y

## Active Threads
- User is researching <topic>
- Open question: <thing still being investigated>
\`\`\`

5. **Overwrite** \`wiki/hot.md\` via \`vault_write\` (path=\`wiki/hot.md\`, content=…). Hot.md is a cache, not a journal — total length ≤ 500 words.
6. Report: word count, changes since previous hot cache.`);
}
