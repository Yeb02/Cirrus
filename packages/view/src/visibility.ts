import { type Id, type Role, ROLES } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import { capacityFor, END_DASHED, GONE_ITEM, PART_GONE, type PlanScene, type SceneStub } from './scene.ts';
import type { SceneChanges } from './sceneUpdate.ts';

const ROOT = -1;
/** The common group of a free part slot. */
export const NO_PART = -2;
const ROLE_CODE: Record<Role, number> = { source: 0, target: 1, associate: 2 };
const NO_STUBS: SceneStub[] = [];
// Bound once: under vitest an imported binding is a getter at each use (T2 of the plan 3c registry).
const foldOf = foldT, ROLE_NAMES = ROLES, GONE = GONE_ITEM, DASHED = END_DASHED, NO_SLOT = PART_GONE;
/** Visible parts are sorted by key = rank of their common group × SPAN + slot (exact in a double below 2⁵³). */
const SPAN = 2 ** 26;

type Typed = Int32Array | Uint32Array | Uint8Array | Int8Array | Float64Array;

/** A copy of `a` of length `cap`, its new part filled with `fill`. */
function grown<T extends Typed>(a: T, cap: number, fill: number): T {
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.set(a);
  if (fill !== 0) b.fill(fill, a.length);
  return b;
}

/**
 * Lists of part slots, one per item slot, in one Int32Array (as the core's pools): each list has a start, a length and
 * a room; one that outgrows its room moves to the end of the pool (or grows in place when it is the last one), and the
 * pool is packed again past half of it wasted. No object per list: the 2.3 million entries of the reference lobby are
 * counted then filed in ≈ 50 ms, against ≈ 610 ms into a Map of arrays (registry, task 6).
 */
export class PartLists {
  data: Int32Array;
  top = 0;
  waste = 0;
  start: Int32Array;
  len: Int32Array;
  cap: Int32Array;

  /** Lists for `owners` item slots; with `counts`, owner o has room for exactly counts[o] parts, packed in owner order. */
  constructor(owners: number, counts?: Int32Array) {
    this.start = new Int32Array(owners);
    this.len = new Int32Array(owners);
    this.cap = new Int32Array(owners);
    let top = 0;
    if (counts) for (let o = 0; o < counts.length; o++) { this.start[o] = top; this.cap[o] = counts[o]; top += counts[o]; }
    this.data = new Int32Array(Math.max(16, top));
    this.top = top;
  }

  /** Room for owners [0, n). */
  owners(n: number): void {
    if (n <= this.start.length) return;
    const cap = Math.max(n, 2 * this.start.length);
    this.start = grown(this.start, cap, 0);
    this.len = grown(this.len, cap, 0);
    this.cap = grown(this.cap, cap, 0);
  }

  /** The parts filed under item o, as a view: valid until the lists change. */
  of(o: number): Int32Array {
    return o < this.len.length ? this.data.subarray(this.start[o], this.start[o] + this.len[o]) : this.data.subarray(0, 0);
  }

  /** The items with at least one part filed under them (tests and comparisons: a scan). */
  *keys(): IterableIterator<number> {
    for (let o = 0; o < this.len.length; o++) if (this.len[o] > 0) yield o;
  }

  get size(): number {
    let n = 0;
    for (let o = 0; o < this.len.length; o++) if (this.len[o] > 0) n++;
    return n;
  }

  push(o: number, c: number): void {
    const n = this.len[o];
    if (n === this.cap[o]) this.grow(o, n + 1);
    this.data[this.start[o] + n] = c;
    this.len[o] = n + 1;
  }

  /** Takes out of o's list the parts whose stamp is `gen`, the others kept in their order; an emptied list gives its room back. */
  purge(o: number, stamp: Uint32Array, gen: number): void {
    const s = this.start[o], end = s + this.len[o], d = this.data;
    let w = s;
    for (let r = s; r < end; r++) if (stamp[d[r]] !== gen) d[w++] = d[r];
    this.len[o] = w - s;
    if (w === s && this.cap[o] > 0) {
      this.waste += this.cap[o];
      this.start[o] = this.cap[o] = 0;
      if (this.waste * 2 > this.top && this.top > 4096) this.compact();
    }
  }

  private grow(o: number, need: number): void {
    const cap = this.cap[o], start = this.start[o], next = Math.max(need, 2 * cap, 4);
    if (cap > 0 && start + cap === this.top) {
      this.ensure(start + next);
      this.top = start + next;
      this.cap[o] = next;
      return;
    }
    this.ensure(this.top + next);
    this.data.copyWithin(this.top, start, start + this.len[o]);
    this.start[o] = this.top;
    this.cap[o] = next;
    this.top += next;
    this.waste += cap;
    if (this.waste * 2 > this.top && this.top > 4096) this.compact();
  }

  private ensure(n: number): void {
    if (n > this.data.length) this.data = grown(this.data, Math.max(n, 2 * this.data.length), 0);
  }

