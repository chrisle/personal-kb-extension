import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ensureVaultExists, resolveVault, vaultPath, type VaultConfig } from "../lib/vaults.js";
import { maybeAutoCommit } from "../lib/autocommit.js";
import { textResult } from "./index.js";

interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
  color?: string;
}

interface Canvas {
  nodes: CanvasNode[];
  edges: Array<{ id: string; fromNode: string; toNode: string }>;
}

export const canvasTools: Tool[] = [
  {
    name: "canvas_create",
    description: "Create a new Obsidian canvas (.canvas) at wiki/canvases/<name>.canvas",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        name: { type: "string", description: "Canvas name (without extension)" },
      },
      required: ["name"],
    },
  },
  {
    name: "canvas_add_node",
    description:
      "Add a node to a canvas. Type 'text' (with `text`), 'file' (with `file` path), or 'link' (with `url`). Auto-positions if x/y omitted.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
        canvas: { type: "string", description: "Canvas name (without extension), defaults to 'main'" },
        type: { type: "string", enum: ["text", "file", "link"] },
        text: { type: "string" },
        file: { type: "string", description: "Path inside vault" },
        url: { type: "string" },
        label: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", default: 400 },
        height: { type: "number", default: 200 },
      },
      required: ["type"],
    },
  },
  {
    name: "canvas_list",
    description: "List all canvases in wiki/canvases/ with node counts.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string" },
      },
    },
  },
];

export async function callCanvasTool(cfg: VaultConfig, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "canvas_create":
      return createCanvas(cfg, args);
    case "canvas_add_node":
      return addNode(cfg, args);
    case "canvas_list":
      return listCanvases(cfg, args);
    default:
      throw new Error(`Unknown canvas tool: ${name}`);
  }
}

function canvasFile(vault: string, name: string): string {
  const safe = name.replace(/[^\w\-. ]/g, "_");
  return vaultPath(vault, path.join("wiki", "canvases", `${safe}.canvas`));
}

async function loadCanvas(file: string): Promise<Canvas> {
  if (!fs.existsSync(file)) return { nodes: [], edges: [] };
  const body = await fsp.readFile(file, "utf8");
  try {
    return JSON.parse(body) as Canvas;
  } catch {
    return { nodes: [], edges: [] };
  }
}

async function saveCanvas(file: string, c: Canvas) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(c, null, 2), "utf8");
}

async function createCanvas(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const name = String(args.name ?? "");
  if (!name) throw new Error("name is required");
  const file = canvasFile(vault, name);
  if (fs.existsSync(file)) throw new Error(`Canvas already exists: ${path.relative(vault, file)}`);
  await saveCanvas(file, { nodes: [], edges: [] });
  await maybeAutoCommit(vault, cfg.autoCommit, `canvas: create ${name}`);
  return textResult(`Created ${path.relative(vault, file)}`);
}

async function addNode(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const canvasName = String(args.canvas ?? "main");
  const type = String(args.type) as CanvasNode["type"];
  const file = canvasFile(vault, canvasName);
  const c = await loadCanvas(file);

  const offset = c.nodes.length * 60;
  const node: CanvasNode = {
    id: randomUUID(),
    type,
    x: typeof args.x === "number" ? args.x : 50 + offset,
    y: typeof args.y === "number" ? args.y : 50 + offset,
    width: typeof args.width === "number" ? args.width : 400,
    height: typeof args.height === "number" ? args.height : 200,
  };
  if (type === "text") node.text = String(args.text ?? "");
  if (type === "file") node.file = String(args.file ?? "");
  if (type === "link") node.url = String(args.url ?? "");
  if (args.label) node.label = String(args.label);

  c.nodes.push(node);
  await saveCanvas(file, c);
  await maybeAutoCommit(vault, cfg.autoCommit, `canvas: add ${type} to ${canvasName}`);
  return textResult(`Added ${type} node to ${path.relative(vault, file)} (id ${node.id})`);
}

async function listCanvases(cfg: VaultConfig, args: Record<string, unknown>) {
  const vault = resolveVault(cfg, args.vault as string | undefined);
  ensureVaultExists(vault);
  const dir = path.join(vault, "wiki", "canvases");
  if (!fs.existsSync(dir)) return textResult("No canvases (run canvas_create to make one)");
  const entries = await fsp.readdir(dir);
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".canvas")) continue;
    const c = await loadCanvas(path.join(dir, e));
    lines.push(`${e}  nodes=${c.nodes.length} edges=${c.edges.length}`);
  }
  return textResult(lines.join("\n") || "No canvases");
}
