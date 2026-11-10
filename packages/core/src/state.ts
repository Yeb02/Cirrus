import { isObject, validAnchor } from './annotation.ts';
import { BranchSet, connectionAt, ConnectionsFacade, MapFacade, PlacementsFacade, placementAt, RecordFacade } from './facades.ts';
import { DEFAULT_PREAMBLE } from './latex.ts';
import type { BranchRec, ConnectionLayout, ConnectionRec, Id, NodeRec, PhantomRec, Placement, PlanRec, PreambleRec, TagKeyDef, TagValue } from './model.ts';
import type { Op } from './ops.ts';
import type { Snapshot } from './snapshot.ts';
import {
  EMPTY_TAGS, emptyTables, growInt32, INCLUSION, kindCode, KINDS, memberCode, memberNode, NO_RECORD, Pool, roleCode, ROLES, SOURCE, STRUCTURE, type Tables,
  TARGET,
} from './tables.ts';

/** The direct groups of one plan (spec 10), by node row. */
interface PlanGroups {
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
  /** Per group node identifier: the identifiers of the phantoms sitting in it (spec 8.5). */
  phantomsIn: Map<Id, Id[]>;
  /** The connection rows of kind structure (spec 15): those a plan's type can make wrong. */
  structures: Set<number>;
  /**
   * Per tag key: the identifiers of the nodes and connections whose tags use it, those a change of that key can make
   * wrong (identifiers are unique across kinds).
   */
  tagged: Map<string, Set<Id>>;
}

/**
 * In-memory state (plan 3c): read-only Map façades over tables of rows, columns and pools, with derived indices; the
 * accessors below read rows directly. Only applyOp writes, in place: a state is not a frozen snapshot, and a command
 * that tries operations undoes them (transact). Records are never mutated in place: operations replace them.
 */
export interface State {
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
  /** The global LaTeX preamble; null: never set (preambleText gives the one in effect). */
  readonly preamble: PreambleRec | null;
}

/** Core's own view of a state: the façades plus the tables and indices behind them (not exported from @cirrus/core). */
interface StateData extends State {
  readonly tables: Tables;
  readonly index: Indices;
}

/** Core only: the tables and indices of a state (every state is made by stateOf). */
export const dataOf = (s: State): StateData => s as StateData;

export const placementKey = (plan: Id, node: Id): string => `${plan}|${node}`;
export const layoutKey = (plan: Id, connection: Id): string => `${plan}|${connection}`;

function emptyIndex(): Indices {
  return {
    memberOf: new Pool(1), placedIn: new Pool(1), groupOf: [], groupMembers: [], phantomsOf: new Map(), phantomsIn: new Map(), structures: new Set(),
    tagged: new Map(),
  };
}

function stateOf(tables: Tables, index: Indices): StateData {
  return {
    tables, index,
    nodes: new RecordFacade(tables.nodes), connections: new ConnectionsFacade(tables), plans: new RecordFacade(tables.plans),
    tagKeys: new MapFacade(tables.tagKeys), placements: new PlacementsFacade(tables), branches: new BranchSet(tables),
    connLayouts: new MapFacade(tables.layouts), phantoms: new MapFacade(tables.phantoms),
    get preamble() { return tables.preamble; },
  };
}

export function emptyState(): State {
  return stateOf(emptyTables(), emptyIndex());
}

// Direct accessors for hot paths: rows instead of identifiers, no record built, nothing to write through. A row comes
// from nodeRow, planRow, connRow, memberOf, placedIn, forEachInPlan…; −1 means no such identifier.

export const nodeRow = (s: State, id: Id): number => dataOf(s).tables.nodes.rows.get(id);
export const planRow = (s: State, id: Id): number => dataOf(s).tables.plans.rows.get(id);
export const connRow = (s: State, id: Id): number => dataOf(s).tables.conns.rows.get(id);
/**
 * The row a node's or connection's identifier held before the row was freed (its last reference gone), as long as
 * no other identifier holds that row; −1 otherwise. For a reader that kept rows (a scene) after an action, an undo
 * among them, removed what held them.
 */