  /** The lists packed in owner order, each keeping its room. */
  private compact(): void {
    const live = this.top - this.waste, data = new Int32Array(Math.max(16, live + (live >> 1)));
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

/** Stamps of a pass (a visible set, an update), so that no array is cleared nor allocated per pass. */
interface Scratch {
  gen: number;
  /** Fold state of a group (1 open, 2 fading, 3 closed), valid where stateAt is the pass's stamp. */
  stateAt: Uint32Array;
  state: Int8Array;
  /** An end lifted to its highest closed ancestor (liftO) and to its highest closed or fading one (liftC). */
  liftAt: Uint32Array;
  liftO: Int32Array;
  liftC: Int32Array;
  /** An open group reached by the pass: its rank in the order they open, and whether it or a group above it fades. */
  openAt: Uint32Array;
  rank: Int32Array;
  fading: Uint8Array;
  /** A part already looked at in the pass (or, in an update, to be filed again); and one seen. */
  partAt: Uint32Array;
  seenAt: Uint32Array;
  /** The roots found by a pass, by rank, when they are many (sorted by a scan rather than a sort). */
  rankAt: Uint32Array;
}

/**
 * What finds the visible set without scanning the plan (plan 3c, task 6, decision 9): per item, its parent, depth, box
 * and fold step in typed arrays; per part, its common group, and the parts filed under the tops of their ends
 * (`byTop`) and under every item they touch (`incident`); a tree over the roots. Built once for a scene (buildIndex),
 * then kept up to date at the cost of what an update changed (updateIndex). It owns all its arrays: no scene's array is
 * ever written, and those of the scenes it followed are not kept.
 */
export interface SceneIndex {
  /** Item slots followed: the scene's items.length. The per-item arrays are longer, their capacity doubled as they grow. */
  itemCount: number;
  parent: Int32Array;
  depth: Int32Array;
  /** Each item's box: its own, or a group's padded envelope; empty (+∞ to −∞) for a free slot. */
  minX: Float64Array;
  minY: Float64Array;
  maxX: Float64Array;
  maxY: Float64Array;
  /** A group's largest member step, −∞ for any other item. */
  maxChildK: Float64Array;
  /** The node each item stands for (SceneItem.node, '' for a free slot): what the visible ends name, read contiguously. */
  node: Id[];
  /** Part slots followed: the scene's partCount. The per-part arrays are longer, as the per-item ones. */
  partCount: number;
  /** Each part's common group: the lowest drawn group above all its ends and its centre; −1 at top level, NO_PART for a free slot. */
  lca: Int32Array;
  /**
   * Each part filed under the distinct tops of its ends and of its centre: the ancestor right under its common group, or
   * the end itself. A top is always a child of its parts' common group (a root for a top-level part).
   */
  byTop: PartLists;
  /** Each part filed under every item it touches: its ends and its centre. */
  incident: PartLists;
  /** The scene's roots this index follows, and the rank of each among them (draw order); −1 for any other slot. */
  roots: readonly number[];
  rootRank: Int32Array;
  /** A tree over the roots as they were when it was built: its entry j is treeRoots[j]; null without roots. */
  rootTree: Flatbush | null;
  treeRoots: Int32Array;
  /**
   * The slots whose tree entry is stale or missing — roots changed, come or gone since the tree was built — flagged in
   * `stale` (whose tree entries are skipped) and searched one by one; past indexDirtyMax, the tree is built again. A
   * freed slot may be named here: it is never read, being no root.
   */
  dirtyRoots: number[];
  stale: Uint8Array;
  /** Distinct maxChildK values, ascending: the fold state of the whole plan is one letter per value; and how many groups have each. */
  levels: number[];
  levelCount: Map<number, number>;
  /**
   * What each part is filed under, to take it out again: from refAt, refItems items (incident), then refTops tops
   * (byTop), in one pool; a part filed again writes at its end, and the pool is packed past half of it wasted.
   */
  refAt: Int32Array;
  refItems: Int32Array;
  refTops: Int32Array;
  refs: Int32Array;
  refTop: number;
  refWaste: number;
  scratch: Scratch;
}

// ———— Arrays

/** Room for `n` item slots: capacity doubled when it is short. */
function ensureItems(ix: SceneIndex, n: number): void {
  if (n <= ix.parent.length) return;
  const cap = Math.max(n, 2 * ix.parent.length), sc = ix.scratch;
  ix.parent = grown(ix.parent, cap, ROOT);
  ix.depth = grown(ix.depth, cap, 0);
  ix.minX = grown(ix.minX, cap, Infinity);
  ix.minY = grown(ix.minY, cap, Infinity);
  ix.maxX = grown(ix.maxX, cap, -Infinity);
  ix.maxY = grown(ix.maxY, cap, -Infinity);
  ix.maxChildK = grown(ix.maxChildK, cap, -Infinity);
  for (let i = ix.node.length; i < cap; i++) ix.node.push('');
  ix.rootRank = grown(ix.rootRank, cap, -1);
  ix.stale = grown(ix.stale, cap, 0);
  ix.byTop.owners(cap);
  ix.incident.owners(cap);
  sc.stateAt = grown(sc.stateAt, cap, 0);
  sc.state = grown(sc.state, cap, 0);
  sc.liftAt = grown(sc.liftAt, cap, 0);
  sc.liftO = grown(sc.liftO, cap, 0);
  sc.liftC = grown(sc.liftC, cap, 0);
  sc.openAt = grown(sc.openAt, cap, 0);
  sc.rank = grown(sc.rank, cap, 0);
  sc.fading = grown(sc.fading, cap, 0);
  sc.rankAt = grown(sc.rankAt, cap, 0);
}

/** Room for `m` part slots. */
function ensureParts(ix: SceneIndex, m: number): void {
  if (m <= ix.lca.length) return;
  const cap = Math.max(m, 2 * ix.lca.length);
  ix.lca = grown(ix.lca, cap, NO_PART);
  ix.refAt = grown(ix.refAt, cap, 0);
  ix.refItems = grown(ix.refItems, cap, 0);
  ix.refTops = grown(ix.refTops, cap, 0);
  ix.scratch.partAt = grown(ix.scratch.partAt, cap, 0);
  ix.scratch.seenAt = grown(ix.scratch.seenAt, cap, 0);
}

/** An index for `n` item slots and `m` part slots, all free. */
function emptyIndex(n: number, m: number): SceneIndex {
  const ni = capacityFor(n), np = capacityFor(m);
  return {
    itemCount: 0, parent: new Int32Array(ni).fill(ROOT), depth: new Int32Array(ni), minX: new Float64Array(ni).fill(Infinity), minY: new Float64Array(ni).fill(Infinity),
    maxX: new Float64Array(ni).fill(-Infinity), maxY: new Float64Array(ni).fill(-Infinity), maxChildK: new Float64Array(ni).fill(-Infinity), node: new Array<Id>(ni).fill(''), partCount: 0,
    lca: new Int32Array(np).fill(NO_PART), byTop: new PartLists(ni), incident: new PartLists(ni), roots: [], rootRank: new Int32Array(ni).fill(-1), rootTree: null,
    treeRoots: new Int32Array(0), dirtyRoots: [], stale: new Uint8Array(ni), levels: [], levelCount: new Map(), refAt: new Int32Array(np), refItems: new Int32Array(np),
    refTops: new Int32Array(np), refs: new Int32Array(capacityFor(4 * m)), refTop: 0, refWaste: 0,
    scratch: {
      gen: 0, stateAt: new Uint32Array(ni), state: new Int8Array(ni), liftAt: new Uint32Array(ni), liftO: new Int32Array(ni), liftC: new Int32Array(ni),
      openAt: new Uint32Array(ni), rank: new Int32Array(ni), fading: new Uint8Array(ni), partAt: new Uint32Array(np), seenAt: new Uint32Array(np),
      rankAt: new Uint32Array(ni),
    },
  };
}

/** A new stamp; every stamp array is cleared when they run out (after 4 billion passes). */
function nextGen(sc: Scratch): number {
  if (sc.gen >= 0xfffffffe) {
    for (const a of [sc.stateAt, sc.liftAt, sc.openAt, sc.partAt, sc.seenAt, sc.rankAt]) a.fill(0);
    sc.gen = 0;
  }
  return ++sc.gen;
}

// ———— Items

const isFree = (ix: SceneIndex, i: number): boolean => ix.minX[i] > ix.maxX[i];

/**
 * Writes into slot i the box of offsetPolygon(hull, d), by the same arithmetic in the same order (the same numbers to
 * the bit), without making the polygon: no object per vertex for the 6 000 groups of the reference lobby.
 */
function envelopeBox(ix: SceneIndex, i: number, hull: readonly { x: number; y: number }[], d: number): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  const m = hull.length;
  if (m < 3) for (const q of offsetPolygon(hull as { x: number; y: number }[], d)) take(q.x, q.y);
  else {
    for (let k = 0; k < m; k++) {
      const prev = hull[(k + m - 1) % m], cur = hull[k], next = hull[(k + 1) % m];
      const n1x = cur.y - prev.y, n1y = -(cur.x - prev.x), n2x = next.y - cur.y, n2y = -(next.x - cur.x);
      const l1 = Math.hypot(n1x, n1y) || 1, l2 = Math.hypot(n2x, n2y) || 1;
      const nx = n1x / l1 + n2x / l2, ny = n1y / l1 + n2y / l2, ln = Math.hypot(nx, ny);
      if (ln < 1e-9) take(cur.x + 1 * d, cur.y + 0 * d);
      else take(cur.x + (nx / ln) * d, cur.y + (ny / ln) * d);
    }
  }
  ix.minX[i] = x0;
  ix.minY[i] = y0;
  ix.maxX[i] = x1;
  ix.maxY[i] = y1;
}

/** Slot i as the scene has it: parent, depth, fold step, box. */
function writeItem(ix: SceneIndex, scene: PlanScene, i: number): void {
  const it = scene.items[i];
  if (it === GONE) {
    ix.parent[i] = ROOT;
    ix.depth[i] = 0;
    ix.maxChildK[i] = -Infinity;
    ix.node[i] = '';
    ix.minX[i] = ix.minY[i] = Infinity;
    ix.maxX[i] = ix.maxY[i] = -Infinity;
    return;
  }
  ix.parent[i] = it.parent;
  ix.depth[i] = it.depth;
  ix.node[i] = it.node;
  if (it.kind === 'group') {
    ix.maxChildK[i] = it.maxChildK!;
    envelopeBox(ix, i, it.hull!, it.pad!);
  } else {
    ix.maxChildK[i] = -Infinity;
    ix.minX[i] = it.x - it.halfW;
    ix.maxX[i] = it.x + it.halfW;
    ix.minY[i] = it.y - it.halfH;
    ix.maxY[i] = it.y + it.halfH;
  }
}

/** One group more (+1) or less (−1) at fold step k; whether the set of steps changed. */
function countLevel(ix: SceneIndex, k: number, d: number): boolean {
  if (k === -Infinity) return false;
  const n = (ix.levelCount.get(k) ?? 0) + d;
  if (n === 0) { ix.levelCount.delete(k); return true; }
  ix.levelCount.set(k, n);
  return n === 1 && d > 0;
}

const sortedLevels = (ix: SceneIndex): number[] => [...ix.levelCount.keys()].sort((a, b) => a - b);

/** The roots this index follows, and their ranks: those of the previous roots cleared. */
function setRoots(ix: SceneIndex, roots: readonly number[]): void {
  for (const r of ix.roots) ix.rootRank[r] = -1;
  for (let k = 0; k < roots.length; k++) ix.rootRank[roots[k]] = k;
  ix.roots = roots;
}

function markDirty(ix: SceneIndex, i: number): void {
  if (ix.stale[i] === 0) { ix.stale[i] = 1; ix.dirtyRoots.push(i); }
}

/** The tree over the roots as they are: no root is dirty any longer. */
function buildTree(ix: SceneIndex): void {
  for (const r of ix.dirtyRoots) ix.stale[r] = 0;
  ix.dirtyRoots = [];
  const roots = ix.roots;
  ix.treeRoots = Int32Array.from(roots);
  if (roots.length === 0) { ix.rootTree = null; return; }
  const tree = new Flatbush(roots.length), { minX, minY, maxX, maxY } = ix;
  for (const r of roots) tree.add(minX[r], minY[r], maxX[r], maxY[r]);
  tree.finish();
  ix.rootTree = tree;
}

// ———— Parts

/** The deepest group that is a or above a and b or above b (ROOT for none), by depths. */
function meet(parent: Int32Array, depth: Int32Array, a: number, b: number): number {
  while (a !== ROOT && b !== ROOT && a !== b) {
    if (depth[a] >= depth[b]) a = parent[a];
    else b = parent[b];
  }
  return a === b ? a : ROOT;
}

/** The ancestor of x right under its common group `lca` (x itself when its parent is it). */
function topOf(parent: Int32Array, x: number, lca: number): number {
  for (let steps = 0; parent[x] !== lca && parent[x] !== ROOT && steps < 10_000; steps++) x = parent[x];
  return x;
}

/** Room for `need` more references at the end of the pool: packed once half of it is waste, else grown. */
function ensureRefs(ix: SceneIndex, need: number): void {
  if (ix.refTop + need <= ix.refs.length) return;
  if (ix.refWaste * 2 > ix.refTop && ix.refTop > 4096) {
    const live = ix.refTop - ix.refWaste, out = new Int32Array(Math.max(ix.refs.length, capacityFor(live + need)));
    let top = 0;
    for (let c = 0; c < ix.partCount; c++) {
      const n = ix.refItems[c] + ix.refTops[c];
      if (n === 0) continue;
      out.set(ix.refs.subarray(ix.refAt[c], ix.refAt[c] + n), top);
      ix.refAt[c] = top;
      top += n;
    }
    ix.refs = out;
    ix.refTop = top;
    ix.refWaste = 0;
    if (ix.refTop + need <= ix.refs.length) return;
  }
  ix.refs = grown(ix.refs, Math.max(ix.refTop + need, 2 * ix.refs.length), 0);
}

/** Part c (live) as the scene has it: its common group, and its items then their tops written at the end of the pool. */
function derivePart(ix: SceneIndex, scene: PlanScene, c: number): void {
  const { parent, depth } = ix, endItem = scene.ends.item;
  const s0 = scene.endStart[c], n = scene.endCount[c], center = scene.center[c];
  if (n === 2 && center < 0 && endItem[s0] !== endItem[s0 + 1]) {
    // Two ends (most parts): both chains climbed together to where they meet, which gives the common group and the tops.
    const a = endItem[s0], b = endItem[s0 + 1];
    let x = a, y = b;
    while (depth[x] > depth[y]) x = parent[x];
    while (depth[y] > depth[x]) y = parent[y];
    while (x !== y && parent[x] !== parent[y]) { x = parent[x]; y = parent[y]; }
    ensureRefs(ix, 4);
    const refs = ix.refs, at = ix.refTop;
    refs[at] = a;
    refs[at + 1] = b;
    refs[at + 2] = x;
    if (x !== y) refs[at + 3] = y;
    ix.lca[c] = parent[x];
    ix.refAt[c] = at;
    ix.refItems[c] = 2;
    ix.refTops[c] = x === y ? 1 : 2;
    ix.refTop = at + 2 + ix.refTops[c];
    return;
  }
  let lca: number;
  if (n === 0) lca = center >= 0 ? parent[center] : ROOT;
  else {
    lca = parent[endItem[s0]];
    for (let k = 1; k < n && lca !== ROOT; k++) lca = meet(parent, depth, lca, parent[endItem[s0 + k]]);
    if (center >= 0 && lca !== ROOT) lca = meet(parent, depth, lca, parent[center]);
  }
  ix.lca[c] = lca;
  ensureRefs(ix, 2 * (n + 1));
  const refs = ix.refs, at = ix.refTop;
  let w = at;
  // Its distinct items (ends, then the centre), then their distinct tops.
  for (let k = 0; k <= n; k++) {
    const x = k < n ? endItem[s0 + k] : center;
    let j = at;
    while (j < w && refs[j] !== x) j++;
    if (x >= 0 && j === w) refs[w++] = x;
  }
  const items = w;
  for (let k = at; k < items; k++) {
    const t = topOf(parent, refs[k], lca);
    let j = items;
    while (j < w && refs[j] !== t) j++;
    if (j === w) refs[w++] = t;
  }
  ix.refAt[c] = at;
  ix.refItems[c] = items - at;
  ix.refTops[c] = w - items;
  ix.refTop = w;
}

/** Part c filed under its items and its tops, as its references say. */
function fileRefs(ix: SceneIndex, c: number): void {
  const refs = ix.refs, at = ix.refAt[c], items = at + ix.refItems[c], end = items + ix.refTops[c];
  for (let k = at; k < items; k++) ix.incident.push(refs[k], c);
  for (let k = items; k < end; k++) ix.byTop.push(refs[k], c);
}

/** Takes the parts stamped `gen` in partAt (listed in `parts`) out of every list they were filed in. */
function unfileParts(ix: SceneIndex, parts: readonly number[], gen: number): void {
  const items = new Set<number>(), tops = new Set<number>(), refs = ix.refs;
  for (const c of parts) {
    if (c >= ix.partCount) continue;
    const at = ix.refAt[c], ni = ix.refItems[c], nt = ix.refTops[c];
    for (let k = at; k < at + ni; k++) items.add(refs[k]);
    for (let k = at + ni; k < at + ni + nt; k++) tops.add(refs[k]);
    ix.refWaste += ni + nt;
    ix.refItems[c] = ix.refTops[c] = 0;
    ix.lca[c] = NO_PART;
  }
  const partAt = ix.scratch.partAt;
  for (const k of items) ix.incident.purge(k, partAt, gen);
  for (const k of tops) ix.byTop.purge(k, partAt, gen);
}

// ———— Building and following

/** The index of a scene, built anew: O(items + parts). */
export function buildIndex(scene: PlanScene, _p: RenderParams): SceneIndex {
  const n = scene.items.length, m = scene.partCount;
  const ix = emptyIndex(n, m);
  for (let i = 0; i < n; i++) writeItem(ix, scene, i);
  ix.itemCount = n;
  for (let i = 0; i < n; i++) countLevel(ix, ix.maxChildK[i], 1);
  ix.levels = sortedLevels(ix);
  setRoots(ix, scene.roots);
  buildTree(ix);
  ix.partCount = m;
  const part = scene.part;
  for (let c = 0; c < m; c++) if (part[c] !== NO_SLOT) derivePart(ix, scene, c);
  // The lists, each made at its size: counted, then filled in slot order.
  const owners = ix.parent.length, byItem = new Int32Array(owners), byTop = new Int32Array(owners), refs = ix.refs;
  for (let c = 0; c < m; c++) {
    const at = ix.refAt[c], items = at + ix.refItems[c], end = items + ix.refTops[c];
    for (let k = at; k < items; k++) byItem[refs[k]]++;
    for (let k = items; k < end; k++) byTop[refs[k]]++;
  }
  const incident = (ix.incident = new PartLists(owners, byItem)), tops = (ix.byTop = new PartLists(owners, byTop));
  const atItem = incident.start.slice(), atTop = tops.start.slice(), di = incident.data, dt = tops.data;
  for (let c = 0; c < m; c++) {
    const at = ix.refAt[c], items = at + ix.refItems[c], end = items + ix.refTops[c];
    for (let k = at; k < items; k++) di[atItem[refs[k]]++] = c;
    for (let k = items; k < end; k++) dt[atTop[refs[k]]++] = c;
  }
  incident.len.set(byItem);
  tops.len.set(byTop);
  return ix;
}

/** The changes of two updates in a row, as one: what an index behind by both must follow. */
export function mergeChanges(a: SceneChanges, b: SceneChanges): SceneChanges {
  return { items: [...new Set([...a.items, ...b.items])], parts: [...new Set([...a.parts, ...b.parts])], hierarchy: a.hierarchy || b.hierarchy, full: a.full || b.full };
}

/**
 * The index of `scene`, from the index of the scene it was updated from by `changes` (updateScene, or several updates
 * merged by mergeChanges), at the cost of what changed: the items written take their place and box again; the parts
 * written, those of the items gone, and those of every item whose chain of groups changed (an item with another parent,
 * and everything below it) are filed again; a root changed, come or gone is searched apart until indexDirtyMax of them
 * make the tree be built again. Built anew when `changes.full`. Changed in place, and given back.
 */
export function updateIndex(index: SceneIndex, scene: PlanScene, changes: SceneChanges, p: RenderParams): SceneIndex {
  if (changes.full) return buildIndex(scene, p);
  const ix = index, items = scene.items;
  ensureItems(ix, items.length);
  ensureParts(ix, scene.partCount);
  const gen = nextGen(ix.scratch), partAt = ix.scratch.partAt, parts: number[] = [];
  const refile = (c: number) => { if (partAt[c] !== gen) { partAt[c] = gen; parts.push(c); } };
  for (const c of changes.parts) refile(c);
  const moved: number[] = [];
  let levels = false;
  for (const i of changes.items) {
    const wasFree = i >= ix.itemCount || isFree(ix, i), oldParent = ix.parent[i], oldK = ix.maxChildK[i];
    const x0 = ix.minX[i], y0 = ix.minY[i], x1 = ix.maxX[i], y1 = ix.maxY[i];
    writeItem(ix, scene, i);
    const free = items[i] === GONE;
    if (oldK !== ix.maxChildK[i]) {
      if (countLevel(ix, oldK, -1)) levels = true;
      if (countLevel(ix, ix.maxChildK[i], 1)) levels = true;
    }
    if (wasFree !== free || oldParent !== ix.parent[i]) moved.push(i);
    const wasRoot = !wasFree && oldParent === ROOT, isRoot = !free && ix.parent[i] === ROOT;
    const boxed = x0 !== ix.minX[i] || y0 !== ix.minY[i] || x1 !== ix.maxX[i] || y1 !== ix.maxY[i];
    if ((wasRoot || isRoot) && (wasRoot !== isRoot || boxed)) markDirty(ix, i);
    if (free) for (const c of ix.incident.of(i)) refile(c);
  }
  ix.itemCount = items.length;
  // Below an item with another parent, every chain of groups changed: the parts of all those items are filed again.
  for (const i of moved) {
    const stack = [i];
    while (stack.length > 0) {
      const d = stack.pop()!;
      for (const c of ix.incident.of(d)) refile(c);
      if (items[d] !== GONE) for (const k of items[d].children) stack.push(k);
    }
  }
  unfileParts(ix, parts, gen);
  ix.partCount = scene.partCount;
  const part = scene.part;
  for (const c of parts) {
    if (c >= scene.partCount || part[c] === NO_SLOT) continue;
    derivePart(ix, scene, c);
    fileRefs(ix, c);
  }
  if (scene.roots !== ix.roots) setRoots(ix, scene.roots);
  if (levels) ix.levels = sortedLevels(ix);
  if (ix.dirtyRoots.length > p.indexDirtyMax) buildTree(ix);
  return ix;
}

// ———— Visible set

export type LevelState = 'open' | 'fading' | 'closed';
const stateOf = (t: number): LevelState => (t >= 1 ? 'closed' : t > 0 ? 'fading' : 'open');

/** One letter per distinct maxChildK: the visible set only changes when this string does. */
export function foldSignature(index: SceneIndex, zoom: number, p: RenderParams): string {
  return index.levels.map((k) => stateOf(foldT(k, zoom, p))[0]).join('');
}

/** item: drawn endpoint with the fading level open; item2: with it closed (equal outside a fold transition). */
export interface VisibleEnd { item: number; item2: number; role: Role; key: Id; hollow: boolean; hollow2: boolean; dashed: boolean }

export interface VisibleConnection {
  /** Scene connection indices merged into this line (length ≥ 1, spec 8.5 « 2 connexions »). */
  conns: number[];
  ends: VisibleEnd[];
  stubs: SceneStub[];
  center?: number;
  /** none: static; slide: endpoints glide from item to item2 as the level folds; out: internal to the folding group. */
  fade: 'none' | 'slide' | 'out';
  /** maxChildK of the fading level; NaN when fade is 'none'. */
  foldK: number;
}

export interface VisibleSet {
  /** Boxes and phantoms drawn: top-level items and members of groups that are not closed. */
  items: number[];
  /** Envelopes drawn, parents first. */
  groups: number[];
  connections: VisibleConnection[];
  signature: string;
}

/** Distinct drawn items among the ends: with the fading level open (item) or closed (item2). */
function distinctEnds(ends: VisibleEnd[], closed: boolean): number {
  if (ends.length > 16) return new Set(ends.map((e) => (closed ? e.item2 : e.item))).size;
  let n = 0;
  for (let a = 0; a < ends.length; a++) {
    const x = closed ? ends[a].item2 : ends[a].item;
    let b = 0;
    while (b < a && (closed ? ends[b].item2 : ends[b].item) !== x) b++;
    if (b === a) n++;
  }
  return n;
}

/**
 * What a camera shows (spec 8.2, 8.5): items in the view (widened by viewMarginPx) down to closed groups, and the
 * connections seen there, their ends lifted to the highest closed ancestor (hollow arrows). While a level folds, ends
 * glide toward its border; a connection internal to the folding group fades with it.
 *
 * Rule (plan 3c, task 6): a part is seen when an end lifted under its common group — to its highest closed ancestor,
 * or to its highest closed or fading ancestor below that group — or its centre, is in the view; its common group being
 * the top level or an open group drawn. What was seen only through a fading ancestor at or above the common group is no
 * longer drawn: it was off the screen, and already faded out by endpointFade.
 *
 * Its cost is what it visits: the roots in the view (the tree, plus the dirty roots), the children in the view of the
 * open groups reached, and the parts filed under the items reached (byTop) — never the plan. Items come in pre-order
 * of the scene's tree (roots in draw order); connections by their common group's rank among the open groups reached
 * (the top level first), then by slot (R22): the same for an index kept up to date as for one built anew.
 */
export function computeVisible(scene: PlanScene, index: SceneIndex, cam: Camera, p: RenderParams): VisibleSet {
  const ix = index, { parent, minX, minY, maxX, maxY, maxChildK, lca } = ix, zoom = cam.zoom;
  const halfW = (cam.widthPx / 2 + p.viewMarginPx) / zoom, halfH = (cam.heightPx / 2 + p.viewMarginPx) / zoom;
  const vx0 = cam.x - halfW, vx1 = cam.x + halfW, vy0 = cam.y - halfH, vy1 = cam.y + halfH;
  const inView = (i: number) => maxX[i] >= vx0 && minX[i] <= vx1 && maxY[i] >= vy0 && minY[i] <= vy1;
  const sc = ix.scratch, g = nextGen(sc);
  const { stateAt, state, liftAt, liftO, liftC, openAt, rank, fading, partAt, seenAt, rankAt } = sc;
  /** 1 open, 2 fading, 3 closed. */
  const st = (a: number) => {
    if (stateAt[a] !== g) {
      stateAt[a] = g;
      const k = maxChildK[a], t = k === -Infinity ? 0 : foldOf(k, zoom, p);
      state[a] = t >= 1 ? 3 : t > 0 ? 2 : 1;
    }
    return state[a];
  };
  const lift = (m: number) => {
    if (liftAt[m] === g) return;
    liftAt[m] = g;
    let o = m, c = m;
    for (let a = parent[m]; a !== ROOT; a = parent[a]) {
      const s = st(a);
      if (s === 3) o = a;
      if (s >= 2) c = a;
    }
    liftO[m] = o;
    liftC[m] = c;
  };
  /** m lifted to its highest closed or fading ancestor below the common group L (L or a group above it fades). */
  const under = (m: number, L: number) => {
    let c = m;
    for (let a = parent[m]; a !== L && a !== ROOT; a = parent[a]) if (st(a) >= 2) c = a;
    return c;
  };

  const out: VisibleSet = { items: [], groups: [], connections: [], signature: foldSignature(ix, zoom, p) };
  // The roots in the view, in draw order: the tree's entries still valid, then the dirty roots; ordered by a scan of
  // their ranks when they are many, else sorted.
  const found: number[] = [];
  if (ix.rootTree) {
    for (const j of ix.rootTree.search(vx0, vy0, vx1, vy1)) {
      const r = ix.treeRoots[j];
      if (ix.stale[r] === 0) found.push(ix.rootRank[r]);
    }
  }
  for (const r of ix.dirtyRoots) if (ix.rootRank[r] >= 0 && inView(r)) found.push(ix.rootRank[r]);
  const roots = scene.roots, stack: number[] = [];
  if (found.length * 16 > roots.length) {
    for (const k of found) rankAt[k] = g;
    for (let k = roots.length - 1; k >= 0; k--) if (rankAt[k] === g) stack.push(roots[k]);
  } else {
    const ranks = Int32Array.from(found).sort();
    for (let k = ranks.length - 1; k >= 0; k--) stack.push(roots[ranks[k]]);
  }
  // Down to the closed groups, children in the view; at each item reached, the parts filed under it (their common
  // group is its parent: the top level, or an open group reached before it).
  const { endStart, endCount, center } = scene, endItem = scene.ends.item;
  const { start: listAt, len: listLen, data: listed } = ix.byTop;
  const seen: number[] = [];
  let opened = 0;
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (let li = listAt[i], lend = li + listLen[i]; li < lend; li++) {
      const c = listed[li];
      if (partAt[c] === g) continue;
      partAt[c] = g;
      const L = lca[c];
      if (L !== ROOT && openAt[L] !== g) continue;
      const capped = L !== ROOT && fading[L] === 1;
      let shown = false;
      for (let k = endStart[c], end = k + endCount[c]; k < end && !shown; k++) {
        const m = endItem[k];
        if (liftAt[m] !== g) lift(m);
        shown = inView(liftO[m]) || inView(capped ? under(m, L) : liftC[m]);
      }
      const ctr = center[c];
      if (ctr >= 0) {
        if (liftAt[ctr] !== g) lift(ctr);
        if (liftO[ctr] !== ctr) continue; // the centre phantom is folded away with its group
        if (!shown) shown = inView(ctr);
      }
      if (!shown) continue;
      seenAt[c] = g;
      seen.push(c);
    }
    if (maxChildK[i] === -Infinity) { out.items.push(i); continue; }
    out.groups.push(i);
    const s = st(i);
    if (s === 3) continue;
    openAt[i] = g;
    rank[i] = ++opened;
    const pa = parent[i];
    fading[i] = s === 2 || (pa !== ROOT && fading[pa] === 1) ? 1 : 0;
    const kids = scene.items[i].children;
    for (let c = kids.length - 1; c >= 0; c--) if (inView(kids[c])) stack.push(kids[c]);
  }
  // In order of common group, then of slot: many parts seen (a whole plan in view) by a scan of the slots, stable by
  // common group (a counting sort); a few by a sort of their keys.
  const groupRank = (c: number) => (lca[c] === ROOT ? 0 : rank[lca[c]]);
  let order: ArrayLike<number>;
  if (seen.length * 8 > ix.partCount) {
    const bucket = new Int32Array(opened + 2), slots = new Int32Array(seen.length);
    for (const c of seen) bucket[groupRank(c) + 1]++;
    for (let r = 1; r < bucket.length; r++) bucket[r] += bucket[r - 1];
    for (let c = 0; c < ix.partCount; c++) if (seenAt[c] === g) slots[bucket[groupRank(c)]++] = c;
    order = slots;
  } else {
    const keys = new Float64Array(seen.length);
    for (let q = 0; q < seen.length; q++) keys[q] = groupRank(seen[q]) * SPAN + seen[q];
    keys.sort();
    for (let q = 0; q < keys.length; q++) keys[q] %= SPAN;
    order = keys;
  }

