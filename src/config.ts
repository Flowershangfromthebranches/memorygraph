import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface MemoryGraphConfig {
  dataDir: string;
  databasePath: string;
  host: string;
  port: number;
}

function parsePort(value: string | undefined): number {
  if (!value) return 4765;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`Invalid MEMORYGRAPH_PORT: ${value}`);
  return parsed;
}

export function loadConfig(overrides: Partial<Pick<MemoryGraphConfig, "dataDir" | "host" | "port">> = {}): MemoryGraphConfig {
  const dataDir = resolve(overrides.dataDir ?? process.env.MEMORYGRAPH_DATA_DIR ?? join(homedir(), ".memorygraph"));
  return {
    dataDir,
    databasePath: join(dataDir, "memorygraph.db"),
    host: overrides.host ?? process.env.MEMORYGRAPH_HOST ?? "127.0.0.1",
    port: overrides.port ?? parsePort(process.env.MEMORYGRAPH_PORT),
  };
}

