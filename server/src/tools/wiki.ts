import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ensureVaultExists, kbDir, resolveVault, type VaultConfig } from "../lib/vaults.js";
import { textResult } from "./index.js";

export const wikiTools: Tool[] = [
  {
    name: "wiki_ingest",
    description:
      "Read a source document from .obsidian/.raw/. Returns full content for the model to extract entities, concepts, and write structured wiki pages. Does NOT itself write — the model decides what pages to author and uses vault_write.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        source: { type: "string", description: "Filename inside .obsidian/.raw/, e.g. 'meeting-2026-04-29.md'" },
      },
      required: ["source"],
    },
  },
  {
    name: "wiki_query",
    description:
      "Search .obsidian/wiki/ for a query. Returns matched pages with snippets so the model can synthesize an answer.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "wiki_lint",
    description:
      "Return a structural snapshot of the wiki: page count, link graph (in/out counts), orphans (pages with zero backlinks), and broken links. The model uses this to suggest cleanups.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
      },
    },
  },
];

export async function callWikiTool(cfg: VaultConfig, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "wiki_ingest":
      return ingest(cfg, args);
    case "wiki_query":
      return query(cfg, args);
    case "wiki_lint":
      return lint(cfg, args);
    default:
      throw new Error(`Unknown wiki tool: ${name}`);
  }
}

async function ingest(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const source = String(args.source ?? "");
  if (!source) throw new Error("source is required");
  const target = path.join(kbDir(vault), ".raw", source);
  if (!fs.existsSync(target)) throw new Error(`Source not found in .obsidian/.raw/: ${source}`);
  const content = await fsp.readFile(target, "utf8");
  return textResult(`# Source: ${source}\n# Path: .obsidian/.raw/${source}\n# Length: ${content.length} chars\n\n${content}`);
}

async function query(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const q = String(args.query ?? "").toLowerCase();
  const limit = Number(args.limit ?? 20);
  if (!q) throw new Error("query is required");

  const wikiDir = path.join(kbDir(vault), "wiki");
  if (!fs.existsSync(wikiDir)) throw new Error("No .obsidian/wiki/ folder yet — run vault_scaffold first");

  const hits: Array<{ file: string; line: number; snippet: string }> = [];
  await scan(wikiDir, vault, q, hits, limit);

  if (hits.length === 0) return textResult(`No matches for "${q}" in .obsidian/wiki/`);
  const lines = hits.map((h) => `${h.file}:${h.line}: ${h.snippet}`);
  return textResult(`Matches for "${q}" (${hits.length}):\n\n${lines.join("\n")}`);
}

async function scan(
  dir: string,
  vault: string,
  q: string,
  hits: Array<{ file: string; line: number; snippet: string }>,
  limit: number,
) {
  if (hits.length >= limit) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (hits.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await scan(full, vault, q, hits, limit);
      continue;
    }
    if (!/\.md$/i.test(e.name)) continue;
    const body = await fsp.readFile(full, "utf8");
    const lower = body.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    const lineNo = body.slice(0, idx).split("\n").length;
    const line = body.split("\n")[lineNo - 1] ?? "";
    hits.push({
      file: path.relative(vault, full),
      line: lineNo,
      snippet: line.trim().slice(0, 200),
    });
  }
}

async function lint(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const wikiDir = path.join(kbDir(vault), "wiki");
  if (!fs.existsSync(wikiDir)) throw new Error("No .obsidian/wiki/ folder yet — run vault_scaffold first");

  const pages = new Map<string, { outbound: Set<string>; inbound: Set<string> }>();

  const allFiles: string[] = [];
  await collect(wikiDir, allFiles);
  for (const f of allFiles) {
    if (!/\.md$/i.test(f)) continue;
    const stem = path.basename(f, path.extname(f));
    pages.set(stem, { outbound: new Set(), inbound: new Set() });
  }

  const linkRe = /\[\[([^\]|#]+)/g;
  for (const f of allFiles) {
    if (!/\.md$/i.test(f)) continue;
    const stem = path.basename(f, path.extname(f));
    const body = await fsp.readFile(f, "utf8");
    const node = pages.get(stem)!;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(body)) !== null) {
      const target = m[1].trim();
      node.outbound.add(target);
      const targetNode = pages.get(target);
      if (targetNode) targetNode.inbound.add(stem);
    }
  }

  const total = pages.size;
  const orphans: string[] = [];
  const broken: Array<{ from: string; to: string }> = [];
  for (const [name, node] of pages) {
    if (node.inbound.size === 0 && name !== "index" && name !== "hot") orphans.push(name);
    for (const t of node.outbound) {
      if (!pages.has(t)) broken.push({ from: name, to: t });
    }
  }

  const lines = [
    `# Lint report — ${path.basename(vault)}`,
    `Pages: ${total}`,
    `Orphans (no inbound links, excl. index/hot): ${orphans.length}`,
    orphans.length ? `  ${orphans.slice(0, 30).join(", ")}` : "",
    `Broken links: ${broken.length}`,
    ...broken.slice(0, 30).map((b) => `  ${b.from} → ${b.to}`),
  ].filter(Boolean);
  return textResult(lines.join("\n"));
}

async function collect(dir: string, out: string[]) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collect(full, out);
    else out.push(full);
  }
}