export const formerNodeRow = (s: State, id: Id): number => dataOf(s).tables.nodes.rows.formerRow(id);
export const formerConnRow = (s: State, id: Id): number => dataOf(s).tables.conns.rows.formerRow(id);
export const nodeId = (s: State, row: number): Id => dataOf(s).tables.nodes.rows.ids[row];
export const planId = (s: State, row: number): Id => dataOf(s).tables.plans.rows.ids[row];
export const connId = (s: State, row: number): Id => dataOf(s).tables.conns.rows.ids[row];
/** Connection rows are [0, connRowCount): some are free or without a record (connKind NO_RECORD). */
export const connRowCount = (s: State): number => dataOf(s).tables.conns.rows.end;
/** The kind of connection row `row` as its index in KINDS (KNOWLEDGE, INCLUSION, STRUCTURE), or NO_RECORD. */
export const connKind = (s: State, row: number): number => dataOf(s).tables.conns.kind[row];
export const connTitle = (s: State, row: number): string => dataOf(s).tables.conns.title[row];
export const connRelation = (s: State, row: number): string => dataOf(s).tables.conns.relation[row];
/** Its tags, as stored (one shared empty array for the many without): the search reads them without a record (plan 6a, D1). */
export const connTags = (s: State, row: number): readonly TagValue[] => dataOf(s).tables.conns.tags[row];
/**
 * The rows of the connections whose relation is not empty, trash included, in row order: the LaTeX registry reads them
 * without visiting every row (half a million in the bench's base) through the accessors.
 */
export function relationRows(s: State): number[] {
  const C = dataOf(s).tables.conns, kind = C.kind, relation = C.relation, none = NO_RECORD, out: number[] = [];
  for (let r = 0, end = C.rows.end; r < end; r++) if (kind[r] !== none && relation[r] !== '') out.push(r);
  return out;
}
export const connTrashed = (s: State, row: number): boolean => !Number.isNaN(dataOf(s).tables.conns.trashedAt[row]);
/** The record of connection row `row` (which has one), built from its columns. */
export const connectionOfRow = (s: State, row: number): ConnectionRec => connectionAt(dataOf(s).tables, row);
/** Without a copy, for hot loops: the number of members of connection row `row`, and member `i` (node row × 4 + role). */
export const memberCount = (s: State, row: number): number => dataOf(s).tables.conns.members.len[row];
export const memberAt = (s: State, row: number, i: number): number => {
  const pool = dataOf(s).tables.conns.members;
  return pool.data[pool.start[row] + i];
};
export const placementOf = (s: State, plan: Id, node: Id): Placement | undefined => placementAt(dataOf(s).tables, plan, node);
const NO_PLACEMENTS: ReadonlyMap<number, Placement> = new Map();
/** The placements of plan row `plan`, by node row, read-only (a plan's scene reads them by row, without identifiers). */
export const placementsIn = (s: State, plan: number): ReadonlyMap<number, Placement> => dataOf(s).tables.plans.placements[plan] ?? NO_PLACEMENTS;
/** The record of node row `row`, or undefined. */
export const nodeAt = (s: State, row: number): NodeRec | undefined => dataOf(s).tables.nodes.recs[row];
/** Whether connection row `c` has a branch to node row `n` in plan row `p`. */
export const hasBranch = (s: State, c: number, p: number, n: number): boolean => dataOf(s).tables.conns.branches.indexOf(c, p, n) >= 0;
/** The node rows connection row `c` shows in plan row `p` (its branches there), as a new list. */
export function branchNodes(s: State, c: number, p: number): number[] {
  const v = dataOf(s).tables.conns.branches.view(c), out: number[] = [];
  for (let i = 0; i < v.length; i += 2) if (v[i] === p) out.push(v[i + 1]);
  return out;
}
/** The connection rows node row `row` is a member of, as a copy. */
export const memberOf = (s: State, row: number): Int32Array => dataOf(s).index.memberOf.view(row).slice();
/** Without a copy, for hot loops: how many connections node row `row` is a member of, and the `i`-th one's row. */
export const memberOfCount = (s: State, row: number): number => {
  const pool = dataOf(s).index.memberOf;
  return row < pool.len.length ? pool.len[row] : 0;
};
export const memberOfAt = (s: State, row: number, i: number): number => {
  const pool = dataOf(s).index.memberOf;
  return pool.data[pool.start[row] + i];
};
/** The plan rows node row `row` is placed in, as a copy. */
export const placedIn = (s: State, row: number): Int32Array => dataOf(s).index.placedIn.view(row).slice();
/** Without a copy, for hot loops: how many plans node row `row` is placed in (the search's groups: plan 6a, D1). */
export const placedInCount = (s: State, row: number): number => {
  const pool = dataOf(s).index.placedIn;
  return row >= 0 && row < pool.len.length ? pool.len[row] : 0;
};
/** The node rows whose direct group in plan row `plan` is node row `group`. */
export const groupMembers = (s: State, plan: number, group: number): readonly number[] => dataOf(s).index.groupMembers[plan]?.get(group) ?? [];
/** The direct group's node row of node row `node` in plan row `plan`, or −1. */
export function directGroup(s: State, plan: number, node: number): number {
  const g = dataOf(s).index.groupOf[plan];
  return g !== undefined && node < g.group.length ? g.group[node] : -1;
}
export const phantomsOf = (s: State, connection: Id): readonly Id[] => dataOf(s).index.phantomsOf.get(connection) ?? [];
/** The identifiers of the phantoms sitting in group `group` (any plan). */
export const phantomsIn = (s: State, group: Id): readonly Id[] => dataOf(s).index.phantomsIn.get(group) ?? [];
/** Core only: whether `rec` is its connection's current record, in the sense of canonical (read from the columns). */
export const isCurrentConnection = (s: State, rec: ConnectionRec): boolean => connectionIs(dataOf(s).tables, rec.id, rec);
/** The LaTeX preamble in effect (spec 5.6): the base's, or DEFAULT_PREAMBLE when it never set one (D5: never stored). */
export const preambleText = (s: State): string => s.preamble?.text ?? DEFAULT_PREAMBLE;

