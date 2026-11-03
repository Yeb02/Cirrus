import {
  branchNodes, type ConnectionRec, connId, connKind, connRow, formerConnRow, formerNodeRow, groupMembers, type Id, INCLUSION, memberAt, memberCount, memberOf, nodeAt,
  nodeId, nodeRow, type NodeRec,
  type Op, type PhantomRec, phantomsIn, phantomsOf, placementsIn, type PlanRec, planRow, SOURCE, type State,
} from '@cirrus/core';
import type { Bounds } from './camera.ts';
import type { RenderParams } from './params.ts';
import {
  badgeOf, boundsOf, buildScene, capacityFor, drawnKind, drawOrder, extentOf, GONE_ITEM, type GroupShape, groupShape, layoutIn, linesCache, makeScene,
  type Measure, nodeItem, PART_FAR, PART_GONE, PART_MAIN, parentOf, partsOf, type PartSpec, phantomItem, type PlanScene, type SceneData, type SceneItem,
  idOrder, type SceneLookup, type SceneStub, tails, union, unseen,
} from './scene.ts';

/** What an update changed, for those who keep something per item or per part (visibility index, renderer). */
export interface SceneChanges {
  /** Item slots written: appeared, changed or removed. */
  items: number[];
  /** Part slots written: appeared, derived again or removed. The parts of a moved item are not listed: their ends follow it. */
  parts: number[];
  /** Whether parents, children, kinds, depths or roots changed. */
  hierarchy: boolean;
  /** The scene was built anew: everything changed, slots included. */
  full: boolean;
}

const noChange = (): SceneChanges => ({ items: [], parts: [], hierarchy: false, full: false });
const NO_PHANTOMS: PhantomRec[] = [];

type Column = Int32Array | Uint8Array | unknown[];
const isTyped = (a: Column): a is Int32Array | Uint8Array => ArrayBuffer.isView(a);

/**
 * A column shared with the previous scene, indexed by slot (parts, ends): written in place past the end that every
 * scene sharing it reached (tails), copied before any other write — the previous scene never sees a change.
 */
class Col<T extends Column> {
  a: T;
  owned = false;
  private claimed = false;
  private readonly count0: number;

  constructor(a: T, count0: number) {
    this.a = a;
    this.count0 = count0;
  }

  /** The array to write index i into. */
  at(i: number): T {
    if (!this.owned) {
      if (i < this.count0) this.own(i + 1);
      else if (!this.claimed) {
        if (tails.get(this.a) === this.count0) this.claimed = true;
        else this.own(i + 1);
      }
    }
    if (isTyped(this.a) && i >= this.a.length) this.own(i + 1);
    return this.a;
  }

  /** Whether writing index i would copy the column. */
  copies(i: number): boolean {
    if (this.owned) return isTyped(this.a) && i >= this.a.length;
    return i < this.count0 || (!this.claimed && tails.get(this.a) !== this.count0) || (isTyped(this.a) && i >= this.a.length);
  }

  /** The new scene fills the column up to `count`: marked, if it is the column's own or it wrote past the shared end. */
  seal(count: number): void {
    if (this.owned || this.claimed) tails.set(this.a, count);
  }

  own(need: number): void {
    const a = this.a;
    if (isTyped(a)) {
      const b = new (a.constructor as new (n: number) => Int32Array | Uint8Array)(Math.max(a.length, need > a.length ? capacityFor(need) : 0));
      b.set(a);
      this.a = b as T;
    } else this.a = a.slice() as T;
    this.owned = true;
  }
}

/** A copy of `a` at least `n` long, the new part filled with −1. */
function grownCopy(a: Int32Array, n: number): Int32Array {
  const b = new Int32Array(Math.max(a.length, n > a.length ? capacityFor(n) : 0)).fill(-1);
  b.set(a);
  return b;
}

const sameStubs = (a: readonly SceneStub[] | undefined, b: SceneStub[] | null): boolean =>
  (a === undefined || a.length === 0) === (b === null)
  && (b === null || (a!.length === b.length && a!.every((x, i) => x.role === b[i].role && x.node === b[i].node && x.title === b[i].title)));

const sameMembers = (a: ConnectionRec, b: ConnectionRec): boolean =>
  a.members.length === b.members.length && a.members.every((m, i) => m.node === b.members[i].node && m.role === b.members[i].role);

const firstSource = (c: ConnectionRec | null): Id | undefined => c?.members.find((m) => m.role === 'source')?.node;

/** A drawn box's own fields (a group's centre aside: it is derived). */
const sameOwn = (a: SceneItem, b: SceneItem): boolean =>
  a.title === b.title && a.lines === b.lines && a.k === b.k && a.halfW === b.halfW && a.halfH === b.halfH && a.node === b.node && a.phantom === b.phantom
  && a.connection === b.connection;

const sameShape = (a: SceneItem, b: GroupShape): boolean =>
  a.x === b.x && a.y === b.y && a.pad === b.pad && a.maxChildK === b.maxChildK && a.hull!.length === b.hull.length
  && a.hull!.every((q, i) => q.x === b.hull[i].x && q.y === b.hull[i].y);

const sameExtent = (a: Bounds | null, b: Bounds | null): boolean =>
  a === b || (a !== null && b !== null && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY);

