import type { Evidence, GraphNode, ProjectState } from "../types";

export function Inspector({ node, evidence, projectState }: { node: GraphNode | null; evidence: Evidence[]; projectState: ProjectState | null }) {
  return (
    <aside className="inspector">
      <div className="inspector-heading"><span>Inspector</span><small>{node ? "Evidence view" : "Project pulse"}</small></div>
      {node ? (
        <>
          <div className="inspector-type">{node.type}</div>
          <h2>{node.label}</h2>
          <div className={`status-pill status-${node.status}`}>{node.status}</div>
          <p className="inspector-summary">{node.summary || "No summary has been projected for this node."}</p>
          <dl>
            <dt>Valid from</dt><dd>{new Date(node.validFrom).toLocaleString()}</dd>
            <dt>Node ID</dt><dd><code>{node.id}</code></dd>
            <dt>Source event</dt><dd><code>{node.sourceEventId ?? "project identity"}</code></dd>
          </dl>
          <section className="evidence-list"><h3>Evidence</h3>{evidence.length ? evidence.map((item, index) => <article key={item.id ?? index}><span>{item.event.agentId}</span><strong>{item.event.summary}</strong><small>{item.uri ?? "No external URI"}</small></article>) : <p>No source event is attached.</p>}</section>
        </>
      ) : projectState ? (
        <>
          <span className="eyebrow">CURRENT TRUTH</span><h2>{projectState.project.name}</h2>
          <div className="pulse-grid"><div><b>{projectState.state.length}</b><span>state</span></div><div><b>{projectState.activeWork.length}</b><span>active</span></div><div><b>{projectState.decisions.length}</b><span>decisions</span></div></div>
          <section className="state-list"><h3>Project state</h3>{projectState.state.slice(0, 12).map((entry) => <article key={entry.key}><span>{entry.key}</span><strong>{entry.valueText}</strong></article>)}</section>
        </>
      ) : <div className="empty-inspector">Select a project or node to inspect its current truth and evidence.</div>}
    </aside>
  );
}

