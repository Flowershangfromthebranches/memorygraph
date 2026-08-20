#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import BetterSqlite3 from "better-sqlite3";

import { createDefaultAdapterRegistry } from "./adapters/registry.js";
import { createMemoryGraphHttpServer } from "./api/http-server.js";
import { loadConfig } from "./config.js";
import { MemoryGraphCore } from "./core/memorygraph-core.js";
import { EDGE_TYPES, type EdgeType, type EntityStatus } from "./domain/types.js";
import { buildMcpServer } from "./mcp/server.js";
import { Neo4jProjection } from "./graph/neo4j-projection.js";
import { GraphReplayer } from "./graph/replayer.js";
import { currentServiceDefinition, ServiceManager } from "./operations/service-manager.js";
import { currentIntegrationRuntime, IntegrationManager, type SupportedAgent } from "./operations/integration-manager.js";
import { MemoryDatabase } from "./storage/database.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []);
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function printHelp(): void {
  process.stdout.write(`MemoryGraph\n\nUsage:\n  memorygraph init [cwd] [--name NAME] [--data-dir DIR]\n  memorygraph root add <root> --project-id ID [--primary]\n  memorygraph remember [cwd] --agent AGENT --kind KIND --title TITLE --content TEXT [--key KEY] [--value JSON] [--status STATUS]\n  memorygraph link <source-cwd> <target-cwd> --relation RELATION\n  memorygraph privacy [cwd] [--store-message-content true|false] [--max-message-chars N] [--exclude PATTERN]\n  memorygraph sync [cwd] [--data-dir DIR]\n  memorygraph resume [cwd] --agent AGENT [--project-id ID] [--token-budget N] [--data-dir DIR]\n  memorygraph replay [cwd] [--data-dir DIR]\n  memorygraph export [cwd] --output FILE [--data-dir DIR]\n  memorygraph project-neo4j [cwd] [--data-dir DIR]\n  memorygraph backup --output FILE [--data-dir DIR]\n  memorygraph restore --input FILE [--data-dir DIR]\n  memorygraph service <install|status|uninstall> [--data-dir DIR]\n  memorygraph integration <install|status|uninstall> --agent <codex|opencode|command-code|workbuddy|trae|all>\n  memorygraph serve [--host HOST] [--port PORT] [--data-dir DIR]\n  memorygraph mcp [--data-dir DIR]\n  memorygraph doctor [--data-dir DIR]\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const dataDir = option(args, "--data-dir");
  const host = option(args, "--host");
  const portText = option(args, "--port");
  const port = portText ? Number.parseInt(portText, 10) : undefined;
  const config = loadConfig({
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  });
  const database = new MemoryDatabase(config.databasePath);
  const core = new MemoryGraphCore(database, createDefaultAdapterRegistry(database));

  if (command === "init") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const project = core.resolveProject(cwd, true, option(args, "--name"));
    process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "root") {
    if (args[1] !== "add" || !args[2]) throw new Error("Usage: memorygraph root add <root> --project-id ID [--primary]");
    const projectId = option(args, "--project-id");
    if (!projectId) throw new Error("--project-id is required");
    process.stdout.write(`${JSON.stringify(core.attachProjectRoot(projectId, resolve(args[2]), args.includes("--primary")), null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "resume") {
    const projectId = option(args, "--project-id");
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const agent = option(args, "--agent");
    if (!agent) throw new Error("--agent is required");
    const tokenBudgetText = option(args, "--token-budget");
    const context = projectId
      ? core.resumeProjectById({ projectId, receivingAgent: agent, ...(tokenBudgetText ? { tokenBudget: Number.parseInt(tokenBudgetText, 10) } : {}) })
      : core.resumeProject({ cwd, receivingAgent: agent, ...(tokenBudgetText ? { tokenBudget: Number.parseInt(tokenBudgetText, 10) } : {}) });
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "remember") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const agent = option(args, "--agent");
    const kind = option(args, "--kind");
    const title = option(args, "--title");
    const content = option(args, "--content");
    const status = option(args, "--status") ?? "active";
    if (!agent || !kind || !title || !content) throw new Error("--agent, --kind, --title, and --content are required");
    if (!["fact", "state", "decision", "issue", "task", "requirement", "milestone", "note"].includes(kind)) throw new Error(`Unsupported kind: ${kind}`);
    if (!["planned", "active", "blocked", "complete", "deprecated"].includes(status)) throw new Error(`Unsupported status: ${status}`);
    const key = option(args, "--key");
    const valueText = option(args, "--value");
    const remembered = core.remember({
      cwd,
      agent,
      kind: kind as Parameters<MemoryGraphCore["remember"]>[0]["kind"],
      title,
      content,
      status: status as EntityStatus,
      ...(key ? { key } : {}),
      ...(valueText ? { value: JSON.parse(valueText) as unknown } : {}),
      sourceUri: `manual://cli/${agent}`,
    });
    process.stdout.write(`${JSON.stringify(remembered, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "sync") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    process.stdout.write(`${JSON.stringify(core.syncProject(cwd), null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "link") {
    const sourceCwd = args[1];
    const targetCwd = args[2];
    const relation = option(args, "--relation");
    if (!sourceCwd || !targetCwd || !relation) throw new Error("source-cwd, target-cwd, and --relation are required");
    if (!EDGE_TYPES.includes(relation as EdgeType)) throw new Error(`Unsupported relation: ${relation}`);
    process.stdout.write(`${JSON.stringify(core.linkProjects({ sourceCwd, targetCwd, relation: relation as EdgeType, agent: "cli" }), null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "privacy") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const project = core.resolveProject(cwd, false);
    const storeText = option(args, "--store-message-content");
    const maxText = option(args, "--max-message-chars");
    const excluded = options(args, "--exclude");
    if (storeText !== undefined && storeText !== "true" && storeText !== "false") throw new Error("--store-message-content must be true or false");
    if (maxText !== undefined && (!Number.isInteger(Number(maxText)) || Number(maxText) < 200 || Number(maxText) > 20_000)) throw new Error("--max-message-chars must be an integer from 200 to 20000");
    const changed = storeText !== undefined || maxText !== undefined || excluded.length > 0;
    const policy = changed ? database.setPrivacyPolicy({
      projectId: project.projectId,
      ...(storeText === undefined ? {} : { storeMessageContent: storeText === "true" }),
      ...(maxText === undefined ? {} : { maxMessageChars: Number.parseInt(maxText, 10) }),
      ...(excluded.length === 0 ? {} : { excludedPathPatterns: excluded }),
    }) : database.getPrivacyPolicy(project.projectId);
    process.stdout.write(`${JSON.stringify({ project, policy }, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "replay") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const project = core.resolveProject(cwd, false);
    process.stdout.write(`${JSON.stringify(new GraphReplayer(database).rebuildProject(project.projectId), null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "export") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const output = option(args, "--output");
    if (!output) throw new Error("--output is required");
    const project = core.resolveProject(cwd, false);
    const target = resolve(output);
    writeFileSync(target, `${JSON.stringify(database.exportProject(project.projectId), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`${JSON.stringify({ projectId: project.projectId, exported: target }, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "project-neo4j") {
    const cwd = resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
    const project = core.resolveProject(cwd, false);
    const password = process.env.NEO4J_PASSWORD;
    if (!password) throw new Error("NEO4J_PASSWORD is required");
    const projection = new Neo4jProjection(database, {
      uri: process.env.NEO4J_URI ?? "bolt://127.0.0.1:7687",
      username: process.env.NEO4J_USER ?? "neo4j",
      password,
      database: process.env.NEO4J_DATABASE ?? "neo4j",
    });
    try {
      await projection.verify();
      process.stdout.write(`${JSON.stringify(await projection.rebuildProject(project.projectId), null, 2)}\n`);
    } finally {
      await projection.close();
      database.close();
    }
    return;
  }

  if (command === "backup") {
    const output = option(args, "--output");
    if (!output) throw new Error("--output is required");
    process.stdout.write(`${JSON.stringify({ backup: await database.backup(output) }, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === "restore") {
    const input = option(args, "--input");
    if (!input) throw new Error("--input is required");
    const source = resolve(input);
    if (!existsSync(source)) throw new Error(`Backup not found: ${source}`);
    if (source === config.databasePath) throw new Error("--input must point to a backup, not the active database");
    const validation = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
    try { validation.prepare("SELECT max(version) FROM schema_migrations").get(); }
    finally { validation.close(); }
    const serviceManager = new ServiceManager();
    const serviceStatus = serviceManager.status();
    const cliPath = process.argv[1] ?? resolve(import.meta.dirname, "cli.js");
    const serviceDefinition = currentServiceDefinition(cliPath, config.dataDir, config.host, config.port);
    if (serviceStatus.installed) serviceManager.uninstall();
    database.close();
    const recovery = `${config.databasePath}.pre-restore-${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
    try {
      if (existsSync(config.databasePath)) renameSync(config.databasePath, recovery);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${config.databasePath}${suffix}`)) renameSync(`${config.databasePath}${suffix}`, `${recovery}${suffix}`);
      }
      copyFileSync(source, config.databasePath);
    } catch (error) {
      if (existsSync(recovery)) copyFileSync(recovery, config.databasePath);
      throw error;
    } finally {
      if (serviceStatus.installed) serviceManager.install(serviceDefinition);
    }
    process.stdout.write(`${JSON.stringify({ restored: config.databasePath, previousDatabase: recovery, serviceRestarted: serviceStatus.installed }, null, 2)}\n`);
    return;
  }

  if (command === "service") {
    const action = args[1] ?? "status";
    const manager = new ServiceManager();
    database.close();
    if (action === "install") {
      const cliPath = process.argv[1] ?? resolve(import.meta.dirname, "cli.js");
      process.stdout.write(`${JSON.stringify(manager.install(currentServiceDefinition(cliPath, config.dataDir, config.host, config.port)), null, 2)}\n`);
    } else if (action === "uninstall") {
      process.stdout.write(`${JSON.stringify(manager.uninstall(), null, 2)}\n`);
    } else if (action === "status") {
      process.stdout.write(`${JSON.stringify(manager.status(), null, 2)}\n`);
    } else {
      throw new Error(`Unsupported service action: ${action}`);
    }
    return;
  }

  if (command === "integration") {
    const action = args[1] ?? "status";
    const agentOption = option(args, "--agent") ?? "all";
    const supported: SupportedAgent[] = ["codex", "opencode", "command-code", "workbuddy", "trae"];
    const agents = agentOption === "all" ? supported : supported.filter((agent) => agent === agentOption);
    if (agents.length === 0) throw new Error(`Unsupported agent: ${agentOption}`);
    const cliPath = process.argv[1] ?? resolve(import.meta.dirname, "cli.js");
    const manager = new IntegrationManager(currentIntegrationRuntime(cliPath, config.dataDir));
    database.close();
    const statuses = agents.map((agent) => {
      if (action === "install") return manager.install(agent);
      if (action === "uninstall") return manager.uninstall(agent);
      if (action === "status") return manager.status(agent);
      throw new Error(`Unsupported integration action: ${action}`);
    });
    process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
    return;
  }

  if (command === "serve") {
    const webRoot = resolve(join(import.meta.dirname, "..", "web-dist"));
    const server = createMemoryGraphHttpServer(core, { ...(existsSync(webRoot) ? { webRoot } : {}) });
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolveListening);
    });
    process.stdout.write(`MemoryGraph listening at http://${config.host}:${config.port}\n`);
    const shutdown = () => server.close(() => { database.close(); process.exit(0); });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  if (command === "mcp") {
    const handle = serveStdio(() => buildMcpServer(core), {
      onerror: (error) => console.error(`[memorygraph] ${error.message}`),
    });
    const shutdown = async () => {
      await handle.close();
      database.close();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return;
  }

  if (command === "doctor") {
    const userDirectory = homedir();
    const quickCheckRow = database.db.prepare("PRAGMA quick_check").get();
    const databaseIntegrity = quickCheckRow ? String(Object.values(quickCheckRow)[0]) : "no result";
    const commands = { git: commandAvailable("git"), docker: commandAvailable("docker"), node: commandAvailable("node") };
    const sources = {
      codex: existsSync(join(userDirectory, ".codex", "sessions")),
      opencode: existsSync(join(userDirectory, ".local", "share", "opencode")),
      commandCode: existsSync(join(userDirectory, ".commandcode")),
      workBuddy: existsSync(join(userDirectory, ".workbuddy", "projects")),
      trae: existsSync(join(userDirectory, "Library", "Application Support", "Trae CN")) || existsSync(join(userDirectory, "Library", "Application Support", "TRAE SOLO CN")),
    };
    const service = new ServiceManager().status();
    const warnings = [
      ...(!commands.docker ? ["Docker is unavailable; Neo4j projection remains optional and offline."] : []),
      ...(!service.installed ? ["The background Core service is not installed."] : !service.running ? ["The background Core service is installed but not running."] : []),
      ...Object.entries(sources).filter(([, available]) => !available).map(([agent]) => `${agent} passive source was not found.`),
    ];
    process.stdout.write(`${JSON.stringify({
      ok: databaseIntegrity === "ok" && commands.git && commands.node,
      database: config.databasePath,
      databaseIntegrity,
      commands,
      adapterSources: sources,
      uiBuilt: existsSync(resolve(join(import.meta.dirname, "..", "web-dist", "index.html"))),
      service: { installed: service.installed, running: service.running, definitionPath: service.definitionPath },
      warnings,
    }, null, 2)}\n`);
    database.close();
    return;
  }

  database.close();
  printHelp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
