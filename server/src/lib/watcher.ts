import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import chokidar, { type FSWatcher } from "chokidar";
import { ensureKBScaffolded } from "./vaults.js";
import { resolveClaudeBin } from "./claude-bin.js";
import { isIngestible, isOfficeFile, extractText } from "./converter.js";

const EXCLUDED_DIRS = new Set([
  "wiki",
  ".git",
  ".trash",
  "_templates",
  "node_modules",
]);

const HIDDEN_PREFIX = ".";

type Event = "add" | "change" | "unlink";
type EntryStatus = "queued" | "active" | "done" | "failed" | "skipped";

interface QueueEntry {
  id: string;
  vault: string;
  rel: string;
  event: Event;
  status: EntryStatus;
  enqueuedAt: number;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  message?: string;
}

const watchers: FSWatcher[] = [];
const queue: QueueEntry[] = [];
const active: QueueEntry[] = [];
const recent: QueueEntry[] = [];
const RECENT_MAX = 50;
let nextEntryId = 1;
let running = false;

const dashboardEvents = new EventEmitter();
dashboardEvents.setMaxListeners(0);

export interface DashboardSnapshot {
  queued: QueueEntry[];
  active: QueueEntry[];
  recent: QueueEntry[];
  concurrency: number;
  updatedAt: number;
}

export function getDashboardState(): DashboardSnapshot {
  return {
    queued: queue.map((e) => ({ ...e })),
    active: active.map((e) => ({ ...e })),
    recent: recent.map((e) => ({ ...e })),
    concurrency: CONCURRENCY,
    updatedAt: Date.now(),
  };
}

export function subscribeDashboard(listener: (snapshot: DashboardSnapshot) => void): () => void {
  const handler = () => listener(getDashboardState());
  dashboardEvents.on("change", handler);
  return () => dashboardEvents.off("change", handler);
}

function notifyDashboard(): void {
  dashboardEvents.emit("change");
}

function pushRecent(entry: QueueEntry): void {
  recent.unshift({ ...entry });
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
}

function removeFromActive(id: string): void {
  const idx = active.findIndex((e) => e.id === id);
  if (idx >= 0) active.splice(idx, 1);
}

const LOG_REL = path.join(".vault-meta", "watcher.log");
const STATE_REL = path.join(".vault-meta", "ingest-state.json");

type IngestState = Record<string, number>; // rel → mtime ms at last successful ingest

function loadIngestState(vault: string): IngestState {
  try {
    return JSON.parse(fs.readFileSync(path.join(vault, STATE_REL), "utf8")) as IngestState;
  } catch {
    return {};
  }
}

