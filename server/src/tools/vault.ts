import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ensureVaultExists,
  getActiveVault,
  kbDir,
  listVaults,
  OBSIDIAN_IGNORE,
  resolveVault,
  setActiveVault,
  upsertClaudeMd,
  vaultPath,
  type VaultConfig,
} from "../lib/vaults.js";
import { maybeAutoCommit } from "../lib/autocommit.js";
import { log } from "../lib/log.js";
import { textResult } from "./index.js";

const ASSETS_DIR = fileURLToPath(new URL("../../../assets/", import.meta.url));

export const vaultTools: Tool[] = [
  {
    name: "vault_scaffold",
    description:
      "Bootstrap a knowledge base in the vault root. Creates wiki/, .raw/, .vault-meta/, seeds WIKI.md and index/hot stubs. Idempotent — existing files are preserved unless `overwrite` is true.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: "Vault name or absolute path. Defaults to active vault." },
        overwrite: { type: "boolean", description: "Overwrite existing assets", default: false },
      },
    },
  },
  {
    name: "vault_read",
    description: "Read a UTF-8 file from a vault. Path is relative to the vault root.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        path: { type: "string", description: "Path relative to vault root (e.g. 'wiki/index.md')" },
      },
      required: ["path"],
    },
  },
  {
    name: "vault_write",
    description:
      "Write or overwrite a UTF-8 file in a vault. Creates parent directories. Auto-commits if the vault is a git repo and auto_commit is enabled.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        path: { type: "string", description: "Path relative to vault root" },
        content: { type: "string" },
        commit_message: { type: "string", description: "Optional summary for the auto-commit" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "vault_list",
    description: "List entries (files and dirs) under a vault path. Recursive optional.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        path: { type: "string", description: "Path relative to vault root", default: "." },
        recursive: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "vault_search",
    description:
      "Search vault for a substring across filenames and file contents. Returns up to 50 matches with file:line previews.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        query: { type: "string", description: "Substring (case-insensitive)" },
        glob: { type: "string", description: "Limit to files matching this prefix (e.g. 'wiki/')", default: "" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_active",
    description: "Show all configured vaults and which is active. With `set`, switches the active vault.",
    inputSchema: {
      type: "object",
      properties: {
        set: { type: "string", description: "Optional: name or path of vault to make active" },
      },
    },
  },
];

export async function callVaultTool(
  cfg: VaultConfig,
  name: string,
  args: Record<string, unknown>,
) {
  switch (name) {
    case "vault_scaffold":
      return scaffold(cfg, args);
    case "vault_read":
      return readFile(cfg, args);
    case "vault_write":
      return writeFile(cfg, args);
    case "vault_list":
      return listEntries(cfg, args);
    case "vault_search":
      return search(cfg, args);
    case "vault_active":
      return active(cfg, args);
    default:
      throw new Error(`Unknown vault tool: ${name}`);
  }
}

async function scaffold(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const overwrite = Boolean(args.overwrite);

  const created: string[] = [];
  const skipped: string[] = [];
  const kb = kbDir(vault);

  // Copy WIKI.md to vault root
  await copyAsset("WIKI.md", path.join(kb, "WIKI.md"), overwrite, created, skipped);

  // Create KB subdirs at vault root
  for (const dir of ["wiki", ".raw", ".vault-meta"]) {
    const target = path.join(kb, dir);
    if (!fs.existsSync(target)) {
      await fsp.mkdir(target, { recursive: true });
      created.push(`${dir}/`);
    } else {
      skipped.push(`${dir}/`);
    }
  }

  // Seed wiki/index.md and wiki/hot.md
  const indexPath = path.join(kb, "wiki", "index.md");
  if (!fs.existsSync(indexPath) || overwrite) {
    await fsp.writeFile(indexPath, INDEX_TEMPLATE, "utf8");
    created.push("wiki/index.md");
  }
  const hotPath = path.join(kb, "wiki", "hot.md");
  if (!fs.existsSync(hotPath) || overwrite) {
    await fsp.writeFile(hotPath, HOT_TEMPLATE, "utf8");
    created.push("wiki/hot.md");
  }

  // Tell Obsidian not to index plumbing files / non-markdown attachments
  const ignorePath = path.join(vault, ".obsidianignore");
  await fsp.writeFile(ignorePath, OBSIDIAN_IGNORE, "utf8");
  created.push(".obsidianignore");

  const claudeAction = await upsertClaudeMd(vault);
  created.push(`CLAUDE.md (${claudeAction})`);

  await maybeAutoCommit(vault, cfg.autoCommit, "scaffold");

  return textResult(
    `Scaffolded ${vault}\nCreated:\n  ${created.join("\n  ") || "(nothing)"}\n\nSkipped (already present):\n  ${skipped.join("\n  ") || "(nothing)"}`,
  );
}

async function copyAsset(rel: string, dest: string, overwrite: boolean, created: string[], skipped: string[]) {
  const src = path.join(ASSETS_DIR, rel);
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest) && !overwrite) {
    skipped.push(rel);
    return;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  created.push(rel);
}