/** Whether an extent reaches the bounds on a side: removing it may shrink them. */
const touches = (e: Bounds, b: Bounds): boolean => e.minX <= b.minX || e.minY <= b.minY || e.maxX >= b.maxX || e.maxY >= b.maxY;

/** The hue ranks once the top-level groups `left` went and `joined` came: by identifier, as huesOf ranks them. */
function huesAfter(prev: Map<number, number>, items: SceneItem[], left: number[], joined: number[]): Map<number, number> {
  const order: number[] = [];
  for (const [g, r] of prev) order[r] = g;
  const gone = new Set(left), tops = order.filter((g) => !gone.has(g));
  for (const g of joined) {
    let lo = 0, hi = tops.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (items[tops[mid]].id < items[g].id) lo = mid + 1; else hi = mid; }
    tops.splice(lo, 0, g);
  }
  return new Map(tops.map((g, r) => [g, r]));
}

/** What the operations touch in one plan (step 1 of updateScene). */
interface Touched {
  /** Nodes whose item may appear, change or go. */
  nodes: Set<Id>;
  /** Of those, the ones whose first operation shows them drawn before it (placed here and not in the trash). */
  before: Map<Id, boolean>;
  phantoms: Set<Id>;
  /** Connection rows whose parts are derived again. */
  conns: Set<number>;
  /** Connections without a row any longer, by the row they held (formerConnRow): their parts there go. */
  freed: Map<Id, number>;
  /** Of those, the ones whose row is taken by another already: their parts are searched for by identifier (rare). */
  lost: Set<Id>;
  /** Nodes whose direct group in this plan may have changed. */
  groups: Set<Id>;
  /** Node rows whose badge is computed again. */
  badges: Set<number>;
  /** Connection rows that may have become seen by a member: their record changed, a branch or a phantom came here. */
  raised: Set<number>;
}

function touchedBy(prev: PlanScene, s: State, ops: readonly Op[]): Touched {
  const planId = prev.plan.id;
  const t: Touched = {
    nodes: new Set(), before: new Map(), phantoms: new Set(), conns: new Set(), freed: new Map(), lost: new Set(), groups: new Set(), badges: new Set(),
    raised: new Set(),
  };
  const conn = (id: Id, raised = false) => {
    const r = connRow(s, id);
    if (r < 0) {
      // Its row was freed (the undo of its creation): the core says which, unless another took it since.
      const former = formerConnRow(s, id);
      if (former >= 0) t.freed.set(id, former);
      else t.lost.add(id);
      return;
    }
    t.conns.add(r);
    if (raised) t.raised.add(r);
  };
  const badge = (node: Id) => { const r = nodeRow(s, node); if (r >= 0) t.badges.add(r); };
  /** This plan's phantoms of a connection, all or those standing for one node. */
  const phantomsHere = (connection: Id, node?: Id) => {
    for (const id of phantomsOf(s, connection)) {
      const ph = s.phantoms.get(id);
      if (ph && ph.plan === planId && (node === undefined || ph.of.node === node)) t.phantoms.add(id);
    }
  };
  const placedFirst = new Map<Id, boolean>(), aliveFirst = new Map<Id, boolean>();
  for (const op of ops) {
    switch (op.t) {
      case 'node': {
        const b = op.before, a = op.after, id = (a ?? b)!.id;
        const alive = (x: NodeRec | null) => x !== null && x.trashedAt === undefined;
        if (!aliveFirst.has(id)) aliveFirst.set(id, alive(b));
        if (b?.title === a?.title && alive(b) === alive(a)) break; // summary, tags, files: not drawn
        t.nodes.add(id);
        const r = nodeRow(s, id);
        if (r < 0) break;
        t.badges.add(r);
        // Its stubs' titles and its phantoms' titles, wherever it is a member.
        for (const c of memberOf(s, r)) { t.conns.add(c); if (b?.title !== a?.title) phantomsHere(connId(s, c), id); }
        break;
      }
      case 'connection': {
        const b = op.before, a = op.after, id = (a ?? b)!.id;
        if (b && a && b.kind === a.kind && b.title === a.title && b.trashedAt === a.trashedAt && sameMembers(b, a)) break; // relation, tags
        conn(id, true);
        for (const m of [...(b?.members ?? []), ...(a?.members ?? [])]) badge(m.node);
        if (b?.kind === 'inclusion' || a?.kind === 'inclusion') for (const src of [firstSource(b), firstSource(a)]) if (src !== undefined) t.groups.add(src);
        if (b?.title !== a?.title || (b === null) !== (a === null)) phantomsHere(id);
        break;
      }
      case 'plan': // this plan's record: compared whole below; another plan's: nothing here
      case 'tagKey':
        break;
      case 'placement': {
        const rec = (op.after ?? op.before)!;
        if (rec.plan !== planId) break;
        t.nodes.add(rec.node);
        if (!placedFirst.has(rec.node)) placedFirst.set(rec.node, op.before !== null);
        break;
      }
      case 'branch': {
        if (op.key.plan !== planId) break;
        conn(op.key.connection, op.after);
        badge(op.key.node);
        const c = connRow(s, op.key.connection);
        if (c >= 0 && connKind(s, c) === INCLUSION) {
          for (let k = 0, n = memberCount(s, c); k < n; k++) {
            const m = memberAt(s, c, k);
            if ((m & 3) === SOURCE) { t.groups.add(nodeId(s, m >> 2)); break; }
          }
        }
        break;
      }
      case 'connLayout': {
        const rec = (op.after ?? op.before)!;
        if (rec.plan === planId) conn(rec.connection);
        break;
      }
      case 'phantom': {
        const b = op.before, a = op.after;
        if (b?.plan !== planId && a?.plan !== planId) break;
        t.phantoms.add((a ?? b)!.id);
        for (const x of [b, a]) if (x && x.plan === planId) { conn(x.connection, x === a); badge(x.of.node); }
        break;
      }
    }
  }
  // Whether each node was drawn before the operations: its first operation's "before", else the state as it is.
  const pr = planRow(s, planId);
  for (const id of t.nodes) {
    const r = nodeRow(s, id), rec = r >= 0 ? nodeAt(s, r) : undefined;
    const placed = placedFirst.get(id) ?? (r >= 0 && pr >= 0 && placementsIn(s, pr).has(r));
    const alive = aliveFirst.get(id) ?? (rec !== undefined && rec.trashedAt === undefined);
    t.before.set(id, placed && alive);
  }
  return t;
}

