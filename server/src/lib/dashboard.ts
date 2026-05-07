import { spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, subscribeDashboard, getLogLines, subscribeLogLine, appendLog, getMaintenanceEnabled, setMaintenanceEnabled, cancelJob, retryJob, getMaxRetries, setMaxRetries, getRetryOnFailure, setRetryOnFailure, type DashboardSnapshot } from "./watcher.js";
import { resolveClaudeBin } from "./claude-bin.js";
import { parseFrontmatter } from "./frontmatter.js";
import { log } from "./log.js";
import type { VaultConfig } from "./vaults.js";
import { getWikiIndex, extractTopics, findMatchingPages } from "./wiki-index.js";

const DEFAULT_PORT = 3737;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function resolveStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../dashboard/out"),
    path.resolve(here, "../../../dashboard/out"),
    path.resolve(here, "../dashboard/out"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return null;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

let server: http.Server | null = null;
let activeCfg: VaultConfig | null = null;

function getVaultPath(): string | null {
  return activeCfg?.active ?? null;
}

// ── Wiki API helpers ────────────────────────────────────────────────────────

async function collectMdFiles(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectMdFiles(full, out);
    else if (/\.md$/i.test(e.name)) out.push(full);
  }
}

interface WikiPageMeta {
  path: string;   // relative to vault root, e.g. "wiki/concepts/clearance/risk.md"
  stem: string;   // basename without extension
  title: string;
  domain: string;
  type: string;
}

async function listWikiPages(vault: string): Promise<WikiPageMeta[]> {
  const wikiDir = path.join(vault, "wiki");
  if (!fs.existsSync(wikiDir)) return [];
  const files: string[] = [];
  await collectMdFiles(wikiDir, files);
  const pages: WikiPageMeta[] = [];
  for (const f of files) {
    const rel = path.relative(vault, f).replace(/\\/g, "/");
    const content = await fsp.readFile(f, "utf8").catch(() => "");
    const fm = parseFrontmatter(content);
    const stem = path.basename(f, ".md");
    pages.push({
      path: rel,
      stem,
      title: (fm.title as string) || stem,
      domain: (fm.domain as string) || "_global",
      type: (fm.type as string) || "",
    });
  }
  return pages;
}

function safeWikiPath(vault: string, requested: string): string | null {
  if (!requested) return null;
  const decoded = decodeURIComponent(requested);
  const full = path.resolve(vault, decoded);
  const wikiRoot = path.resolve(vault, "wiki");
  if (full !== wikiRoot && !full.startsWith(wikiRoot + path.sep)) return null;
  if (!full.endsWith(".md")) return null;
  return full;
}

// Anywhere-in-vault path validation used by /api/wiki/open. Wikilinks can point
// to attachments (PDFs in .raw/, images, etc.), not just wiki/*.md, so this
// only enforces the escape guard, not the wiki/.md restriction.
const VAULT_OPEN_IGNORE = new Set([".git", "node_modules"]);

function safeVaultPath(vault: string, requested: string): string | null {
  if (!requested) return null;
  const decoded = decodeURIComponent(requested);
  const full = path.resolve(vault, decoded);
  const root = path.resolve(vault);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, full);
  const top = rel.split(path.sep)[0];
  if (VAULT_OPEN_IGNORE.has(top)) return null;
  return full;
}

