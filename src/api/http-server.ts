import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import { MemoryGraphCore } from "../core/memorygraph-core.js";
import { EDGE_TYPES, type EdgeType } from "../domain/types.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 1_048_576) throw new Error("Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${key}`);
  return value;
}

function allowDevOrigin(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin === "http://127.0.0.1:4766" || origin === "http://localhost:4766" || origin === "tauri://localhost" || origin === "http://tauri.localhost") {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  }
}

function serveStatic(pathname: string, webRoot: string, response: ServerResponse): boolean {
  const root = resolve(webRoot);
  const requested = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  let candidate = resolve(root, requested);
  if (!candidate.startsWith(`${root}${sep}`) && candidate !== root) return false;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) candidate = join(root, "index.html");
  if (!existsSync(candidate)) return false;
  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream",
    "cache-control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(candidate).pipe(response);
  return true;
}

export interface HttpServerOptions {
  webRoot?: string;
}

export function createMemoryGraphHttpServer(core: MemoryGraphCore, options: HttpServerOptions = {}): Server {
  return createServer(async (request, response) => {
    allowDevOrigin(request, response);
    const host = request.headers.host ?? "";
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host)) {
      json(response, 421, { error: "misdirected_request", message: "MemoryGraph accepts only loopback Host headers." });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { status: "ok", service: "memorygraph", version: "0.1.0", database: core.database.path });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        json(response, 200, { projects: core.database.listProjects() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/graph") {
        json(response, 200, core.database.graph(url.searchParams.get("projectId") ?? undefined));
        return;
      }
      const diffMatch = /^\/api\/projects\/([^/]+)\/diff$/u.exec(url.pathname);
      if (request.method === "GET" && diffMatch) {
        const projectId = decodeURIComponent(diffMatch[1] ?? "");
        const project = core.database.getProject(projectId);
        if (!project) { json(response, 404, { error: "project_not_found" }); return; }
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to") ?? new Date().toISOString();
        if (!from || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new Error("Valid from and to timestamps are required");
        json(response, 200, { project, ...core.database.diffState(projectId, from, to) });
        return;
      }
      const projectMatch = /^\/api\/projects\/([^/]+)\/(state|events|timeline|handoffs|state-history|privacy)$/u.exec(url.pathname);
      if (request.method === "GET" && projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1] ?? "");
        const project = core.database.getProject(projectId);
        if (!project) {
          json(response, 404, { error: "project_not_found" });
          return;
        }
        if (projectMatch[2] === "privacy") {
          json(response, 200, { project, policy: core.database.getPrivacyPolicy(projectId) });
        } else if (projectMatch[2] === "state") {
          const workTypes = new Set(["Workstream", "Requirement", "Task", "Issue", "Milestone"]);
          json(response, 200, {
            project,
            state: core.database.currentState(projectId),
            activeWork: core.database.activeNodes(projectId, 500).filter((node) => workTypes.has(node.type)),
            decisions: core.database.recentDecisions(projectId),
          });
        } else if (projectMatch[2] === "handoffs") {
          json(response, 200, { project, handoffs: core.database.listHandoffs(projectId) });
        } else if (projectMatch[2] === "state-history") {
          json(response, 200, { project, stateHistory: core.database.stateHistory(projectId) });
        } else {
          json(response, 200, { project, events: core.database.recentEvents(projectId, 200) });
        }
        return;
      }
      const privacyMatch = /^\/api\/projects\/([^/]+)\/privacy$/u.exec(url.pathname);
      if (request.method === "POST" && privacyMatch) {
        const projectId = decodeURIComponent(privacyMatch[1] ?? "");
        const project = core.database.getProject(projectId);
        if (!project) { json(response, 404, { error: "project_not_found" }); return; }
        const body = await readJson(request);
        json(response, 200, { project, policy: core.database.setPrivacyPolicy({
          projectId,
          ...(typeof body.store_message_content === "boolean" ? { storeMessageContent: body.store_message_content } : {}),
          ...(typeof body.max_message_chars === "number" ? { maxMessageChars: body.max_message_chars } : {}),
          ...(Array.isArray(body.excluded_paths) ? { excludedPathPatterns: body.excluded_paths.filter((value): value is string => typeof value === "string") } : {}),
        }) });
        return;
      }
      const evidenceMatch = /^\/api\/nodes\/([^/]+)\/evidence$/u.exec(url.pathname);
      if (request.method === "GET" && evidenceMatch) {
        json(response, 200, { evidence: core.database.nodeEvidence(decodeURIComponent(evidenceMatch[1] ?? "")) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/projects/resolve") {
        const body = await readJson(request);
        json(response, 200, core.resolveProject(requiredString(body, "cwd"), body.create_if_missing !== false, typeof body.name === "string" ? body.name : undefined));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/sync") {
        json(response, 200, { projects: core.syncAllProjects() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/projects/link") {
        const body = await readJson(request);
        const relation = requiredString(body, "relation");
        if (!EDGE_TYPES.includes(relation as EdgeType)) throw new Error(`Unsupported relation: ${relation}`);
        json(response, 200, core.linkProjects({
          sourceCwd: requiredString(body, "source_cwd"),
          targetCwd: requiredString(body, "target_cwd"),
          relation: relation as EdgeType,
          ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
          ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/resume") {
        const body = await readJson(request);
        json(response, 200, core.resumeProject({
          cwd: requiredString(body, "cwd"),
          receivingAgent: requiredString(body, "receiving_agent"),
          ...(typeof body.token_budget === "number" ? { tokenBudget: body.token_budget } : {}),
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/search") {
        const body = await readJson(request);
        json(response, 200, core.search(requiredString(body, "cwd"), requiredString(body, "query"), typeof body.limit === "number" ? body.limit : 20));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/remember") {
        const body = await readJson(request);
        const kind = requiredString(body, "kind");
        if (!["fact", "state", "decision", "issue", "task", "requirement", "milestone", "note"].includes(kind)) throw new Error(`Unsupported kind: ${kind}`);
        json(response, 200, core.remember({
          cwd: requiredString(body, "cwd"),
          agent: requiredString(body, "agent"),
          kind: kind as Parameters<MemoryGraphCore["remember"]>[0]["kind"],
          title: requiredString(body, "title"),
          content: requiredString(body, "content"),
          ...(typeof body.key === "string" ? { key: body.key } : {}),
          ...(body.value === undefined ? {} : { value: body.value }),
          ...(typeof body.source_uri === "string" ? { sourceUri: body.source_uri } : {}),
        }));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (options.webRoot && serveStatic(url.pathname, options.webRoot, response)) return;
      json(response, 404, { error: "ui_not_built", message: "Run npm run build:web." });
    } catch (error) {
      json(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
