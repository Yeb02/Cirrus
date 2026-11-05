import type { ConnectionLayout, ConnectionRec, Id, NodeRec, PhantomRec, Placement, PlanRec, PreambleRec, TagKeyDef } from './model.ts';
import { dataOf, emptyState, loadRecords, reindex, type State } from './state.ts';

/** The state as plain JSON arrays (no Map or Set): for IPC between processes and, later, the first sync of a PC. */
export interface Snapshot {
  nodes: NodeRec[];
  connections: ConnectionRec[];
  plans: PlanRec[];
  tagKeys: TagKeyDef[];
  placements: Placement[];
  branches: [plan: Id, connection: Id, node: Id][];
  connLayouts: ConnectionLayout[];
  phantoms: PhantomRec[];
  /** null: never set. */
  preamble: PreambleRec | null;
}

export function toSnapshot(s: State): Snapshot {
  const T = dataOf(s).tables, C = T.conns, pool = C.branches, plans = T.plans.rows.ids, nodes = T.nodes.rows.ids;
  const branches: Snapshot['branches'] = [];
  for (let c = 0; c < C.rows.end; c++) {
    for (let i = pool.start[c], end = i + pool.len[c]; i < end; i += 2) branches.push([plans[pool.data[i]], C.rows.ids[c], nodes[pool.data[i + 1]]]);
  }
  return {
    nodes: [...s.nodes.values()], connections: [...s.connections.values()], plans: [...s.plans.values()], tagKeys: [...s.tagKeys.values()],
    placements: [...s.placements.values()], branches, connLayouts: [...s.connLayouts.values()], phantoms: [...s.phantoms.values()], preamble: s.preamble,
  };
}

/** Loaded in bulk, then indexed once. */
export function fromSnapshot(x: Snapshot): State {
  const s = emptyState();
  loadRecords(s, x);
  reindex(s);
  return s;
}