function saveIngestEntry(vault: string, rel: string, mtime: number): void {
  const statePath = path.join(vault, STATE_REL);
  try {
    let state: IngestState = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")) as IngestState; } catch { }
    state[rel] = mtime;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

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
  // Scaffold wiki/, .raw/, .vault-meta/ if not present
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
  const rel = (p: string) => path.relative(vault, p);
  watcher.on("add", (p) => isIngestible(rel(p)) && enqueue(vault, p, "add"));
  watcher.on("change", (p) => isIngestible(rel(p)) && enqueue(vault, p, "change"));
  watcher.on("unlink", (p) => isIngestible(rel(p)) && enqueue(vault, p, "unlink"));
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
  const state = loadIngestState(vault);
  let skipped = 0;
  let queued = 0;
  for (const filePath of files) {
    const rel = path.relative(vault, filePath);
    if (!rel) continue;
    const mtime = fs.statSync(filePath).mtimeMs;
    if (state[rel] === mtime) { skipped++; continue; }
    if (!queue.some((q) => q.vault === vault && q.rel === rel && q.event === "add")) {
      queue.push({
        id: String(nextEntryId++),
        vault,
        rel,
        event: "add",
        status: "queued",
        enqueuedAt: Date.now(),
      });
      queued++;
    }
  }
  if (queued === 0) {
    logLine(vault, `initial scan: all ${files.length} file(s) already up to date`);
    return;
  }
  logLine(vault, `initial scan: ${queue.length} file(s) queued, ${skipped} unchanged [queue depth: ${queue.length}]`);
  notifyDashboard();
  void drain();
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
    } else if (isIngestible(path.relative(vault, full))) {
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
  queue.push({
    id: String(nextEntryId++),
    vault,
    rel,
    event,
    status: "queued",
    enqueuedAt: Date.now(),
  });
  logLine(vault, `enqueue ${event} ${rel} [queue depth: ${queue.length}]`);
  notifyDashboard();
  void drain();
}

const CONCURRENCY = 5;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  let completed = 0;
  let lastVault = "";
  try {
    const inFlight = new Set<Promise<void>>();

    const startNext = () => {
      while (inFlight.size < CONCURRENCY && queue.length > 0) {
        const entry = queue.shift()!;
        entry.status = "active";
        entry.startedAt = Date.now();
        active.push(entry);
        lastVault = entry.vault;
        const mtime = entry.event !== "unlink"
          ? (fs.statSync(path.join(entry.vault, entry.rel), { throwIfNoEntry: false })?.mtimeMs ?? 0)
          : 0;
        logLine(entry.vault, `start [${active.length}/${CONCURRENCY}] ${entry.event} ${entry.rel} [${queue.length} queued]`);
        notifyDashboard();
        const p: Promise<void> = runIngest(entry).then((code) => {
          entry.exitCode = code ?? null;
          entry.endedAt = Date.now();
          if (code === 0) {
            entry.status = "done";
            if (entry.event !== "unlink" && mtime > 0) {
              saveIngestEntry(entry.vault, entry.rel, mtime);
            }
          } else if (code === null) {
            entry.status = "skipped";
          } else {
            entry.status = "failed";
          }
        }).catch((err) => {
          entry.endedAt = Date.now();
          entry.status = "failed";
          entry.message = (err as Error).message;
        }).finally(() => {
          inFlight.delete(p);
          removeFromActive(entry.id);
          pushRecent(entry);
          completed++;
          notifyDashboard();
        });
        inFlight.add(p);
      }
    };

    startNext();
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
      startNext();
    }

    if (completed > 0 && lastVault) {
      logLine(lastVault, `✓ ingest complete — ${completed} file(s) processed`);
    }
  } finally {
    running = false;
  }
}

const SCOPE_RULE = [
  `STRICT SCOPE: this knowledge base folder is your current working directory. You MUST stay inside it.`,
  `- Do NOT use 'find', 'grep -r', or any command that traverses paths outside the cwd.`,
  `- Do NOT search /Users, $HOME, ~, or any absolute path outside cwd.`,
  `- Use only relative paths from cwd. The wiki lives at wiki/. Raw sources at .raw/.`,
  `- If the named file does not exist in cwd, STOP. Do not try to locate it elsewhere. Report "file not found" and exit.`,
  `META FILES: Do NOT create wikilinks to wiki/index.md, wiki/log.md, wiki/hot.md, or WIKI.md from any content page.`,
  `- These files are managed automatically. Never add [[index]], [[log]], [[hot]], or [[WIKI]] to Related sections or anywhere else in content pages.`,
].join("\n");

const SOURCE_RULE = (basename: string) => [
  `CITATIONS: Every wiki page you create or update MUST use footnote citations linking facts back to their source documents.`,
  `- Add a frontmatter field: source: "[[${basename}]]"`,
  `- Use ONE citation number per SOURCE DOCUMENT, not per fact. If all content comes from one file, use only [^1] — place it once per section heading, not on every bullet point.`,
  `- If content comes from multiple source documents, use a different number per document: [^1] for the first, [^2] for the second, etc.`,
  `- Place the citation on the section heading or the first sentence of the section, not on every individual bullet.`,
  `- At the bottom of the page add a References section:`,
  `  [^1]: [[${basename}]] — section or slide name if known`,
  `- Never repeat the same citation number multiple times on consecutive lines.`,
].join("\n");