/** The scene being made from the previous one: its arrays copied on their first write in this update (step 2 on). */
class Update {
  readonly prev: PlanScene;
  readonly s: State;
  readonly plan: PlanRec;
  readonly pr: number;
  readonly p: RenderParams;
  readonly linesOf: (t: string) => number;
  readonly L: SceneLookup;

  items: SceneItem[];
  private itemsOwned = false;
  /** Items whose object this update made: changed in place from then on. */
  private readonly mine = new Set<number>();
  private readonly childrenMine = new Set<number>();
  itemOfNode: Int32Array;
  private nodeMapOwned = false;
  freeItems: number[];
  private freeItemsOwned = false;
  roots: number[];
  private rootsOwned = false;
  readonly phantomSlots = new Map<Id, number | null>();
  readonly stubChanges = new Map<number, SceneStub[] | null>();

  partCount: number;
  readonly connRow: Col<Int32Array>;
  readonly part: Col<Uint8Array>;
  readonly center: Col<Int32Array>;
  readonly endStart: Col<Int32Array>;
  readonly endCount: Col<Int32Array>;
  readonly partNext: Col<Int32Array>;
  readonly ids: Col<Id[]>;
  readonly titles: Col<string[]>;
  readonly layout: Col<PlanScene['layout']>;
  partHead: Int32Array;
  private headOwned = false;
  freeParts: number[];
  private freePartsOwned = false;
  readonly endItem: Col<Int32Array>;
  readonly endKey: Col<Int32Array>;
  readonly endMeta: Col<Uint8Array>;
  endTop: number;
  endWaste: number;

  readonly changedItems = new Set<number>();
  readonly changedParts = new Set<number>();
  hierarchy = false;

  constructor(prev: PlanScene, s: State, plan: PlanRec, measure: Measure, p: RenderParams) {
    this.prev = prev;
    this.s = s;
    this.plan = plan;
    this.pr = planRow(s, plan.id);
    this.p = p;
    this.linesOf = linesCache(measure);
    this.items = prev.items;
    this.itemOfNode = prev.itemOfNode;
    this.freeItems = prev.freeItems;
    this.roots = prev.roots;
    this.partCount = prev.partCount;
    const n = prev.partCount;
    this.connRow = new Col(prev.connRow, n);
    this.part = new Col(prev.part, n);
    this.center = new Col(prev.center, n);
    this.endStart = new Col(prev.endStart, n);
    this.endCount = new Col(prev.endCount, n);
    this.partNext = new Col(prev.partNext, n);
    this.ids = new Col(prev.ids, n);
    this.titles = new Col(prev.titles, n);
    this.layout = new Col(prev.layout, n);
    this.partHead = prev.partHead;
    this.freeParts = prev.freeParts;
    const e = prev.ends;
    this.endItem = new Col(e.item, e.top);
    this.endKey = new Col(e.key, e.top);
    this.endMeta = new Col(e.meta, e.top);
    this.endTop = e.top;
    this.endWaste = e.waste;
    this.L = {
      s, plan, planRow: this.pr, kind: drawnKind(plan), itemOfNode: this.itemOfNode, phantomItem: (id) => this.phantomSlot(id) ?? -1,
      layoutOf: (c) => layoutIn(s, plan.id, c),
    };
  }

  // ———— Items

  phantomSlot(id: Id): number | undefined {
    const v = this.phantomSlots.get(id);
    return v === undefined ? this.prev.itemOfPhantom.get(id) : v ?? undefined;
  }

  private ownItems(): SceneItem[] {
    if (!this.itemsOwned) { this.items = this.items.slice(); this.itemsOwned = true; }
    return this.items;
  }

  /** Slot i's item, made this update's own to change in place. */
  mut(i: number): SceneItem {
    const items = this.ownItems();
    if (!this.mine.has(i)) { items[i] = { ...items[i] }; this.mine.add(i); }
    this.changedItems.add(i);
    return items[i];
  }

