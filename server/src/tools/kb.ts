import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ensureVaultExists, kbDir, resolveVault, type VaultConfig } from "../lib/vaults.js";
import { log } from "../lib/log.js";
import { parseFrontmatter, slugify } from "../lib/frontmatter.js";
import { maybeAutoCommit } from "../lib/autocommit.js";
import { textResult } from "./index.js";

export const kbTools: Tool[] = [
  {
    name: "kb_ingest",
    description:
      "Read a source document from .raw/. Returns full content for the model to extract entities, concepts, and write structured knowledge base pages. Does NOT itself write — the model decides what pages to author and uses vault_write.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        source: { type: "string", description: "Filename inside .raw/, e.g. 'meeting-2026-04-29.md'" },
      },
      required: ["source"],
    },
  },
  {
    name: "kb_query",
    description:
      "Search the knowledge base (wiki/) for a query. Returns matched pages with snippets so the model can synthesize an answer.",
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
    name: "kb_search",
    description:
      "Search the knowledge base for pages matching a query. Returns results formatted like a web search — title, wikilink, path, and a one-line snippet — ranked by relevance. When you use these results to answer a question, cite each fact back to its source page (use the `[[stem]]` wikilink shown in the result, or the full path).",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "kb_lint",
    description:
      "Return a structural snapshot of the knowledge base: page count, link graph (in/out counts), orphans (pages with zero backlinks), and broken links. The model uses this to suggest cleanups.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
      },
    },
  },
  {
    name: "kb_reindex",
    description:
      "Rebuild wiki/index.md (slim domain map) and wiki/index/<domain>.md (per-domain page lists) from a frontmatter scan. Idempotent — call after creating, moving, or deleting wiki pages.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
      },
    },
  },
];

export async function callKbTool(cfg: VaultConfig, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "kb_ingest":
      return ingest(cfg, args);
    case "kb_query":
      return query(cfg, args);
    case "kb_search":
      return search(cfg, args);
    case "kb_lint":
      return lint(cfg, args);
    case "kb_reindex":
      return reindex(cfg, args);
    default:
      throw new Error(`Unknown kb tool: ${name}`);
  }
}

async function ingest(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const source = String(args.source ?? "");
  if (!source) throw new Error("source is required");
  const target = path.join(kbDir(vault), ".raw", source);
  if (!fs.existsSync(target)) throw new Error(`Source not found in .raw/: ${source}`);
  const content = await fsp.readFile(target, "utf8");
  log("kb_ingest", `${path.basename(vault)} source=${source} (${content.length} chars)`);
  return textResult(`# Source: ${source}\n# Path: .raw/${source}\n# Length: ${content.length} chars\n\n${content}`);
}

