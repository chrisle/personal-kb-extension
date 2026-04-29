import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Resource, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { getActiveVault, type VaultConfig } from "../lib/vaults.js";

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
  if (uri === SCHEMES.hot) return readActiveVaultFile(cfg, "wiki/hot.md", uri);
  if (uri === SCHEMES.index) return readActiveVaultFile(cfg, "wiki/index.md", uri);
  if (uri === SCHEMES.schema) return readBundled("WIKI.md", uri);
  throw new Error(`Unknown resource URI: ${uri}`);
}

async function readActiveVaultFile(cfg: VaultConfig, rel: string, uri: string): Promise<ReadResourceResult> {
  const vault = getActiveVault(cfg);
  const target = path.resolve(vault, rel);
  if (!fs.existsSync(target)) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: `# (${rel} not yet present in active vault)\n\nVault: ${vault}\nRun /wiki to scaffold, then /hot-update to populate.`,
        },
      ],
    };
  }
  const text = await fsp.readFile(target, "utf8");
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
}

async function readBundled(rel: string, uri: string): Promise<ReadResourceResult> {
  const target = path.join(ASSETS_DIR, rel);
  if (!fs.existsSync(target)) throw new Error(`Bundled asset not found: ${rel}`);
  const text = await fsp.readFile(target, "utf8");
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
}