function buildPrompt(event: Event, rel: string, extractedText?: string): string {
  if (event === "unlink") {
    return [
      `A file was just deleted from this knowledge base folder: ${rel}`,
      ``,
      SCOPE_RULE,
      ``,
      `Update the wiki to keep it consistent with the deletion:`,
      `1. Search wiki/ for references to "${rel}" or its basename — links, frontmatter source: fields, log entries.`,
      `2. Remove or update broken links. If a wiki/sources/<domain>/* page was created solely from this file, delete it.`,
      `3. If concept/entity pages now have no remaining sources or inbound links, mark them orphaned in frontmatter (status: orphan) — do not delete unless they are clearly only-from-this-source.`,
      `4. Append a one-line entry to wiki/log.md noting "deleted ${rel}" with today's date.`,
      `5. Run kb_reindex to rebuild wiki/index.md and wiki/index/<domain>.md.`,
      ``,
      `Use WIKI.md for schema conventions. Be conservative: prefer marking orphaned over hard-deleting.`,
    ].join("\n");
  }

  const basename = path.basename(rel);

  if (extractedText) {
    return [
      `kb-ingest ${rel}`,
      ``,
      SCOPE_RULE,
      ``,
      SOURCE_RULE(basename),
      ``,
      `The file "${rel}" is a binary document. Its extracted text content is below.`,
      ``,
      `--- EXTRACTED CONTENT ---`,
      extractedText,
      `--- END ---`,
      ``,
      WRITE_RULE,
    ].join("\n");
  }

  return [
    `kb-ingest ${rel}`,
    ``,
    SCOPE_RULE,
    ``,
    SOURCE_RULE(basename),
    ``,
    `The source file is at the relative path "${rel}" from the current working directory. Read it directly; do not search for it.`,
    WRITE_RULE,
  ].join("\n");
}

const WRITE_RULE = `Write every wiki page under wiki/<type-folder>/<domain>/<slug>.md (e.g. wiki/concepts/clearance/risk-rating.md). vault_write rejects single-segment writes at wiki/ root. Allowed at root: index.md, log.md, hot.md, overview.md, README.md. Domain hub pages live at wiki/domains/<slug>.md. After writing, call kb_reindex to rebuild wiki/index.md and wiki/index/<domain>.md. Use WIKI.md as the schema reference.`;

async function runIngest(entry: QueueEntry): Promise<number | null> {
  if (entry.event !== "unlink" && !isIngestible(entry.rel)) {
    logLine(entry.vault, `skip ${entry.rel} (unsupported file type)`);
    return null;
  }

  let extractedText: string | undefined;
  if (entry.event !== "unlink" && isOfficeFile(entry.rel)) {
    const filePath = path.join(entry.vault, entry.rel);
    const text = await extractText(filePath);
    if (text === null) {
      logLine(entry.vault, `skip ${entry.rel} (text extraction failed — file may be corrupt or encrypted)`);
      return null;
    }
    logLine(entry.vault, `extracted ${text.length} chars from ${entry.rel}`);
    extractedText = text;
  }

  return new Promise((resolve) => {
    const bin = resolveClaudeBin();
    const prompt = buildPrompt(entry.event, entry.rel, extractedText);
    const model = (process.env.OBSIDIAN_INGEST_MODEL ?? "claude-sonnet-4-6").trim();
    const args = ["--model", model, "-p", prompt];
    const startMs = Date.now();
    const child = spawn(bin, args, {
      cwd: entry.vault,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        PATH: [
          process.env.PATH,
          path.dirname(process.execPath),
          ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
        ].filter(Boolean).join(path.delimiter),
      },
    });
    const onChunk = (stream: "stdout" | "stderr") => (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) logLine(entry.vault, `[${stream}] ${entry.rel}: ${line}`);
      }
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));
    child.on("error", (err) => {
      logLine(entry.vault, `spawn failed ${entry.rel}: ${err.message}`);
      resolve(null);
    });
    child.on("exit", (code, signal) => {
      const elapsed = Date.now() - startMs;
      const status = code === 0 ? "done" : `failed (exit ${code ?? signal})`;
      logLine(entry.vault, `${status} ${entry.rel} [${elapsed}ms] — ${queue.length} remaining`);
      resolve(code);
    });
  });
}