  /** Replaces slot i's item by one this update made. */
  put(i: number, it: SceneItem): void {
    const items = this.ownItems();
    if (i === items.length) items.push(it);
    else items[i] = it;
    if (it === GONE_ITEM) this.mine.delete(i);
    else this.mine.add(i);
    this.childrenMine.delete(i);
    this.changedItems.add(i);
  }

  /** Slot i's children, made this update's own to change in place. */
  children(i: number): number[] {
    const it = this.mut(i);
    if (!this.childrenMine.has(i)) { it.children = [...it.children]; this.childrenMine.add(i); }
    return it.children;
  }

  setNodeSlot(r: number, i: number): void {
    if (!this.nodeMapOwned || r >= this.itemOfNode.length) {
      this.itemOfNode = grownCopy(this.itemOfNode, r + 1);
      this.nodeMapOwned = true;
      this.L.itemOfNode = this.itemOfNode;
    }
    this.itemOfNode[r] = i;
  }

  private ownFreeItems(): number[] {
    if (!this.freeItemsOwned) { this.freeItems = [...this.freeItems]; this.freeItemsOwned = true; }
    return this.freeItems;
  }

  /** A slot for a new item: a free one (freed before this update), else a new one at the end. */
  allocItem(): number {
    const free = this.ownFreeItems();
    return free.length > 0 ? free.pop()! : this.items.length;
  }

  /** Slots removed in this update: free once its items are placed (an item appearing now never takes one). */
  private readonly freed: number[] = [];

  freeItem(i: number): void {
    this.put(i, GONE_ITEM);
    this.freed.push(i);
  }

  /** The slots removed in this update, given back. */
  releaseItems(): void {
    if (this.freed.length > 0) this.ownFreeItems().push(...this.freed);
  }

  ownRoots(): number[] {
    if (!this.rootsOwned) { this.roots = [...this.roots]; this.rootsOwned = true; }
    return this.roots;
  }

