import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { MemoryDatabase } from "../src/storage/database.js";

const enabled = process.env.PERFORMANCE_TEST === "1";
const temporary = enabled ? mkdtempSync(join(tmpdir(), "memorygraph-performance-")) : "";
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe.skipIf(!enabled)("performance budget", () => {
  it("ingests 5,000 events and returns an FTS result within the local budget", () => {
    const database = new MemoryDatabase(join(temporary, "memorygraph.db"));
    const project = database.createProject({ name: "Performance", slug: "performance", root: join(temporary, "project") });
    const ingestStarted = performance.now();
    for (let index = 0; index < 5_000; index += 1) {
      database.appendEvent({
        projectId: project.projectId,
        agentId: index % 2 === 0 ? "codex" : "opencode",
        kind: "message",
        occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
        sourceUri: `performance://event/${index}`,
        dedupeKey: `performance-${index}`,
        summary: index === 4_321 ? "distinctive temporal projection benchmark needle" : `event ${index} routine project progress`,
        payload: { index, status: "active" },
      });
    }
    const ingestMs = performance.now() - ingestStarted;
    const searchStarted = performance.now();
    const hits = database.search(project.projectId, "distinctive benchmark needle", 10);
    const searchMs = performance.now() - searchStarted;
    expect(hits[0]?.title).toContain("distinctive temporal projection benchmark needle");
    expect(ingestMs).toBeLessThan(15_000);
    expect(searchMs).toBeLessThan(500);
    database.close();
  }, 20_000);
});

