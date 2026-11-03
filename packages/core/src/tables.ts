import type { ConnectionKind, ConnectionLayout, Id, NodeRec, PhantomRec, Placement, PlanRec, Role, TagKeyDef, TagValue } from './model.ts';

// The state's storage (plan 3c, decision 1): nodes, plans and connections get integer rows; connections, their members
// and their branches live in columns and pools; nodes, plans, placements, phantoms, layouts and tag keys stay objects.
// Only state.ts writes here (applyOp), and codec.ts in bulk (decodeState); readers go through the façades or the
// accessors of state.ts.

/** Connection kinds and member roles stored as their index in these lists. */
export const KINDS: readonly ConnectionKind[] = ['knowledge', 'inclusion', 'structure'];
export const ROLES: readonly Role[] = ['source', 'target', 'associate'];
export const KNOWLEDGE = 0, INCLUSION = 1, STRUCTURE = 2;
export const SOURCE = 0, TARGET = 1, ASSOCIATE = 2;
/** The kind of a connection row without a record: only its branches refer to it. */
export const NO_RECORD = 255;
/** The tags of every connection that has none: one frozen array. */
export const EMPTY_TAGS: readonly TagValue[] = Object.freeze([]);

export function kindCode(kind: ConnectionKind): number {
  const k = KINDS.indexOf(kind);
  if (k < 0) throw new Error(`unknown connection kind: ${kind}`);
  return k;
}
export function roleCode(role: Role): number {
  const r = ROLES.indexOf(role);
  if (r < 0) throw new Error(`unknown role: ${role}`);
  return r;
}
/** A member in the pool: node row × 4 + role. */
export const memberCode = (nodeRow: number, role: number): number => nodeRow * 4 + role;
export const memberNode = (m: number): number => m >> 2;
export const memberRole = (m: number): number => m & 3;

/** A copy of `a` of length `n` (at least a.length), its new part filled with `fill`. */
function resized<T extends Int32Array | Float64Array | Uint8Array>(a: T, n: number, fill = 0): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  (b as Int32Array).set(a as Int32Array);
  if (fill !== 0) b.fill(fill, a.length);
  return b;
}
/** At least `min` long, doubling. */
const grown = <T extends Int32Array | Float64Array | Uint8Array>(a: T, min: number, fill = 0): T => resized(a, Math.max(min, a.length * 2, 16), fill);
export const growInt32 = (a: Int32Array, min: number, fill = 0): Int32Array => (min <= a.length ? a : grown(a, min, fill));
/** At least `n` long, exactly: sizing for a bulk load. */
const presized = <T extends Int32Array | Float64Array | Uint8Array>(a: T, n: number, fill = 0): T => (n <= a.length ? a : resized(a, n, fill));

/**
 * Identifiers and their rows. A row is counted by the references that hold it (its record, members, branches,
 * placements) and freed at zero onto a last-in first-out list: undoing a removal gets the same row back.
 */
export class Rows {
  /** Identifier → row; null until first needed after a bulk restore (restored). */
  private index: Map<Id, number> | null;
  /** The identifier of each row; '' for a free row. Replaced whole only by a bulk restore. */
  ids: string[];
  refs: Int32Array;
  readonly free: number[];
  /** Rows ever allocated: the per-row columns cover [0, end). */
  end: number;

  constructor() {
    this.index = new Map();
    this.ids = [];
    this.refs = new Int32Array(16);
    this.free = [];
    this.end = 0;
  }

  /** Identifier → row of the held rows. */
  get row(): Map<Id, number> {
    return (this.index ??= this.indexIds());
  }

  /**
   * `ids`, `refs`, `free` and `end` were filled in bulk (decodeState): the identifier map is built at its first use, from
   * `ids`. Hashing every identifier of a large base is most of a load's decoding, and a reader may never need some tables'.
   */
  restored(): void {
    this.index = null;
  }

