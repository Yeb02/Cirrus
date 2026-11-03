import { BranchSet, ConnectionsFacade, MapFacade, PlacementsFacade, placementAt, RecordFacade } from './facades.ts';
import type { BranchRec, ConnectionLayout, ConnectionRec, Id, NodeRec, PhantomRec, Placement, PlanRec, TagKeyDef } from './model.ts';
import type { Op } from './ops.ts';
import type { Snapshot } from './snapshot.ts';
import {
  cloneTables, EMPTY_TAGS, emptyTables, growInt32, INCLUSION, kindCode, memberCode, memberNode, NO_RECORD, Pool, roleCode, SOURCE,
  type Tables, TARGET,
} from './tables.ts';

/** The direct groups of one plan (spec 10), by node row. */
export interface PlanGroups {
  /** The direct group's node row, −1 for none; with several, the one through the inclusion of smallest identifier. */
  group: Int32Array;
  /** Nodes with several direct groups (rule twoGroups): all of them, `group` first, by inclusion identifier. */
  multi: Map<number, number[]>;
}

/** What applyOp keeps up to date with the tables, in O(what an operation touches); reindex builds them at load. */
export interface Indices {
  /** Per node row: the connection rows it is a member of (any kind, trash included), each once. */
  memberOf: Pool;
  /** Per node row: the plan rows it is placed in. */
  placedIn: Pool;
  /** Per plan row. */
  groupOf: (PlanGroups | undefined)[];
  /** Per plan row: group node row → the node rows whose direct group it is. */
  groupMembers: (Map<number, number[]> | undefined)[];
  /** Per connection identifier: its phantoms' identifiers. */
  phantomsOf: Map<Id, Id[]>;
}

/**
 * In-memory state (plan 3c): tables of rows, columns and pools behind read-only Map façades, and derived indices.
 * Only applyOp writes. Records are never mutated in place: operations replace them, so copies can share them.
 */
export interface State {
  readonly tables: Tables;
  readonly index: Indices;
  readonly nodes: ReadonlyMap<Id, NodeRec>;
  /** Each `get` builds the record from the columns. */
  readonly connections: ReadonlyMap<Id, ConnectionRec>;
  readonly plans: ReadonlyMap<Id, PlanRec>;
  readonly tagKeys: ReadonlyMap<string, TagKeyDef>;
  /** key `${plan}|${node}` */
  readonly placements: ReadonlyMap<string, Placement>;
  readonly branches: BranchSet;
  /** key `${plan}|${connection}` */
  readonly connLayouts: ReadonlyMap<string, ConnectionLayout>;
  readonly phantoms: ReadonlyMap<Id, PhantomRec>;
}

export const placementKey = (plan: Id, node: Id): string => `${plan}|${node}`;
export const layoutKey = (plan: Id, connection: Id): string => `${plan}|${connection}`;

function emptyIndex(): Indices {
  return { memberOf: new Pool(1), placedIn: new Pool(1), groupOf: [], groupMembers: [], phantomsOf: new Map() };
}

function cloneIndex(x: Indices): Indices {
  const lists = (m: Map<number, number[]>) => new Map([...m].map(([k, v]) => [k, v.slice()]));
  return {
    memberOf: new Pool(1, x.memberOf), placedIn: new Pool(1, x.placedIn),
    groupOf: x.groupOf.map((g) => g && { group: g.group.slice(), multi: lists(g.multi) }),
    groupMembers: x.groupMembers.map((m) => m && lists(m)),
    phantomsOf: new Map([...x.phantomsOf].map(([k, v]) => [k, v.slice()])),
  };
}

function stateOf(tables: Tables, index: Indices): State {
  return {
    tables, index,
    nodes: new RecordFacade(tables.nodes), connections: new ConnectionsFacade(tables), plans: new RecordFacade(tables.plans),
    tagKeys: new MapFacade(tables.tagKeys), placements: new PlacementsFacade(tables), branches: new BranchSet(tables),
    connLayouts: new MapFacade(tables.layouts), phantoms: new MapFacade(tables.phantoms),
  };
}

