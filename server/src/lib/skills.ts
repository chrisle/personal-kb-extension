import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_SRC = path.join(EXTENSION_ROOT, "assets", "skills");
const MARKER = ".obsidian-claude-accenture";

function skillNames(): string[] {
  try {
    return fs.readdirSync(SKILLS_SRC).filter((name) => {
      const full = path.join(SKILLS_SRC, name);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "SKILL.md"));
    });
  } catch {
    return [];
  }
}

function skillsDest(vault: string): string {
  return path.join(vault, ".claude", "skills");
}

export function setupSkills(vaults: string[]): void {
  const names = skillNames();
  if (names.length === 0) return;
  const current = new Set(names);
  for (const vault of vaults) {
    const dest = skillsDest(vault);
    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const src = path.join(SKILLS_SRC, name);
      const skillDest = path.join(dest, name);
      try {
        if (fs.existsSync(skillDest) && !fs.existsSync(path.join(skillDest, MARKER))) continue;
        fs.cpSync(src, skillDest, { recursive: true, force: true });
        fs.writeFileSync(path.join(skillDest, MARKER), "");
        process.stderr.write(`[skills] installed ${name} → ${skillDest}\n`);
      } catch (err) {
        process.stderr.write(`[skills] failed to install ${name}: ${(err as Error).message}\n`);
      }
    }
    // Remove orphaned skill dirs we previously installed but no longer ship
    try {
      for (const entry of fs.readdirSync(dest)) {
        if (current.has(entry)) continue;
        const orphan = path.join(dest, entry);
        if (!fs.statSync(orphan).isDirectory()) continue;
        if (!fs.existsSync(path.join(orphan, MARKER))) continue;
        fs.rmSync(orphan, { recursive: true, force: true });
        process.stderr.write(`[skills] removed obsolete ${entry} → ${orphan}\n`);
      }
    } catch {
      // best-effort
    }
  }
}

export function teardownSkills(_vaults: string[]): void {
  // Skills are left in place intentionally — the user owns them once installed.
}