export class OpConflictError extends Error {}

/** JSON with sorted keys and without undefined properties: structural equality of records. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const CONNECTION_KEYS = new Set(['id', 'kind', 'title', 'relation', 'tags', 'members', 'trashedAt']);
const MEMBER_KEYS = new Set(['node', 'role']);
/** Whether `rec` has a defined property outside `keys` (canonical would see it). */
const extra = (rec: object, keys: Set<string>): boolean => {
  for (const k in rec) if (!keys.has(k) && (rec as Record<string, unknown>)[k] !== undefined) return true;
  return false;
};

/**
 * Whether connection `id` is `rec` (null: it has no record), in the sense of canonical, read from its columns without
 * building its record or serialising either: a connection's "before" is checked at each operation and each undo.
 */
function connectionIs(T: Tables, id: Id, rec: ConnectionRec | null): boolean {
  const C = T.conns, r = C.rows.get(id), has = r >= 0 && C.kind[r] !== NO_RECORD;
  if (!rec || !has) return !rec && !has;
  const at = C.trashedAt[r];
  if (rec.id !== id || KINDS[C.kind[r]] !== rec.kind || C.title[r] !== rec.title || C.relation[r] !== rec.relation
    || (Number.isNaN(at) ? rec.trashedAt !== undefined : rec.trashedAt !== at)) return false;
  const tags = C.tags[r], theirs = rec.tags;
  if (tags !== theirs && !(tags.length === 0 && Array.isArray(theirs) && theirs.length === 0) && canonical(tags) !== canonical(theirs)) return false;
  const pool = C.members, start = pool.start[r], n = pool.len[r], ids = T.nodes.rows.ids, members = rec.members;
  if (!Array.isArray(members) || members.length !== n || extra(rec, CONNECTION_KEYS)) return false;
  for (let i = 0; i < n; i++) {
    const m = pool.data[start + i], mine = members[i];
    if (!mine || ids[m >> 2] !== mine.node || ROLES[m & 3] !== mine.role || extra(mine, MEMBER_KEYS)) return false;
  }
  return true;
}

function check(current: unknown, before: unknown, what: string): void {
  // The same record (an action computed on this state, then applied for real): equal without serialising it.
  if ((current ?? null) === (before ?? null)) return;
  if (canonical(current ?? null) !== canonical(before ?? null)) {
    throw new OpConflictError(`${what} a changé depuis : l'opération ne s'applique plus.`);
  }
}

/**
 * Applies one operation after checking its "before"; leaves the state untouched when the check fails, or when the
 * record is invalid (every check comes before the first write).
 */
export function applyOp(s: State, op: Op): void {
  write(dataOf(s), op, true, false);
}

/**
 * Core only: applies an operation whose "before" is the current record by construction, without checking it (a
 * draft's own operation, read from the state at that moment). An invalid record still throws before any write.
 */
export function applyKnown(s: State, op: Op): void {
  write(dataOf(s), op, false, false);
}

/** Applies operations in order, all or none: when one is refused, those before it are undone, and its error is thrown. */
export function applyOps(s: State, ops: readonly Op[]): void {
  const done: Op[] = [];
  try {
    for (const op of ops) {
      applyOp(s, op);
      done.push(op);
    }
  } catch (e) {
    rollback(s, done, 0);
    throw e;
  }
}

/**
 * Core only: undoes the operations of `log` after its first `to`, the last first, and removes them from it: each
 * inverse puts back the "before" its operation replaced. Exact by construction (each was applied to this state, in
 * this order, with nothing in between), so it is not checked.
 */
export function rollback(s: State, log: Op[], to: number): void {
  const d = dataOf(s);
  while (log.length > to) write(d, log.pop()!, false, true);
}