export function emptyState(): State {
  return stateOf(emptyTables(), emptyIndex());
}

/** A deep copy of the tables and indices (records shared): for drafts until commands apply in place (plan 3c, task 3). */
export function cloneState(s: State): State {
  return stateOf(cloneTables(s.tables), cloneIndex(s.index));
}

// Direct accessors for hot paths: rows instead of identifiers, no record built.

export const nodeRow = (s: State, id: Id): number => s.tables.nodes.rows.get(id);
export const planRow = (s: State, id: Id): number => s.tables.plans.rows.get(id);
export const connRow = (s: State, id: Id): number => s.tables.conns.rows.get(id);
/** The members of connection row `row`, node row × 4 + role (memberNode, memberRole): a view valid until the next write. */
export const membersOf = (s: State, row: number): Int32Array => s.tables.conns.members.view(row);
export const placementOf = (s: State, plan: Id, node: Id): Placement | undefined => placementAt(s.tables, plan, node);
/** The connection rows node row `row` is a member of: a view valid until the next write. */
export const memberOf = (s: State, row: number): Int32Array => s.index.memberOf.view(row);
/** The plan rows node row `row` is placed in: a view valid until the next write. */
export const placedIn = (s: State, row: number): Int32Array => s.index.placedIn.view(row);
/** The node rows whose direct group in plan row `plan` is node row `group`. */
export const groupMembers = (s: State, plan: number, group: number): readonly number[] => s.index.groupMembers[plan]?.get(group) ?? [];
/** The direct group's node row of node row `node` in plan row `plan`, or −1. */
export function directGroup(s: State, plan: number, node: number): number {
  const g = s.index.groupOf[plan];
  return g !== undefined && node < g.group.length ? g.group[node] : -1;
}
export const phantomsOf = (s: State, connection: Id): readonly Id[] => s.index.phantomsOf.get(connection) ?? [];

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

/** Applies one operation after checking its "before"; leaves the state untouched when the check fails. */
export function applyOp(s: State, op: Op): void {
  switch (op.t) {
    case 'node': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty node operation');
      check(s.nodes.get(rec.id) ?? null, op.before, `Le nœud « ${rec.title} »`);
      return writeNode(s, rec.id, op.after);
    }
    case 'connection': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty connection operation');
      check(s.connections.get(rec.id) ?? null, op.before, 'La connexion');
      return writeConnection(s, rec.id, op.after, true);
    }
    case 'plan': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty plan operation');
      check(s.plans.get(rec.id) ?? null, op.before, `Le plan « ${rec.name} »`);
      return writePlan(s, rec.id, op.after);
    }
    case 'tagKey': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty tagKey operation');
      check(s.tagKeys.get(rec.key) ?? null, op.before, `Le tag « ${rec.key} »`);
      if (op.after) s.tables.tagKeys.set(rec.key, op.after);
      else s.tables.tagKeys.delete(rec.key);
      return;
    }
    case 'placement': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty placement operation');
      check(placementOf(s, rec.plan, rec.node) ?? null, op.before, 'La position du nœud');
      return writePlacement(s, rec.plan, rec.node, op.after, true);
    }
    case 'connLayout': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty connLayout operation');
      const key = layoutKey(rec.plan, rec.connection);
      check(s.tables.layouts.get(key) ?? null, op.before, 'La forme de la connexion');
      if (op.after) s.tables.layouts.set(key, op.after);
      else s.tables.layouts.delete(key);
      return;
    }
    case 'phantom': {
      const rec = op.after ?? op.before;
      if (!rec) throw new Error('empty phantom operation');
      check(s.tables.phantoms.get(rec.id) ?? null, op.before, 'Le fantôme');
      return writePhantom(s, rec.id, op.after, true);
    }
    case 'branch': {
      if (s.branches.has(op.key) !== op.before) throw new OpConflictError("La branche a changé depuis : l'opération ne s'applique plus.");
      return writeBranch(s, op.key, op.after, true);
    }
  }
}

