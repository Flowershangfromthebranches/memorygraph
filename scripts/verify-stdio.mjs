import { resolve } from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cwd = resolve(process.argv[2] ?? process.cwd());
const dataDir = resolve(process.argv[3] ?? ".memorygraph-dev");
const receivingAgent = process.argv[4] ?? "stdio-verifier";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/cli.js"), "mcp", "--data-dir", dataDir],
  stderr: "pipe",
});
const client = new Client({ name: "memorygraph-stdio-verifier", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const resumed = await client.callTool({
    name: "resume_project",
    arguments: { cwd, receiving_agent: receivingAgent, token_budget: 1_500 },
  });
  if (resumed.isError) throw new Error("resume_project returned an MCP error");
  const payload = resumed.structuredContent ?? {};
  const project = payload.project && typeof payload.project === "object" ? payload.project : {};
  process.stdout.write(`${JSON.stringify({
    transport: "stdio",
    receivingAgent,
    tools: tools.tools.map((tool) => tool.name).sort(),
    projectId: project.projectId ?? null,
    handoffId: payload.handoffId ?? null,
    previousAgent: payload.previousAgent ?? null,
    estimatedTokens: payload.estimatedTokens ?? null,
    sync: payload.sync ?? [],
  }, null, 2)}\n`);
} finally {
  await client.close();
}
