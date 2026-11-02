import type { ConnectionLayout, ConnectionRec, NodeRec, PhantomRec, Placement, PlanRec, TagKeyDef } from './model.ts';
import { emptyState, layoutKey, placementKey, type State } from './state.ts';

/** The state as plain JSON arrays (no Map or Set): for IPC between processes and, later, the first sync of a PC. */
export interface Snapshot {
  nodes: NodeRec[];
  connections: ConnectionRec[];
  plans: PlanRec[];
  tagKeys: TagKeyDef[];
  placements: Placement[];
  /** Branch keys `${plan}|${connection}|${node}`. */
  branches: string[];
  connLayouts: ConnectionLayout[];
  phantoms: PhantomRec[];
}

export function toSnapshot(s: State): Snapshot {
  return {
    nodes: [...s.nodes.values()], connections: [...s.connections.values()], plans: [...s.plans.values()], tagKeys: [...s.tagKeys.values()],
    placements: [...s.placements.values()], branches: [...s.branches], connLayouts: [...s.connLayouts.values()], phantoms: [...s.phantoms.values()],
  };
}

export function fromSnapshot(x: Snapshot): State {
  const s = emptyState();
  for (const n of x.nodes) s.nodes.set(n.id, n);
  for (const c of x.connections) s.connections.set(c.id, c);
  for (const p of x.plans) s.plans.set(p.id, p);
  for (const t of x.tagKeys) s.tagKeys.set(t.key, t);
  for (const p of x.placements) s.placements.set(placementKey(p.plan, p.node), p);
  for (const b of x.branches) s.branches.add(b);
  for (const l of x.connLayouts) s.connLayouts.set(layoutKey(l.plan, l.connection), l);
  for (const p of x.phantoms) s.phantoms.set(p.id, p);
  return s;
}