/**
 * Writes records into an empty state without checks or indices, in bulk (loading a snapshot, the store's tables, a
 * synthetic base): reindex must follow.
 */
export function loadRecords(s: State, x: Snapshot): void {
  const T = s.tables, C = T.conns;
  if (T.nodes.rows.end + T.plans.rows.end + C.rows.end > 0) throw new Error('loadRecords needs an empty state');
  // Sized to the records: no doubling slack in the columns of a large base.
  T.nodes.rows.presize(x.nodes.length);
  C.presize(x.connections.length, x.connections.reduce((n, c) => n + c.members.length, 0));
  for (const p of x.plans) writePlan(s, p.id, p);
  for (const n of x.nodes) writeNode(s, n.id, n);
  for (const t of x.tagKeys) T.tagKeys.set(t.key, t);
  for (const c of x.connections) writeConnection(s, c.id, c, false);
  for (const p of x.placements) writePlacement(s, p.plan, p.node, p, false);
  // Branches: rows first, then the pool, each connection's list exactly its size. Consecutive branches mostly share
  // their connection and plan: those are not looked up again (identifiers parsed from JSON are hashed per lookup).
  const rows = new Int32Array(x.branches.length * 3);
  let lastConn: Id | undefined, lastPlan: Id | undefined, c = -1, p = -1;
  x.branches.forEach(([plan, connection, node], i) => {
    c = connection === lastConn ? C.rows.refAgain(c) : C.ref((lastConn = connection));
    p = plan === lastPlan ? T.plans.rows.refAgain(p) : refPlan(s, (lastPlan = plan));
    rows[3 * i] = c;
    rows[3 * i + 1] = p;
    rows[3 * i + 2] = refNode(s, node);
  });
  const counts = new Int32Array(C.kind.length);
  for (let i = 0; i < rows.length; i += 3) counts[rows[i]]++;
  C.branches = Pool.sized(2, counts);
  for (let i = 0; i < rows.length; i += 3) C.branches.push(rows[i], rows[i + 1], rows[i + 2]);
  C.branchCount = x.branches.length;
  for (const l of x.connLayouts) T.layouts.set(layoutKey(l.plan, l.connection), l);
  for (const p of x.phantoms) writePhantom(s, p.id, p, false);
}

/** Builds every index from the tables (at load, after loadRecords): O(base), once, each list exactly its size. */
export function reindex(s: State): void {
  const T = s.tables, C = T.conns, I = s.index;
  const nodeCap = T.nodes.recs.length, bp = C.branches, bd = bp.data;
  // Hot loops read local copies and inline the member coding (node row = m >> 2): under vitest every imported binding
  // is a getter, four times slower here (bundled code is not affected).
  const none = NO_RECORD, inclusion = INCLUSION, source = SOURCE, target = TARGET;
  // memberOf: each node once per connection, even when it is a member twice. Counted, then filled.
  const kind = C.kind, md = C.members.data, ms = C.members.start, ml = C.members.len, connEnd = C.rows.end;
  const counts = new Int32Array(nodeCap);
  let memberOf: Pool | undefined;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) memberOf = Pool.sized(1, counts);
    const od = memberOf?.data, os = memberOf?.start, ol = memberOf?.len;
    for (let c = 0; c < connEnd; c++) {
      if (kind[c] === none) continue;
      const s0 = ms[c], end = s0 + ml[c];
      outer: for (let i = s0; i < end; i++) {
        const n = md[i] >> 2;
        for (let j = s0; j < i; j++) if (md[j] >> 2 === n) continue outer;
        if (od) od[os![n] + ol![n]++] = c;
        else counts[n]++;
      }
    }
  }
  I.memberOf = memberOf!;
  counts.fill(0);
  T.plans.placements.forEach((map) => { if (map) for (const n of map.keys()) counts[n]++; });
  const placed = Pool.sized(1, counts);
  T.plans.placements.forEach((map, p) => { if (map) for (const n of map.keys()) placed.push(n, p); });
  I.placedIn = placed;
  // Groups: each inclusion not in the trash puts its first source in its first target, in every plan where both
  // branches are shown. A node found twice in a plan is resolved by regroup, once the rest is in place.
  I.groupOf = [];
  I.groupMembers = [];
  const twice: number[] = [];
  for (let c = 0; c < C.rows.end; c++) {
    if (kind[c] !== inclusion || !Number.isNaN(C.trashedAt[c]) || bp.len[c] === 0) continue;
    const m = firstWith(s, c, source), g = firstWith(s, c, target);
    if (m < 0 || g < 0) continue;
    for (let i = bp.start[c], end = i + bp.len[c]; i < end; i += 2) {
      const p = bd[i];
      if (bd[i + 1] !== m || bp.indexOf(c, p, g) < 0) continue;
      const pg = (I.groupOf[p] ??= { group: new Int32Array(nodeCap).fill(-1), multi: new Map() });
      if (pg.group[m] < 0) pg.group[m] = g;
      else twice.push(p, m);
    }
  }
  I.groupOf.forEach((pg, p) => {
    if (!pg) return;
    const members = (I.groupMembers[p] = new Map<number, number[]>());
    pg.group.forEach((g, n) => { if (g >= 0) listAdd(members, g, n); });
  });
  for (let i = 0; i < twice.length; i += 2) regroup(s, twice[i], twice[i + 1]);
  I.phantomsOf = new Map();
  for (const ph of T.phantoms.values()) listAdd(I.phantomsOf, ph.connection, ph.id);
}