  /** Inserts slot i among `list` (sorted in draw order). */
  insertSorted(list: number[], i: number): void {
    const order = drawOrder(this.items);
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (order(list[mid], i) < 0) lo = mid + 1; else hi = mid; }
    list.splice(lo, 0, i);
  }

  link(i: number, parent: number): void {
    if (parent >= 0) this.insertSorted(this.children(parent), i);
    else this.insertSorted(this.ownRoots(), i);
  }

  unlink(i: number, parent: number): void {
    const list = parent >= 0 ? (this.items[parent] === GONE_ITEM ? null : this.children(parent)) : this.ownRoots();
    if (!list) return;
    const at = list.indexOf(i);
    if (at >= 0) list.splice(at, 1);
  }

  // ———— Parts

  /** Every column a new part writes is already this update's own: a free slot can be taken without a copy. */
  private partColumnsOwned(): boolean {
    return [this.connRow, this.part, this.center, this.endStart, this.endCount, this.partNext, this.ids, this.titles, this.layout].every((c) => c.owned);
  }

  /**
   * A slot for a new part: a free one when the columns are copied anyway; else the end of the shared columns, where
   * writing copies nothing; when they must grow (or be copied), a free one again.
   */
  allocPart(): number {
    if (this.freeParts.length > 0 && this.partColumnsOwned()) return this.popFreePart();
    const cols = [this.connRow, this.part, this.center, this.endStart, this.endCount, this.partNext, this.ids, this.titles, this.layout];
    if (this.freeParts.length > 0 && cols.some((c) => c.copies(this.partCount))) {
      for (const c of cols) if (!c.owned) c.own(this.partCount);
      return this.popFreePart();
    }
    return this.partCount++;
  }

  private popFreePart(): number {
    if (!this.freePartsOwned) { this.freeParts = [...this.freeParts]; this.freePartsOwned = true; }
    return this.freeParts.pop()!;
  }

  private setHead(c: number, i: number): void {
    if (!this.headOwned || c >= this.partHead.length) { this.partHead = grownCopy(this.partHead, c + 1); this.headOwned = true; }
    this.partHead[c] = i;
  }

  /** The parts of connection row c in the scene being made. */
  partsOfRow(c: number): number[] {
    const out: number[] = [];
    if (c >= this.partHead.length) return out;
    for (let i = this.partHead[c]; i >= 0; i = this.partNext.a[i]) out.push(i);
    return out;
  }

  /** Writes a part's ends at the top of the pool (copied nothing if the pool's end is ours). */
  private writeEnds(i: number, ends: number[]): void {
    const n = ends.length / 3, top = this.endTop;
    if (n > 0) {
      const item = this.endItem.at(top + n - 1), key = this.endKey.at(top + n - 1), meta = this.endMeta.at(top + n - 1);
      for (let k = 0; k < n; k++) { item[top + k] = ends[3 * k]; key[top + k] = ends[3 * k + 1]; meta[top + k] = ends[3 * k + 2]; }
    }
    this.endTop = top + n;
    this.endStart.at(i)[i] = top;
    this.endCount.at(i)[i] = n;
  }

  private sameEnds(i: number, ends: number[]): boolean {
    const n = this.endCount.a[i];
    if (n * 3 !== ends.length) return false;
    const s0 = this.endStart.a[i], item = this.endItem.a, key = this.endKey.a, meta = this.endMeta.a;
    for (let k = 0; k < n; k++) if (item[s0 + k] !== ends[3 * k] || key[s0 + k] !== ends[3 * k + 1] || meta[s0 + k] !== ends[3 * k + 2]) return false;
    return true;
  }

  stubsOf(i: number): SceneStub[] | undefined {
    const v = this.stubChanges.get(i);
    return v === undefined ? this.prev.stubs.get(i) : v ?? undefined;
  }

  addPart(c: number, id: Id, spec: PartSpec): void {
    const i = this.allocPart();
    this.connRow.at(i)[i] = c;
    this.part.at(i)[i] = spec.far ? PART_FAR : PART_MAIN;
    this.center.at(i)[i] = spec.center;
    this.ids.at(i)[i] = id;
    this.titles.at(i)[i] = spec.title;
    this.layout.at(i)[i] = spec.layout;
    this.writeEnds(i, spec.ends);
    if (spec.stubs || this.stubsOf(i)) this.stubChanges.set(i, spec.stubs);
    this.partNext.at(i)[i] = c < this.partHead.length ? this.partHead[c] : -1;
    this.setHead(c, i);
    this.changedParts.add(i);
  }

  /** Part i derived again: only what differs is written. */
  rewritePart(i: number, spec: PartSpec): void {
    let changed = false;
    if (this.titles.a[i] !== spec.title) { this.titles.at(i)[i] = spec.title; changed = true; }
    if (this.layout.a[i] !== spec.layout) { this.layout.at(i)[i] = spec.layout; changed = true; }
    if (this.center.a[i] !== spec.center) { this.center.at(i)[i] = spec.center; changed = true; }
    if (!this.sameEnds(i, spec.ends)) { this.endWaste += this.endCount.a[i]; this.writeEnds(i, spec.ends); changed = true; }
    if (!sameStubs(this.stubsOf(i), spec.stubs)) { this.stubChanges.set(i, spec.stubs); changed = true; }
    if (changed) this.changedParts.add(i);
  }

  removePart(i: number): void {
    const c = this.connRow.a[i];
    if (c < this.partHead.length && this.partHead[c] === i) this.setHead(c, this.partNext.a[i]);
    else for (let j = c < this.partHead.length ? this.partHead[c] : -1; j >= 0; j = this.partNext.a[j]) {
      if (this.partNext.a[j] === i) { this.partNext.at(j)[j] = this.partNext.a[i]; break; }
    }
    // Nothing left that points anywhere: ends, centre, next part, layout, stubs.
    this.part.at(i)[i] = PART_GONE;
    if (this.layout.a[i] !== undefined) this.layout.at(i)[i] = undefined;
    if (this.stubsOf(i)) this.stubChanges.set(i, null);
    this.endWaste += this.endCount.a[i];
    if (this.endCount.a[i] !== 0) this.endCount.at(i)[i] = 0;
    if (this.center.a[i] !== -1) this.center.at(i)[i] = -1;
    if (this.partNext.a[i] !== -1) this.partNext.at(i)[i] = -1;
    if (!this.freePartsOwned) { this.freeParts = [...this.freeParts]; this.freePartsOwned = true; }
    this.freeParts.push(i);
    this.changedParts.add(i);
  }

  /** The end pool packed again (past half of it wasted): every live part's ends, in slot order. */
  compactEnds(): void {
    const live = this.endTop - this.endWaste, cap = capacityFor(live);
    const item = new Int32Array(cap), key = new Int32Array(cap), meta = new Uint8Array(cap);
    const start = this.endStart, count = this.endCount, part = this.part.a;
    let top = 0;
    for (let i = 0; i < this.partCount; i++) {
      if (part[i] === PART_GONE) continue;
      const s0 = start.a[i], n = count.a[i];
      item.set(this.endItem.a.subarray(s0, s0 + n), top);
      key.set(this.endKey.a.subarray(s0, s0 + n), top);
      meta.set(this.endMeta.a.subarray(s0, s0 + n), top);
      if (s0 !== top) start.at(i)[i] = top;
      top += n;
    }
    for (const [c, a] of [[this.endItem, item], [this.endKey, key], [this.endMeta, meta]] as const) { c.a = a as never; c.owned = true; }
    this.endTop = top;
    this.endWaste = 0;
  }

  /** The scene made: its data, and how far it fills the columns it shares. */
  data(bounds: Bounds | null, hues: Map<number, number>): SceneData {
    const prev = this.prev;
    const data: SceneData = {
      plan: this.plan, items: this.items, itemOfNode: this.itemOfNode, itemOfPhantom: (prev.itemOfPhantom as LayeredMapOf<Id, number>).with(this.phantomSlots),
      freeItems: this.freeItems, roots: this.roots, partCount: this.partCount, connRow: this.connRow.a, part: this.part.a, center: this.center.a, layout: this.layout.a,
      ids: this.ids.a, titles: this.titles.a, endStart: this.endStart.a, endCount: this.endCount.a,
      ends: { item: this.endItem.a, key: this.endKey.a, meta: this.endMeta.a, top: this.endTop, waste: this.endWaste },
      stubs: (prev.stubs as LayeredMapOf<number, SceneStub[]>).with(this.stubChanges), partHead: this.partHead, partNext: this.partNext.a, freeParts: this.freeParts,
      hues, bounds,
    };
    // A mark is never lowered: a scene that went further on a shared column keeps its end.
    for (const c of [this.connRow, this.part, this.center, this.endStart, this.endCount, this.partNext, this.ids, this.titles, this.layout]) c.seal(this.partCount);
    for (const c of [this.endItem, this.endKey, this.endMeta]) c.seal(this.endTop);
    return data;
  }
}

