import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultConfig {
  vaults: string[];
  active: string | null;
  autoCommit: boolean;
  autoWatch: boolean;
}

export function loadConfigFromArgv(argv: string[]): VaultConfig {
  const vaults = argv
    .slice(2)
    .map((p) => path.resolve(p))
    .filter((p) => p.length > 0);

  const activeName = (process.env.OBSIDIAN_ACTIVE_VAULT ?? "").trim();
  const autoCommitRaw = process.env.OBSIDIAN_AUTO_COMMIT ?? "true";
  const autoCommit = !["0", "false", "no", "off"].includes(autoCommitRaw.toLowerCase());
  const autoWatchRaw = process.env.OBSIDIAN_AUTO_WATCH ?? "false";
  const autoWatch = ["1", "true", "yes", "on"].includes(autoWatchRaw.toLowerCase());

  let active: string | null = null;
  if (activeName) {
    active = vaults.find((v) => path.basename(v) === activeName) ?? null;
  }
  if (!active && vaults.length > 0) {
    active = vaults[0];
  }

  return { vaults, active, autoCommit, autoWatch };
}

let runtimeActive: string | null = null;

export function getActiveVault(cfg: VaultConfig): string {
  const candidate = runtimeActive ?? cfg.active;
  if (!candidate) {
    throw new Error(
      "No vault configured. Open Claude Desktop → Settings → Extensions → Claude + Obsidian and add at least one vault directory.",
    );
  }
  return candidate;
}

export function setActiveVault(cfg: VaultConfig, nameOrPath: string): string {
  const resolved = resolveVault(cfg, nameOrPath);
  runtimeActive = resolved;
  return resolved;
}

export function resolveVault(cfg: VaultConfig, nameOrPath?: string): string {
  if (!nameOrPath) return getActiveVault(cfg);

  const direct = path.resolve(nameOrPath);
  if (cfg.vaults.includes(direct)) return direct;

  const byName = cfg.vaults.find((v) => path.basename(v) === nameOrPath);
  if (byName) return byName;

  throw new Error(
    `Vault "${nameOrPath}" not configured. Configured vaults: ${cfg.vaults.map((v) => path.basename(v)).join(", ") || "(none)"}`,
  );
}

export function vaultPath(vault: string, relative: string): string {
  const target = path.resolve(vault, relative);
  const root = path.resolve(vault);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path "${relative}" escapes vault root "${vault}"`);
  }
  return target;
}

export function ensureVaultExists(vault: string): void {
  if (!fs.existsSync(vault)) {
    throw new Error(`Vault directory does not exist: ${vault}`);
  }
  const stat = fs.statSync(vault);
  if (!stat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vault}`);
  }
}

export function listVaults(cfg: VaultConfig): Array<{ name: string; path: string; active: boolean }> {
  const active = runtimeActive ?? cfg.active;
  return cfg.vaults.map((v) => ({
    name: path.basename(v),
    path: v,
    active: v === active,
  }));
}