// Rows: each reference to an identifier holds its row (Rows.ref), and gives it back (unref*) when it goes.

function refNode(s: State, id: Id): number {
  const r = s.tables.nodes.ref(id);
  s.index.memberOf.owners(r + 1);
  s.index.placedIn.owners(r + 1);
  return r;
}

function unrefNode(s: State, r: number): void {
  if (!s.tables.nodes.unref(r)) return;
  s.index.memberOf.release(r);
  s.index.placedIn.release(r);
}

function refPlan(s: State, id: Id): number {
  return s.tables.plans.ref(id);
}

function unrefPlan(s: State, r: number): void {
  if (!s.tables.plans.unref(r)) return;
  s.index.groupOf[r] = undefined;
  s.index.groupMembers[r] = undefined;
}

function writeNode(s: State, id: Id, after: NodeRec | null): void {
  const N = s.tables.nodes, r = N.rows.get(id), had = r >= 0 && N.recs[r] !== undefined;
  if (after) {
    const row = had ? r : refNode(s, id);
    if (!had) N.count++;
    N.recs[row] = after;
  } else if (had) {
    N.recs[r] = undefined;
    N.count--;
    unrefNode(s, r);
  }
}

function writePlan(s: State, id: Id, after: PlanRec | null): void {
  const P = s.tables.plans, r = P.rows.get(id), had = r >= 0 && P.recs[r] !== undefined;
  if (after) {
    const row = had ? r : refPlan(s, id);
    if (!had) P.count++;
    P.recs[row] = after;
  } else if (had) {
    P.recs[r] = undefined;
    P.count--;
    unrefPlan(s, r);
  }
}

/** The first member of connection row `c` with this role (SOURCE, TARGET…), as a node row, or −1. */
function firstWith(s: State, c: number, role: number): number {
  const pool = s.tables.conns.members, d = pool.data;
  for (let i = pool.start[c], end = i + pool.len[c]; i < end; i++) if ((d[i] & 3) === role) return d[i] >> 2;
  return -1;
}

/** The plan rows where connection row `c` has branches, each once. */
function plansOfRow(s: State, c: number): number[] {
  const pool = s.tables.conns.branches, d = pool.data, out: number[] = [];
  for (let i = pool.start[c], end = i + pool.len[c]; i < end; i += 2) if (!out.includes(d[i])) out.push(d[i]);
  return out;
}

const NO_MEMBERS = new Int32Array(0);

