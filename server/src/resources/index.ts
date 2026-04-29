import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Resource, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { getActiveVault, kbDir, type VaultConfig } from "../lib/vaults.js";

const ASSETS_DIR = fileURLToPath(new URL("../../../assets/", import.meta.url));

const SCHEMES = {
  hot: "vault://hot.md",
  schema: "vault://WIKI.md",
  index: "vault://wiki/index.md",
} as const;

export function resources(_cfg: VaultConfig): Resource[] {
  return [
    {
      uri: SCHEMES.hot,
      name: "Hot cache",
      description: "Rolling ~500-word summary of recent vault activity. Read at session start to restore context.",
      mimeType: "text/markdown",
    },
    {
      uri: SCHEMES.schema,
      name: "Wiki schema (WIKI.md)",
      description: "Full schema reference for the wiki structure, frontmatter, and conventions.",
      mimeType: "text/markdown",
    },
    {
      uri: SCHEMES.index,
      name: "Wiki index",
      description: "The active vault's wiki/index.md — master catalog of all pages.",
      mimeType: "text/markdown",
    },
  ];
}

export async function readResource(cfg: VaultConfig, uri: string): Promise<ReadResourceResult> {
  if (uri === SCHEMES.hot) return readKBFile(cfg, "wiki/hot.md", uri);
  if (uri === SCHEMES.index) return readKBFile(cfg, "wiki/index.md", uri);
  if (uri === SCHEMES.schema) return readKBFile(cfg, "WIKI.md", uri, path.join(ASSETS_DIR, "WIKI.md"));
  throw new Error(`Unknown resource URI: ${uri}`);
}

async function readKBFile(
  cfg: VaultConfig,
  rel: string,
  uri: string,
  fallback?: string,
): Promise<ReadResourceResult> {
  const vault = getActiveVault(cfg);
  const target = path.join(kbDir(vault), rel);
  if (fs.existsSync(target)) {
    const text = await fsp.readFile(target, "utf8");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }
  if (fallback && fs.existsSync(fallback)) {
    const text = await fsp.readFile(fallback, "utf8");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }
  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: `# (${rel} not yet present)\n\nVault: ${vault}\nRun /wiki to scaffold, then /hot-update to populate.`,
      },
    ],
  };
}
