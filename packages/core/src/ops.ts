import type { BranchRec, ConnectionLayout, ConnectionRec, Id, NodeRec, PhantomRec, Placement, PlanRec, PreambleRec, TagKeyDef } from './model.ts';

/**
 * Every change is a record-level operation carrying the record before and after (null = absent).
 * Inverting swaps the two; applying checks that "before" matches the current state.
 */
export type Op =
  | { t: 'node'; before: NodeRec | null; after: NodeRec | null }
  | { t: 'connection'; before: ConnectionRec | null; after: ConnectionRec | null }
  | { t: 'plan'; before: PlanRec | null; after: PlanRec | null }
  | { t: 'tagKey'; before: TagKeyDef | null; after: TagKeyDef | null }
  | { t: 'placement'; before: Placement | null; after: Placement | null }
  | { t: 'branch'; key: BranchRec; before: boolean; after: boolean }
  | { t: 'connLayout'; before: ConnectionLayout | null; after: ConnectionLayout | null }
  | { t: 'phantom'; before: PhantomRec | null; after: PhantomRec | null }
  /** The base's single preamble record (null: never set, DEFAULT_PREAMBLE applies). */
  | { t: 'preamble'; before: PreambleRec | null; after: PreambleRec | null };

/** The two synchronised flows of spec 6.1 (analytics come later). */
export type Flow = 'content' | 'layout';

export function flowOf(op: Op): Flow {
  return op.t === 'node' || op.t === 'connection' || op.t === 'plan' || op.t === 'tagKey' || op.t === 'preamble' ? 'content' : 'layout';
}

export function invertOp(op: Op): Op {
  return { ...op, before: op.after, after: op.before } as Op;
}

/** The object an operation is about, for per-object history (spec 6.3). */
export function subjectOf(op: Op): Id {
  switch (op.t) {
    case 'node':
    case 'connection':
    case 'plan':
    case 'phantom':
      return (op.after ?? op.before)!.id;
    case 'tagKey':
      return (op.after ?? op.before)!.key;
    case 'placement':
      return (op.after ?? op.before)!.node;
    case 'branch':
      return op.key.connection;
    case 'connLayout':
      return (op.after ?? op.before)!.connection;
    case 'preamble':
      return 'preamble';
  }
}