function writeConnection(s: State, id: Id, after: ConnectionRec | null, indexed: boolean): void {
  const C = s.tables.conns;
  let r = C.rows.get(id);
  const had = r >= 0 && C.kind[r] !== NO_RECORD;
  if (!had && !after) return;
  const old = had ? C.members.view(r).slice() : NO_MEMBERS;
  const oldSource = had && C.kind[r] === INCLUSION ? firstWith(s, r, SOURCE) : -1;
  let fresh = NO_MEMBERS;
  if (after) {
    if (!had) { r = C.ref(id); C.count++; }
    C.kind[r] = kindCode(after.kind);
    C.title[r] = after.title;
    C.relation[r] = after.relation;
    C.tags[r] = after.tags.length === 0 ? EMPTY_TAGS : after.tags;
    C.trashedAt[r] = after.trashedAt ?? NaN;
    fresh = new Int32Array(after.members.length);
    after.members.forEach((m, i) => { fresh[i] = memberCode(refNode(s, m.node), roleCode(m.role)); });
    C.members.set(r, fresh);
  } else {
    C.kind[r] = NO_RECORD;
    C.title[r] = '';
    C.relation[r] = '';
    C.tags[r] = EMPTY_TAGS;
    C.trashedAt[r] = NaN;
    C.members.release(r);
    C.count--;
  }
  if (indexed) {
    updateMemberOf(s, r, old, fresh);
    // Groups through this connection, in every plan where it has branches, for its old and new member.
    const newSource = after && C.kind[r] === INCLUSION ? firstWith(s, r, SOURCE) : -1;
    if (oldSource >= 0 || newSource >= 0) {
      for (const p of plansOfRow(s, r)) {
        if (oldSource >= 0) regroup(s, p, oldSource);
        if (newSource >= 0 && newSource !== oldSource) regroup(s, p, newSource);
      }
    }
  }
  for (let i = 0; i < old.length; i++) unrefNode(s, memberNode(old[i]));
  if (!after) C.unref(r);
}

/** memberOf after a connection's members changed from `old` to `fresh`: only the nodes that came or went. */
function updateMemberOf(s: State, c: number, old: Int32Array, fresh: Int32Array): void {
  /** Node row `n` among the first `end` members of `list`. */
  const has = (list: Int32Array, n: number, end = list.length) => {
    for (let i = 0; i < end; i++) if (memberNode(list[i]) === n) return true;
    return false;
  };
  const I = s.index;
  for (let i = 0; i < old.length; i++) {
    const n = memberNode(old[i]);
    if (!has(fresh, n) && !has(old, n, i)) I.memberOf.removeAt(n, I.memberOf.indexOf(n, c));
  }
  for (let i = 0; i < fresh.length; i++) {
    const n = memberNode(fresh[i]);
    if (!has(old, n) && !has(fresh, n, i)) I.memberOf.push(n, c);
  }
}

function writeBranch(s: State, b: BranchRec, present: boolean, indexed: boolean): void {
  const C = s.tables.conns;
  if (present) {
    const c = C.ref(b.connection), p = refPlan(s, b.plan), n = refNode(s, b.node);
    C.branches.push(c, p, n);
    C.branchCount++;
    if (indexed) regroupVia(s, c, p);
    return;
  }
  const c = C.rows.get(b.connection), p = s.tables.plans.rows.get(b.plan), n = s.tables.nodes.rows.get(b.node);
  C.branches.removeAt(c, C.branches.indexOf(c, p, n));
  C.branchCount--;
  if (indexed) regroupVia(s, c, p);
  unrefNode(s, n);
  unrefPlan(s, p);
  C.unref(c);
}

/** A branch of connection row `c` in plan row `p` came or went: the group its member gets through it may change. */
function regroupVia(s: State, c: number, p: number): void {
  if (s.tables.conns.kind[c] !== INCLUSION) return;
  const src = firstWith(s, c, SOURCE);
  if (src >= 0) regroup(s, p, src);
}

