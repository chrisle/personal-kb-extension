import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function maybeAutoCommit(vault: string, enabled: boolean, summary: string): Promise<string | null> {
  if (!enabled) return null;
  if (!fs.existsSync(path.join(vault, ".git"))) return null;

  try {
    await exec("git", ["add", path.join(".obsidian", "wiki"), path.join(".obsidian", ".raw"), path.join(".obsidian", ".vault-meta")], { cwd: vault });
  } catch {
    // any of those folders may not exist yet — fall through and commit what's staged
  }

  try {
    const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], { cwd: vault });
    if (!stdout.trim()) return null;
  } catch {
    return null;
  }

  const ts = new Date().toISOString().replace("T", " ").slice(0, 16);
  const msg = `wiki: ${summary} (${ts})`;
  try {
    await exec("git", ["commit", "-m", msg], { cwd: vault });
    return msg;
  } catch (err) {
    return `commit-failed: ${(err as Error).message}`;
  }
}