  const aggregated = new Map<string, VisibleConnection>();
  const nodes = ix.node, endMeta = scene.ends.meta, layout = scene.layout, noStubs = scene.stubs.size === 0;
  let sliding = false, foldK = -Infinity;
  /** The end at pool entry k, lifted. */
  const endAt = (k: number): VisibleEnd => {
    const item = endItem[k], meta = endMeta[k];
    if (liftAt[item] !== g) lift(item);
    const o = liftO[item], c = liftC[item];
    if (o !== c) { sliding = true; if (maxChildK[c] > foldK) foldK = maxChildK[c]; }
    return { item: o, item2: c, role: ROLE_NAMES[meta & 3], key: nodes[item], hollow: o !== item, hollow2: c !== item, dashed: (meta & DASHED) !== 0 };
  };
  for (let q = 0; q < order.length; q++) {
    const pi = order[q], s0 = endStart[pi], ne = endCount[pi];
    sliding = false;
    foldK = -Infinity;
    let ends: VisibleEnd[];
    if (ne === 2) ends = [endAt(s0), endAt(s0 + 1)];
    else {
      ends = [];
      for (let k = 0; k < ne; k++) ends.push(endAt(s0 + k));
    }
    const ctr = center[pi];
    const stubs = noStubs ? NO_STUBS : scene.stubs.get(pi) ?? NO_STUBS;
    const extra = stubs.length + (ctr >= 0 ? 1 : 0);
    const two = ne === 2 && ends[0].item !== ends[1].item;
    if (!two && distinctEnds(ends, false) + extra < 2) continue;
    const fade: VisibleConnection['fade'] = !sliding ? 'none' : distinctEnds(ends, true) + extra < 2 ? 'out' : 'slide';
    if (fade !== 'none') {
      const vc: VisibleConnection = { conns: [pi], ends, stubs, fade, foldK };
      if (ctr >= 0) vc.center = ctr;
      out.connections.push(vc);
      continue;
    }
    // Static: merge ends that land on the same (item, role), then merge whole connections between the same ends.
    let merged = ends;
    for (let a = 1; a < ne && merged === ends && !two; a++) {
      for (let b = 0; b < a; b++) if (ends[b].item === ends[a].item && ends[b].role === ends[a].role) { merged = []; break; }
    }
    if (merged !== ends) for (const e of ends) if (!merged.some((m) => m.item === e.item && m.role === e.role)) merged.push(e);
    const vc: VisibleConnection = { conns: [pi], ends: merged, stubs, fade, foldK: Number.NaN };
    if (ctr >= 0) vc.center = ctr;
    let hollow = false, dashed = false;
    for (const e of merged) { if (e.hollow) hollow = true; if (e.dashed) dashed = true; }
    // Only ends lifted onto a closed group merge (spec 8.5, « Groupe replié »): open parallel connections stay apart.
    if (layout[pi] || stubs.length > 0 || ctr >= 0 || dashed || !hollow) { out.connections.push(vc); continue; }
    const key = merged.map((e) => e.item * 3 + ROLE_CODE[e.role]).sort((a, b) => a - b).join(',');
    const existing = aggregated.get(key);
    if (existing) existing.conns.push(pi);
    else { aggregated.set(key, vc); out.connections.push(vc); }
  }
  return out;
}
