import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, subscribeDashboard, type DashboardSnapshot } from "./watcher.js";
import { log } from "./log.js";

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
  // server/dist/index.js → ../../../dashboard/out (when bundled, dist sits next to dashboard/)
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

export function startDashboard(): void {
  const port = parsePort(process.env.OBSIDIAN_DASHBOARD_PORT);
  const staticDir = resolveStaticDir();
  if (!staticDir) {
    log("dashboard", `static assets not found — UI disabled (built JSON API still available on port ${port})`);
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

  server.on("error", (err) => {
    log("dashboard", `error: ${err.message}`);
  });

  server.listen(port, "127.0.0.1", () => {
    log("dashboard", `listening on http://127.0.0.1:${port}`);
  });
}

export async function stopDashboard(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server!.close(() => resolve());
  });
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

  const send = (snapshot: DashboardSnapshot) => {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };

  send(getDashboardState());
  const unsubscribe = subscribeDashboard(send);

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

async function serveStatic(
  root: string,
  pathname: string,
  method: string,
  res: http.ServerResponse,
): Promise<void> {
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
      const headers: http.OutgoingHttpHeaders = {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": stat.size,
        "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
      };
      res.writeHead(200, headers);
      if (method === "HEAD") { res.end(); return; }
      fs.createReadStream(file).pipe(res);
      return;
    } catch {
      continue;
    }
  }

  // Fallback to index.html for client-side routes (Next.js exports per-route HTML;
  // this only fires for unknown paths)
  try {
    const fallback = path.join(root, "index.html");
    const stat = await fsp.stat(fallback);
    res.writeHead(200, {
      "content-type": MIME[".html"]!,
      "content-length": stat.size,
      "cache-control": "no-store",
    });
    fs.createReadStream(fallback).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}