/** Writes `op`, or its inverse when `back` (from "after" to "before", without building it), after checking it if `checked`. */
function write(d: StateData, op: Op, checked: boolean, back: boolean): void {
  switch (op.t) {
    case 'node': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty node operation');
      if (checked) check(d.nodes.get(rec.id) ?? null, before, `Le nœud « ${rec.title} »`);
      return writeNode(d, rec.id, after, true);
    }
    case 'connection': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty connection operation');
      if (checked && !connectionIs(d.tables, rec.id, before)) throw new OpConflictError("La connexion a changé depuis : l'opération ne s'applique plus.");
      return writeConnection(d, rec.id, after, true);
    }
    case 'plan': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty plan operation');
      if (checked) check(d.plans.get(rec.id) ?? null, before, `Le plan « ${rec.name} »`);
      return writePlan(d, rec.id, after);
    }
    case 'tagKey': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty tagKey operation');
      if (checked) check(d.tagKeys.get(rec.key) ?? null, before, `Le tag « ${rec.key} »`);
      if (after) d.tables.tagKeys.set(rec.key, after);
      else d.tables.tagKeys.delete(rec.key);
      return;
    }
    case 'placement': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty placement operation');
      if (checked) check(placementOf(d, rec.plan, rec.node) ?? null, before, 'La position du nœud');
      return writePlacement(d, rec.plan, rec.node, after, true);
    }
    case 'connLayout': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty connLayout operation');
      const key = layoutKey(rec.plan, rec.connection);
      if (checked) check(d.tables.layouts.get(key) ?? null, before, 'La forme de la connexion');
      if (after) d.tables.layouts.set(key, after);
      else d.tables.layouts.delete(key);
      return;
    }
    case 'phantom': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after, rec = after ?? before;
      if (!rec) throw new Error('empty phantom operation');
      // Unchecked, the "before" is the current record.
      const current = checked ? d.tables.phantoms.get(rec.id) ?? null : before;
      if (checked) check(current, before, 'Le fantôme');
      return writePhantom(d, rec.id, current ?? undefined, after, true);
    }
    case 'branch': {
      const before = back ? Boolean(op.after) : op.before, present = back ? op.before : Boolean(op.after);
      if (checked && d.branches.has(op.key) !== before) throw new OpConflictError("La branche a changé depuis : l'opération ne s'applique plus.");
      // Added when there, removed when absent: nothing to do, as for a set.
      if (present === before) return;
      return writeBranch(d, op.key, present, true);
    }
    case 'preamble': {
      const before = back ? op.after : op.before, after = back ? op.before : op.after;
      if (!before && !after) throw new Error('empty preamble operation');
      if (after) checkPreamble(after);
      if (checked) check(d.tables.preamble, before, 'Le préambule');
      d.tables.preamble = after;
      return;
    }
  }
}

/**
 * Writes records into an empty state without checks or indices, in bulk (loading a snapshot, the store's tables, a
 * synthetic base): reindex must follow.
 */
export function loadRecords(s: State, x: Snapshot): void {
  const d = dataOf(s), T = d.tables, C = T.conns;
  if (T.nodes.rows.end + T.plans.rows.end + C.rows.end > 0) throw new Error('loadRecords needs an empty state');
  // Sized to the records: no doubling slack in the columns of a large base.
  T.nodes.rows.presize(x.nodes.length);
  C.presize(x.connections.length, x.connections.reduce((n, c) => n + c.members.length, 0));
  for (const p of x.plans) writePlan(d, p.id, p);
  for (const n of x.nodes) writeNode(d, n.id, n, false);
  for (const t of x.tagKeys) T.tagKeys.set(t.key, t);
  for (const c of x.connections) writeConnection(d, c.id, c, false);
  for (const p of x.placements) writePlacement(d, p.plan, p.node, p, false);
  // Branches: rows first, then the pool, each connection's list exactly its size. Consecutive branches mostly share
  // their connection and plan: those are not looked up again (identifiers parsed from JSON are hashed per lookup).
  const rows = new Int32Array(x.branches.length * 3);
  let lastConn: Id | undefined, lastPlan: Id | undefined, c = -1, p = -1;
  x.branches.forEach(([plan, connection, node], i) => {
    c = connection === lastConn ? C.rows.refAgain(c) : C.ref((lastConn = connection));
    p = plan === lastPlan ? T.plans.rows.refAgain(p) : refPlan(d, (lastPlan = plan));
    rows[3 * i] = c;
    rows[3 * i + 1] = p;
    rows[3 * i + 2] = refNode(d, node);
  });
  const counts = new Int32Array(C.kind.length);
  for (let i = 0; i < rows.length; i += 3) counts[rows[i]]++;
  C.branches = Pool.sized(2, counts);
  for (let i = 0; i < rows.length; i += 3) C.branches.push(rows[i], rows[i + 1], rows[i + 2]);
  C.branchCount = x.branches.length;
  for (const l of x.connLayouts) T.layouts.set(layoutKey(l.plan, l.connection), l);
  for (const p of x.phantoms) writePhantom(d, p.id, T.phantoms.get(p.id), p, false);
  // A snapshot made before plan 4b has none.
  if (x.preamble) checkPreamble(x.preamble);
  T.preamble = x.preamble ?? null;
}