/**
 * The direct groups of node row `m` in plan row `p`, recomputed from its connections (memberOf): through each
 * inclusion not in the trash whose first source is `m`, its first target, when both branches are shown in `p`.
 */
function regroup(s: State, p: number, m: number): void {
  const C = s.tables.conns, list = s.index.memberOf;
  const found: number[] = [];
  for (let i = list.start[m], end = i + list.len[m]; i < end; i++) {
    const c = list.data[i];
    if (C.kind[c] !== INCLUSION || !Number.isNaN(C.trashedAt[c]) || firstWith(s, c, SOURCE) !== m) continue;
    const g = firstWith(s, c, TARGET);
    if (g >= 0 && C.branches.indexOf(c, p, m) >= 0 && C.branches.indexOf(c, p, g) >= 0) found.push(g, c);
  }
  let group = found.length > 0 ? found[0] : -1, multi: number[] | undefined;
  if (found.length > 2) {
    const ids = C.rows.ids, pairs: [number, number][] = [];
    for (let i = 0; i < found.length; i += 2) pairs.push([found[i], found[i + 1]]);
    pairs.sort((a, b) => (ids[a[1]] < ids[b[1]] ? -1 : ids[a[1]] > ids[b[1]] ? 1 : 0));
    group = pairs[0][0];
    multi = pairs.map(([g]) => g);
  }
  setGroup(s, p, m, group, multi);
}

function setGroup(s: State, p: number, m: number, group: number, multi: number[] | undefined): void {
  const I = s.index;
  let pg = I.groupOf[p];
  const old = pg !== undefined && m < pg.group.length ? pg.group[m] : -1;
  if (group >= 0) {
    if (!pg) pg = I.groupOf[p] = { group: new Int32Array(0), multi: new Map() };
    pg.group = growInt32(pg.group, m + 1, -1);
  }
  if (pg) {
    if (m < pg.group.length) pg.group[m] = group;
    if (multi) pg.multi.set(m, multi);
    else pg.multi.delete(m);
  }
  if (old === group) return;
  const members = (I.groupMembers[p] ??= new Map());
  if (old >= 0) listDrop(members, old, m);
  if (group >= 0) listAdd(members, group, m);
}

function listAdd<K, V>(map: Map<K, V[]>, key: K, v: V): void {
  const list = map.get(key);
  if (list) list.push(v);
  else map.set(key, [v]);
}

/** Removes `v` (the last element takes its place); an emptied list leaves the map. */
function listDrop<K, V>(map: Map<K, V[]>, key: K, v: V): void {
  const list = map.get(key)!;
  const i = list.indexOf(v);
  list[i] = list[list.length - 1];
  list.pop();
  if (list.length === 0) map.delete(key);
}

function writePlacement(s: State, plan: Id, node: Id, after: Placement | null, indexed: boolean): void {
  const P = s.tables.plans, p0 = P.rows.get(plan), n0 = s.tables.nodes.rows.get(node);
  const map = p0 >= 0 && n0 >= 0 ? P.placements[p0] : undefined;
  const had = map !== undefined && map.has(n0);
  if (after) {
    if (had) { map.set(n0, after); return; }
    const p = refPlan(s, plan), n = refNode(s, node);
    (P.placements[p] ??= new Map()).set(n, after);
    P.placementCount++;
    if (indexed) s.index.placedIn.push(n, p);
  } else if (had) {
    map.delete(n0);
    P.placementCount--;
    if (indexed) s.index.placedIn.removeAt(n0, s.index.placedIn.indexOf(n0, p0));
    unrefNode(s, n0);
    unrefPlan(s, p0);
  }
}

function writePhantom(s: State, id: Id, after: PhantomRec | null, indexed: boolean): void {
  const T = s.tables, before = T.phantoms.get(id);
  const moved = before?.connection !== after?.connection;
  if (indexed && before && moved) listDrop(s.index.phantomsOf, before.connection, id);
  if (after) T.phantoms.set(id, after);
  else T.phantoms.delete(id);
  if (indexed && after && moved) listAdd(s.index.phantomsOf, after.connection, id);
}
