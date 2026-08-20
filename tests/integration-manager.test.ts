import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IntegrationManager, type IntegrationPaths, type IntegrationRuntime } from "../src/operations/integration-manager.js";
import { renderLinuxUnit } from "../src/operations/service-manager.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memorygraph-integrations-"));
  cleanup.push(root);
  const skillSource = join(root, "source-skill");
  mkdirSync(skillSource, { recursive: true });
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: memorygraph\ndescription: test\n---\n");
  const paths: IntegrationPaths = {
    opencodeConfig: join(root, "opencode.json"),
    opencodeSkillRoot: join(root, "opencode-skills"),
    codexSkillRoot: join(root, "codex-skills"),
    commandCodeSkillRoot: join(root, "command-skills"),
    workbuddyConfig: join(root, "workbuddy.json"),
    workbuddySkillRoot: join(root, "workbuddy-skills"),
    traeConfigs: [join(root, "trae", "mcp.json")],
    traeSkillRoots: [join(root, "trae-skills")],
  };
  mkdirSync(join(root, "trae"), { recursive: true });
  writeFileSync(paths.opencodeConfig, JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { keep: true } }));
  writeFileSync(paths.workbuddyConfig, JSON.stringify({ mcpServers: { retained: { command: "keep" } } }));
  writeFileSync(paths.traeConfigs[0]!, JSON.stringify({ mcpServers: {} }));
  const runtime: IntegrationRuntime = { nodePath: "/usr/bin/node", cliPath: "/opt/memorygraph/cli.js", dataDir: "/data/memorygraph", skillSource };
  const installed = new Set<string>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const execute = (command: string, args: string[]) => {
    calls.push({ command, args });
    const action = args.includes("add") || args.includes("add-json") ? "add" : args.includes("remove") ? "remove" : "get";
    const key = `${command}:memorygraph`;
    if (action === "add") installed.add(key);
    if (action === "remove") installed.delete(key);
    if (action === "get" && !installed.has(key)) throw new Error("not found");
    return installed.has(key) ? "memorygraph configured" : "";
  };
  return { root, paths, runtime, calls, manager: new IntegrationManager(runtime, paths, execute) };
}

describe("IntegrationManager", () => {
  it("quotes Linux service paths that contain spaces", () => {
    const unit = renderLinuxUnit({
      nodePath: "/opt/node bin/node",
      cliPath: "/Users/example/New project/memorygraph/dist/cli.js",
      dataDir: "/Users/example/Library/Application Support/MemoryGraph",
      host: "127.0.0.1",
      port: 4765,
    });
    expect(unit).toContain('ExecStart="/opt/node bin/node" "/Users/example/New project/memorygraph/dist/cli.js"');
    expect(unit).toContain('--data-dir "/Users/example/Library/Application Support/MemoryGraph"');
  });

  it("installs and recoverably removes OpenCode MCP plus Skill without overwriting unrelated config", () => {
    const { manager, paths } = fixture();
    const installed = manager.install("opencode");
    expect(installed.mcpConfigured).toBe(true);
    expect(installed.skillInstalled).toBe(true);
    const config = JSON.parse(readFileSync(paths.opencodeConfig, "utf8")) as Record<string, any>;
    expect(config.provider.keep).toBe(true);
    expect(config.mcp.memorygraph.command).toEqual(["/usr/bin/node", "/opt/memorygraph/cli.js", "mcp", "--data-dir", "/data/memorygraph"]);

    const removed = manager.uninstall("opencode");
    expect(removed.mcpConfigured).toBe(false);
    expect(removed.skillInstalled).toBe(false);
    expect(existsSync(paths.opencodeSkillRoot)).toBe(true);
  });

  it("uses native CLI registration for Codex and Command Code", () => {
    const { manager, calls } = fixture();
    expect(manager.install("codex").mcpConfigured).toBe(true);
    expect(manager.install("codex").mcpConfigured).toBe(true);
    expect(manager.install("command-code").mcpConfigured).toBe(true);
    expect(calls.some((call) => call.command === "codex" && call.args.slice(0, 3).join(" ") === "mcp add memorygraph")).toBe(true);
    expect(calls.some((call) => call.command === "commandcode" && call.args.includes("add-json"))).toBe(true);
  });

  it("preserves existing WorkBuddy entries and configures Trae", () => {
    const { manager, paths } = fixture();
    manager.install("workbuddy");
    manager.install("trae");
    const workbuddy = JSON.parse(readFileSync(paths.workbuddyConfig, "utf8")) as Record<string, any>;
    const trae = JSON.parse(readFileSync(paths.traeConfigs[0]!, "utf8")) as Record<string, any>;
    expect(workbuddy.mcpServers.retained.command).toBe("keep");
    expect(workbuddy.mcpServers.memorygraph.command).toBe("/usr/bin/node");
    expect(trae.mcpServers.memorygraph.args).toContain("mcp");
  });
});