/** Builds every index from the tables (at load, after loadRecords): O(base), once, each list exactly its size. */
export function reindex(s: State): void {
  const d = dataOf(s), T = d.tables, C = T.conns, I = d.index;
  const nodeCap = T.nodes.recs.length, bp = C.branches, bd = bp.data;
  // Hot loops read local copies and inline the member coding (node row = m >> 2): under vitest every imported binding
  // is a getter, four times slower here (bundled code is not affected).
  const none = NO_RECORD, inclusion = INCLUSION, source = SOURCE, target = TARGET;
  // memberOf: each node once per connection, even when it is a member twice. Counted, then filled; a connection of two
  // members (most of them) without the inner loop.
  const kind = C.kind, md = C.members.data, ms = C.members.start, ml = C.members.len, connEnd = C.rows.end;
  const counts = new Int32Array(nodeCap);
  for (let c = 0; c < connEnd; c++) {
    if (kind[c] === none) continue;
    const s0 = ms[c], len = ml[c];
    if (len === 2) {
      const a = md[s0] >> 2, b = md[s0 + 1] >> 2;
      counts[a]++;
      if (b !== a) counts[b]++;
      continue;
    }
    outer: for (let i = s0, end = s0 + len; i < end; i++) {
      const n = md[i] >> 2;
      for (let j = s0; j < i; j++) if (md[j] >> 2 === n) continue outer;
      counts[n]++;
    }
  }
  const memberOf = Pool.sized(1, counts), od = memberOf.data, os = memberOf.start, ol = memberOf.len;
  for (let c = 0; c < connEnd; c++) {
    if (kind[c] === none) continue;
    const s0 = ms[c], len = ml[c];
    if (len === 2) {
      const a = md[s0] >> 2, b = md[s0 + 1] >> 2;
      od[os[a] + ol[a]++] = c;
      if (b !== a) od[os[b] + ol[b]++] = c;
      continue;
    }
    outer: for (let i = s0, end = s0 + len; i < end; i++) {
      const n = md[i] >> 2;
      for (let j = s0; j < i; j++) if (md[j] >> 2 === n) continue outer;
      od[os[n] + ol[n]++] = c;
    }
  }
  I.memberOf = memberOf;
  counts.fill(0);
  T.plans.placements.forEach((map) => { if (map) for (const n of map.keys()) counts[n]++; });
  const placed = Pool.sized(1, counts);
  T.plans.placements.forEach((map, p) => { if (map) for (const n of map.keys()) placed.push(n, p); });
  I.placedIn = placed;
  // Groups: each inclusion not in the trash puts its first source in its first target, in every plan where both
  // branches are shown. A node found twice in a plan is resolved by regroup, once the rest is in place.
  I.groupOf = [];
  const twice: number[] = [];
  for (let c = 0; c < C.rows.end; c++) {
    if (kind[c] !== inclusion || !Number.isNaN(C.trashedAt[c]) || bp.len[c] === 0) continue;
    const m = firstWith(d, c, source), g = firstWith(d, c, target);
    if (m < 0 || g < 0) continue;
    for (let i = bp.start[c], end = i + bp.len[c]; i < end; i += 2) {
      const p = bd[i];
      if (bd[i + 1] !== m || bp.indexOf(c, p, g) < 0) continue;
      const pg = (I.groupOf[p] ??= { group: new Int32Array(nodeCap).fill(-1), multi: new Map() });
      if (pg.group[m] < 0) pg.group[m] = g;
      else twice.push(p, m);
    }
  }
  indexGroupMembers(d);
  for (let i = 0; i < twice.length; i += 2) regroup(d, twice[i], twice[i + 1]);
  indexByIdentifiers(d);
}

/**
 * Core only (decodeState): the indices a snapshot does not keep, built from its tables and from the indices it keeps
 * (memberOf, placedIn, groupOf with its multi): groupMembers, the phantoms' indices, structures and tagged.
 */
export function reindexRest(s: State): void {
  const d = dataOf(s);
  indexGroupMembers(d);
  indexByIdentifiers(d);
}

/** groupMembers from groupOf: each plan's group → its members, in node order. */
function indexGroupMembers(d: StateData): void {
  const I = d.index;
  I.groupMembers = [];
  I.groupOf.forEach((pg, p) => {
    if (!pg) return;
    const members = (I.groupMembers[p] = new Map<number, number[]>());
    pg.group.forEach((g, n) => { if (g >= 0) listAdd(members, g, n); });
  });
}

