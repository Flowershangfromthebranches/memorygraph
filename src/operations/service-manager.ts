import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ServiceDefinition {
  nodePath: string;
  cliPath: string;
  dataDir: string;
  host: string;
  port: number;
}

export interface ServiceStatus {
  platform: string;
  installed: boolean;
  running: boolean;
  definitionPath: string;
  detail: string;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function macPath(): string { return join(homedir(), "Library", "LaunchAgents", "app.memorygraph.core.plist"); }
function linuxPath(): string { return join(homedir(), ".config", "systemd", "user", "memorygraph.service"); }

function definitionPath(): string {
  if (platform() === "darwin") return macPath();
  if (platform() === "linux") return linuxPath();
  return join(homedir(), ".memorygraph", "memorygraph-task.txt");
}

function macPlist(definition: ServiceDefinition): string {
  const stdout = join(definition.dataDir, "logs", "core.stdout.log");
  const stderr = join(definition.dataDir, "logs", "core.stderr.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.memorygraph.core</string>
  <key>ProgramArguments</key><array>
    <string>${xml(definition.nodePath)}</string><string>${xml(definition.cliPath)}</string><string>serve</string>
    <string>--data-dir</string><string>${xml(definition.dataDir)}</string>
    <string>--host</string><string>${xml(definition.host)}</string>
    <string>--port</string><string>${definition.port}</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict></plist>
`;
}

function linuxUnit(definition: ServiceDefinition): string {
  return `[Unit]
Description=MemoryGraph local core
After=graphical-session.target

[Service]
Type=simple
ExecStart=${definition.nodePath} ${definition.cliPath} serve --data-dir ${definition.dataDir} --host ${definition.host} --port ${definition.port}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export class ServiceManager {
  install(definition: ServiceDefinition): ServiceStatus {
    mkdirSync(join(definition.dataDir, "logs"), { recursive: true });
    const target = definitionPath();
    mkdirSync(dirname(target), { recursive: true });
    if (platform() === "darwin") {
      if (existsSync(target)) {
        try { execFileSync("launchctl", ["bootout", `gui/${userInfo().uid}`, target], { stdio: "ignore" }); } catch { /* not loaded */ }
      }
      writeFileSync(target, macPlist(definition), "utf8");
      execFileSync("launchctl", ["bootstrap", `gui/${userInfo().uid}`, target]);
    } else if (platform() === "linux") {
      writeFileSync(target, linuxUnit(definition), "utf8");
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      execFileSync("systemctl", ["--user", "enable", "--now", "memorygraph.service"]);
    } else if (platform() === "win32") {
      const taskCommand = `\"${definition.nodePath}\" \"${definition.cliPath}\" serve --data-dir \"${definition.dataDir}\" --host ${definition.host} --port ${definition.port}`;
      writeFileSync(target, taskCommand, "utf8");
      execFileSync("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", "MemoryGraph Core", "/TR", taskCommand]);
      execFileSync("schtasks", ["/Run", "/TN", "MemoryGraph Core"]);
    } else {
      throw new Error(`Unsupported service platform: ${platform()}`);
    }
    return this.status();
  }

  uninstall(): ServiceStatus {
    const target = definitionPath();
    if (platform() === "darwin" && existsSync(target)) {
      try { execFileSync("launchctl", ["bootout", `gui/${userInfo().uid}`, target], { stdio: "ignore" }); } catch { /* already stopped */ }
      unlinkSync(target);
    } else if (platform() === "linux") {
      try { execFileSync("systemctl", ["--user", "disable", "--now", "memorygraph.service"]); } catch { /* already stopped */ }
      if (existsSync(target)) unlinkSync(target);
      execFileSync("systemctl", ["--user", "daemon-reload"]);
    } else if (platform() === "win32") {
      try { execFileSync("schtasks", ["/Delete", "/F", "/TN", "MemoryGraph Core"]); } catch { /* already removed */ }
      if (existsSync(target)) unlinkSync(target);
    }
    return this.status();
  }

  status(): ServiceStatus {
    const target = definitionPath();
    let running = false;
    let detail = existsSync(target) ? "installed" : "not installed";
    try {
      if (platform() === "darwin") {
        detail = execFileSync("launchctl", ["print", `gui/${userInfo().uid}/app.memorygraph.core`], { encoding: "utf8", timeout: 3_000 });
        running = /state\s*=\s*running/u.test(detail);
      } else if (platform() === "linux") {
        detail = execFileSync("systemctl", ["--user", "is-active", "memorygraph.service"], { encoding: "utf8", timeout: 3_000 }).trim();
        running = detail === "active";
      } else if (platform() === "win32") {
        detail = execFileSync("schtasks", ["/Query", "/TN", "MemoryGraph Core", "/FO", "LIST"], { encoding: "utf8", timeout: 3_000 });
        running = /Running/iu.test(detail);
      }
    } catch (error) {
      detail = error instanceof Error ? error.message.split("\n")[0] ?? detail : detail;
    }
    return { platform: platform(), installed: existsSync(target), running, definitionPath: target, detail: detail.slice(0, 2_000) };
  }

  readDefinition(): string | null {
    const target = definitionPath();
    return existsSync(target) ? readFileSync(target, "utf8") : null;
  }
}

export function currentServiceDefinition(cliPath: string, dataDir: string, host: string, port: number): ServiceDefinition {
  return { nodePath: process.execPath, cliPath: resolve(cliPath), dataDir: resolve(dataDir), host, port };
}

