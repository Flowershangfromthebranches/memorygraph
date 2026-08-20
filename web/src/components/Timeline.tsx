import type { MemoryDiff, TimelineEvent } from "../types";

const KIND_MARKS: Record<string, string> = { decision: "◇", issue: "!", state_change: "↻", handoff: "⇄", git_commit: "●", file_change: "+" };

export function Timeline({ events, diff, onDiff }: { events: TimelineEvent[]; diff: MemoryDiff | null; onDiff: () => void }) {
  if (!events.length) return <div className="empty-canvas"><span>⌁</span><h2>No history yet</h2><p>Ingested agent events will appear here with source evidence.</p></div>;
  return (
    <div className="timeline-view">
      <button className="diff-button" onClick={onDiff}>± Memory Diff</button>
      {diff && <section className="diff-panel"><header><div><span className="eyebrow">STATE CHANGESET</span><h3>Memory Diff</h3></div><small>{new Date(diff.from).toLocaleString()} → now</small></header><div className="diff-groups"><div><b>+ {diff.added.length}</b><span>added</span>{diff.added.map((entry) => <p key={entry.key}>{entry.key}: {entry.valueText}</p>)}</div><div><b>↻ {diff.changed.length}</b><span>changed</span>{diff.changed.map((entry) => <p key={entry.key}>{entry.key}: <s>{entry.before.valueText}</s> → {entry.after.valueText}</p>)}</div><div><b>− {diff.removed.length}</b><span>removed</span>{diff.removed.map((entry) => <p key={entry.key}>{entry.key}</p>)}</div></div></section>}
      <div className="timeline-rail" />
      {events.map((event, index) => (
        <article className="timeline-event" key={event.id}>
          <time>{new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(event.occurredAt))}</time>
          <span className="timeline-mark">{KIND_MARKS[event.kind] ?? "·"}</span>
          <div>
            <div className="event-meta"><span>{event.agentId}</span><span>{event.kind.replaceAll("_", " ")}</span></div>
            <h3>{event.summary}</h3>
            <p>{event.sourceUri}</p>
          </div>
          <b>{String(events.length - index).padStart(2, "0")}</b>
        </article>
      ))}
    </div>
  );
}
