import { spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, subscribeDashboard, getLogLines, subscribeLogLine, type DashboardSnapshot } from "./watcher.js";
import { parseFrontmatter } from "./frontmatter.js";
import { resolveClaudeBin } from "./claude-bin.js";
import { log } from "./log.js";
import type { VaultConfig } from "./vaults.js";

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

interface SearchResult {
  path: string;
  title: string;
  snippet: string;
}

async function searchViaClaudeP(vault: string, query: string): Promise<SearchResult[]> {
  const bin = resolveClaudeBin();
  const model = (process.env.OBSIDIAN_INGEST_MODEL ?? "claude-sonnet-4-6").trim();
  const safeQuery = query.replace(/["`$\\]/g, " ").trim().slice(0, 200);

  const prompt = [
    `Search the wiki/ folder for pages about: ${safeQuery}`,
    ``,
    `Steps:`,
    `1. Use bash to find matching files (case-insensitive grep):`,
    `   find wiki/ -name "*.md" | xargs grep -il "${safeQuery}" 2>/dev/null | head -20`,
    `2. For each matching file, read it to extract the frontmatter "title:" field and the best matching line as a snippet.`,
    `3. Output ONLY valid JSON objects, one per line, no markdown, no other text:`,
    `{"path":"wiki/concepts/domain/slug.md","title":"Page Title","snippet":"Relevant excerpt here..."}`,
    ``,
    `Max 10 results. If no files match, output nothing.`,
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn(bin, ["--model", model, "-p", prompt], {
      cwd: vault,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: [
          process.env.PATH,
          path.dirname(process.execPath),
          ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
        ].filter(Boolean).join(path.delimiter),
      },
    });

    let stdout = "";
    child.stdout?.on("data", (buf: Buffer) => { stdout += buf.toString("utf8"); });
    child.on("error", () => resolve([]));

    const timeout = setTimeout(() => { child.kill(); resolve([]); }, 60_000);

    child.on("exit", () => {
      clearTimeout(timeout);
      const results: SearchResult[] = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const r = JSON.parse(t) as Record<string, unknown>;
          if (typeof r.path === "string" && typeof r.title === "string") {
            results.push({ path: r.path, title: r.title, snippet: String(r.snippet ?? "") });
          }
        } catch { /* skip malformed line */ }
      }
      resolve(results);
    });
  });
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

    if (url.pathname === "/api/wiki/search") {
      const vault = getVaultPath();
      if (!vault) { sendJson(res, 503, { error: "No active vault" }); return; }
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) { sendJson(res, 400, { error: "q required" }); return; }
      const results = await searchViaClaudeP(vault, q);
      sendJson(res, 200, { results });
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
  server.listen(port, "127.0.0.1", () => log("dashboard", `listening on http://127.0.0.1:${port}`));
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

  try {
    const fallback = path.join(root, "index.html");
    const stat = await fsp.stat(fallback);
    res.writeHead(200, { "content-type": MIME[".html"]!, "content-length": stat.size, "cache-control": "no-store" });
    fs.createReadStream(fallback).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}
