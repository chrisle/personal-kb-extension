import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function savePrompt(_cfg: VaultConfig, args: Record<string, string>): Promise<GetPromptResult> {
  const title = (args.title ?? "").trim();
  const kind = (args.kind ?? "").trim().toLowerCase();

  return userMessage(`# /save — File this conversation as a knowledge base note

${title ? `Note title: **${title}**` : "No title given — analyze the conversation and propose a clear, search-friendly title."}
${kind ? `Note kind: **${kind}**` : "No kind given — pick one: concept (idea/pattern/framework), decision (rationale/trade-offs), session (a working chat to file as-is), or entity (person/org/product)."}

## What to do

1. Determine target vault: call **vault_active** if unsure.
2. Check for duplicates: call **kb_query** with the proposed title; if a page already exists, offer to update it instead of creating a new file.
3. **Link discovery**: identify the 3–5 main entities, concepts, or topics this note touches. Call **kb_query** for each. Note matching pages — you'll wikilink to them in step 5 and add a backlink under their "## Related" section after writing (bidirectional links keep the graph dense).
4. Pick a \`domain\` slug for the note (the broad subject area — e.g. \`clearance\`, \`finance\`, \`ai-research\`). If genuinely cross-cutting, use \`_global\`.
5. Synthesize content from the conversation:
   - **concept**: definition, key points, examples, links to related concepts
   - **decision**: context, options considered, decision, consequences
   - **session**: chronological narrative + key takeaways
   - **entity**: identifying info, role, relationships
6. Front matter (always):
   \`\`\`yaml
   ---
   type: <concept|entity|source|domain|comparison|question>
   title: "Human title"
   domain: <domain-slug>
   status: draft
   created: <YYYY-MM-DD>
   updated: <YYYY-MM-DD>
   tags: [...]
   ---
   \`\`\`
7. Write via **vault_write** at \`wiki/<type-folder>/<domain>/<slug>.md\` (e.g. \`wiki/concepts/clearance/risk-rating.md\`). The tool rejects single-segment writes at the wiki/ root.
8. Use \`[[stem]]\` wikilinks (filename without path/extension). Stems must be unique vault-wide.
9. For each existing page B you linked to from this new note, append \`- [[<new-stem>]] — <one-line why>\` under B's "## Related" section (create the section if missing).
10. Append one line at the TOP of \`wiki/log.md\`: \`YYYY-MM-DD — saved [[stem]] (<kind>, domain: <domain>)\`.
11. Run **kb_reindex** to rebuild \`wiki/index.md\` and \`wiki/index/<domain>.md\`.
12. Report: path written, domain, links created, anything flagged for follow-up.

If no vault is configured, instruct the user to set one up in Claude Desktop → Settings → Extensions → Local Knowledge Base.`);
}
