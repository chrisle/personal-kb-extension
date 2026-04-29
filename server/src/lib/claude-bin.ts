import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cached: string | null | undefined;

export function resolveClaudeBin(): string {
  if (cached !== undefined) return cached ?? "claude";
  cached = findBundled();
  if (cached) {
    process.stderr.write(`[claude-bin] using bundled: ${cached}\n`);
  } else {
    process.stderr.write(`[claude-bin] no bundled Claude Code found, falling back to PATH "claude"\n`);
  }
  return cached ?? "claude";
}

function findBundled(): string | null {
  const dd = desktopDataDir();
  if (!dd) return null;
  const ccDir = path.join(dd, "claude-code");
  if (!fs.existsSync(ccDir)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ccDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const versions = entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(semverDesc);

  for (const v of versions) {
    const exe = platformExe(path.join(ccDir, v));
    if (exe) return exe;
  }
  return null;
}

function desktopDataDir(): string | null {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Claude");
    case "win32":
      return process.env.APPDATA ? path.join(process.env.APPDATA, "Claude") : null;
    case "linux":
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Claude");
    default:
      return null;
  }
}

function platformExe(versionDir: string): string | null {
  const candidates =
    process.platform === "darwin"
      ? [path.join(versionDir, "claude.app", "Contents", "MacOS", "claude")]
      : process.platform === "win32"
      ? [path.join(versionDir, "claude.exe"), path.join(versionDir, "claude.cmd")]
      : [path.join(versionDir, "claude")];
  for (const c of candidates) {
    try {
      const stat = fs.statSync(c);
      if (stat.isFile()) return c;
    } catch {
      // continue
    }
  }
  return null;
}

function semverDesc(a: string, b: string): number {
  const ap = a.split(".").map((n) => parseInt(n, 10) || 0);
  const bp = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return b.localeCompare(a);
}
