import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Blocks, GitBranch, History, Network, RefreshCw, Search, Trees, Waypoints } from "lucide-react";

import { api } from "./api";
import { GraphCanvas } from "./components/GraphCanvas";
import { HandoffView } from "./components/HandoffView";
import { Inspector } from "./components/Inspector";
import { NarrativeTree } from "./components/NarrativeTree";
import { Timeline } from "./components/Timeline";
import type { Evidence, GraphData, GraphNode, Handoff, MemoryDiff, Project, ProjectState, TimelineEvent, ViewMode } from "./types";

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] };
const VIEWS: Array<{ id: ViewMode; label: string; icon: typeof Blocks }> = [
  { id: "atlas", label: "Atlas", icon: Blocks },
  { id: "graph", label: "Graph", icon: Network },
  { id: "tree", label: "Tree", icon: Trees },
  { id: "timeline", label: "Timeline", icon: History },
  { id: "handoff", label: "Handoff", icon: Waypoints },
];

export default function App() {
  const [view, setView] = useState<ViewMode>("atlas");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workspaceGraph, setWorkspaceGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [projectGraph, setProjectGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [memoryDiff, setMemoryDiff] = useState<MemoryDiff | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const initialSyncStarted = useRef(false);

  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null;
  const agents = useMemo(() => [...new Set(events.map((event) => event.agentId))], [events]);

  const refreshWorkspace = useCallback(async () => {
    try {
      const [{ projects: list }, graph] = await Promise.all([api.projects(), api.graph()]);
      setProjects(list);
      setWorkspaceGraph(graph);
      setSelectedProjectId((current) => current ?? list[0]?.projectId ?? null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, []);

  const refreshProject = useCallback(async (projectId: string) => {
    try {
      const [graph, timeline, handoffData, state] = await Promise.all([api.graph(projectId), api.events(projectId), api.handoffs(projectId), api.state(projectId)]);
      setProjectGraph(graph); setEvents(timeline.events); setHandoffs(handoffData.handoffs); setProjectState(state);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, []);

  const syncAll = useCallback(async () => {
    setSyncing(true);
    try {
      await api.sync();
      await refreshWorkspace();
      if (selectedProjectId) await refreshProject(selectedProjectId);
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); await refreshWorkspace(); }
    finally { setSyncing(false); }
  }, [refreshProject, refreshWorkspace, selectedProjectId]);

  useEffect(() => {
    if (initialSyncStarted.current) return;
    initialSyncStarted.current = true;
    void syncAll();
  }, [syncAll]);
  useEffect(() => { if (selectedProjectId) void refreshProject(selectedProjectId); }, [refreshProject, selectedProjectId]);
  useEffect(() => {
    if (!selectedNode) { setEvidence([]); return; }
    void api.evidence(selectedNode.id).then((payload) => setEvidence(payload.evidence)).catch(() => setEvidence([]));
  }, [selectedNode]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectNode = useCallback((node: GraphNode) => {
    setSelectedNode(node);
    if (node.type === "Project") {
      setSelectedProjectId(node.projectId);
      if (view === "atlas") setView("graph");
    }
  }, [view]);

  const runSearch = async () => {
    if (!selectedProject || !searchQuery.trim()) return;
    try { setSearchHits((await api.search(selectedProject.primaryRoot, searchQuery)).hits); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const focusSearchHit = async (hit: Record<string, unknown>) => {
    if (hit.kind !== "node" || typeof hit.id !== "string") return;
    try {
      const neighborhood = await api.neighborhood(hit.id);
      const node = neighborhood.nodes.find((candidate) => candidate.id === hit.id);
      if (!node) return;
      setProjectGraph(neighborhood);
      setSelectedProjectId(node.projectId);
      setSelectedNode(node);
      setView("graph");
      setSearchOpen(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const generateHandoff = async (agent: string) => {
    if (!selectedProject) return;
    await api.resume(selectedProject.primaryRoot, agent);
    await refreshProject(selectedProject.projectId);
  };

  const loadDiff = async () => {
    if (!selectedProject) return;
    try { setMemoryDiff(await api.diff(selectedProject.projectId, selectedProject.createdAt, new Date().toISOString())); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const title = view === "atlas" ? "My Workspace" : selectedProject?.name ?? "Select a project";
  const subtitle = view === "atlas" ? `${projects.length} projects · shared state atlas`
    : view === "timeline" ? `${events.length} evidence-backed events`
      : view === "handoff" ? `${handoffs.length} recorded agent transfers`
        : `${view[0]?.toUpperCase()}${view.slice(1)} view · ${projectGraph.totalNodes ?? projectGraph.nodes.length} nodes${projectGraph.truncated ? ` · showing ${projectGraph.nodes.length}` : ""}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("atlas")}><span className="brand-mark"><i /><i /><i /></span><span>Memory<b>Graph</b></span></button>
        <nav aria-label="Primary views">{VIEWS.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)} disabled={id !== "atlas" && !selectedProject}><Icon size={15} />{label}</button>)}</nav>
        <button className="search-button" onClick={() => setSearchOpen((open) => !open)}><Search size={16} /><span>Search memory</span><kbd>⌘K</kbd></button>
      </header>

      <aside className="project-sidebar">
        <div className="sidebar-label"><span>Projects</span><b>{projects.length}</b></div>
        <div className="project-list">{projects.map((project, index) => <button key={project.projectId} className={selectedProjectId === project.projectId ? "selected" : ""} onClick={() => { setSelectedProjectId(project.projectId); setView("graph"); setSelectedNode(null); }}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{project.name}</strong><small>{project.slug}</small></div><i /></button>)}</div>
        <div className="sidebar-foot"><GitBranch size={14} /><span>Local evidence<br /><b>Source of truth</b></span></div>
      </aside>

      <main className="workspace">
        <div className="workspace-heading"><div><span className="eyebrow">{view.toUpperCase()} MODE</span><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-actions">{view === "graph" && agents.length > 0 && <div className="agent-trail"><span>Agent trail</span><button className={!agentFilter ? "active" : ""} onClick={() => setAgentFilter(null)}>All</button>{agents.map((agent) => <button key={agent} className={agentFilter === agent ? "active" : ""} onClick={() => setAgentFilter(agent)}>{agent}</button>)}</div>}<button className="sync-button" onClick={() => void syncAll()} disabled={syncing}><RefreshCw size={13} className={syncing ? "spinning" : ""} />{syncing ? "Syncing" : "Sync"}</button></div></div>
        <section className={`view-stage view-${view}`}>
          {view === "atlas" && <GraphCanvas data={workspaceGraph} onSelect={selectNode} atlas />}
          {view === "graph" && <GraphCanvas data={projectGraph} onSelect={selectNode} agentFilter={agentFilter} />}
          {view === "tree" && <NarrativeTree data={projectGraph} onSelect={selectNode} />}
          {view === "timeline" && <Timeline events={events} diff={memoryDiff} onDiff={() => void loadDiff()} />}
          {view === "handoff" && selectedProject && <HandoffView project={selectedProject} handoffs={handoffs} onGenerate={generateHandoff} />}
          <div className="view-legend"><span><i className="status-dot status-complete" />Complete</span><span><i className="status-dot status-active" />Active</span><span><i className="status-dot status-blocked" />Blocked</span><span><i className="status-dot status-planned" />Planned</span><span><i className="status-dot status-deprecated" />Deprecated</span></div>
        </section>
      </main>

      <Inspector node={selectedNode} evidence={evidence} projectState={projectState} />

      {searchOpen && <div className="search-panel" role="dialog" aria-label="Search project memory"><div className="search-box"><Search size={18} /><input autoFocus aria-label="Memory search query" placeholder="Search decisions, issues, files, sessions…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); if (event.key === "Escape") setSearchOpen(false); }} /><button onClick={() => void runSearch()}>Search</button></div><div className="search-results">{searchHits.map((hit, index) => <button key={String(hit.id ?? index)} onClick={() => void focusSearchHit(hit)} disabled={hit.kind !== "node"}><span>{String(hit.kind ?? "memory")}</span><strong>{String(hit.title ?? "Untitled")}</strong><p>{String(hit.snippet ?? "")}</p></button>)}{searchQuery && !searchHits.length && <p>Press Enter to search this project.</p>}</div></div>}
      {error && <button className="error-toast" onClick={() => setError(null)}>⚠ {error}<span>×</span></button>}
    </div>
  );
}
