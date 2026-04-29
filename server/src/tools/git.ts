import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ensureVaultExists, resolveVault, type VaultConfig } from "../lib/vaults.js";
import { textResult } from "./index.js";

const exec = promisify(execFile);

export const gitTools: Tool[] = [
  {
    name: "git_commit",
    description:
      "Stage all changes in the vault and create a commit. Use when auto_commit is disabled or to make an explicit commit with a custom message.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
];

export async function callGitTool(cfg: VaultConfig, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "git_commit":
      return commit(cfg, args);
    default:
      throw new Error(`Unknown git tool: ${name}`);
  }
}

async function commit(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  if (!fs.existsSync(path.join(vault, ".git"))) {
    throw new Error(`Not a git repo: ${vault}`);
  }
  const msg = String(args.message ?? "").trim();
  if (!msg) throw new Error("message is required");

  await exec("git", ["add", "-A"], { cwd: vault });
  try {
    const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], { cwd: vault });
    if (!stdout.trim()) return textResult("Nothing to commit (no staged changes)");
  } catch (err) {
    return textResult(`Could not check staged changes: ${(err as Error).message}`);
  }
  const { stdout } = await exec("git", ["commit", "-m", msg], { cwd: vault });
  return textResult(stdout.trim());
}
