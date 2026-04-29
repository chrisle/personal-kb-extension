import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function canvasPrompt(_cfg: VaultConfig, _args: Record<string, string>): Promise<GetPromptResult> {
  return userMessage(`# /canvas — Obsidian canvas (visual board)

Available operations (use the matching tool):

| Operation | Tool | Notes |
|-----------|------|-------|
| List canvases | \`canvas_list\` | Shows all canvases with node counts |
| Create canvas | \`canvas_create\` | At \`wiki/canvases/<name>.canvas\` |
| Add text card | \`canvas_add_node\` type=text, text=... | |
| Add file/note card | \`canvas_add_node\` type=file, file=wiki/concepts/foo.md | Path is vault-relative |
| Add link card | \`canvas_add_node\` type=link, url=https://... | |

## What to do

1. Confirm vault: \`vault_active\`. If none, instruct user to set one up and stop.
2. If the user said \`/canvas\` with no operation, run \`canvas_list\` and show what exists.
3. If they want to add to a canvas, ask which one (default: \`main\`) if not specified.
4. Auto-position nodes if x/y not given; the tool handles spacing.
5. After any modification, report: canvas file path, node added/removed.

Default canvas is \`wiki/canvases/main.canvas\`. Create it if missing.`);
}