async function query(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const q = String(args.query ?? "").toLowerCase();
  const limit = Number(args.limit ?? 20);
  if (!q) throw new Error("query is required");

  const wikiDir = path.join(kbDir(vault), "wiki");
  if (!fs.existsSync(wikiDir)) throw new Error("No wiki/ folder yet — run vault_scaffold first");

  const hits: Array<{ file: string; line: number; snippet: string }> = [];
  await scan(wikiDir, vault, q, hits, limit);

  log("kb_query", `${path.basename(vault)} query="${q}" → ${hits.length} hit(s)`);
  if (hits.length === 0) return textResult(`No matches for "${q}" in wiki/`);
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

async function search(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const q = String(args.query ?? "").toLowerCase().trim();
  const limit = Math.min(Number(args.limit ?? 10), 20);
  if (!q) throw new Error("query is required");

  const wikiDir = path.join(kbDir(vault), "wiki");
  if (!fs.existsSync(wikiDir)) throw new Error("No wiki/ folder yet — run vault_scaffold first");

  // Collect all wiki .md files
  const allFiles: string[] = [];
  await collect(wikiDir, allFiles);

  // Score each file: count occurrences of query terms, weight by position
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ file: string; score: number; snippet: string; title: string }> = [];

  for (const f of allFiles) {
    if (!/\.md$/i.test(f)) continue;
    const body = await fsp.readFile(f, "utf8");
    const lower = body.toLowerCase();
    let score = 0;
    for (const term of terms) {
      let pos = 0;
      while ((pos = lower.indexOf(term, pos)) !== -1) {
        // Higher weight for matches in first 500 chars (frontmatter + title)
        score += pos < 500 ? 3 : 1;
        pos += term.length;
      }
    }
    if (score === 0) continue;

    const fm = parseFrontmatter(body);
    const title = String(fm.title || path.basename(f, ".md"));

    // Best snippet: find the line with the most term matches
    const lines = body.split("\n").filter((l) => !l.startsWith("---") && l.trim());
    let bestLine = "";
    let bestLineScore = 0;
    for (const line of lines) {
      const ll = line.toLowerCase();
      let ls = 0;
      for (const t of terms) { if (ll.includes(t)) ls++; }
      if (ls > bestLineScore) { bestLineScore = ls; bestLine = line.trim(); }
    }
    const snippet = bestLine.replace(/^\s*[-#*>]+\s*/, "").slice(0, 140);

    scored.push({ file: f, score, snippet, title });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  log("kb_search", `${path.basename(vault)} query="${q}" → ${top.length} result(s)`);

  if (top.length === 0) return textResult(`No results for "${q}" in wiki/`);

  const lines = top.map((r, i) => {
    const rel = path.relative(vault, r.file).replace(/\\/g, "/");
    const stem = path.basename(r.file, ".md");
    return `${i + 1}. **${r.title}** [[${stem}]]\n   ${rel}\n   ${r.snippet || "(no snippet)"}`;
  });

  return textResult(
    `Search results for "${q}" (${top.length}):\n\n${lines.join("\n\n")}\n\n` +
    `When you use any of the above to answer, cite the source page using its [[stem]] wikilink or full path.`,
  );
}

// Vault subtrees we never treat as wiki link targets — git internals, node deps,
// macOS metadata. Anything else (PDFs in .raw/, images, attachments) is fair game.
const VAULT_LINK_IGNORE = new Set([".git", "node_modules", ".vault-meta"]);

async function collectAll(dir: string, vault: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const rel = path.relative(vault, full);
      const top = rel.split(path.sep)[0];
      if (VAULT_LINK_IGNORE.has(top) || e.name === ".DS_Store") continue;
      await collectAll(full, vault, out);
    } else {
      if (e.name === ".DS_Store") continue;
      out.push(full);
    }
  }
}

async function lint(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const wikiDir = path.join(kbDir(vault), "wiki");
  if (!fs.existsSync(wikiDir)) throw new Error("No wiki/ folder yet — run vault_scaffold first");

  // Pages = markdown files under wiki/. These are what we compute orphans for.
  const pages = new Map<string, { outbound: Set<string>; inbound: Set<string> }>();
  const wikiFiles: string[] = [];
  await collect(wikiDir, wikiFiles);
  for (const f of wikiFiles) {
    if (!/\.md$/i.test(f)) continue;
    const stem = path.basename(f, path.extname(f));
    pages.set(stem, { outbound: new Set(), inbound: new Set() });
  }

  // Valid link targets = everything else in the vault (attachments, sources,
  // PDFs, images). Wikilinks can address them by stem ([[diagram]] → diagram.png)
  // or by full filename ([[diagram.png]]).
  const validStems = new Set<string>(pages.keys());
  const validFilenames = new Set<string>();
  const vaultFiles: string[] = [];
  await collectAll(vault, vault, vaultFiles);
  for (const f of vaultFiles) {
    const base = path.basename(f);
    const stem = path.basename(f, path.extname(f));
    validStems.add(stem);
    validFilenames.add(base);
  }

  const linkRe = /\[\[([^\]|#]+)/g;
  for (const f of wikiFiles) {
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
      if (validStems.has(t) || validFilenames.has(t)) continue;
      broken.push({ from: name, to: t });
    }
  }

  log("kb_lint", `${path.basename(vault)} pages=${total} orphans=${orphans.length} broken=${broken.length}`);
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

interface PageRecord {
  rel: string;
  stem: string;
  type: string;
  domain: string;
  title: string;
}

const META_BASENAMES = new Set(["index.md", "log.md", "hot.md", "overview.md", "README.md"]);

async function reindex(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const wikiDir = path.join(kbDir(vault), "wiki");
  if (!fs.existsSync(wikiDir)) throw new Error("No wiki/ folder yet — run vault_scaffold first");

  const indexDir = path.join(wikiDir, "index");
  await fsp.mkdir(indexDir, { recursive: true });

  const allFiles: string[] = [];
  await collect(wikiDir, allFiles);

  const pages: PageRecord[] = [];
  for (const full of allFiles) {
    if (!/\.md$/i.test(full)) continue;
    const rel = path.relative(wikiDir, full).replace(/\\/g, "/");

    // Skip generated/meta files
    if (META_BASENAMES.has(path.basename(rel))) continue;
    if (rel.startsWith("index/")) continue;

    const body = await fsp.readFile(full, "utf8");
    const fm = parseFrontmatter(body);
    if (!fm.type || fm.type === "meta") continue;

    const stem = path.basename(rel, ".md");
    const title = fm.title || stem;
    const domain = (fm.domain && slugify(fm.domain)) || "_global";
    pages.push({ rel, stem, type: fm.type, domain, title });
  }

  // Group by domain → type → pages
  const byDomain = new Map<string, Map<string, PageRecord[]>>();
  for (const p of pages) {
    if (!byDomain.has(p.domain)) byDomain.set(p.domain, new Map());
    const byType = byDomain.get(p.domain)!;
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type)!.push(p);
  }

  // Wipe + rewrite per-domain sub-indexes
  for (const entry of await fsp.readdir(indexDir).catch(() => [])) {
    if (entry.endsWith(".md")) await fsp.rm(path.join(indexDir, entry)).catch(() => {});
  }
  for (const [domain, byType] of byDomain) {
    const lines: string[] = [
      `---`,
      `type: meta`,
      `title: "${domain} Index"`,
      `domain: ${domain}`,
      `---`,
      ``,
      `# ${domain}`,
      ``,
      `Generated by \`kb_reindex\`. ${pages.filter((p) => p.domain === domain).length} page(s).`,
      ``,
    ];
    const orderedTypes = ["domain", "concept", "entity", "source", "comparison", "question"];
    const sortedTypes = [
      ...orderedTypes.filter((t) => byType.has(t)),
      ...[...byType.keys()].filter((t) => !orderedTypes.includes(t)).sort(),
    ];
    for (const t of sortedTypes) {
      const ps = byType.get(t)!.slice().sort((a, b) => a.title.localeCompare(b.title));
      lines.push(`## ${t.charAt(0).toUpperCase() + t.slice(1)}s`);
      for (const p of ps) lines.push(`- [[${p.stem}]] — ${p.title}`);
      lines.push(``);
    }
    await fsp.writeFile(path.join(indexDir, `${domain}.md`), lines.join("\n"), "utf8");
  }

  // Rewrite slim master index
  const domainNames = [...byDomain.keys()].sort();
  const masterLines: string[] = [
    `---`,
    `type: meta`,
    `title: Index`,
    `---`,
    ``,
    `# Index`,
    ``,
    `Slim master index — lists domains only. For pages within a domain, read \`wiki/index/<domain>.md\`. Run \`kb_reindex\` to rebuild.`,
    ``,
    `## Domains`,
    ``,
  ];
  if (domainNames.length === 0) {
    masterLines.push(`(none yet)`);
  } else {
    for (const d of domainNames) {
      const count = pages.filter((p) => p.domain === d).length;
      masterLines.push(`- [[index/${d}|${d}]] — ${count} page(s)`);
    }
  }
  masterLines.push(``);
  await fsp.writeFile(path.join(wikiDir, "index.md"), masterLines.join("\n"), "utf8");

  log("kb_reindex", `${path.basename(vault)} pages=${pages.length} domains=${domainNames.length}`);
  await maybeAutoCommit(vault, cfg.autoCommit, `reindex: ${pages.length} pages across ${domainNames.length} domain(s)`);

  return textResult(
    `Reindexed ${pages.length} page(s) across ${domainNames.length} domain(s):\n  ${
      domainNames.map((d) => `${d} (${pages.filter((p) => p.domain === d).length})`).join(", ") || "(none)"
    }`,
  );
}