  private indexIds(): Map<Id, number> {
    const free = new Uint8Array(this.end), ids = this.ids, map = new Map<Id, number>();
    for (const r of this.free) free[r] = 1;
    for (let r = 0; r < this.end; r++) if (free[r] === 0) map.set(ids[r], r);
    return map;
  }

  get(id: Id): number {
    return this.row.get(id) ?? -1;
  }

  /** Room for `n` rows, exactly. */
  presize(n: number): void {
    this.refs = presized(this.refs, n);
  }

  /** The row of `id`, allocated when it has none, with one more reference. */
  ref(id: Id): number {
    let r = this.row.get(id);
    if (r === undefined) {
      r = this.free.length > 0 ? this.free.pop()! : this.end++;
      this.refs = growInt32(this.refs, r + 1);
      this.row.set(id, r);
      this.ids[r] = id;
    }
    this.refs[r]++;
    return r;
  }

  /** One more reference to a row already held, without looking its identifier up. */
  refAgain(r: number): number {
    this.held(r);
    this.refs[r]++;
    return r;
  }

  /** One reference less; true when that frees the row. */
  unref(r: number): boolean {
    this.held(r);
    if (--this.refs[r] > 0) return false;
    this.row.delete(this.ids[r]);
    this.ids[r] = '';
    this.free.push(r);
    return true;
  }

  /** A row no reference holds (−1 for an unknown identifier, a free row) means the books are wrong: fail loudly. */
  private held(r: number): void {
    if (!(r >= 0 && r < this.end && this.refs[r] > 0)) throw new Error(`rows: row ${r} is not held`);
  }
}

/**
 * Lists of integers, one per owner row, in one Int32Array: each owner has a start, a length and a capacity, in
 * integers. A list that outgrows its capacity moves to the end of the pool (or grows where it is when it is last); the
 * space it leaves, and that of released lists, is waste, and the pool compacts itself past 50 % of waste.
 */
export class Pool {
  /** Integers per entry: 1 (a member, a connection row, a plan row) or 2 (a branch: plan row, node row). */
  readonly stride: number;
  data: Int32Array;
  /** Integers in use or wasted: a moved list goes there. */
  top: number;
  /** Integers left behind by moved or released lists. */
  waste: number;
  start: Int32Array;
  len: Int32Array;
  cap: Int32Array;

  constructor(stride: number) {
    this.stride = stride;
    this.data = new Int32Array(16);
    this.top = 0;
    this.waste = 0;
    this.start = new Int32Array(16);
    this.len = new Int32Array(16);
    this.cap = new Int32Array(16);
  }

  /** An empty pool where owner o has room for exactly counts[o] entries, packed (loading: push fills it without moving). */
  static sized(stride: number, counts: Int32Array): Pool {
    const p = new Pool(stride);
    p.owners(counts.length);
    let top = 0;
    for (let o = 0; o < counts.length; o++) { p.start[o] = top; p.cap[o] = counts[o] * stride; top += p.cap[o]; }
    p.data = new Int32Array(Math.max(16, top));
    p.top = top;
    return p;
  }

  /** Room for `owners` owners and `ints` integers, exactly. */
  presize(owners: number, ints: number): void {
    this.start = presized(this.start, owners);
    this.len = presized(this.len, owners);
    this.cap = presized(this.cap, owners);
    this.data = presized(this.data, ints);
  }

  /** Makes room for owners [0, n). */
  owners(n: number): void {
    if (n <= this.start.length) return;
    this.start = growInt32(this.start, n);
    this.len = growInt32(this.len, n);
    this.cap = growInt32(this.cap, n);
  }

  /** The owner's integers, as a view: valid until the next change of the pool. */
  view(owner: number): Int32Array {
    if (!(owner >= 0 && owner < this.len.length)) return this.data.subarray(0, 0);
    const s = this.start[owner];
    return this.data.subarray(s, s + this.len[owner]);
  }

