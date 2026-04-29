import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

export interface VaultConfig {
  vaults: string[];
  active: string | null;
  autoCommit: boolean;
  autoWatch: boolean;
  autoLint: boolean;
  autoLintIntervalHours: number;
  openBrowser: boolean;
}

export function loadConfigFromArgv(argv: string[]): VaultConfig {
  const vaults = argv
    .slice(2)
    .map((p) => path.resolve(p))
    .filter((p) => p.length > 0);

  const autoCommitRaw = process.env.OBSIDIAN_AUTO_COMMIT ?? "true";
  const autoCommit = !["0", "false", "no", "off"].includes(autoCommitRaw.toLowerCase());
  const autoWatchRaw = process.env.OBSIDIAN_AUTO_WATCH ?? "false";
  const autoWatch = ["1", "true", "yes", "on"].includes(autoWatchRaw.toLowerCase());
  const autoLintRaw = process.env.OBSIDIAN_AUTO_LINT ?? "false";
  const autoLint = ["1", "true", "yes", "on"].includes(autoLintRaw.toLowerCase());
  const autoLintIntervalHours = Math.max(1, Number(process.env.OBSIDIAN_AUTO_LINT_INTERVAL_HOURS ?? "6") || 6);
  const openBrowserRaw = process.env.OBSIDIAN_OPEN_BROWSER ?? "false";
  const openBrowser = ["1", "true", "yes", "on"].includes(openBrowserRaw.toLowerCase());

  const active: string | null = vaults.length > 0 ? vaults[0] : null;

  return { vaults, active, autoCommit, autoWatch, autoLint, autoLintIntervalHours, openBrowser };
}

let runtimeActive: string | null = null;

export function getActiveVault(cfg: VaultConfig): string {
  const candidate = runtimeActive ?? cfg.active;
  if (!candidate) {
    throw new Error(
      "No vault configured. Open Claude Desktop → Settings → Extensions → Local Knowledge Base and add at least one vault directory.",
    );
  }
  return candidate;
}

export function setActiveVault(cfg: VaultConfig, nameOrPath: string): string {
  const resolved = resolveVault(cfg, nameOrPath);
  runtimeActive = resolved;
  return resolved;
}

export function resolveVault(cfg: VaultConfig, nameOrPath?: string): string {
  if (!nameOrPath) return getActiveVault(cfg);

  const direct = path.resolve(nameOrPath);
  if (cfg.vaults.includes(direct)) return direct;

  const byName = cfg.vaults.find((v) => path.basename(v) === nameOrPath);
  if (byName) return byName;

  throw new Error(
    `Vault "${nameOrPath}" not configured. Configured vaults: ${cfg.vaults.map((v) => path.basename(v)).join(", ") || "(none)"}`,
  );
}

export function vaultPath(vault: string, relative: string): string {
  const target = path.resolve(vault, relative);
  const root = path.resolve(vault);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path "${relative}" escapes vault root "${vault}"`);
  }
  return target;
}

/** Root of the KB — wiki/, .raw/, .vault-meta/ live directly in the vault. */
export function kbDir(vault: string): string {
  return vault;
}

/** Resolve a path relative to the vault root, with escape guard. */
export function kbPath(vault: string, relative: string): string {
  const kb = kbDir(vault);
  const target = path.resolve(kb, relative);
  if (target !== kb && !target.startsWith(kb + path.sep)) {
    throw new Error(`Path "${relative}" escapes knowledge base root`);
  }
  return target;
}

export function ensureVaultExists(vault: string): void {
  if (!fs.existsSync(vault)) {
    throw new Error(`Vault directory does not exist: ${vault}`);
  }
  const stat = fs.statSync(vault);
  if (!stat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vault}`);
  }
}

export function listVaults(cfg: VaultConfig): Array<{ name: string; path: string; active: boolean }> {
  const active = runtimeActive ?? cfg.active;
  return cfg.vaults.map((v) => ({
    name: path.basename(v),
    path: v,
    active: v === active,
  }));
}

/**
 * Idempotent: ensure wiki/, .raw/, .vault-meta/ exist at the vault root
 * and seed WIKI.md, wiki/index.md, wiki/hot.md if missing. Called by the watcher on startup.
 */