/** The phantoms' indices, the structure connections and the tag index, from the tables. */
function indexByIdentifiers(d: StateData): void {
  const T = d.tables, C = T.conns, I = d.index, kind = C.kind, connEnd = C.rows.end, none = NO_RECORD;
  I.phantomsOf = new Map();
  I.phantomsIn = new Map();
  for (const ph of T.phantoms.values()) {
    listAdd(I.phantomsOf, ph.connection, ph.id);
    if (ph.group !== undefined) listAdd(I.phantomsIn, ph.group, ph.id);
  }
  I.structures = new Set();
  I.tagged = new Map();
  const structure = STRUCTURE, noTags = EMPTY_TAGS, connIds = C.rows.ids, tags = C.tags;
  for (let c = 0; c < connEnd; c++) {
    if (kind[c] === structure) I.structures.add(c);
    if (kind[c] !== none && tags[c].length > 0) retag(I.tagged, connIds[c], noTags, tags[c]);
  }
  for (const rec of T.nodes.recs) if (rec && rec.tags.length > 0) retag(I.tagged, rec.id, noTags, rec.tags);
}

/** The tag index after the tags of record `id` went from `old` to `fresh`. */
function retag(tagged: Map<string, Set<Id>>, id: Id, old: readonly TagValue[], fresh: readonly TagValue[]): void {
  if (old === fresh) return;
  for (const t of old) {
    if (fresh.some((x) => x.key === t.key)) continue;
    const ids = tagged.get(t.key);
    if (ids?.delete(id) && ids.size === 0) tagged.delete(t.key);
  }
  for (const t of fresh) {
    const ids = tagged.get(t.key);
    if (ids) ids.add(id);
    else tagged.set(t.key, new Set([id]));
  }
}

// Rows: each reference to an identifier holds its row (Rows.ref), and gives it back (unref*) when it goes.

function refNode(d: StateData, id: Id): number {
  const r = d.tables.nodes.ref(id);
  d.index.memberOf.owners(r + 1);
  d.index.placedIn.owners(r + 1);
  return r;
}

function unrefNode(d: StateData, r: number): void {
  if (!d.tables.nodes.unref(r)) return;
  d.index.memberOf.release(r);
  d.index.placedIn.release(r);
}

function refPlan(d: StateData, id: Id): number {
  return d.tables.plans.ref(id);
}

function unrefPlan(d: StateData, r: number): void {
  if (!d.tables.plans.unref(r)) return;
  d.index.groupOf[r] = undefined;
  d.index.groupMembers[r] = undefined;
}

const isTagList = (v: unknown): boolean => Array.isArray(v) && v.every(isObject);

/**
 * What the tables and the indices read of a node record, checked before anything is written: a string identifier, its
 * tags (objects) and files as arrays (the tag index and reindex read them); an annotation's anchor within its bounds
 * (validAnchor), as the snapshot's decoder wants it, so that a base never holds one its snapshot would refuse.
 */
function checkNode(n: NodeRec): void {
  if (!isObject(n) || typeof n.id !== 'string') throw new Error('invalid node record');
  if (!isTagList(n.tags)) throw new Error(`invalid node tags: ${n.id}`);
  if (!Array.isArray(n.files)) throw new Error(`invalid node files: ${n.id}`);
  if (n.anchor !== undefined && !validAnchor(n.anchor)) throw new Error(`invalid node anchor: ${n.id}`);
}

/**
 * What the columns read of a connection record, checked before anything is written: a string identifier, a known
 * kind, a numeric trashedAt or none, its tags (objects) as an array, its members as objects with a string node and a
 * known role.
 */
function checkConnection(c: ConnectionRec): void {
  if (!isObject(c) || typeof c.id !== 'string') throw new Error('invalid connection record');
  kindCode(c.kind);
  if (c.trashedAt !== undefined && (typeof c.trashedAt !== 'number' || Number.isNaN(c.trashedAt))) throw new Error(`invalid trashedAt: ${String(c.trashedAt)}`);
  if (!isTagList(c.tags)) throw new Error(`invalid connection tags: ${c.id}`);
  if (!Array.isArray(c.members)) throw new Error(`invalid connection members: ${c.id}`);
  for (const m of c.members) {
    if (!isObject(m) || typeof m.node !== 'string') throw new Error(`invalid member of connection ${c.id}`);
    roleCode(m.role);
  }
}

/** What preambleText reads of the preamble record, checked before it is written: its text, a string. */
function checkPreamble(p: PreambleRec): void {
  if (!isObject(p) || typeof p.text !== 'string') throw new Error('invalid preamble record');
}

/**
 * Throws when the "after" of a node, connection or preamble operation is a record the state cannot store: the one
 * check the state's writes make (applyOp, a rollback, a bulk load) and the base makes before writing
 * (LocalStore.commit), so the base never holds a record that its tables could not be loaded back with.
 */