async function copyDir(src: string, dest: string, overwrite: boolean, created: string[], skipped: string[]) {
  if (!fs.existsSync(src)) return;
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d, overwrite, created, skipped);
    } else {
      const rel = path.relative(ASSETS_DIR, s);
      if (fs.existsSync(d) && !overwrite) {
        skipped.push(rel);
        continue;
      }
      await fsp.copyFile(s, d);
      created.push(rel);
    }
  }
}

async function readFile(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const rel = String(args.path);
  const target = vaultPath(vault, rel);
  if (!fs.existsSync(target)) throw new Error(`File not found: ${rel}`);
  const content = await fsp.readFile(target, "utf8");
  log("vault_read", `${path.basename(vault)} ${rel} (${content.length} chars)`);
  return textResult(content);
}

async function writeFile(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const rel = String(args.path);
  const content = String(args.content ?? "");
  const target = vaultPath(vault, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  log("vault_write", `${path.basename(vault)} ${rel} (${content.length} chars)`);

  const summary = (args.commit_message as string | undefined)?.trim() || `update ${rel}`;
  const commit = await maybeAutoCommit(vault, cfg.autoCommit, summary);
  return textResult(`Wrote ${rel} (${content.length} chars)${commit ? `\nCommit: ${commit}` : ""}`);
}

async function listEntries(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const rel = String(args.path ?? ".");
  const recursive = Boolean(args.recursive);
  const target = vaultPath(vault, rel);

  if (!fs.existsSync(target)) throw new Error(`Path not found: ${rel}`);

  const lines: string[] = [];
  await walk(target, vault, recursive, lines);
  return textResult(lines.join("\n") || "(empty)");
}

async function walk(dir: string, vault: string, recursive: boolean, lines: string[]) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(vault, full);
    lines.push(e.isDirectory() ? `${rel}/` : rel);
    if (recursive && e.isDirectory()) await walk(full, vault, recursive, lines);
  }
}

async function search(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const query = String(args.query ?? "").toLowerCase();
  const prefix = String(args.glob ?? "");
  if (!query) throw new Error("query is required");

  const matches: string[] = [];
  await searchDir(vault, vault, prefix, query, matches);
  log("vault_search", `${path.basename(vault)} query="${query}" → ${matches.length} match(es)`);
  return textResult(matches.slice(0, 50).join("\n") || `No matches for "${query}"`);
}

async function searchDir(dir: string, vault: string, prefix: string, query: string, matches: string[]) {
  if (matches.length >= 50) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "obsidian") continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(vault, full);
    if (e.isDirectory()) {
      await searchDir(full, vault, prefix, query, matches);
      continue;
    }
    if (prefix && !rel.startsWith(prefix)) continue;
    if (e.name.toLowerCase().includes(query)) {
      matches.push(`${rel} [filename match]`);
      continue;
    }
    if (!/\.(md|canvas|txt)$/i.test(e.name)) continue;
    try {
      const body = await fsp.readFile(full, "utf8");
      const lower = body.toLowerCase();
      const idx = lower.indexOf(query);
      if (idx === -1) continue;
      const lineNo = body.slice(0, idx).split("\n").length;
      const line = body.split("\n")[lineNo - 1] ?? "";
      matches.push(`${rel}:${lineNo}: ${line.trim().slice(0, 200)}`);
    } catch {
      // unreadable file, skip
    }
    if (matches.length >= 50) return;
  }
}

async function active(cfg: VaultConfig, args: Record<string, unknown>) {
  const set = (args.set as string | undefined)?.trim();
  if (set) setActiveVault(cfg, set);
  const vaults = listVaults(cfg);
  const lines = vaults.map((v) => `${v.active ? "* " : "  "}${v.name}  ${v.path}`);
  if (vaults.length === 0) lines.push("(no vaults configured — add some in Claude Desktop → Settings → Extensions)");
  const activePath = (() => {
    try {
      return getActiveVault(cfg);
    } catch {
      return "(none)";
    }
  })();
  return textResult(`Active: ${activePath}\n\nVaults:\n${lines.join("\n")}`);
}

const INDEX_TEMPLATE = `# Index

This is the entry point for the wiki. Read this first to orient yourself.

## Domains

(none yet — populate as you add concept and entity pages)

## Recent Sources

(populated by ingest)
`;

const HOT_TEMPLATE = `# Hot Cache

A rolling, ~500-word summary of recent activity. Used by the model to restore context across sessions.

## Last Updated
(uninitialized)

## Key Recent Facts

## Recent Changes

## Active Threads
`;