/** The shared maps of a scene (LayeredMap), as updateScene writes them. */
interface LayeredMapOf<K, V> extends ReadonlyMap<K, V> { with(changes: Map<K, V | null>): ReadonlyMap<K, V> }

/**
 * The scene of `prev`'s plan after `ops` were applied to `s` (plan 3c, task 5), at the cost of what they touch: the
 * nodes, phantoms and connections they name, the hierarchy around what changed, the groups above it, the badges of
 * the members concerned. `prev` is left as it was; operations without effect on its plan give it back as it is. Past
 * `sceneCompactShare` of free slots, or when the plan changes type, the scene is built anew (`full`).
 */
export function updateScene(prev: PlanScene, s: State, ops: readonly Op[], measure: Measure, p: RenderParams): { scene: PlanScene; changes: SceneChanges } {
  const planId = prev.plan.id, plan = s.plans.get(planId);
  // A plan gone: the view drops its scene; nothing to show anew.
  if (!plan) return { scene: prev, changes: noChange() };
  const rebuild = () => ({ scene: buildScene(s, planId, measure, p), changes: { items: [], parts: [], hierarchy: true, full: true } });
  if (plan.type !== prev.plan.type) return rebuild();
  const t = touchedBy(prev, s, ops);
  const touched = t.nodes.size + t.phantoms.size + t.conns.size + t.freed.size + t.lost.size + t.groups.size + t.badges.size;
  if (plan === prev.plan && touched === 0) return { scene: prev, changes: noChange() };

  const u = new Update(prev, s, plan, measure, p), pr = u.pr;
  const appeared: number[] = [], removed: { slot: number; it: SceneItem }[] = [], gone: number[] = [], came: number[] = [];
  /** Items whose box (or a group's own step and title) changed: the groups above them are derived again. */
  const reshaped = new Set<number>();

  // 2. Items: appear, change or go. A node's slot in prev comes from the row it holds, or held before its row was
  // freed (the undo of its creation: formerNodeRow); a row taken by another names its former holder too.
  const lost = new Set<Id>(), slotOf = new Map<Id, { slot: number; row: number }>();
  const holder = (r: number) => (r >= 0 && r < prev.itemOfNode.length ? prev.itemOfNode[r] : -1);
  for (const id of t.nodes) {
    let r = nodeRow(s, id);
    if (r < 0) r = formerNodeRow(s, id);
    const i = holder(r);
    if (i >= 0 && prev.items[i].id === id) slotOf.set(id, { slot: i, row: r });
    else if (i >= 0 && !slotOf.has(prev.items[i].id)) slotOf.set(prev.items[i].id, { slot: i, row: r });
  }
  for (const id of t.nodes) if (!slotOf.has(id) && t.before.get(id)) lost.add(id);
  // Its row freed, then taken by a node these operations do not name (rare): searched for.
  if (lost.size > 0) prev.items.forEach((it, i) => { if (it.kind !== 'phantom' && lost.has(it.id)) slotOf.set(it.id, { slot: i, row: -1 }); });
  const placements = placementsIn(s, pr);
  for (const id of t.nodes) {
    const r = nodeRow(s, id), was = slotOf.get(id), slot = was?.slot ?? -1;
    const rec = r >= 0 ? nodeAt(s, r) : undefined, pl = r >= 0 ? placements.get(r) : undefined;
    const shown = rec !== undefined && pl !== undefined && rec.trashedAt === undefined;
    if (slot >= 0 && !shown) {
      removed.push({ slot, it: prev.items[slot] });
      const row = was!.row >= 0 ? was!.row : u.itemOfNode.indexOf(slot);
      if (row >= 0 && u.itemOfNode[row] === slot) u.setNodeSlot(row, -1);
      u.freeItem(slot);
      if (r >= 0) gone.push(r);
    } else if (shown) {
      const fresh = nodeItem(rec, pl, u.linesOf, p);
      if (slot < 0) {
        const i = u.allocItem();
        u.put(i, fresh);
        u.setNodeSlot(r, i);
        appeared.push(i);
        came.push(r);
      } else if (!sameOwn(u.items[slot], fresh) || (u.items[slot].kind === 'node' && (u.items[slot].x !== fresh.x || u.items[slot].y !== fresh.y))) {
        const it = u.mut(slot);
        it.title = fresh.title; it.lines = fresh.lines; it.k = fresh.k; it.halfW = fresh.halfW; it.halfH = fresh.halfH;
        if (it.kind === 'node') { it.x = fresh.x; it.y = fresh.y; }
        reshaped.add(slot);
      }
    }
  }
  const phantomMoved: number[] = [];
  for (const id of t.phantoms) {
    const slot = prev.itemOfPhantom.get(id) ?? -1, rec = s.phantoms.get(id);
    const shown = rec !== undefined && rec.plan === planId;
    if (slot >= 0 && !shown) {
      removed.push({ slot, it: prev.items[slot] });
      u.phantomSlots.set(id, null);
      u.freeItem(slot);
    } else if (shown) {
      const fresh = phantomItem(s, rec, u.linesOf, p);
      if (slot < 0) {
        const i = u.allocItem();
        u.put(i, fresh);
        u.phantomSlots.set(id, i);
        appeared.push(i);
      } else {
        const old = u.items[slot];
        if (!sameOwn(old, fresh) || old.x !== fresh.x || old.y !== fresh.y) {
          // Every field of its record anew, what it stands for included (a record received may change it); its place
          // in the hierarchy kept until step 3.
          u.put(slot, { ...fresh, parent: old.parent, children: old.children, depth: old.depth, badge: old.badge });
          reshaped.add(slot);
        }
        phantomMoved.push(slot);
      }
    }
  }
  u.releaseItems();

  // 3. Parents: of what appeared, of the phantoms touched, of the children of what went, and of the items below a node
  // that came, went or changed group (through the nodes not placed here, by groupMembers).
  const candidates = new Set<number>([...appeared, ...phantomMoved]);
  const placed = (r: number) => (r < u.itemOfNode.length ? u.itemOfNode[r] : -1);
  const seen = new Set<number>();
  const below = (g: number) => {
    if (seen.has(g)) return;
    seen.add(g);
    for (const id of phantomsIn(s, nodeId(s, g))) {
      const i = u.phantomSlot(id);
      if (i !== undefined && s.phantoms.get(id)?.plan === planId) candidates.add(i);
    }
    for (const m of groupMembers(s, pr, g)) {
      const i = placed(m);
      if (i >= 0) candidates.add(i);
      else below(m);
    }
  };
  for (const { it } of removed) for (const c of it.children) candidates.add(c);
  for (const r of [...came, ...gone]) below(r);
  for (const id of t.groups) {
    const r = nodeRow(s, id);
    if (r < 0) continue;
    if (placed(r) >= 0) candidates.add(placed(r));
    else below(r);
  }
  const removedSlots = new Set(removed.map((x) => x.slot));
  for (const { slot, it } of removed) if (!removedSlots.has(it.parent)) u.unlink(slot, it.parent);
  if (removed.length > 0) u.hierarchy = true;
  /** Groups whose children changed: their kind and envelope are derived again. */
  const regrouped = new Set<number>();
  for (const { it } of removed) if (it.parent >= 0 && !removedSlots.has(it.parent)) regrouped.add(it.parent);
  const moved: number[] = [];
  const isNew = new Set(appeared);
  for (const i of candidates) {
    if (u.items[i] === GONE_ITEM) continue;
    const parent = parentOf(s, pr, u.itemOfNode, u.items[i]), old = u.items[i].parent;
    if (!isNew.has(i) && parent === old) continue;
    if (!isNew.has(i)) { u.unlink(i, old); if (old >= 0) regrouped.add(old); }
    u.mut(i).parent = parent;
    u.link(i, parent);
    if (parent >= 0) regrouped.add(parent);
    moved.push(i);
    u.hierarchy = true;
  }

  // 4. Kinds (a node with children is a group, a group without is a node again), then depths below what moved.
  const dirty = new Set<number>();
  for (const g of regrouped) {
    const it = u.items[g];
    if (it === GONE_ITEM || it.kind === 'phantom') continue;
    if (it.kind === 'node' && it.children.length > 0) u.mut(g).kind = 'group';
    else if (it.kind === 'group' && it.children.length === 0) {
      const r = nodeRow(s, it.id), fresh = nodeItem(nodeAt(s, r)!, placements.get(r)!, u.linesOf, p);
      u.put(g, { ...fresh, parent: it.parent, children: [], depth: it.depth, badge: it.badge });
      reshaped.add(g);
    }
    dirty.add(g);
  }
  const depthOf = (i: number) => { let d = 0; for (let a = u.items[i].parent, n = 0; a >= 0 && n < u.items.length; a = u.items[a].parent, n++) d++; return d; };
  const fix = (i: number, d: number) => {
    if (u.items[i].depth === d && !isNew.has(i)) return;
    if (u.items[i].depth !== d) u.mut(i).depth = d;
    for (const c of u.items[i].children) fix(c, d + 1);
  };
  for (const [i, d] of moved.map((i) => [i, depthOf(i)] as const).sort((a, b) => a[1] - b[1])) fix(i, d);

  // 5. The groups above what changed, deepest first: each derived again; its parent too when it changed.
  for (const i of reshaped) if (u.items[i] !== GONE_ITEM && u.items[i].parent >= 0) dirty.add(u.items[i].parent);
  const levels: Set<number>[] = [];
  for (const g of dirty) (levels[u.items[g].depth] ??= new Set()).add(g);
  for (let d = levels.length - 1; d >= 0; d--) {
    for (const g of levels[d] ?? []) {
      const old = u.items[g];
      if (old === GONE_ITEM || old.kind !== 'group') continue;
      const shape = groupShape(u.items, g, p);
      if (old.hull && sameShape(old, shape)) continue;
      const it = Object.assign(u.mut(g), shape);
      if (it.parent >= 0) (levels[d - 1] ??= new Set()).add(it.parent);
    }
  }

  // 6. Parts of the connections touched, and of those of the nodes that came or went; the connections gone.
  for (const r of [...came, ...gone]) for (const c of memberOf(s, r)) t.conns.add(c);
  // A freed connection's parts, on the row it held; its identifier checked (a row is recycled after it is freed).
  for (const [id, row] of t.freed) for (const i of u.partsOfRow(row)) if (u.ids.a[i] === id) u.removePart(i);
  // Its row already taken by an identifier this plan's operations do not name (rare): searched for by identifier.
  if (t.lost.size > 0) {
    for (let i = 0; i < u.partCount; i++) if (u.part.a[i] !== PART_GONE && t.lost.has(u.ids.a[i])) u.removePart(i);
  }
  for (const c of t.conns) {
    const id = connId(s, c), mine = phantomsOf(s, id);
    let phantoms = NO_PHANTOMS;
    if (mine.length > 0) {
      phantoms = [];
      for (const ph of mine) { const x = s.phantoms.get(ph); if (x && x.plan === planId) phantoms.push(x); }
      phantoms.sort(idOrder);
    }
    const specs = partsOf(u.L, c, branchNodes(s, c, pr), phantoms);
    // Nothing here before, nothing now (an inclusion, a connection of another kind or not shown here).
    if (specs.length === 0 && (c >= u.partHead.length || u.partHead[c] < 0)) continue;
    const existing = u.partsOfRow(c).filter((i) => {
      if (u.ids.a[i] === id) return true;
      u.removePart(i); // the row holds another connection now
      return false;
    });
    for (const spec of specs) {
      const at = existing.findIndex((i) => (u.part.a[i] === PART_FAR) === spec.far && (!spec.far || u.center.a[i] === spec.center));
      if (at < 0) { u.addPart(c, id, spec); continue; }
      u.rewritePart(existing[at], spec);
      existing.splice(at, 1);
    }
    for (const i of existing) u.removePart(i);
  }

  // 7. Badges. The nodes the operations name, and what came: computed again. The members of the connections touched:
  // their badge only goes when a touched connection may have become seen by them (drawn here now, a branch or a
  // phantom added, its record changed); otherwise it stays, or comes if one of those connections is not seen now.
  const full = new Set<number>([...t.badges, ...came]);
  const raised = (c: number) => t.raised.has(c) || ((c >= prev.partHead.length || prev.partHead[c] < 0) && c < u.partHead.length && u.partHead[c] >= 0);
  const touchedOf = new Map<number, number[]>();
  for (const c of t.conns) {
    for (let k = 0, n = memberCount(s, c); k < n; k++) {
      const r = memberAt(s, c, k) >> 2, list = touchedOf.get(r);
      if (!list) touchedOf.set(r, [c]);
      else if (!list.includes(c)) list.push(c);
    }
  }
  for (const [r, cs] of touchedOf) {
    const i = placed(r);
    if (i < 0 || full.has(r)) continue;
    if (cs.some(raised)) { full.add(r); continue; }
    if (!u.items[i].badge && cs.some((c) => unseen(u.L, c, r, u.partHead))) u.mut(i).badge = true;
  }
  for (const r of full) {
    const i = placed(r);
    if (i < 0) continue;
    const b = badgeOf(u.L, r, u.partHead);
    if (u.items[i].badge !== b) u.mut(i).badge = b;
  }

  // 8. Bounds, from what changed (all of them again when what reached them shrank or went); hue ranks when the
  // hierarchy changed.
  let bounds = prev.bounds;
  for (const i of u.changedItems) {
    const before = i < prev.items.length ? extentOf(prev.items[i]) : null, after = extentOf(u.items[i]);
    if (sameExtent(before, after)) continue;
    if (before && bounds && touches(before, bounds)) { bounds = boundsOf(u.items); break; }
    bounds = union(bounds, after);
  }
  // The hue ranks, when a top-level group came, went, or stopped or started being one: from the previous ranks.
  let hues = prev.hues;
  const topGroup = (it: SceneItem | undefined) => it !== undefined && it !== GONE_ITEM && it.kind === 'group' && it.parent < 0;
  const left: number[] = [], joined: number[] = [];
  if (u.hierarchy) {
    for (const i of u.changedItems) {
      const was = topGroup(prev.items[i]), is = topGroup(u.items[i]);
      if (was && !is) left.push(i);
      else if (is && !was) joined.push(i);
    }
  }
  if (left.length + joined.length > 0) hues = huesAfter(prev.hues, u.items, left, joined);

  const nothing = u.changedItems.size === 0 && u.changedParts.size === 0 && plan === prev.plan && u.phantomSlots.size === 0;
  if (nothing) return { scene: prev, changes: noChange() };
  const share = p.sceneCompactShare;
  if (u.freeItems.length > share * u.items.length || u.freeParts.length > share * u.partCount) return rebuild();
  if (u.endWaste * 2 > u.endTop && u.endTop > 4096) u.compactEnds();
  const scene = makeScene(s, u.data(bounds, hues));
  return { scene, changes: { items: [...u.changedItems], parts: [...u.changedParts], hierarchy: u.hierarchy, full: false } };
}