export async function ensureKBScaffolded(vault: string): Promise<void> {
  const name = path.basename(vault);
  const kb = kbDir(vault);
  const assetsDir = fileURLToPath(new URL("../../../assets/", import.meta.url));

  for (const dir of ["wiki", "wiki/index", ".raw", ".vault-meta"]) {
    const target = path.join(kb, dir);
    const existed = fs.existsSync(target);
    await fsp.mkdir(target, { recursive: true });
    if (!existed) log("scaffold", `created ${dir}/ (${name})`);
  }

  const wikiMdDest = path.join(kb, "WIKI.md");
  if (!fs.existsSync(wikiMdDest)) {
    const wikiMdSrc = path.join(assetsDir, "WIKI.md");
    if (fs.existsSync(wikiMdSrc)) {
      await fsp.copyFile(wikiMdSrc, wikiMdDest);
      log("scaffold", `seeded WIKI.md (${name})`);
    }
  }

  const indexPath = path.join(kb, "wiki", "index.md");
  if (!fs.existsSync(indexPath)) {
    await fsp.writeFile(indexPath, KB_INDEX_TEMPLATE, "utf8");
    log("scaffold", `seeded wiki/index.md (${name})`);
  }

  const hotPath = path.join(kb, "wiki", "hot.md");
  if (!fs.existsSync(hotPath)) {
    await fsp.writeFile(hotPath, KB_HOT_TEMPLATE, "utf8");
    log("scaffold", `seeded wiki/hot.md (${name})`);
  }

  const obsidianIgnorePath = path.join(vault, ".obsidianignore");
  await fsp.writeFile(obsidianIgnorePath, OBSIDIAN_IGNORE, "utf8");
  log("scaffold", `wrote .obsidianignore (${name})`);

  await upsertClaudeMd(vault);
}

const KB_INDEX_TEMPLATE = `---
type: meta
title: Index
---

# Index

Slim master index — lists domains only. For pages within a domain, read \`wiki/index/<domain>.md\`.

## Domains

(none yet — \`kb_reindex\` populates this from frontmatter scan)
`;

const KB_HOT_TEMPLATE = `---
type: meta
title: Hot Cache
---

# Hot Cache

A rolling, ~500-word summary of recent activity. Used by the model to restore context across sessions.

## Last Updated
(uninitialized)

## Key Recent Facts

## Recent Changes

## Active Threads
`;

// Hides plumbing files from Obsidian's graph/search while keeping concept pages visible.
export const OBSIDIAN_IGNORE = `wiki/hot.md
wiki/log.md
wiki/index.md
wiki/index/
wiki/**/_index.md
WIKI.md
.raw
.vault-meta
`;

const CLAUDE_WIKI_START = "<!-- wiki-kb:start -->";
const CLAUDE_WIKI_END = "<!-- wiki-kb:end -->";

const CLAUDE_WIKI_SECTION = `${CLAUDE_WIKI_START}
## Wiki Knowledge Base

This vault has a persistent, Claude-maintained wiki at \`wiki/\`.

**At the start of every session**, orient yourself:
1. Read \`wiki/hot.md\` — rolling ~500-word context summary
2. Read \`wiki/index.md\` — slim domain map (always small)
3. For a specific domain, read \`wiki/index/<domain>.md\`
4. Use \`kb_query\` to find specific pages — don't browse the tree

**Structure**
- \`wiki/<type>/<domain>/<slug>.md\` — every page lives at this depth (type ∈ concepts, entities, sources, domains, comparisons, questions, meta)
- \`wiki/index.md\` — slim master, lists domains only
- \`wiki/index/<domain>.md\` — per-domain page list, generated by \`kb_reindex\`
- \`.raw/\` — source documents (drop files here to ingest; never modify)
- \`WIKI.md\` — schema reference

**Operations**
- Ingest: drop a file into the vault — the watcher ingests it automatically
- Query: \`kb_query\` first, then read 3–5 pages
- Lint: "lint the wiki" — runs \`kb_lint\` for orphans and broken links
- Reindex: "reindex" — runs \`kb_reindex\` to rebuild master + sub-indexes

**Skills**
- \`/kb-query\` — ask any question about the knowledge base
- \`/kb-view\` — browse the knowledge base like Wikipedia
- \`/save\` — file the current conversation into the knowledge base
- \`/kb-ingest\` — manually ingest a source from .raw/
- \`/kb-lint\` — health check (orphans, broken links)
- \`/kb-reindex\` — rebuild indexes from frontmatter
${CLAUDE_WIKI_END}`;

const CLAUDE_MD_FRESH = `# Wiki Vault

${CLAUDE_WIKI_SECTION}
`;

export async function upsertClaudeMd(vault: string): Promise<"created" | "updated"> {
  const dest = path.join(vault, "CLAUDE.md");
  const name = path.basename(vault);

  if (!fs.existsSync(dest)) {
    await fsp.writeFile(dest, CLAUDE_MD_FRESH, "utf8");
    log("scaffold", `created CLAUDE.md (${name})`);
    return "created";
  }

  const existing = await fsp.readFile(dest, "utf8");
  const startIdx = existing.indexOf(CLAUDE_WIKI_START);
  const endIdx = existing.indexOf(CLAUDE_WIKI_END);

  let next: string;
  if (startIdx !== -1 && endIdx !== -1) {
    next =
      existing.slice(0, startIdx) +
      CLAUDE_WIKI_SECTION +
      existing.slice(endIdx + CLAUDE_WIKI_END.length);
  } else {
    next = existing.trimEnd() + "\n\n" + CLAUDE_WIKI_SECTION + "\n";
  }

  await fsp.writeFile(dest, next, "utf8");
  log("scaffold", `updated CLAUDE.md (${name})`);
  return "updated";
}
