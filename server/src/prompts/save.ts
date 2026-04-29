import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function savePrompt(_cfg: VaultConfig, args: Record<string, string>): Promise<GetPromptResult> {
  const title = (args.title ?? "").trim();
  const kind = (args.kind ?? "").trim().toLowerCase();

  return userMessage(`# /save — File this conversation as a wiki note

${title ? `Note title: **${title}**` : "No title given — analyze the conversation and propose a clear, search-friendly title."}
${kind ? `Note kind: **${kind}**` : "No kind given — pick one: concept (idea/pattern/framework), decision (rationale/trade-offs), session (a working chat to file as-is), or entity (person/org/product)."}

## What to do

1. Determine target vault: call **vault_active** if unsure.
2. Check for duplicates: call **wiki_query** with the proposed title; if a page already exists, offer to update it instead of creating a new file.
3. Synthesize content from the conversation:
   - **concept**: definition, key points, examples, links to related concepts
   - **decision**: context, options considered, decision, consequences
   - **session**: chronological narrative + key takeaways
   - **entity**: identifying info, role, relationships
4. Write the note via **vault_write** at the right path:
   - concept → \`wiki/concepts/<kebab-title>.md\`
   - decision → \`wiki/decisions/<kebab-title>.md\` (create dir if missing)
   - session → \`wiki/sessions/<YYYY-MM-DD>-<kebab-title>.md\`
   - entity → \`wiki/entities/<kebab-title>.md\`
5. Front matter (always):
   \`\`\`yaml
   ---
   type: <concept|decision|session|entity>
   status: draft
   created: <YYYY-MM-DD>
   updated: <YYYY-MM-DD>
   tags: [...]
   ---
   \`\`\`
6. Use \`[[wikilinks]]\` for cross-references. Do NOT use absolute paths.
7. Update \`wiki/index.md\` to add the new entry under the right section.
8. Append a one-line entry at the TOP of \`wiki/log.md\`: \`YYYY-MM-DD — saved [[Note Title]] (<kind>)\`.
9. Report: path written, links created, anything you flagged for follow-up.

If no vault is configured, instruct the user to set one up in Claude Desktop → Settings → Extensions → Claude + Obsidian.`);
}