async function findByStem(vault: string, stem: string): Promise<string | null> {
  // Try direct path first (handles path-style wikilinks like "index/clearance")
  const directPath = path.join(vault, "wiki", stem.replace(/\//g, path.sep) + ".md");
  if (fs.existsSync(directPath)) {
    return path.relative(vault, directPath).replace(/\\/g, "/");
  }
  // Fall back to basename search
  const wikiDir = path.join(vault, "wiki");
  if (!fs.existsSync(wikiDir)) return null;
  const files: string[] = [];
  await collectMdFiles(wikiDir, files);
  const match = files.find((f) => path.basename(f, ".md") === stem);
  if (!match) return null;
  return path.relative(vault, match).replace(/\\/g, "/");
}

// Whole-vault stem/filename resolver for /api/wiki/open. Wiki pages can link
// to any file in the vault — attachments, PDFs in .raw/, images — not just
// wiki/*.md, so try the md-page resolver first (cheap, hits the common case)
// and fall back to a vault-wide scan that matches by stem or full filename.
async function collectAllVaultFiles(dir: string, vault: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const rel = path.relative(vault, full);
      const top = rel.split(path.sep)[0];
      if (VAULT_OPEN_IGNORE.has(top) || e.name === ".DS_Store") continue;
      await collectAllVaultFiles(full, vault, out);
    } else if (e.name !== ".DS_Store") {
      out.push(full);
    }
  }
}

async function findFileInVault(vault: string, target: string): Promise<string | null> {
  const md = await findByStem(vault, target);
  if (md) return md;
  const files: string[] = [];
  await collectAllVaultFiles(vault, vault, files);
  const byFilename = files.find((f) => path.basename(f) === target);
  if (byFilename) return path.relative(vault, byFilename).replace(/\\/g, "/");
  const byStem = files.find((f) => path.basename(f, path.extname(f)) === target);
  if (byStem) return path.relative(vault, byStem).replace(/\\/g, "/");
  return null;
}

