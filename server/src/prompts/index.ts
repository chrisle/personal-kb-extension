import type { Prompt, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { VaultConfig } from "../lib/vaults.js";

import { kbPrompt } from "./kb.js";
import { savePrompt } from "./save.js";
import { autoresearchPrompt } from "./autoresearch.js";
import { canvasPrompt } from "./canvas.js";
import { hotUpdatePrompt } from "./hot-update.js";
import { vaultUsePrompt } from "./vault-use.js";

const definitions: Prompt[] = [
  {
    name: "kb",
    description: "Bootstrap or check a knowledge base vault. Routes to scaffold/query/lint/ingest based on context.",
  },
  {
    name: "save",
    description: "Save the current conversation as a structured knowledge base note.",
    arguments: [
      { name: "title", description: "Optional note title", required: false },
      { name: "kind", description: "Note kind: concept | decision | session", required: false },
    ],
  },
  {
    name: "autoresearch",
    description: "Autonomous research loop: search, synthesize, file into the knowledge base.",
    arguments: [{ name: "topic", description: "Topic to research", required: false }],
  },
  {
    name: "canvas",
    description: "Manage Obsidian canvas (visual board) operations.",
  },
  {
    name: "hot-update",
    description: "Update wiki/hot.md with a session summary (replaces upstream Stop hook).",
  },
  {
    name: "vault-use",
    description: "Switch the active vault for this session.",
    arguments: [{ name: "name", description: "Vault name or path", required: true }],
  },
];

export const prompts: Prompt[] = definitions;

export async function getPrompt(
  cfg: VaultConfig,
  name: string,
  args: Record<string, string>,
): Promise<GetPromptResult> {
  switch (name) {
    case "kb":
      return kbPrompt(cfg, args);
    case "save":
      return savePrompt(cfg, args);
    case "autoresearch":
      return autoresearchPrompt(cfg, args);
    case "canvas":
      return canvasPrompt(cfg, args);
    case "hot-update":
      return hotUpdatePrompt(cfg, args);
    case "vault-use":
      return vaultUsePrompt(cfg, args);
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

export function userMessage(text: string): GetPromptResult {
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}
