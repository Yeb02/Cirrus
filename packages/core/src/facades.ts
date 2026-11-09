import type { BranchRec, ConnectionRec, Id, Member, Placement, TagValue } from './model.ts';
import { KINDS, NO_RECORD, ROLES, type Rows, type Tables } from './tables.ts';

// Read-only views of the tables as Maps and a Set (plan 3c, decision 1): readers keep the Map interface, writes go
// through applyOp only.

const readOnly = (): never => {
  throw new Error('read-only state: write through applyOp');
};

/** The ReadonlyMap interface over a collection of the state; set, delete and clear throw. */
abstract class Facade<K, V> implements ReadonlyMap<K, V> {
  abstract get(key: K): V | undefined;
  abstract has(key: K): boolean;
  abstract get size(): number;
  abstract entries(): MapIterator<[K, V]>;
  abstract keys(): MapIterator<K>;
  abstract values(): MapIterator<V>;
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
  set(): never { return readOnly(); }
  delete(): never { return readOnly(); }
  clear(): never { return readOnly(); }
}

/** Records by row (nodes, plans): row order, rows without a record skipped. */
export class RecordFacade<V> extends Facade<Id, V> {
  private readonly table: { readonly rows: Rows; readonly recs: (V | undefined)[]; readonly count: number };
  constructor(table: { readonly rows: Rows; readonly recs: (V | undefined)[]; readonly count: number }) {
    super();
    this.table = table;
  }
  get(id: Id): V | undefined {
    const r = this.table.rows.row.get(id);
    return r === undefined ? undefined : this.table.recs[r];
  }
  has(id: Id): boolean { return this.get(id) !== undefined; }
  get size(): number { return this.table.count; }
  *entries(): MapIterator<[Id, V]> {
    const { rows, recs } = this.table;
    for (let r = 0; r < recs.length; r++) { const v = recs[r]; if (v !== undefined) yield [rows.ids[r], v]; }
  }
  *keys(): MapIterator<Id> {
    const { rows, recs } = this.table;
    for (let r = 0; r < recs.length; r++) if (recs[r] !== undefined) yield rows.ids[r];
  }
  *values(): MapIterator<V> {
    const recs = this.table.recs;
    for (let r = 0; r < recs.length; r++) { const v = recs[r]; if (v !== undefined) yield v; }
  }
}

/** The record of connection row `r` (which has one), built from its columns: a new object at each call. */
export function connectionAt(t: Tables, r: number): ConnectionRec {
  const C = t.conns, pool = C.members, ids = t.nodes.rows.ids, roles = ROLES;
  const members: Member[] = [];
  for (let i = pool.start[r], end = i + pool.len[r]; i < end; i++) {
    const m = pool.data[i];
    members.push({ node: ids[m >> 2], role: roles[m & 3] });
  }
  const c: ConnectionRec = { id: C.rows.ids[r], kind: KINDS[C.kind[r]], title: C.title[r], relation: C.relation[r], tags: C.tags[r] as TagValue[], members };
  const at = C.trashedAt[r];
  if (!Number.isNaN(at)) c.trashedAt = at;
  return c;
}

/** Connections: `get` and iteration build each record from the columns (prefer connRow, memberCount and memberAt on hot paths). */
export class ConnectionsFacade extends Facade<Id, ConnectionRec> {
  private readonly t: Tables;
  constructor(t: Tables) { super(); this.t = t; }
  get(id: Id): ConnectionRec | undefined {
    const r = this.t.conns.rows.row.get(id);
    return r === undefined || this.t.conns.kind[r] === NO_RECORD ? undefined : connectionAt(this.t, r);
  }
  has(id: Id): boolean {
    const r = this.t.conns.rows.row.get(id);
    return r !== undefined && this.t.conns.kind[r] !== NO_RECORD;
  }
  get size(): number { return this.t.conns.count; }
  *entries(): MapIterator<[Id, ConnectionRec]> {
    const C = this.t.conns;
    for (let r = 0; r < C.rows.end; r++) if (C.kind[r] !== NO_RECORD) yield [C.rows.ids[r], connectionAt(this.t, r)];
  }
  *keys(): MapIterator<Id> {
    const C = this.t.conns;
    for (let r = 0; r < C.rows.end; r++) if (C.kind[r] !== NO_RECORD) yield C.rows.ids[r];
  }
  *values(): MapIterator<ConnectionRec> {
    const C = this.t.conns;
    for (let r = 0; r < C.rows.end; r++) if (C.kind[r] !== NO_RECORD) yield connectionAt(this.t, r);
  }
}

/** The placement of `node` in `plan`, without building a key. */
export function placementAt(t: Tables, plan: Id, node: Id): Placement | undefined {
  const p = t.plans.rows.row.get(plan), n = t.nodes.rows.row.get(node);
  return p === undefined || n === undefined ? undefined : t.plans.placements[p]?.get(n);
}