  /** The index of entry (a, b) in the owner's list (b only for pairs), or −1. */
  indexOf(owner: number, a: number, b = 0): number {
    if (!(owner >= 0 && owner < this.len.length)) return -1;
    const s = this.start[owner], end = s + this.len[owner], d = this.data;
    if (this.stride === 1) {
      for (let i = s; i < end; i++) if (d[i] === a) return i - s;
    } else {
      for (let i = s; i < end; i += 2) if (d[i] === a && d[i + 1] === b) return (i - s) / 2;
    }
    return -1;
  }

  push(owner: number, a: number, b = 0): void {
    this.owner(owner);
    const n = this.len[owner];
    this.reserve(owner, n + this.stride);
    const i = this.start[owner] + n;
    this.data[i] = a;
    if (this.stride === 2) this.data[i + 1] = b;
    this.len[owner] = n + this.stride;
  }

  /** Removes entry `index`; the last entry takes its place. */
  removeAt(owner: number, index: number): void {
    this.owner(owner);
    if (!(index >= 0 && index * this.stride < this.len[owner])) throw new Error(`pool: owner ${owner} has no entry ${index}`);
    const s = this.start[owner], last = this.len[owner] - this.stride, at = index * this.stride;
    for (let k = 0; k < this.stride; k++) this.data[s + at + k] = this.data[s + last + k];
    this.len[owner] = last;
  }

  /** Replaces the owner's list. */
  set(owner: number, values: ArrayLike<number>): void {
    this.owner(owner);
    this.len[owner] = 0;
    this.reserve(owner, values.length);
    this.data.set(values, this.start[owner]);
    this.len[owner] = values.length;
  }

  /** Gives up the owner's list and its space. */
  release(owner: number): void {
    if (owner >= this.cap.length) return;
    this.owner(owner);
    if (this.cap[owner] === 0) return;
    this.waste += this.cap[owner];
    this.start[owner] = this.len[owner] = this.cap[owner] = 0;
    this.settle();
  }

  /** An owner outside the pool (−1 for an unknown row) means the books are wrong: fail loudly. */
  private owner(owner: number): void {
    if (!(owner >= 0 && owner < this.start.length)) throw new Error(`pool: no owner ${owner}`);
  }

  private reserve(owner: number, need: number): void {
    const cap = this.cap[owner];
    if (need <= cap) return;
    const start = this.start[owner], next = Math.max(need, cap * 2);
    if (cap > 0 && start + cap === this.top) {
      // Last in the pool: it grows where it is.
      this.ensure(start + next);
      this.top = start + next;
      this.cap[owner] = next;
      return;
    }
    this.ensure(this.top + next);
    this.data.copyWithin(this.top, start, start + this.len[owner]);
    this.start[owner] = this.top;
    this.cap[owner] = next;
    this.top += next;
    this.waste += cap;
    this.settle();
  }

  private ensure(n: number): void {
    if (n > this.data.length) this.data = grown(this.data, n);
  }

  private settle(): void {
    if (this.waste * 2 > this.top) this.compact();
  }

  /** Lists packed in owner order, each keeping its capacity: no waste left. */
  compact(): void {
    const live = this.top - this.waste;
    const data = new Int32Array(Math.max(16, live + (live >> 1)));
    let top = 0;
    for (let o = 0; o < this.cap.length; o++) {
      const cap = this.cap[o];
      if (cap === 0) continue;
      data.set(this.data.subarray(this.start[o], this.start[o] + this.len[o]), top);
      this.start[o] = top;
      top += cap;
    }
    this.data = data;
    this.top = top;
    this.waste = 0;
  }
}

export class NodeTable {
  readonly rows: Rows;
  /** The record of each row; undefined for a row held by references only, or free. */
  readonly recs: (NodeRec | undefined)[];
  count: number;

  constructor() {
    this.rows = new Rows();
    this.recs = [];
    this.count = 0;
  }

