import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";

import type { GraphData, GraphNode } from "../types";

const TYPE_COLORS: Record<string, string> = {
  Project: "#ff6b47",
  Workstream: "#f4b942",
  Task: "#37b99c",
  Decision: "#7c68ee",
  Fact: "#9256a6",
  Issue: "#e55757",
  State: "#2b82d9",
  Agent: "#1f2c37",
  Session: "#72818d",
  File: "#aa7f52",
  Concept: "#6e8e3b",
};

function seed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return Math.abs(hash);
}

export function GraphCanvas({ data, onSelect, agentFilter, atlas = false }: {
  data: GraphData;
  onSelect: (node: GraphNode) => void;
  agentFilter?: string | null;
  atlas?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const graph = new Graph({ multi: true, type: "directed", allowSelfLoops: false });
    const visibleNodes = atlas ? data.nodes.filter((node) => node.type === "Project") : data.nodes;
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    for (const node of visibleNodes) {
      const nodeAgent = typeof node.attributes.agent === "string" ? node.attributes.agent : null;
      const dimmed = Boolean(agentFilter && node.type !== "Project" && nodeAgent !== agentFilter);
      const angle = (seed(node.id) % 360) * Math.PI / 180;
      const radius = 2 + (seed(`${node.id}:radius`) % 100) / 20;
      graph.addNode(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        label: node.label,
        size: node.type === "Project" ? 18 : node.type === "Workstream" ? 11 : 7,
        color: dimmed ? "#c7cbc8" : TYPE_COLORS[node.type] ?? "#60717e",
        original: node,
        zIndex: node.type === "Project" ? 2 : 1,
      });
    }
    for (const edge of data.edges) {
      if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
      if (graph.hasEdge(edge.id)) continue;
      graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
        color: edge.type === "SUPERSEDES" ? "#d75b5b" : "#aab3ae",
        size: edge.type === "CONTAINS" ? 1.6 : 1,
        type: "arrow",
        label: edge.type,
      });
    }
    if (graph.order > 1) {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, { iterations: Math.min(180, 50 + graph.order * 3), settings: { ...settings, gravity: 0.08, scalingRatio: atlas ? 8 : 4 } });
    }
    const renderer = new Sigma(graph, container.current, {
      renderEdgeLabels: graph.size <= 18,
      labelDensity: 1,
      labelGridCellSize: 90,
      labelRenderedSizeThreshold: 5,
      defaultEdgeType: "arrow",
      zIndex: true,
      stagePadding: 48,
    });
    renderer.on("clickNode", ({ node }) => {
      const original = graph.getNodeAttribute(node, "original") as GraphNode;
      onSelect(original);
      const display = renderer.getNodeDisplayData(node);
      if (display) void renderer.getCamera().animate({ x: display.x, y: display.y, ratio: Math.max(0.45, renderer.getCamera().getState().ratio * 0.72) }, { duration: 350 });
    });
    return () => renderer.kill();
  }, [agentFilter, atlas, data, onSelect]);

  if (data.nodes.length === 0) {
    return <div className="empty-canvas"><span>◎</span><h2>No graph yet</h2><p>Initialize a project or ingest an agent session to grow the atlas.</p></div>;
  }
  return <>
    <div className="graph-canvas" ref={container} role="img" aria-label={atlas ? "Workspace atlas graph" : "Project knowledge graph"} />
    <div className="sr-only" role="region" aria-label={atlas ? "Workspace atlas nodes" : "Project graph nodes"}>
      <ul>{data.nodes.map((node) => <li key={node.id}><button onClick={() => onSelect(node)}>{node.type}: {node.label} ({node.status})</button></li>)}</ul>
    </div>
  </>;
}
