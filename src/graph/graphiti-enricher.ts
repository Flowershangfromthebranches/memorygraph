import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { MemoryEvent, ProjectIdentity } from "../domain/types.js";

export interface GraphitiEnricherOptions {
  url: string;
  verificationTimeoutMs?: number;
}

export class GraphitiEnricher {
  constructor(private readonly options: GraphitiEnricherOptions) {}

  async addEpisode(project: ProjectIdentity, event: MemoryEvent): Promise<void> {
    const client = new Client({ name: "memorygraph-graphiti-bridge", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.options.url));
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "add_memory",
        arguments: {
          name: `${event.kind}: ${event.summary}`,
          episode_body: JSON.stringify({ summary: event.summary, kind: event.kind, agent: event.agentId, payload: event.payload }),
          group_id: project.projectId,
          source: "json",
          source_description: event.sourceUri,
          uuid: event.id,
          reference_time: event.occurredAt,
        },
      });
      if (result.isError) throw new Error(`Graphiti rejected episode ${event.id}`);
      const deadline = Date.now() + (this.options.verificationTimeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        const listed = await client.callTool({ name: "get_episodes", arguments: { group_ids: [project.projectId], max_episodes: 100 } });
        if (!listed.isError) {
          const structured = listed.structuredContent;
          const episodes = structured && typeof structured === "object" && Array.isArray((structured as Record<string, unknown>).episodes)
            ? (structured as Record<string, unknown>).episodes as unknown[]
            : [];
          if (episodes.some((episode) => episode && typeof episode === "object" && (episode as Record<string, unknown>).uuid === event.id)) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`Graphiti queued episode ${event.id} but it was not observable before the verification timeout`);
    } finally {
      await client.close();
    }
  }
}