/** Placements under the key `${plan}|${node}` (placementKey), parsed on lookup; plan by plan in iteration. */
export class PlacementsFacade extends Facade<string, Placement> {
  private readonly t: Tables;
  constructor(t: Tables) { super(); this.t = t; }
  get(key: string): Placement | undefined {
    const i = key.indexOf('|');
    return i < 0 ? undefined : placementAt(this.t, key.slice(0, i), key.slice(i + 1));
  }
  has(key: string): boolean { return this.get(key) !== undefined; }
  get size(): number { return this.t.plans.placementCount; }
  *entries(): MapIterator<[string, Placement]> {
    const P = this.t.plans, ids = this.t.nodes.rows.ids;
    for (let p = 0; p < P.placements.length; p++) {
      const map = P.placements[p];
      if (map) for (const [n, pl] of map) yield [`${P.rows.ids[p]}|${ids[n]}`, pl];
    }
  }
  *keys(): MapIterator<string> {
    for (const [k] of this.entries()) yield k;
  }
  *values(): MapIterator<Placement> {
    const P = this.t.plans;
    for (let p = 0; p < P.placements.length; p++) { const map = P.placements[p]; if (map) yield* map.values(); }
  }
}

/** A collection kept as a Map (phantoms, layouts, tag keys), read through without copy. */
export class MapFacade<K, V> extends Facade<K, V> {
  private readonly map: Map<K, V>;
  constructor(map: Map<K, V>) { super(); this.map = map; }
  get(key: K): V | undefined { return this.map.get(key); }
  has(key: K): boolean { return this.map.has(key); }
  get size(): number { return this.map.size; }
  entries(): MapIterator<[K, V]> { return this.map.entries(); }
  keys(): MapIterator<K> { return this.map.keys(); }
  values(): MapIterator<V> { return this.map.values(); }
}

/**
 * The branches, from the pool of pairs (plan row, node row) of each connection: membership, iteration as BranchRec,
 * and per-connection and per-plan queries without building keys. add and delete throw: branches change by applyOp.
 */
export class BranchSet implements Iterable<BranchRec> {
  private readonly t: Tables;
  constructor(t: Tables) { this.t = t; }

  get size(): number { return this.t.conns.branchCount; }

  has(b: BranchRec): boolean {
    const t = this.t, c = t.conns.rows.row.get(b.connection), p = t.plans.rows.row.get(b.plan), n = t.nodes.rows.row.get(b.node);
    return c !== undefined && p !== undefined && n !== undefined && t.conns.branches.indexOf(c, p, n) >= 0;
  }

  add(_b: BranchRec): never { return readOnly(); }
  delete(_b: BranchRec): never { return readOnly(); }

  *[Symbol.iterator](): Generator<BranchRec, undefined> {
    const C = this.t.conns, pool = C.branches, plans = this.t.plans.rows.ids, nodes = this.t.nodes.rows.ids;
    for (let c = 0; c < C.rows.end; c++) {
      for (let i = 0; i < pool.len[c]; i += 2) {
        const at = pool.start[c] + i;
        yield { plan: plans[pool.data[at]], connection: C.rows.ids[c], node: nodes[pool.data[at + 1]] };
      }
    }
    return undefined;
  }

  /** The nodes of `connection` shown in `plan`. */
  nodesIn(connection: Id, plan: Id): Id[] {
    const t = this.t, c = t.conns.rows.row.get(connection), p = t.plans.rows.row.get(plan);
    if (c === undefined || p === undefined) return [];
    const v = t.conns.branches.view(c), out: Id[] = [];
    for (let i = 0; i < v.length; i += 2) if (v[i] === p) out.push(t.nodes.rows.ids[v[i + 1]]);
    return out;
  }

  /** The plans where `connection` has at least one branch. */
  plansOf(connection: Id): Id[] {
    const t = this.t, c = t.conns.rows.row.get(connection);
    if (c === undefined) return [];
    const v = t.conns.branches.view(c), out: Id[] = [];
    for (let i = 0; i < v.length; i += 2) { const plan = t.plans.rows.ids[v[i]]; if (!out.includes(plan)) out.push(plan); }
    return out;
  }

  /**
   * Every connection row with branches in `plan` (with or without a record), in row order, with the node rows shown
   * there. `nodeRows` is reused from one call to the next: copy it to keep it.
   */
  forEachInPlan(plan: Id, fn: (connectionRow: number, nodeRows: Int32Array) => void): void {
    const p = this.t.plans.rows.row.get(plan);
    if (p === undefined) return;
    const C = this.t.conns, pool = C.branches, byLength: Int32Array[] = [];
    let buf = new Int32Array(8);
    for (let c = 0; c < C.rows.end; c++) {
      const len = pool.len[c];
      if (len === 0) continue;
      const s = pool.start[c], d = pool.data;
      let k = 0;
      for (let i = s; i < s + len; i += 2) {
        if (d[i] !== p) continue;
        if (k === buf.length) { const b = new Int32Array(k * 2); b.set(buf); buf = b; }
        buf[k++] = d[i + 1];
      }
      if (k === 0) continue;
      const out = (byLength[k] ??= new Int32Array(k));
      for (let i = 0; i < k; i++) out[i] = buf[i];
      fn(c, out);
    }
  }
}