interface SearchResult {
  path: string;
  title: string;
  snippet: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchWiki(vault: string, query: string): Promise<SearchResult[]> {
  const t0 = Date.now();
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const wikiDir = path.join(vault, "wiki");
  if (!fs.existsSync(wikiDir)) {
    appendLog("search", `no wiki/ dir at ${wikiDir}`);
    return [];
  }

  const files: string[] = [];
  await collectMdFiles(wikiDir, files);

  interface Scored { result: SearchResult; score: number; }
  const scored: Scored[] = [];

  for (const f of files) {
    const content = await fsp.readFile(f, "utf8").catch(() => "");
    if (!content) continue;
    const lower = content.toLowerCase();

    // Require all tokens present (AND search)
    if (!tokens.every((t) => lower.includes(t))) continue;

    const fm = parseFrontmatter(content);
    const stem = path.basename(f, ".md");
    const title = (fm.title as string) || stem;
    const titleLower = title.toLowerCase();
    const pathLower = f.toLowerCase();

    // Score: title matches dominate, then filename, then body hit count
    let score = 0;
    for (const t of tokens) {
      if (titleLower.includes(t)) score += 20;
      if (pathLower.includes(t)) score += 5;
      const hits = (lower.match(new RegExp(escapeRegex(t), "g")) || []).length;
      score += Math.min(hits, 8);
    }

    // Snippet: first non-frontmatter line containing any token
    let snippet = "";
    const lines = content.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const ll = trimmed.toLowerCase();
      if (tokens.some((t) => ll.includes(t))) {
        snippet = trimmed.slice(0, 200);
        break;
      }
    }

    const rel = path.relative(vault, f).replace(/\\/g, "/");
    scored.push({ result: { path: rel, title, snippet }, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, 20).map((s) => s.result);

  const elapsed = Date.now() - t0;
  const titlePreview = results.length ? results.slice(0, 3).map((r) => r.title).join(" · ") : "(no results)";
  appendLog(
    "search",
    `scanned=${files.length} matched=${results.length} ${elapsed}ms top=[${titlePreview}]`,
  );
  return results;
}

// ── Graph (nodes + edges from wikilinks) ───────────────────────────────────

interface GraphNode {
  id: string;        // wiki-relative path like "wiki/concepts/foo.md"
  stem: string;      // basename without .md
  title: string;
  domain: string;
  type: string;
  degree: number;    // total connections (in + out)
}

interface GraphEdge {
  source: string;    // node id
  target: string;    // node id
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Convert a .obsidianignore-style pattern to a tester for vault-relative paths.
// Supports: trailing-slash directories, * (no slash), ** (any depth), bare names treated as both files and dir prefixes.
function compileIgnorePattern(raw: string): (rel: string) => boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return () => false;
  const isDir = trimmed.endsWith("/");
  const pattern = isDir ? trimmed.slice(0, -1) : trimmed;

  if (isDir) {
    return (rel) => rel === pattern || rel.startsWith(pattern + "/");
  }
  if (!pattern.includes("*")) {
    // Treat plain entries as both exact file and directory prefix (mirrors gitignore behavior for ".raw", ".vault-meta")
    return (rel) => rel === pattern || rel.startsWith(pattern + "/");
  }
  // Translate glob → regex. ** = any chars including /, * = anything but /
  const re = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DS::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DS::/g, ".*") + "$";
  const compiled = new RegExp(re);
  return (rel) => compiled.test(rel);
}

async function loadObsidianIgnore(vault: string): Promise<((rel: string) => boolean)[]> {
  const file = path.join(vault, ".obsidianignore");
  try {
    const text = await fsp.readFile(file, "utf8");
    return text.split(/\r?\n/).map(compileIgnorePattern);
  } catch {
    return [];
  }
}

async function buildGraph(vault: string): Promise<GraphData> {
  const wikiDir = path.join(vault, "wiki");
  if (!fs.existsSync(wikiDir)) return { nodes: [], edges: [] };

  const files: string[] = [];
  await collectMdFiles(wikiDir, files);

  const ignoreTests = await loadObsidianIgnore(vault);
  const isIgnored = (rel: string) => ignoreTests.some((t) => t(rel));

  // First pass: gather page metadata, build stem → path index
  interface PageInfo { rel: string; stem: string; title: string; domain: string; type: string; content: string; }
  const pages: PageInfo[] = [];
  const stemIndex = new Map<string, string>();   // stem → rel
  const pathIndex = new Map<string, string>();   // rel-without-ext (e.g. "index/clearance") → rel

  for (const f of files) {
    const rel = path.relative(vault, f).replace(/\\/g, "/");
    if (isIgnored(rel)) continue;
    const content = await fsp.readFile(f, "utf8").catch(() => "");
    if (!content) continue;
    const fm = parseFrontmatter(content);
    const stem = path.basename(f, ".md");
    const title = (fm.title as string) || stem;
    const domain = (fm.domain as string) || "_global";
    const type = (fm.type as string) || "";
    pages.push({ rel, stem, title, domain, type, content });
    if (!stemIndex.has(stem)) stemIndex.set(stem, rel);
    const noExt = rel.replace(/^wiki\//, "").replace(/\.md$/, "");
    pathIndex.set(noExt, rel);
  }

  // Second pass: extract wikilinks → edges
  const edgeSet = new Set<string>();   // dedupe via "src→dst"
  const edges: GraphEdge[] = [];
  const wikilinkRe = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

  for (const p of pages) {
    // Strip frontmatter so [[]] in metadata doesn't double-count
    const body = p.content.replace(/^---\n[\s\S]*?\n---\n/, "");
    let m: RegExpExecArray | null;
    while ((m = wikilinkRe.exec(body)) !== null) {
      const target = m[1].trim();
      if (!target) continue;
      // Resolve target → rel
      let targetRel: string | undefined = pathIndex.get(target);
      if (!targetRel) targetRel = stemIndex.get(target);
      if (!targetRel) continue;
      if (targetRel === p.rel) continue;       // skip self-links
      const key = `${p.rel}→${targetRel}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: p.rel, target: targetRel });
    }
  }

  // Compute degree for each node
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = pages.map((p) => ({
    id: p.rel,
    stem: p.stem,
    title: p.title,
    domain: p.domain,
    type: p.type,
    degree: degree.get(p.rel) ?? 0,
  }));

  return { nodes, edges };
}

// ── Live notes (real-time KB suggestions from transcript) ──────────────────
//
// The transcript window is searched against an in-memory wiki index (built
// lazily, refreshed every few seconds). Returns categorized bullets in the
// tens-of-milliseconds range — no model spawn, no network round-trip.

interface LiveNoteItem {
  topic: string;   // category the bullet sits under (a phrase from the transcript)
  path: string;    // wiki-relative path, e.g. "wiki/concepts/foo.md"
  title: string;
  bullet: string;  // single-line summary pulled from the page body
}

interface LiveNotesResult {
  topics: string[];
  items: LiveNoteItem[];
}

async function readBody(req: http.IncomingMessage, max = 32_000): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) { req.destroy(); reject(new Error("payload too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function suggestFromTranscript(vault: string, transcript: string): Promise<LiveNotesResult> {
  const t0 = Date.now();
  const safe = transcript.trim().slice(-1500);
  if (!safe) return { topics: [], items: [] };

  const index = await getWikiIndex(vault);
  const tIndex = Date.now() - t0;

  const topics = extractTopics(safe);
  const matches = findMatchingPages(index, topics);

  const items: LiveNoteItem[] = matches.map(({ topic, page }) => ({
    topic,
    path: page.path,
    title: page.title,
    bullet: page.bullet,
  }));

  const topicPreview = topics.length ? topics.slice(0, 4).join(" · ") : "(no topics)";
  appendLog(
    "live-notes",
    `local search: pages=${index.pages.length} topics=[${topicPreview}] matches=${items.length} index=${tIndex}ms total=${Date.now() - t0}ms`,
  );

  return { topics, items };
}

// ── Meeting extraction (Claude-powered) ─────────────────────────────────────

interface MeetingExtract {
  minutes: string[];
  topics: string[];
  actions: string[];
}

async function callClaudeJson<T>(prompt: string): Promise<T> {
  const bin = resolveClaudeBin();
  const args = ["--model", "claude-sonnet-4-6", "--output-format", "json", "-p", prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (buf: Buffer) => chunks.push(buf));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error(`claude exited ${code}`)); return; }
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: string };
        resolve(JSON.parse(raw.result ?? "{}") as T);
      } catch (e) {
        reject(new Error(`parse error: ${e}`));
      }
    });
  });
}

async function extractMeetingData(transcript: string): Promise<MeetingExtract> {
  const prompt = `You are a concise meeting note-taker. Given this transcript, return ONLY a JSON object — no explanation, no markdown fences:
{
  "minutes": ["one sentence per topic discussed, in chronological order"],
  "topics": ["3-6 key nouns or short phrases suitable as knowledge-base search queries"],
  "actions": ["concrete tasks with owner and deadline if stated — empty array if none"]
}

Rules:
- minutes: 3-8 entries, each a single clear past-tense sentence
- topics: nouns/phrases only, no verbs
- actions: only explicit commitments or tasks; omit vague statements

Transcript:
${transcript.slice(-3000)}`;

  try {
    const result = await callClaudeJson<MeetingExtract>(prompt);
    return {
      minutes: Array.isArray(result.minutes) ? result.minutes : [],
      topics:  Array.isArray(result.topics)  ? result.topics  : [],
      actions: Array.isArray(result.actions) ? result.actions : [],
    };
  } catch (e) {
    appendLog("live-notes", `extractMeetingData error: ${e}`);
    return { minutes: [], topics: [], actions: [] };
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startDashboard(cfg: VaultConfig): void {
  activeCfg = cfg;
  const port = parsePort(process.env.OBSIDIAN_DASHBOARD_PORT);
  const staticDir = resolveStaticDir();
  if (!staticDir) {
    log("dashboard", `static assets not found — UI disabled (API still on port ${port})`);
  }

  server = http.createServer(async (req, res) => {
    if (!req.url) { res.writeHead(400).end(); return; }
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/api/state") {
      sendJson(res, 200, getDashboardState());
      return;
    }

    if (url.pathname === "/api/events") {
      handleSse(req, res);
      return;
    }

    if (url.pathname === "/api/logs") {
      handleLogSse(req, res);
      return;
    }

    // Wiki API
    if (url.pathname === "/api/wiki") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const reqPath = url.searchParams.get("path") ?? "";
      if (!reqPath) {
        // Default to index
        const indexPath = safeWikiPath(vault, "wiki/index.md");
        if (!indexPath || !fs.existsSync(indexPath)) {
          sendJson(res, 404, { error: "No wiki/index.md yet" });
        } else {
          const content = await fsp.readFile(indexPath, "utf8");
          sendJson(res, 200, { path: "wiki/index.md", content });
        }
        return;
      }
      const full = safeWikiPath(vault, reqPath);
      if (!full) { sendJson(res, 400, { error: "Invalid path" }); return; }
      if (!fs.existsSync(full)) { sendJson(res, 404, { error: "Not found" }); return; }
      const content = await fsp.readFile(full, "utf8");
      sendJson(res, 200, { path: reqPath, content });
      return;
    }

    if (url.pathname === "/api/wiki/pages") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const pages = await listWikiPages(vault);
      sendJson(res, 200, { pages });
      return;
    }

    if (url.pathname === "/api/wiki/by-stem") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const stem = url.searchParams.get("stem") ?? "";
      if (!stem) { sendJson(res, 400, { error: "stem required" }); return; }
      const rel = await findByStem(vault, stem);
      if (!rel) { sendJson(res, 404, { error: "Not found" }); return; }
      const full = path.join(vault, rel);
      const content = await fsp.readFile(full, "utf8");
      sendJson(res, 200, { path: rel, content });
      return;
    }

    // Open a wiki file in the OS default app (Obsidian, VS Code, Finder, etc.)
    // Accepts either ?stem= (basename or path-style wikilink) or ?path= (full
    // wiki-relative path). Used by the graph side-panel preview so clicking a
    // referenced file launches it in the user's editor instead of just
    // navigating within the dashboard.
    if (url.pathname === "/api/wiki/open") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const pathParam = url.searchParams.get("path");
      const stemParam = url.searchParams.get("stem");
      let rel: string | null = null;
      if (pathParam) {
        const safe = safeVaultPath(vault, pathParam);
        if (!safe) { sendJson(res, 400, { error: "Invalid path" }); return; }
        rel = path.relative(vault, safe).replace(/\\/g, "/");
      } else if (stemParam) {
        rel = await findFileInVault(vault, stemParam);
      } else {
        sendJson(res, 400, { error: "stem or path required" });
        return;
      }
      if (!rel) { sendJson(res, 404, { error: "Not found" }); return; }
      const full = path.join(vault, rel);
      const pageParam = url.searchParams.get("page");
      const pageNum = pageParam ? parseInt(pageParam, 10) : null;
      const ext = path.extname(full).toLowerCase();
      const platform = process.platform;

      if (platform === "darwin" && pageNum && (ext === ".pptx" || ext === ".ppt")) {
        // AppleScript: open PowerPoint and go to specific slide
        const script = `tell application "Microsoft PowerPoint"\n  activate\n  open POSIX file "${full}"\n  delay 1\n  tell active presentation\n    set current slide to slide ${pageNum} of active presentation\n  end tell\nend tell`;
        const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
        child.on("error", () => {
          // Fallback: just open
          const fb = spawn("open", [full], { detached: true, stdio: "ignore" });
          fb.unref();
        });
        child.unref();
        appendLog("graph", `open ${rel} slide ${pageNum} via AppleScript`);
      } else if (platform === "darwin" && pageNum && (ext === ".docx" || ext === ".doc")) {
        // AppleScript: open Word and go to specific page
        const script = `tell application "Microsoft Word"\n  activate\n  open POSIX file "${full}"\n  delay 1\n  go to active document what:=wdGoToPage which:=wdGoToAbsolute count:=${pageNum}\nend tell`;
        const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
        child.on("error", () => {
          const fb = spawn("open", [full], { detached: true, stdio: "ignore" });
          fb.unref();
        });
        child.unref();
        appendLog("graph", `open ${rel} page ${pageNum} via AppleScript`);
      } else {
        // Default: open with OS default handler (existing behavior)
        let cmd: string;
        let args: string[];
        if (platform === "darwin") { cmd = "open"; args = [full]; }
        else if (platform === "win32") { cmd = "cmd"; args = ["/c", "start", "", full]; }
        else { cmd = "xdg-open"; args = [full]; }
        try {
          const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
          child.on("error", (err) => appendLog("graph", `open spawn error: ${err.message}`));
          child.unref();
          appendLog("graph", `open ${rel} via ${cmd}${pageNum ? ` (page ${pageNum}, no jump support for ${ext})` : ''}`);
          sendJson(res, 200, { ok: true, path: rel });
        } catch (err) {
          appendLog("graph", `open failed: ${err instanceof Error ? err.message : String(err)}`);
          sendJson(res, 500, { error: "Spawn failed" });
        }
        return;
      }
      sendJson(res, 200, { ok: true, path: rel, page: pageNum });
      return;
    }

    if (url.pathname === "/api/wiki/search") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) { sendJson(res, 400, { error: "q required" }); return; }
      appendLog("search", `request: q="${q.slice(0, 80)}" vault=${path.basename(vault)}`);
      const tStart = Date.now();
      const results = await searchWiki(vault, q);
      appendLog("search", `response: results=${results.length} total=${Date.now() - tStart}ms`);
      sendJson(res, 200, { results });
      return;
    }

    if (url.pathname === "/api/wiki/graph") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const tStart = Date.now();
      const data = await buildGraph(vault);
      appendLog("graph", `nodes=${data.nodes.length} edges=${data.edges.length} ${Date.now() - tStart}ms`);
      sendJson(res, 200, data);
      return;
    }

    if (url.pathname === "/api/live-notes/suggest") {
      if (req.method !== "POST") { sendText(res, 405, "POST required"); return; }
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      let body = "";
      try { body = await readBody(req); } catch { sendJson(res, 413, { error: "Payload too large" }); return; }
      let transcript = "";
      try {
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        transcript = String(parsed.transcript ?? "").trim();
      } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
      if (!transcript) {
        appendLog("live-notes", "request: empty transcript — returning empty");
        sendJson(res, 200, { topics: [], items: [] });
        return;
      }
      appendLog("live-notes", `request: transcript=${transcript.length} chars vault=${path.basename(vault)}`);
      const tStart = Date.now();
      const result = await suggestFromTranscript(vault, transcript);
      appendLog(
        "live-notes",
        `response: topics=${result.topics.length} items=${result.items.length} total=${Date.now() - tStart}ms`,
      );
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/meeting/extract") {
      if (req.method !== "POST") { sendText(res, 405, "POST required"); return; }
      let body = "";
      try { body = await readBody(req); } catch { sendJson(res, 413, { error: "Payload too large" }); return; }
      let transcript = "";
      try {
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        transcript = String(parsed.transcript ?? "").trim();
      } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
      if (!transcript) { sendJson(res, 200, { minutes: [], topics: [], actions: [] }); return; }
      appendLog("live-notes", `meeting/extract: ${transcript.length} chars`);
      const tStart = Date.now();
      const result = await extractMeetingData(transcript);
      appendLog("live-notes", `meeting/extract done: minutes=${result.minutes.length} topics=${result.topics.length} actions=${result.actions.length} [${Date.now() - tStart}ms]`);
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname === "/api/maintenance/toggle" && req.method === "POST") {
      setMaintenanceEnabled(!getMaintenanceEnabled());
      sendJson(res, 200, { maintenanceEnabled: getMaintenanceEnabled() });
      return;
    }

    // Queue job controls
    const queueMatch = url.pathname.match(/^\/api\/queue\/([^/]+)\/(cancel|retry)$/);
    if (queueMatch && req.method === "POST") {
      const [, id, action] = queueMatch;
      const ok = action === "cancel" ? cancelJob(id) : retryJob(id);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }

    // Settings
    if (url.pathname === "/api/settings" && req.method === "GET") {
      sendJson(res, 200, {
        maxRetries: getMaxRetries(),
        retryOnFailure: getRetryOnFailure(),
        maintenanceEnabled: getMaintenanceEnabled(),
      });
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      let body = "";
      try { body = await readBody(req); } catch { sendJson(res, 413, { error: "Payload too large" }); return; }
      try {
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        if (typeof parsed.maxRetries === "number") setMaxRetries(parsed.maxRetries);
        if (typeof parsed.retryOnFailure === "boolean") setRetryOnFailure(parsed.retryOnFailure);
        if (typeof parsed.maintenanceEnabled === "boolean") setMaintenanceEnabled(parsed.maintenanceEnabled);
      } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
      sendJson(res, 200, {
        maxRetries: getMaxRetries(),
        retryOnFailure: getRetryOnFailure(),
        maintenanceEnabled: getMaintenanceEnabled(),
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendText(res, 404, "Not Found");
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (staticDir) {
        await serveStatic(staticDir, url.pathname, req.method, res);
        return;
      }
      sendText(res, 503, "Dashboard UI not built. Run `npm run build` in dashboard/.");
      return;
    }

    sendText(res, 405, "Method Not Allowed");
  });

  server.on("error", (err) => log("dashboard", `error: ${err.message}`));
  server.listen(port, "127.0.0.1", () => {
    log("dashboard", `listening on http://127.0.0.1:${port}`);
    if (cfg.openBrowser) {
      const url = `http://127.0.0.1:${port}`;
      const platform = process.platform;
      let cmd: string;
      let args: string[];
      if (platform === "darwin") { cmd = "open"; args = [url]; }
      else if (platform === "win32") { cmd = "cmd"; args = ["/c", "start", "", url]; }
      else { cmd = "xdg-open"; args = [url]; }
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => log("dashboard", `open browser error: ${err.message}`));
      child.unref();
      log("dashboard", `opening browser at ${url}`);
    }
  });
}

export async function stopDashboard(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => { server!.close(() => resolve()); });
  server = null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });

  const send = (snapshot: DashboardSnapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  send(getDashboardState());
  const unsubscribe = subscribeDashboard(send);
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

function handleLogSse(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });

  res.write(`event: init\ndata: ${JSON.stringify(getLogLines())}\n\n`);
  const unsubscribe = subscribeLogLine((line) => res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`));
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

async function serveStatic(root: string, pathname: string, method: string, res: http.ServerResponse): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const safe = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (safe.includes("..")) { sendText(res, 400, "Bad Request"); return; }

  const candidates: string[] = [];
  if (safe === "" || safe.endsWith("/")) {
    candidates.push(path.join(root, safe, "index.html"));
  } else {
    candidates.push(path.join(root, safe));
    candidates.push(path.join(root, `${safe}.html`));
    candidates.push(path.join(root, safe, "index.html"));
  }

  for (const file of candidates) {
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": stat.size,
        "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
      });
      if (method === "HEAD") { res.end(); return; }
      fs.createReadStream(file).pipe(res);
      return;
    } catch { continue; }
  }

  // Choose SPA fallback: /wiki/* paths fall back to the wiki shell.
  // Next.js exports /wiki as wiki.html (trailingSlash: false), not wiki/index.html.
  const isWikiPath = decoded.startsWith("/wiki/") || decoded === "/wiki";
  const fallbackFile = isWikiPath ? "wiki.html" : "index.html";
  try {
    const fallback = path.join(root, fallbackFile);
    const stat = await fsp.stat(fallback);
    res.writeHead(200, { "content-type": MIME[".html"]!, "content-length": stat.size, "cache-control": "no-store" });
    fs.createReadStream(fallback).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}
