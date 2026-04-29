import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { ensureKBScaffolded } from "./vaults.js";
import { resolveClaudeBin } from "./claude-bin.js";

const EXCLUDED_DIRS = new Set([
  "obsidian",
  ".git",
  ".trash",
  "_templates",
  "node_modules",
]);

const HIDDEN_PREFIX = ".";

type Event = "add" | "change" | "unlink";

interface QueueEntry {
  vault: string;
  rel: string;
  event: Event;
}

const watchers: FSWatcher[] = [];
const queue: QueueEntry[] = [];
let running = false;

const LOG_REL = path.join("obsidian", ".vault-meta", "watcher.log");

export function watcherLog(vault: string, msg: string): void {
  logLine(vault, msg);
}

function logLine(vault: string, msg: string): void {
  const stamp = new Date().toISOString();
  const line = `${stamp} ${msg}\n`;
  process.stderr.write(`[watcher] ${msg}\n`);
  try {
    const logPath = path.join(vault, LOG_REL);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch {
    // best-effort
  }
}

export function startVaultWatchers(vaults: string[], enabled: boolean): void {
  if (!enabled) {
    process.stderr.write(`[watcher] disabled (auto_watch off); skipping\n`);
    return;
  }
  if (vaults.length === 0) {
    process.stderr.write(`[watcher] no vaults configured; skipping\n`);
    return;
  }

  for (const vault of vaults) {
    void setupVault(vault);
  }
}

async function setupVault(vault: string): Promise<void> {
  // Scaffold obsidian/wiki/, .raw/, .vault-meta/ if not present
  try {
    await ensureKBScaffolded(vault);
    logLine(vault, `scaffold ok`);
  } catch (err) {
    logLine(vault, `scaffold failed: ${(err as Error).message}`);
  }

  // Enqueue all existing user files for initial ingest
  await enqueueExistingFiles(vault);

  // Start the file watcher for ongoing changes
  const watcher = chokidar.watch(vault, {
    ignored: (filePath) => isExcluded(vault, filePath),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
    depth: 99,
  });
  watcher.on("add", (p) => enqueue(vault, p, "add"));
  watcher.on("change", (p) => enqueue(vault, p, "change"));
  watcher.on("unlink", (p) => enqueue(vault, p, "unlink"));
  watcher.on("error", (err) => logLine(vault, `error ${err}`));
  watchers.push(watcher);
  logLine(vault, `watching ${vault}`);
}

async function enqueueExistingFiles(vault: string): Promise<void> {
  const files: string[] = [];
  try {
    await collectUserFiles(vault, vault, files);
  } catch (err) {
    logLine(vault, `initial scan failed: ${(err as Error).message}`);
    return;
  }
  if (files.length === 0) {
    logLine(vault, `initial scan: no user files found`);
    return;
  }
  logLine(vault, `initial scan: ${files.length} file(s) queued for ingest`);
  for (const filePath of files) {
    enqueue(vault, filePath, "add");
  }
}

async function collectUserFiles(dir: string, vault: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isExcluded(vault, full)) continue;
    if (e.isDirectory()) {
      await collectUserFiles(full, vault, out);
    } else {
      out.push(full);
    }
  }
}

export async function stopVaultWatchers(): Promise<void> {
  await Promise.all(watchers.splice(0).map((w) => w.close()));
}

function isExcluded(vault: string, filePath: string): boolean {
  if (filePath === vault) return false;
  const rel = path.relative(vault, filePath);
  if (!rel || rel.startsWith("..")) return false;
  const segments = rel.split(path.sep);
  for (const seg of segments) {
    if (EXCLUDED_DIRS.has(seg)) return true;
    if (seg.startsWith(HIDDEN_PREFIX)) return true;
  }
  return false;
}

function enqueue(vault: string, filePath: string, event: Event): void {
  const rel = path.relative(vault, filePath);
  if (!rel) return;
  if (queue.some((q) => q.vault === vault && q.rel === rel && q.event === event)) return;
  queue.push({ vault, rel, event });
  logLine(vault, `enqueue ${event} ${rel}`);
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      await runIngest(entry);
    }
  } finally {
    running = false;
  }
}

const SCOPE_RULE = [
  `STRICT SCOPE: this knowledge base folder is your current working directory. You MUST stay inside it.`,
  `- Do NOT use 'find', 'grep -r', or any command that traverses paths outside the cwd.`,
  `- Do NOT search /Users, $HOME, ~, or any absolute path outside cwd.`,
  `- Use only relative paths from cwd. The wiki lives at obsidian/wiki/. Raw sources at obsidian/.raw/.`,
  `- If the named file does not exist in cwd, STOP. Do not try to locate it elsewhere. Report "file not found" and exit.`,
].join("\n");

function buildPrompt(event: Event, rel: string): string {
  if (event === "unlink") {
    return [
      `A file was just deleted from this knowledge base folder: ${rel}`,
      ``,
      SCOPE_RULE,
      ``,
      `Update the wiki to keep it consistent with the deletion:`,
      `1. Search obsidian/wiki/ for references to "${rel}" or its basename — links, frontmatter source: fields, log entries.`,
      `2. Remove or update broken links. If a obsidian/wiki/sources/* page was created solely from this file, delete it.`,
      `3. If concept/entity pages now have no remaining sources or inbound links, mark them orphaned in frontmatter (status: orphan) — do not delete unless they are clearly only-from-this-source.`,
      `4. Append a one-line entry to obsidian/wiki/log.md noting "deleted ${rel}" with today's date.`,
      `5. Update obsidian/wiki/index.md if any deleted pages were listed there.`,
      ``,
      `Use obsidian/WIKI.md for schema conventions. Be conservative: prefer marking orphaned over hard-deleting.`,
    ].join("\n");
  }
  return [
    `wiki-ingest ${rel}`,
    ``,
    SCOPE_RULE,
    ``,
    `The source file is at the relative path "${rel}" from the current working directory. Read it directly; do not search for it.`,
    `Write all wiki output under obsidian/wiki/. Use obsidian/WIKI.md as the schema reference.`,
  ].join("\n");
}

function runIngest(entry: QueueEntry): Promise<void> {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin();
    const prompt = buildPrompt(entry.event, entry.rel);
    const args = ["-p", prompt];
    logLine(entry.vault, `spawn ${entry.event} ${entry.rel}`);
    const child = spawn(bin, args, {
      cwd: entry.vault,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const onChunk = (stream: "stdout" | "stderr") => (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) logLine(entry.vault, `${stream} ${entry.rel}: ${line}`);
      }
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));
    child.on("error", (err) => {
      logLine(entry.vault, `spawn failed ${entry.rel}: ${err.message}`);
      resolve();
    });
    child.on("exit", (code, signal) => {
      logLine(entry.vault, `ingest done ${entry.rel} (exit ${code ?? "null"} signal ${signal ?? "null"})`);
      resolve();
    });
  });
}
