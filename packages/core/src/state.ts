import type { BranchRec, ConnectionLayout, ConnectionRec, Id, NodeRec, PhantomRec, Placement, PlanRec, TagKeyDef } from './model.ts';
import type { Op } from './ops.ts';

/** In-memory state. Records are never mutated in place: operations replace them, so copies can share them. */
export interface State {
  nodes: Map<Id, NodeRec>;
  connections: Map<Id, ConnectionRec>;
  plans: Map<Id, PlanRec>;
  tagKeys: Map<string, TagKeyDef>;
  /** key `${plan}|${node}` */
  placements: Map<string, Placement>;
  /** key `${plan}|${connection}|${node}` */
  branches: Set<string>;
  /** key `${plan}|${connection}` */
  connLayouts: Map<string, ConnectionLayout>;
  phantoms: Map<Id, PhantomRec>;
}

export const placementKey = (plan: Id, node: Id): string => `${plan}|${node}`;
export const branchKey = (b: BranchRec): string => `${b.plan}|${b.connection}|${b.node}`;
export const layoutKey = (plan: Id, connection: Id): string => `${plan}|${connection}`;

export function parseBranchKey(key: string): BranchRec {
  const i = key.indexOf('|'), j = key.indexOf('|', i + 1);
  return { plan: key.slice(0, i), connection: key.slice(i + 1, j), node: key.slice(j + 1) };
}

export function emptyState(): State {
  return {
    nodes: new Map(), connections: new Map(), plans: new Map(), tagKeys: new Map(),
    placements: new Map(), branches: new Set(), connLayouts: new Map(), phantoms: new Map(),
  };
}

/** Shallow copy of the collections; the records themselves are shared (they are immutable). */
export function cloneState(s: State): State {
  return {
    nodes: new Map(s.nodes), connections: new Map(s.connections), plans: new Map(s.plans), tagKeys: new Map(s.tagKeys),
    placements: new Map(s.placements), branches: new Set(s.branches), connLayouts: new Map(s.connLayouts), phantoms: new Map(s.phantoms),
  };
}

export class OpConflictError extends Error {}

/** JSON with sorted keys and without undefined properties: structural equality of records. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function check(current: unknown, before: unknown, what: string): void {
  if (canonical(current ?? null) !== canonical(before ?? null)) {
    throw new OpConflictError(`${what} a changé depuis : l'opération ne s'applique plus.`);
  }
}

function put<K, V>(map: Map<K, V>, key: K, before: V | null, after: V | null, what: string): void {
  check(map.get(key) ?? null, before, what);
  if (after === null) map.delete(key);
  else map.set(key, after);
}

/** Applies one operation after checking its "before"; leaves the state untouched when the check fails. */
export function applyOp(s: State, op: Op): void {
  switch (op.t) {
    case 'node': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty node operation');
      return put(s.nodes, rec.id, op.before, op.after, `Le nœud « ${rec.title} »`);
    }
    case 'connection': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty connection operation');
      return put(s.connections, rec.id, op.before, op.after, 'La connexion');
    }
    case 'plan': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty plan operation');
      return put(s.plans, rec.id, op.before, op.after, `Le plan « ${rec.name} »`);
    }
    case 'tagKey': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty tagKey operation');
      return put(s.tagKeys, rec.key, op.before, op.after, `Le tag « ${rec.key} »`);
    }
    case 'placement': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty placement operation');
      return put(s.placements, placementKey(rec.plan, rec.node), op.before, op.after, 'La position du nœud');
    }
    case 'connLayout': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty connLayout operation');
      return put(s.connLayouts, layoutKey(rec.plan, rec.connection), op.before, op.after, 'La forme de la connexion');
    }
    case 'phantom': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty phantom operation');
      return put(s.phantoms, rec.id, op.before, op.after, 'Le fantôme');
    }
    case 'branch': {
      const key = branchKey(op.key);
      if (s.branches.has(key) !== op.before) throw new OpConflictError("La branche a changé depuis : l'opération ne s'applique plus.");
      if (op.after) s.branches.add(key);
      else s.branches.delete(key);
      return;
    }
  }
}
