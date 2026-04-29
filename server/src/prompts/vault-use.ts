import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { setActiveVault, type VaultConfig } from "../lib/vaults.js";
import { userMessage } from "./index.js";

export async function vaultUsePrompt(cfg: VaultConfig, args: Record<string, string>): Promise<GetPromptResult> {
  const name = (args.name ?? "").trim();
  if (!name) {
    return userMessage(`# /vault-use — switch active vault\n\nNo name given. Run \`vault_active\` to see configured vaults, then call /vault-use with a name.`);
  }

  let resolved: string;
  try {
    resolved = setActiveVault(cfg, name);
  } catch (err) {
    return userMessage(`# /vault-use\n\nCould not switch: ${(err as Error).message}\n\nUse \`vault_active\` to list configured vaults.`);
  }

  return userMessage(`# /vault-use — switched

Active vault is now: \`${resolved}\`

Subsequent vault_/kb_/canvas_/git_ tool calls in this session will target this vault by default. Tools still accept an explicit \`vault\` argument to override per-call.

Suggested next step: read \`vault://hot.md\` for recent context, or run \`vault_list path=wiki recursive=true\` to see what's there.`);
}
