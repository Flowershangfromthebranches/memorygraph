#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createDefaultAdapterRegistry } from "../adapters/registry.js";
import { loadConfig } from "../config.js";
import { MemoryGraphCore } from "../core/memorygraph-core.js";
import { MemoryDatabase } from "../storage/database.js";
import { buildMcpServer } from "./server.js";

const config = loadConfig();
const database = new MemoryDatabase(config.databasePath);
const core = new MemoryGraphCore(database, createDefaultAdapterRegistry(database));
const handle = serveStdio(() => buildMcpServer(core), {
  onerror: (error) => console.error(`[memorygraph] ${error.message}`),
});

async function shutdown(): Promise<void> {
  await handle.close();
  database.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
