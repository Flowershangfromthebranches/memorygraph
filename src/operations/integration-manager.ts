import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { stableNodeExecutable } from "./service-manager.js";

export type SupportedAgent = "codex" | "opencode" | "command-code" | "workbuddy" | "trae";

export interface IntegrationPaths {
  opencodeConfig: string;
  opencodeSkillRoot: string;
  codexSkillRoot: string;
  workbuddyConfig: string;
  workbuddySkillRoot: string;
  traeConfigs: string[];
  traeSkillRoots: string[];
  commandCodeSkillRoot: string;
}

export interface IntegrationRuntime {
  nodePath: string;
  cliPath: string;
  dataDir: string;
  skillSource: string;
}

export interface IntegrationStatus {
  agent: SupportedAgent;
  mcpConfigured: boolean;
  skillInstalled: boolean;
  details: string[];
}

type Executor = (command: string, args: string[]) => string;

function defaultExecutor(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
}

function timestamp(): string { return new Date().toISOString().replace(/[:.]/gu, "-"); }

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected JSON object: ${path}`);
  return parsed as Record<string, unknown>;
}

function writeJsonWithBackup(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.memorygraph-backup-${timestamp()}`);
  const temporary = `${path}.memorygraph-tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function updateJsonMcp(path: string, shape: "mcp" | "mcpServers", entry: Record<string, unknown> | null): void {
  const config = readJson(path);
  const existing = config[shape];
  const servers = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing as Record<string, unknown> } : {};
  if (entry) servers.memorygraph = entry;
  else delete servers.memorygraph;
  config[shape] = servers;
  writeJsonWithBackup(path, config);
}

function installSkill(source: string, root: string): void {
  const target = join(root, "memorygraph");
  mkdirSync(root, { recursive: true });
  if (existsSync(target)) renameSync(target, `${target}.memorygraph-backup-${timestamp()}`);
  cpSync(source, target, { recursive: true });
}

function uninstallSkill(root: string): void {
  const target = join(root, "memorygraph");
  if (existsSync(target)) renameSync(target, `${target}.removed-${timestamp()}`);
}

function jsonHasMemoryGraph(path: string, shape: "mcp" | "mcpServers"): boolean {
  try {
    const config = readJson(path);
    const value = config[shape];
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && "memorygraph" in value);
  } catch { return false; }
}

export function defaultIntegrationPaths(): IntegrationPaths {
  const userDirectory = homedir();
  return {
    opencodeConfig: join(userDirectory, ".config", "opencode", "opencode.json"),
    opencodeSkillRoot: join(userDirectory, ".config", "opencode", "skills"),
    codexSkillRoot: join(userDirectory, ".codex", "skills"),
    commandCodeSkillRoot: join(userDirectory, ".commandcode", "skills"),
    workbuddyConfig: join(userDirectory, ".workbuddy", "mcp.json"),
    workbuddySkillRoot: join(userDirectory, ".workbuddy", "skills"),
    traeConfigs: [
      join(userDirectory, "Library", "Application Support", "TRAE SOLO CN", "User", "mcp.json"),
      join(userDirectory, "Library", "Application Support", "Trae CN", "User", "mcp.json"),
    ],
    traeSkillRoots: [join(userDirectory, ".trae-cn", "skills")],
  };
}

export class IntegrationManager {
  constructor(
    private readonly runtime: IntegrationRuntime,
    private readonly paths = defaultIntegrationPaths(),
    private readonly execute: Executor = defaultExecutor,
  ) {}

  install(agent: SupportedAgent): IntegrationStatus {
    const command = [this.runtime.nodePath, this.runtime.cliPath, "mcp", "--data-dir", this.runtime.dataDir];
    const stdio = { command: command[0], args: command.slice(1), env: { MEMORYGRAPH_DATA_DIR: this.runtime.dataDir } };
    if (agent === "codex") {
      installSkill(this.runtime.skillSource, this.paths.codexSkillRoot);
      try { this.execute("codex", ["mcp", "remove", "memorygraph"]); } catch { /* first install */ }
      this.execute("codex", ["mcp", "add", "memorygraph", "--env", `MEMORYGRAPH_DATA_DIR=${this.runtime.dataDir}`, "--", ...command]);
    } else if (agent === "opencode") {
      installSkill(this.runtime.skillSource, this.paths.opencodeSkillRoot);
      updateJsonMcp(this.paths.opencodeConfig, "mcp", { type: "local", command, enabled: true, timeout: 20_000 });
    } else if (agent === "command-code") {
      installSkill(this.runtime.skillSource, this.paths.commandCodeSkillRoot);
      try { this.execute("commandcode", ["mcp", "remove", "--scope", "user", "memorygraph"]); } catch { /* first install */ }
      this.execute("commandcode", ["mcp", "add-json", "--scope", "user", "memorygraph", JSON.stringify({ type: "stdio", ...stdio })]);
    } else if (agent === "workbuddy") {
      installSkill(this.runtime.skillSource, this.paths.workbuddySkillRoot);
      updateJsonMcp(this.paths.workbuddyConfig, "mcpServers", stdio);
    } else if (agent === "trae") {
      for (const root of this.paths.traeSkillRoots) installSkill(this.runtime.skillSource, root);
      for (const config of this.paths.traeConfigs) if (existsSync(config) || existsSync(dirname(config))) updateJsonMcp(config, "mcpServers", stdio);
    }
    return this.status(agent);
  }

  uninstall(agent: SupportedAgent): IntegrationStatus {
    if (agent === "codex") {
      try { this.execute("codex", ["mcp", "remove", "memorygraph"]); } catch { /* already absent */ }
      uninstallSkill(this.paths.codexSkillRoot);
    } else if (agent === "opencode") {
      updateJsonMcp(this.paths.opencodeConfig, "mcp", null);
      uninstallSkill(this.paths.opencodeSkillRoot);
    } else if (agent === "command-code") {
      try { this.execute("commandcode", ["mcp", "remove", "--scope", "user", "memorygraph"]); } catch { /* already absent */ }
      uninstallSkill(this.paths.commandCodeSkillRoot);
    } else if (agent === "workbuddy") {
      updateJsonMcp(this.paths.workbuddyConfig, "mcpServers", null);
      uninstallSkill(this.paths.workbuddySkillRoot);
    } else if (agent === "trae") {
      for (const root of this.paths.traeSkillRoots) uninstallSkill(root);
      for (const config of this.paths.traeConfigs) if (existsSync(config)) updateJsonMcp(config, "mcpServers", null);
    }
    return this.status(agent);
  }

  status(agent: SupportedAgent): IntegrationStatus {
    const details: string[] = [];
    let mcpConfigured = false;
    let skillInstalled = false;
    if (agent === "codex") {
      try { details.push(this.execute("codex", ["mcp", "get", "memorygraph"]).trim()); mcpConfigured = true; } catch { details.push("Codex MCP entry not found"); }
      skillInstalled = existsSync(join(this.paths.codexSkillRoot, "memorygraph", "SKILL.md"));
    } else if (agent === "opencode") {
      mcpConfigured = jsonHasMemoryGraph(this.paths.opencodeConfig, "mcp");
      skillInstalled = existsSync(join(this.paths.opencodeSkillRoot, "memorygraph", "SKILL.md"));
    } else if (agent === "command-code") {
      try { details.push(this.execute("commandcode", ["mcp", "get", "memorygraph"]).trim()); mcpConfigured = true; } catch { details.push("Command Code MCP entry not found"); }
      skillInstalled = existsSync(join(this.paths.commandCodeSkillRoot, "memorygraph", "SKILL.md"));
    } else if (agent === "workbuddy") {
      mcpConfigured = jsonHasMemoryGraph(this.paths.workbuddyConfig, "mcpServers");
      skillInstalled = existsSync(join(this.paths.workbuddySkillRoot, "memorygraph", "SKILL.md"));
    } else {
      mcpConfigured = this.paths.traeConfigs.some((path) => jsonHasMemoryGraph(path, "mcpServers"));
      skillInstalled = this.paths.traeSkillRoots.some((root) => existsSync(join(root, "memorygraph", "SKILL.md")));
    }
    details.push(`MCP ${mcpConfigured ? "configured" : "not configured"}`, `Skill ${skillInstalled ? "installed" : "not installed"}`);
    return { agent, mcpConfigured, skillInstalled, details };
  }
}

export function currentIntegrationRuntime(cliPath: string, dataDir: string): IntegrationRuntime {
  return {
    nodePath: stableNodeExecutable(),
    cliPath: resolve(cliPath),
    dataDir: resolve(dataDir),
    skillSource: resolve(import.meta.dirname, "..", "..", "integrations", "skills", "memorygraph"),
  };
}
