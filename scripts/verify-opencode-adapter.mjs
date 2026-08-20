import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { OpenCodeAdapter } from "../dist/adapters/opencode-adapter.js";
import { MemoryDatabase } from "../dist/storage/database.js";

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const sourcePath = resolve(process.argv[3] ?? `${process.env.USERPROFILE ?? ""}/.local/share/opencode/opencode.db`);
const temporary = mkdtempSync(join(tmpdir(), "memorygraph-opencode-verification-"));
const database = new MemoryDatabase(join(temporary, "memorygraph.db"));

try {
  const project = database.createProject({ name: "OpenCode verification", slug: "opencode-verification", root: projectRoot });
  const adapter = new OpenCodeAdapter(database, sourcePath);
  const first = adapter.sync(project);
  const second = adapter.sync(project);
  const events = database.recentEvents(project.projectId, 2_000);
  const byKind = Object.fromEntries([...new Set(events.map((event) => event.kind))].sort().map((kind) => [kind, events.filter((event) => event.kind === kind).length]));
  process.stdout.write(`${JSON.stringify({
    source: "real OpenCode SQLite session store",
    projectRoot,
    firstSync: { scanned: first.scanned, ingested: first.ingested, skipped: first.skipped },
    secondSync: { scanned: second.scanned, ingested: second.ingested, skipped: second.skipped },
    eventKinds: byKind,
    idempotent: second.ingested === 0,
  }, null, 2)}\n`);
} finally {
  database.close();
  rmSync(temporary, { recursive: true, force: true });
}

