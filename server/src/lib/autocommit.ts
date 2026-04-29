import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { log } from "./log.js";

const exec = promisify(execFile);

export async function maybeAutoCommit(vault: string, enabled: boolean, summary: string): Promise<string | null> {
  const name = path.basename(vault);
  if (!enabled) {
    log("git", `auto-commit disabled (${name})`);
    return null;
  }
  if (!fs.existsSync(path.join(vault, ".git"))) {
    log("git", `no .git repo (${name}), skipping commit`);
    return null;
  }

  try {
    await exec("git", ["add", "wiki", ".raw", ".vault-meta"], { cwd: vault });
  } catch {
    // any of those folders may not exist yet — fall through and commit what's staged
  }

  try {
    const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], { cwd: vault });
    if (!stdout.trim()) {
      log("git", `nothing staged to commit (${name})`);
      return null;
    }
  } catch {
    return null;
  }

  const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
  const msg = `wiki: ${summary} (${ts})`;
  try {
    await exec("git", ["commit", "-m", msg], { cwd: vault });
    log("git", `committed "${msg}" (${name})`);
    return msg;
  } catch (err) {
    log("git", `commit failed (${name}): ${(err as Error).message}`);
    return `commit-failed: ${(err as Error).message}`;
  }
}