export function checkRecord(op: Op): void {
  if (op.t === 'node' && op.after) checkNode(op.after);
  else if (op.t === 'connection' && op.after) checkConnection(op.after);
  else if (op.t === 'preamble' && op.after) checkPreamble(op.after);
}

function writeNode(d: StateData, id: Id, after: NodeRec | null, indexed: boolean): void {
  if (after) checkNode(after);
  const N = d.tables.nodes, r = N.rows.get(id), had = r >= 0 && N.recs[r] !== undefined;
  if (indexed) retag(d.index.tagged, id, had ? N.recs[r]!.tags ?? EMPTY_TAGS : EMPTY_TAGS, after?.tags ?? EMPTY_TAGS);
  if (after) {
    const row = had ? r : refNode(d, id);
    if (!had) N.count++;
    N.recs[row] = after;
  } else if (had) {
    N.recs[r] = undefined;
    N.count--;
    unrefNode(d, r);
  }
}

function writePlan(d: StateData, id: Id, after: PlanRec | null): void {
  const P = d.tables.plans, r = P.rows.get(id), had = r >= 0 && P.recs[r] !== undefined;
  if (after) {
    const row = had ? r : refPlan(d, id);
    if (!had) P.count++;
    P.recs[row] = after;
  } else if (had) {
    P.recs[r] = undefined;
    P.count--;
    unrefPlan(d, r);
  }
}

/** The first member of connection row `c` with this role (SOURCE, TARGET…), as a node row, or −1. */
function firstWith(d: StateData, c: number, role: number): number {
  const pool = d.tables.conns.members, data = pool.data;
  for (let i = pool.start[c], end = i + pool.len[c]; i < end; i++) if ((data[i] & 3) === role) return data[i] >> 2;
  return -1;
}

/** The plan rows where connection row `c` has branches, each once. */
function plansOfRow(d: StateData, c: number): number[] {
  const pool = d.tables.conns.branches, data = pool.data, out: number[] = [];
  for (let i = pool.start[c], end = i + pool.len[c]; i < end; i += 2) if (!out.includes(data[i])) out.push(data[i]);
  return out;
}

const NO_MEMBERS = new Int32Array(0);

function writeConnection(d: StateData, id: Id, after: ConnectionRec | null, indexed: boolean): void {
  const C = d.tables.conns;
  let r = C.rows.get(id);
  const had = r >= 0 && C.kind[r] !== NO_RECORD;
  if (!had && !after) return;
  // Every check before the first write: an invalid record throws and leaves the state as it was.
  let kind = NO_RECORD, tags = EMPTY_TAGS, fresh = NO_MEMBERS;
  if (after) {
    checkConnection(after);
    kind = kindCode(after.kind);
    if (after.tags.length > 0) tags = after.tags;
    fresh = new Int32Array(after.members.length);
    after.members.forEach((m, i) => { fresh[i] = roleCode(m.role); });
  }
  const old = had ? C.members.view(r).slice() : NO_MEMBERS;
  const oldSource = had && C.kind[r] === INCLUSION ? firstWith(d, r, SOURCE) : -1;
  const oldKind = had ? C.kind[r] : NO_RECORD, oldTags = had ? C.tags[r] : EMPTY_TAGS;
  if (after) {
    if (!had) { r = C.ref(id); C.count++; }
    C.kind[r] = kind;
    C.title[r] = after.title;
    C.relation[r] = after.relation;
    C.tags[r] = tags;
    C.trashedAt[r] = after.trashedAt ?? NaN;
    after.members.forEach((m, i) => { fresh[i] = memberCode(refNode(d, m.node), fresh[i]); });
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
    updateMemberOf(d, r, old, fresh);
    retag(d.index.tagged, id, oldTags, tags);
    if (oldKind === STRUCTURE && kind !== STRUCTURE) d.index.structures.delete(r);
    if (kind === STRUCTURE && oldKind !== STRUCTURE) d.index.structures.add(r);
    // Groups through this connection, in every plan where it has branches, for its old and new member.
    const newSource = after && C.kind[r] === INCLUSION ? firstWith(d, r, SOURCE) : -1;
    if (oldSource >= 0 || newSource >= 0) {
      for (const p of plansOfRow(d, r)) {
        if (oldSource >= 0) regroup(d, p, oldSource);
        if (newSource >= 0 && newSource !== oldSource) regroup(d, p, newSource);
      }
    }
  }
  for (let i = 0; i < old.length; i++) unrefNode(d, memberNode(old[i]));
  if (!after) C.unref(r);
}

