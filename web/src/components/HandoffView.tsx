import { useState } from "react";

import type { Handoff, Project } from "../types";

export function HandoffView({ project, handoffs, onGenerate }: { project: Project; handoffs: Handoff[]; onGenerate: (agent: string) => Promise<void> }) {
  const [agent, setAgent] = useState("opencode");
  const [working, setWorking] = useState(false);
  return (
    <div className="handoff-view">
      <section className="handoff-compose">
        <div><span className="eyebrow">PULL-BASED HANDOFF</span><h2>Let the next agent pull.</h2><p>Sync latest evidence, verify the repository, compile bounded context, and record the transfer.</p></div>
        <form onSubmit={(event) => { event.preventDefault(); setWorking(true); void onGenerate(agent).finally(() => setWorking(false)); }}>
          <label>Receiving agent<input value={agent} onChange={(event) => setAgent(event.target.value)} /></label>
          <button disabled={working || !agent.trim()}>{working ? "Compiling…" : "Generate handoff →"}</button>
        </form>
      </section>
      <div className="handoff-chain">
        {handoffs.length === 0 ? <div className="empty-canvas"><span>⇄</span><h2>No handoffs yet</h2><p>The first transfer from {project.name} will appear here.</p></div> : handoffs.map((handoff) => (
          <article className="handoff-card" key={handoff.id}>
            <div className="handoff-agents"><strong>{handoff.previousAgent ?? "Project state"}</strong><span>→</span><strong>{handoff.receivingAgent}</strong></div>
            <div className="handoff-stats"><span><b>{handoff.inheritedEventIds.length}</b> inherited</span><span><b>{handoff.estimatedTokens}</b> tokens</span><span className={`outcome outcome-${handoff.outcomeStatus}`}>{handoff.outcomeStatus}</span></div>
            <footer><time>{new Date(handoff.createdAt).toLocaleString()}</time><code>{handoff.id}</code></footer>
          </article>
        ))}
      </div>
    </div>
  );
}

