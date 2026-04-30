import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { resolveClaudeBin } from "./claude-bin.js";
import { appendLog } from "./watcher.js";
import type { VaultConfig } from "./vaults.js";

const LINT_STATE_REL = path.join(".vault-meta", "lint-state.json");

interface LintState {
  lastLintAt: number;
}

function loadLintState(vault: string): LintState {
  try {
    return JSON.parse(fs.readFileSync(path.join(vault, LINT_STATE_REL), "utf8")) as LintState;
  } catch {
    return { lastLintAt: 0 };
  }
}

function saveLintState(vault: string, state: LintState): void {
  const p = path.join(vault, LINT_STATE_REL);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

async function collectMd(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectMd(full, out);
    else if (/\.md$/i.test(e.name)) out.push(full);
  }
}

async function wikiChangedSince(vault: string, since: number): Promise<boolean> {
  const wikiDir = path.join(vault, "wiki");
  if (!fs.existsSync(wikiDir)) return false;
  const files: string[] = [];
  await collectMd(wikiDir, files);
  for (const f of files) {
    const stat = fs.statSync(f, { throwIfNoEntry: false });
    if (stat && stat.mtimeMs > since) return true;
  }
  return false;
}

function logLine(vault: string, msg: string): void {
  appendLog(`auto-lint:${path.basename(vault)}`, msg);
}

const LINT_PROMPT = `Run kb_lint on this vault, then fix the issues it reports:
1. For each broken link: update the link target to the correct page stem, or remove it if no valid target exists.
2. For each orphaned page (zero inbound links, excluding index/hot): add a [[link]] to it from at least one semantically related page under a "## Related" section.
3. After fixing, run kb_reindex to rebuild indexes.
4. Append one line to wiki/log.md: "lint: auto-lint run, fixed <N> issue(s) (<ISO date>)".

Only change what kb_lint reports — no scope creep.`;

const timers: ReturnType<typeof setInterval>[] = [];
let lintRunning = false;

async function checkAndLint(vault: string): Promise<void> {
  if (lintRunning) {
    logLine(vault, "skipping — lint run already in progress");
    return;
  }

  const state = loadLintState(vault);
  if (!(await wikiChangedSince(vault, state.lastLintAt))) {
    logLine(vault, "no wiki changes since last lint — skipping");
    return;
  }

  lintRunning = true;
  logLine(vault, "wiki changed — starting lint run");
  try {
    await runLint(vault);
    saveLintState(vault, { lastLintAt: Date.now() });
  } finally {
    lintRunning = false;
  }
}

function runLint(vault: string): Promise<void> {
  return new Promise((resolve) => {
    const bin = resolveClaudeBin();
    const model = (process.env.OBSIDIAN_INGEST_MODEL ?? "claude-sonnet-4-6").trim();
    const child = spawn(bin, ["--model", model, "-p", LINT_PROMPT], {
      cwd: vault,
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
    child.stdout?.on("data", (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) logLine(vault, `[stdout] ${line}`);
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) logLine(vault, `[stderr] ${line}`);
      }
    });
    child.on("error", (err) => {
      logLine(vault, `spawn failed: ${err.message}`);
      resolve();
    });
    child.on("exit", (code) => {
      logLine(vault, `lint run complete (exit ${code})`);
      resolve();
    });
  });
}

export function startAutoLint(vaults: string[], cfg: VaultConfig): void {
  if (!cfg.autoLint) {
    appendLog("auto-lint", "disabled (OBSIDIAN_AUTO_LINT not set); skipping");
    return;
  }
  if (vaults.length === 0) {
    appendLog("auto-lint", "no vaults configured; skipping");
    return;
  }

  const intervalMs = cfg.autoLintIntervalHours * 60 * 60 * 1000;
  appendLog("auto-lint", `enabled; interval=${cfg.autoLintIntervalHours}h`);

  for (const vault of vaults) {
    const timer = setInterval(() => void checkAndLint(vault), intervalMs);
    timer.unref();
    timers.push(timer);
  }
}

export function stopAutoLint(): void {
  for (const t of timers.splice(0)) clearInterval(t);
}
