import type { GraphData, GraphNode } from "../types";

interface TreeNode {
  node: GraphNode;
  children: TreeNode[];
}

function buildTree(data: GraphData): { roots: TreeNode[]; references: typeof data.edges } {
  const byId = new Map(data.nodes.map((node) => [node.id, { node, children: [] as TreeNode[] }]));
  const childIds = new Set<string>();
  const primaryParent = new Set<string>();
  const references: typeof data.edges = [];
  for (const edge of data.edges) {
    const parent = byId.get(edge.source);
    const child = byId.get(edge.target);
    if (!parent || !child) continue;
    if (edge.type === "CONTAINS" && !primaryParent.has(edge.target)) {
      parent.children.push(child);
      childIds.add(edge.target);
      primaryParent.add(edge.target);
    } else {
      references.push(edge);
    }
  }
  const roots = [...byId.values()].filter(({ node }) => !childIds.has(node.id));
  return { roots, references };
}

function Branch({ branch, depth, onSelect }: { branch: TreeNode; depth: number; onSelect: (node: GraphNode) => void }) {
  return (
    <li className="tree-branch">
      <button className="tree-node" style={{ "--depth": depth } as React.CSSProperties} onClick={() => onSelect(branch.node)}>
        <span className={`status-dot status-${branch.node.status}`} />
        <span className="tree-type">{branch.node.type}</span>
        <strong>{branch.node.label}</strong>
        {branch.node.summary && <small>{branch.node.summary}</small>}
      </button>
      {branch.children.length > 0 && <ul>{branch.children.map((child) => <Branch key={child.node.id} branch={child} depth={depth + 1} onSelect={onSelect} />)}</ul>}
    </li>
  );
}

export function NarrativeTree({ data, onSelect }: { data: GraphData; onSelect: (node: GraphNode) => void }) {
  const { roots, references } = buildTree(data);
  return (
    <div className="tree-view">
      <div className="tree-title"><span>Narrative hierarchy</span><small>Primary branches + {references.length} reference links</small></div>
      {roots.length ? <ul className="tree-root">{roots.map((root) => <Branch key={root.node.id} branch={root} depth={0} onSelect={onSelect} />)}</ul> : <div className="empty-canvas"><h2>No hierarchy yet</h2></div>}
      {references.length > 0 && (
        <section className="reference-links">
          <h3>Reference branches</h3>
          {references.slice(0, 24).map((edge) => <div key={edge.id}><span>{edge.source}</span><em>{edge.type}</em><span>{edge.target}</span></div>)}
        </section>
      )}
    </div>
  );
}