/** memberOf after a connection's members changed from `old` to `fresh`: only the nodes that came or went. */
function updateMemberOf(d: StateData, c: number, old: Int32Array, fresh: Int32Array): void {
  /** Node row `n` among the first `end` members of `list`. */
  const has = (list: Int32Array, n: number, end = list.length) => {
    for (let i = 0; i < end; i++) if (memberNode(list[i]) === n) return true;
    return false;
  };
  const I = d.index;
  for (let i = 0; i < old.length; i++) {
    const n = memberNode(old[i]);
    if (!has(fresh, n) && !has(old, n, i)) I.memberOf.removeAt(n, I.memberOf.indexOf(n, c));
  }
  for (let i = 0; i < fresh.length; i++) {
    const n = memberNode(fresh[i]);
    if (!has(old, n) && !has(fresh, n, i)) I.memberOf.push(n, c);
  }
}

function writeBranch(d: StateData, b: BranchRec, present: boolean, indexed: boolean): void {
  const T = d.tables, C = T.conns;
  if (present) {
    const c = C.ref(b.connection), p = refPlan(d, b.plan), n = refNode(d, b.node);
    C.branches.push(c, p, n);
    C.branchCount++;
    if (indexed) regroupVia(d, c, p);
    return;
  }
  const c = C.rows.get(b.connection), p = T.plans.rows.get(b.plan), n = T.nodes.rows.get(b.node);
  C.branches.removeAt(c, C.branches.indexOf(c, p, n));
  C.branchCount--;
  if (indexed) regroupVia(d, c, p);
  unrefNode(d, n);
  unrefPlan(d, p);
  C.unref(c);
}

/** A branch of connection row `c` in plan row `p` came or went: the group its member gets through it may change. */
function regroupVia(d: StateData, c: number, p: number): void {
  if (d.tables.conns.kind[c] !== INCLUSION) return;
  const src = firstWith(d, c, SOURCE);
  if (src >= 0) regroup(d, p, src);
}

/**
 * The direct groups of node row `m` in plan row `p`, recomputed from its connections (memberOf): through each
 * inclusion not in the trash whose first source is `m`, its first target, when both branches are shown in `p`.
 */
function regroup(d: StateData, p: number, m: number): void {
  const C = d.tables.conns, list = d.index.memberOf;
  const found: number[] = [];
  for (let i = list.start[m], end = i + list.len[m]; i < end; i++) {
    const c = list.data[i];
    if (C.kind[c] !== INCLUSION || !Number.isNaN(C.trashedAt[c]) || firstWith(d, c, SOURCE) !== m) continue;
    const g = firstWith(d, c, TARGET);
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
  setGroup(d, p, m, group, multi);
}

function setGroup(d: StateData, p: number, m: number, group: number, multi: number[] | undefined): void {
  const I = d.index;
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

/** Removes `v` (the last element takes its place); an emptied list leaves the map. A missing `v` throws: the books are wrong. */
function listDrop<K, V>(map: Map<K, V[]>, key: K, v: V): void {
  const list = map.get(key), i = list ? list.indexOf(v) : -1;
  if (!list || i < 0) throw new Error(`index: ${String(v)} is not listed under ${String(key)}`);
  list[i] = list[list.length - 1];
  list.pop();
  if (list.length === 0) map.delete(key);
}

function writePlacement(d: StateData, plan: Id, node: Id, after: Placement | null, indexed: boolean): void {
  const P = d.tables.plans, p0 = P.rows.get(plan), n0 = d.tables.nodes.rows.get(node);
  const map = p0 >= 0 && n0 >= 0 ? P.placements[p0] : undefined;
  const had = map !== undefined && map.has(n0);
  if (after) {
    if (had) { map.set(n0, after); return; }
    const p = refPlan(d, plan), n = refNode(d, node);
    (P.placements[p] ??= new Map()).set(n, after);
    P.placementCount++;
    if (indexed) d.index.placedIn.push(n, p);
  } else if (had) {
    if (indexed) d.index.placedIn.removeAt(n0, d.index.placedIn.indexOf(n0, p0));
    map.delete(n0);
    P.placementCount--;
    unrefNode(d, n0);
    unrefPlan(d, p0);
  }
}

/** `before`: the phantom's current record (undefined: none). */
function writePhantom(d: StateData, id: Id, before: PhantomRec | undefined, after: PhantomRec | null, indexed: boolean): void {
  const T = d.tables, I = d.index;
  const moved = before?.connection !== after?.connection, regrouped = before?.group !== after?.group;
  if (indexed && before && moved) listDrop(I.phantomsOf, before.connection, id);
  if (indexed && before?.group !== undefined && regrouped) listDrop(I.phantomsIn, before.group, id);
  if (after) T.phantoms.set(id, after);
  else T.phantoms.delete(id);
  if (indexed && after && moved) listAdd(I.phantomsOf, after.connection, id);
  if (indexed && after?.group !== undefined && regrouped) listAdd(I.phantomsIn, after.group, id);
}
