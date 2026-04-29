#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfigFromArgv } from "./lib/vaults.js";
import { startVaultWatchers, stopVaultWatchers, watcherLog } from "./lib/watcher.js";
import { tools, callTool } from "./tools/index.js";
import { prompts, getPrompt } from "./prompts/index.js";
import { resources, readResource } from "./resources/index.js";

const cfg = loadConfigFromArgv(process.argv);

const bootMsg =
  `boot vaults=${cfg.vaults.length} active=${cfg.active ?? "(none)"} ` +
  `autoCommit=${cfg.autoCommit} autoWatch=${cfg.autoWatch} pid=${process.pid}`;
process.stderr.write(`[boot] ${bootMsg}\n`);
for (const v of cfg.vaults) watcherLog(v, bootMsg);

startVaultWatchers(cfg.vaults, cfg.autoWatch);
const shutdown = async () => {
  await stopVaultWatchers();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const server = new Server(
  { name: "obsidian-claude-accenture", version: "0.3.0" },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await callTool(cfg, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: (err as Error).message }],
    };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  return getPrompt(cfg, req.params.name, (req.params.arguments ?? {}) as Record<string, string>);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources(cfg) }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  return readResource(cfg, req.params.uri);
});

const transport = new StdioServerTransport();
await server.connect(transport);