  ref(id: Id): number {
    const r = this.rows.ref(id);
    if (r === this.recs.length) this.recs.push(undefined);
    return r;
  }

  /** True when the row is freed. */
  unref(r: number): boolean {
    if (!this.rows.unref(r)) return false;
    this.recs[r] = undefined;
    return true;
  }
}

export class PlanTable {
  readonly rows: Rows;
  readonly recs: (PlanRec | undefined)[];
  /** Per plan row, its placements by node row. */
  readonly placements: (Map<number, Placement> | undefined)[];
  count: number;
  placementCount: number;

  constructor() {
    this.rows = new Rows();
    this.recs = [];
    this.placements = [];
    this.count = 0;
    this.placementCount = 0;
  }

  ref(id: Id): number {
    const r = this.rows.ref(id);
    if (r === this.recs.length) { this.recs.push(undefined); this.placements.push(undefined); }
    return r;
  }

  /** True when the row is freed. */
  unref(r: number): boolean {
    if (!this.rows.unref(r)) return false;
    this.recs[r] = undefined;
    this.placements[r] = undefined;
    return true;
  }
}

export class ConnTable {
  readonly rows: Rows;
  /** Index in KINDS, or NO_RECORD. */
  kind: Uint8Array;
  /** Per row; replaced whole only by a bulk restore, like the columns. */
  title: string[];
  relation: string[];
  tags: (readonly TagValue[])[];
  /** NaN when not in the trash. */
  trashedAt: Float64Array;
  /** Per connection row: its members, node row × 4 + role, in order. */
  readonly members: Pool;
  /** Per connection row: its branches, pairs (plan row, node row). */
  branches: Pool;
  count: number;
  branchCount: number;

  constructor() {
    this.rows = new Rows();
    this.kind = new Uint8Array(16).fill(NO_RECORD);
    this.title = [];
    this.relation = [];
    this.tags = [];
    this.trashedAt = new Float64Array(16).fill(NaN);
    this.members = new Pool(1);
    this.branches = new Pool(2);
    this.count = 0;
    this.branchCount = 0;
  }

  /** Room for `n` connections and `members` members, exactly. */
  presize(n: number, members: number): void {
    this.rows.presize(n);
    this.kind = presized(this.kind, n, NO_RECORD);
    this.trashedAt = presized(this.trashedAt, n, NaN);
    this.members.presize(n, members);
    this.branches.presize(n, 0);
  }

  ref(id: Id): number {
    const r = this.rows.ref(id);
    if (r >= this.kind.length) {
      this.kind = grown(this.kind, r + 1, NO_RECORD);
      this.trashedAt = grown(this.trashedAt, r + 1, NaN);
    }
    if (r === this.title.length) { this.title.push(''); this.relation.push(''); this.tags.push(EMPTY_TAGS); }
    this.members.owners(r + 1);
    this.branches.owners(r + 1);
    return r;
  }

  /** One reference less; a freed row is reset. */
  unref(r: number): void {
    if (!this.rows.unref(r)) return;
    this.kind[r] = NO_RECORD;
    this.title[r] = '';
    this.relation[r] = '';
    this.tags[r] = EMPTY_TAGS;
    this.trashedAt[r] = NaN;
    this.members.release(r);
    this.branches.release(r);
  }
}

export interface Tables {
  readonly nodes: NodeTable;
  readonly plans: PlanTable;
  readonly conns: ConnTable;
  readonly phantoms: Map<Id, PhantomRec>;
  /** key `${plan}|${connection}` */
  readonly layouts: Map<string, ConnectionLayout>;
  readonly tagKeys: Map<string, TagKeyDef>;
}

export function emptyTables(): Tables {
  return { nodes: new NodeTable(), plans: new PlanTable(), conns: new ConnTable(), phantoms: new Map(), layouts: new Map(), tagKeys: new Map() };
}
