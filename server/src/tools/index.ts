import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";

import { vaultTools, callVaultTool } from "./vault.js";
import { kbTools, callKbTool } from "./kb.js";
import { canvasTools, callCanvasTool } from "./canvas.js";
import { gitTools, callGitTool } from "./git.js";

export const tools: Tool[] = [...vaultTools, ...kbTools, ...canvasTools, ...gitTools];

export async function callTool(
  cfg: VaultConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (name.startsWith("vault_")) return callVaultTool(cfg, name, args);
  if (name.startsWith("kb_")) return callKbTool(cfg, name, args);
  if (name.startsWith("canvas_")) return callCanvasTool(cfg, name, args);
  if (name.startsWith("git_")) return callGitTool(cfg, name, args);
  throw new Error(`Unknown tool: ${name}`);
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
