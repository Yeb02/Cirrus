import {
  type ConnectionLayout, connId, connKind, connRow, connRowCount, connTitle, connTrashed, directGroup, formerConnRow, formerNodeRow, hasBranch, type Id, KNOWLEDGE,
  layoutKey, memberAt,
  memberCount, memberOfAt, memberOfCount, NO_RECORD, type NodeRec, nodeAt, nodeId, nodeRow, type PhantomRec, phantomsOf, type Placement, placementsIn, type PlanRec,
  planRow, type Role, ROLES, type State, STRUCTURE, type Vec2,
} from '@cirrus/core';
import type { Bounds } from './camera.ts';
import { convexHull, offsetPolygon } from './geometry/hull.ts';
import { stepScale } from './lod.ts';
import type { RenderParams } from './params.ts';

// Core accessors read in the hot loops of the scene, bound once: under vitest every imported binding is a getter at
// each use (T2 of the plan 3c registry); bundled code is the same either way.
const kindOf = connKind, trashedOf = connTrashed, countOf = memberCount, memberAtOf = memberAt, titleOf = connTitle, rowOfNode = nodeRow, idOfNode = nodeId;
const recOf = nodeAt, ROLE_NAMES = ROLES, KNOWLEDGE_KIND = KNOWLEDGE, branchIn = hasBranch, inCount = memberOfCount, inAt = memberOfAt, groupOfRow = directGroup;
const scaleOf = stepScale, idOfConn = connId;
const NO_PHANTOMS: PhantomRec[] = [];
/** Records by identifier (UUIDv7: creation order). */
export const idOrder = (a: { id: Id }, b: { id: Id }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const NO_ROWS: number[] = [];

/**
 * The lines a node's box is sized for: its title at base size, font baseFontPx, wrap width boxWidth − 2·boxPadX (the
 * layout is scale-invariant). The app's is measureLines (text.ts), from the layout the titles are drawn with.
 */
export type Measure = (title: string) => number;
export type ItemKind = 'node' | 'group' | 'phantom';

export interface SceneItem {
  /** Node id, or phantom id. */
  id: Id;
  kind: ItemKind;
  /** Represented node: the node itself, or a phantom's of.node. */
  node: Id;
  phantom?: 'node' | 'center' | 'absent';
  connection?: Id;
  title: string;
  lines: number;
  /** World centre; a group's is derived from its members (spec 10). */
  x: number;
  y: number;
  k: number;
  /** World half sizes of the box (a group's: its title box when closed). */
  halfW: number;
  halfH: number;
  /** Drawn parent group, -1 at top level. */
  parent: number;
  /** In draw order: nodes and groups by identifier, then phantoms by identifier. */
  children: number[];
  depth: number;
  /** Connections existing but absent from this plan (spec 11.3). */
  badge: boolean;
  /** Group: convex hull of its members' footprints, before padding. */
  hull?: Vec2[];
  /** Group: envelopePad × stepScale(maxChildK). */
  pad?: number;
  /** Group: largest member step, which drives its fold (spec 8.2). */
  maxChildK?: number;
}

export interface SceneEnd { item: number; role: Role; key: Id; dashed: boolean }
export interface SceneStub { role: Role; node: Id; title: string }

/** A part of a connection as the interface reads it (the façade scene.connections materializes it from the columns). */
export interface SceneConnection {
  index: number;
  id: Id;
  /** main: the bundle with its real members; far: the far side of a split arm, from the far node to the centre phantom. */
  part: 'main' | 'far';
  title: string;
  ends: SceneEnd[];
  stubs: SceneStub[];
  /** far part: the centre phantom, a fixed marker. */
  center?: number;
  layout?: ConnectionLayout;
}

/** Codes of the part column. */
export const PART_MAIN = 0, PART_FAR = 1, PART_GONE = 255;
/** An end's meta: its role code in the low two bits, and this bit when it is an absent member's phantom (dashed). */
export const END_DASHED = 4;

/** The ends of every part, in one pool: a part's are [endStart, endStart + endCount). Re-derived ends go to the top. */
export interface EndPool {
  item: Int32Array;
  /** The member's node row. */
  key: Int32Array;
  meta: Uint8Array;
  top: number;
  /** Entries left behind by re-derived or removed parts. */
  waste: number;
}

/**
 * What a plan shows (plan 3c, task 5): items in stable slots (a removed one leaves GONE_ITEM, its slot recycled), and
 * the parts of the connections in columns (a removed one is PART_GONE). Never changed once made: updateScene copies a
 * column before writing it, or writes past the end of every scene that shares it, so a scene held by a gesture stays
 * valid. `byId` and `connections` are read façades (not own properties: the scene's data is plain columns and objects).
 */
export interface PlanScene {
  plan: PlanRec;
  items: SceneItem[];
  /** Node row → its item's slot, −1 for none. */
  itemOfNode: Int32Array;
  itemOfPhantom: ReadonlyMap<Id, number>;
  freeItems: number[];
  /** Top-level items, in draw order. */
  roots: number[];
  /** Part slots in use, free ones included: the part columns are longer. */
  partCount: number;
  /** The connection row of each part. */
  connRow: Int32Array;
  part: Uint8Array;
  /** far part: its centre phantom's slot; −1 otherwise. */
  center: Int32Array;
  layout: (ConnectionLayout | undefined)[];
  /** The connection's identifier and title for each part: what drawing needs without the state. */
  ids: Id[];
  titles: string[];
  endStart: Int32Array;
  endCount: Int32Array;
  ends: EndPool;
  /** Absent members without a phantom, per part (rare). */
  stubs: ReadonlyMap<number, SceneStub[]>;
  /** The parts of each connection row, as a list: its first part (−1 for none), then each part's next (−1 to end it). */
  partHead: Int32Array;
  partNext: Int32Array;
  freeParts: number[];
  /** The rank of each top-level group by identifier (UUIDv7: creation): it keeps its hue as others come (spec 8.4). */
  hues: Map<number, number>;
  bounds: Bounds | null;
  /** Read façade: a node's or phantom's identifier → its slot. */
  readonly byId: ReadonlyMap<Id, number>;
  /** Read façade for the interface: each part materialized from the columns (GONE_PART for a removed one). */
  readonly connections: readonly SceneConnection[];
}

/** The scene's own data: what is copied and shared between versions. */
export type SceneData = Omit<PlanScene, 'byId' | 'connections'>;

const NO_CHILDREN = Object.freeze([]) as unknown as number[];
/** A removed item's slot: nothing references it any longer. */
export const GONE_ITEM: SceneItem = Object.freeze({
  id: '', kind: 'node', node: '', title: '', lines: 0, x: Number.NaN, y: Number.NaN, k: 0, halfW: 0, halfH: 0, parent: -1, children: NO_CHILDREN, depth: 0, badge: false,
});
/** What the façade gives for a removed part. */
export const GONE_PART: SceneConnection = Object.freeze({ index: -1, id: '', part: 'main', title: '', ends: Object.freeze([]) as unknown as SceneEnd[], stubs: Object.freeze([]) as unknown as SceneStub[] });

export const isLive = (scene: Pick<PlanScene, 'items'>, i: number): boolean => scene.items[i] !== GONE_ITEM;

/** The parameters buildScene reads: the scene is rebuilt only when one of them changes (settings panel). */
export function sceneParamsKey(p: RenderParams): string {
  return JSON.stringify([p.factor, p.textScale, p.baseFontPx, p.boxWidth, p.boxPadX, p.boxPadY, p.lineHeight, p.envelopePad, p.centerRadius]);
}

// ———— Maps shared between versions

/**
 * A map shared between scene versions: a base no one changes, and this version's changes over it (null: removed).
 * Copying it on write costs its changes, not its size; the changes are folded into a new base past an eighth of it.
 */
export class LayeredMap<K, V> implements ReadonlyMap<K, V> {
  base: Map<K, V>;
  delta: Map<K, V | null>;
  count: number;

  constructor(base: Map<K, V> = new Map(), delta: Map<K, V | null> = new Map(), count = base.size) {
    this.base = base;
    this.delta = delta;
    this.count = count;
  }

  get(key: K): V | undefined {
    const d = this.delta.get(key);
    return d === undefined ? this.base.get(key) : d ?? undefined;
  }
  has(key: K): boolean { return this.get(key) !== undefined; }
  get size(): number { return this.count; }

  /** This map with these changes (null: removed), itself left as it is. */
  with(changes: Map<K, V | null>): LayeredMap<K, V> {
    if (changes.size === 0) return this;
    const delta = new Map(this.delta);
    let count = this.count;
    for (const [k, v] of changes) {
      const had = this.has(k);
      if (v === null) { if (had) count--; } else if (!had) count++;
      if (v === null && !this.base.has(k)) delta.delete(k);
      else delta.set(k, v);
    }
    if (delta.size * 8 <= this.base.size + 64) return new LayeredMap(this.base, delta, count);
    const base = new Map(this.base);
    for (const [k, v] of delta) { if (v === null) base.delete(k); else base.set(k, v); }
    return new LayeredMap(base, new Map(), base.size);
  }

  *entries(): MapIterator<[K, V]> {
    for (const [k, v] of this.base) if (!this.delta.has(k)) yield [k, v];
    for (const [k, v] of this.delta) if (v !== null) yield [k, v];
  }
  *keys(): MapIterator<K> { for (const [k] of this.entries()) yield k; }
  *values(): MapIterator<V> { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void { for (const [k, v] of this.entries()) fn(v, k, this); }
}

// ———— Columns shared between versions

/**
 * How far some version has filled each tail-shared column (part columns, end pool): a version may write in place past
 * its own count only if no other went further, else it copies the column (updateScene).
 */
export const tails = new WeakMap<object, number>();

/** Room for `n` entries and some to grow: appends rarely need a copy. */
export const capacityFor = (n: number): number => n + Math.max(256, n >> 3);

// ———— Façades

const states = new WeakMap<object, State>();
const byIds = new WeakMap<object, ReadonlyMap<Id, number>>();
const facades = new WeakMap<object, readonly SceneConnection[]>();

/**
 * Identifier → slot: phantoms by their map, nodes by their row — or by the row it held, for a scene older than the
 * removal of its node (formerNodeRow) — the slot checked to hold that identifier.
 */
class ItemsById implements ReadonlyMap<Id, number> {
  private readonly scene: PlanScene;
  constructor(scene: PlanScene) { this.scene = scene; }
  get(id: Id): number | undefined {
    const sc = this.scene, ph = sc.itemOfPhantom.get(id);
    if (ph !== undefined) return ph;
    const s = states.get(sc);
    let r = s ? nodeRow(s, id) : -1;
    if (s && r < 0) r = formerNodeRow(s, id);
    const i = r >= 0 && r < sc.itemOfNode.length ? sc.itemOfNode[r] : -1;
    return i >= 0 && sc.items[i].id === id ? i : undefined;
  }
  has(id: Id): boolean { return this.get(id) !== undefined; }
  get size(): number { return this.scene.items.length - this.scene.freeItems.length; }
  *entries(): MapIterator<[Id, number]> {
    const items = this.scene.items;
    for (let i = 0; i < items.length; i++) if (items[i] !== GONE_ITEM) yield [items[i].id, i];
  }
  *keys(): MapIterator<Id> { for (const [k] of this.entries()) yield k; }
  *values(): MapIterator<number> { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator](): MapIterator<[Id, number]> { return this.entries(); }
  forEach(fn: (value: number, key: Id, map: ReadonlyMap<Id, number>) => void): void { for (const [k, v] of this.entries()) fn(v, k, this); }
}

/** A connection's layout in a plan, by row (updateScene: a few connections). */
export const layoutIn = (s: State, plan: Id, c: number): ConnectionLayout | undefined => s.connLayouts.get(layoutKey(plan, connId(s, c)));

/** A canonical array index ("0", "17"), or −1. */
function indexOf(key: string | symbol): number {
  if (typeof key !== 'string' || key.length === 0) return -1;
  const c = key.charCodeAt(0);
  if (c < 48 || c > 57) return -1;
  const i = Number(key);
  return Number.isInteger(i) && String(i) === key ? i : -1;
}

/** scene.connections: an array whose element i is part i, built at each read (the interface reads a few). */
function connectionsOf(scene: PlanScene): readonly SceneConnection[] {
  const target: SceneConnection[] = [];
  return new Proxy(target, {
    get(t, key, receiver) {
      if (key === 'length') return scene.partCount;
      const i = indexOf(key);
      if (i >= 0) return i < scene.partCount ? materialize(scene, i) : undefined;
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      const i = indexOf(key);
      return i >= 0 ? i < scene.partCount : Reflect.has(t, key);
    },
    ownKeys(t) {
      return [...Array.from({ length: scene.partCount }, (_v, i) => String(i)), ...Reflect.ownKeys(t)];
    },
    getOwnPropertyDescriptor(t, key) {
      const i = indexOf(key);
      if (i >= 0) return i < scene.partCount ? { value: materialize(scene, i), writable: false, enumerable: true, configurable: true } : undefined;
      if (key === 'length') return { value: scene.partCount, writable: true, enumerable: false, configurable: false };
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

const SCENE_PROTO = {
  get byId(): ReadonlyMap<Id, number> {
    const self = this as unknown as PlanScene;
    let m = byIds.get(self);
    if (!m) byIds.set(self, (m = new ItemsById(self)));
    return m;
  },
  get connections(): readonly SceneConnection[] {
    const self = this as unknown as PlanScene;
    let c = facades.get(self);
    if (!c) facades.set(self, (c = connectionsOf(self)));
    return c;
  },
};

/** A scene from its data, with its façades; `s`: the state it shows (identifier lookups). */
export function makeScene(s: State | undefined, data: SceneData): PlanScene {
  const scene = Object.assign(Object.create(SCENE_PROTO) as object, data) as PlanScene;
  if (s) states.set(scene, s);
  return scene;
}

/** The scene with some of its data replaced, everything else shared (previews: a drag, a scale gesture, a layout). */
export function sceneWith(scene: PlanScene, patch: Partial<SceneData>): PlanScene {
  return makeScene(states.get(scene), { ...(scene as SceneData), ...patch });
}

/** Part i's ends, materialized (the hot paths read the pool's columns). */
export function partEnds(scene: PlanScene, i: number): SceneEnd[] {
  const e = scene.ends, out: SceneEnd[] = [];
  for (let k = scene.endStart[i], end = k + scene.endCount[i]; k < end; k++) {
    const m = e.meta[k];
    out.push({ item: e.item[k], role: ROLES[m & 3], key: scene.items[e.item[k]].node, dashed: (m & END_DASHED) !== 0 });
  }
  return out;
}

function materialize(scene: PlanScene, i: number): SceneConnection {
  if (scene.part[i] === PART_GONE) return GONE_PART;
  const c: SceneConnection = {
    index: i, id: scene.ids[i], part: scene.part[i] === PART_FAR ? 'far' : 'main', title: scene.titles[i], ends: partEnds(scene, i),
    stubs: scene.stubs.get(i) ?? [],
  };
  if (scene.center[i] >= 0) c.center = scene.center[i];
  const l = scene.layout[i];
  if (l) c.layout = l;
  return c;
}

/** The part slots of connection row `row`. */
export function partsOfRow(scene: PlanScene, row: number): number[] {
  const out: number[] = [];
  if (row < 0 || row >= scene.partHead.length) return out;
  for (let i = scene.partHead[row]; i >= 0; i = scene.partNext[i]) out.push(i);
  return out;
}

/**
 * The parts of a connection in this scene: its main part and the far parts of its split arms (none: not drawn here).
 * By its row, or the row it held for a scene older than the removal of its connection (formerConnRow).
 */
export function partOf(scene: PlanScene, connection: Id): number[] {
  const s = states.get(scene);
  if (!s) {
    const out: number[] = [];
    for (let i = 0; i < scene.partCount; i++) if (scene.part[i] !== PART_GONE && scene.ids[i] === connection) out.push(i);
    return out;
  }
  const r = connRow(s, connection);
  return partsOfRow(scene, r >= 0 ? r : formerConnRow(s, connection)).filter((i) => scene.ids[i] === connection);
}

// ———— Derivations shared by buildScene and updateScene

/** A box's half sizes at step scale `s` (stepScale). */
const halfWidth = (s: number, p: RenderParams): number => (p.boxWidth / 2) * s;
const halfHeight = (lines: number, s: number, p: RenderParams): number => ((lines * p.lineHeight * p.baseFontPx + 2 * p.boxPadY) / 2) * s;

export const boxHalves = (lines: number, k: number, p: RenderParams): { halfW: number; halfH: number } => {
  const s = stepScale(k, p);
  return { halfW: halfWidth(s, p), halfH: halfHeight(lines, s, p) };
};

/** The lines of each title, measured once. */
export function linesCache(measure: Measure): (title: string) => number {
  const lines = new Map<string, number>();
  return (title) => {
    let n = lines.get(title);
    if (n === undefined) lines.set(title, (n = Math.max(1, measure(title))));
    return n;
  };
}

/** A placed node's item, before its place in the drawn hierarchy. */
export function nodeItem(n: NodeRec, pl: Placement, linesOf: (t: string) => number, p: RenderParams): SceneItem {
  const l = linesOf(n.title), s = scaleOf(pl.k, p);
  return {
    id: n.id, kind: 'node', node: n.id, title: n.title, lines: l, x: pl.x, y: pl.y, k: pl.k, halfW: halfWidth(s, p), halfH: halfHeight(l, s, p), parent: -1, children: [],
    depth: 0, badge: false,
  };
}

/** A centre phantom shows its connection's title (row `c`, −1 for none), or « Connexion » without one. */
export const centerTitle = (s: State, c: number): string => (c >= 0 && connKind(s, c) !== NO_RECORD && connTitle(s, c)) || 'Connexion';

/** A phantom's item, before its place in the drawn hierarchy; `title` for a centre phantom (its connection's). */
export function phantomItem(s: State, ph: PhantomRec, linesOf: (t: string) => number, p: RenderParams, title?: string): SceneItem {
  const t = ph.of.kind === 'center' ? (title ?? centerTitle(s, connRow(s, ph.connection))) : (s.nodes.get(ph.of.node)?.title ?? '');
  const l = linesOf(t), scale = scaleOf(ph.k, p), box = ph.of.kind === 'node';
  return {
    id: ph.id, kind: 'phantom', node: ph.of.node, phantom: ph.of.kind, connection: ph.connection, title: t, lines: l, x: ph.x, y: ph.y, k: ph.k,
    halfW: box ? halfWidth(scale, p) : p.centerRadius * scale, halfH: box ? halfHeight(l, scale, p) : p.centerRadius * scale, parent: -1, children: [], depth: 0,
    badge: false,
  };
}

/** Chains longer than this are cycles (a state that breaks the rules): the walk stops. */
const CHAIN_LIMIT = 10_000;

/**
 * The drawn parent of the group chain starting at node row `g` (included): its first node placed in the plan (spec 7:
 * a group removed from the plan keeps its links), −1 for none. Stops on coming back to `self`, as ancestors does.
 */
export function nearestPlaced(s: State, plan: number, itemOfNode: Int32Array, g: number, self: number): number {
  for (let steps = 0; g >= 0 && g !== self && steps < CHAIN_LIMIT; g = groupOfRow(s, plan, g), steps++) {
    const i = g < itemOfNode.length ? itemOfNode[g] : -1;
    if (i >= 0) return i;
  }
  return -1;
}

/** The drawn parent of an item: a node's nearest placed ancestor; a phantom's group, or its nearest placed ancestor. */
export function parentOf(s: State, plan: number, itemOfNode: Int32Array, it: SceneItem): number {
  if (it.kind !== 'phantom') {
    const n = nodeRow(s, it.id);
    return n < 0 ? -1 : nearestPlaced(s, plan, itemOfNode, groupOfRow(s, plan, n), n);
  }
  // Its group itself first, then the group's ancestors (a cycle is cut by the length of the walk).
  const g = s.phantoms.get(it.id)?.group, r = g === undefined ? -1 : nodeRow(s, g);
  return r < 0 ? -1 : nearestPlaced(s, plan, itemOfNode, r, -1);
}

/** Draw order of siblings: nodes and groups before phantoms, each by identifier (creation order), whatever the state's order. */
export function drawOrder(items: SceneItem[]): (a: number, b: number) => number {
  return (a, b) => {
    const x = items[a], y = items[b];
    const kx = x.kind === 'phantom' ? 1 : 0, ky = y.kind === 'phantom' ? 1 : 0;
    return kx - ky || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  };
}

/** What a group derives from its members (spec 10): its centre, the hull of their footprints, their largest step, its padding. */
export interface GroupShape { x: number; y: number; hull: Vec2[]; maxChildK: number; pad: number }

/** Group i's shape, from its children already derived; nothing is changed. */
export function groupShape(items: SceneItem[], i: number, p: RenderParams): GroupShape {
  const kids = items[i].children.map((c) => items[c]);
  const corners: Vec2[] = [];
  for (const c of kids) {
    if (c.kind === 'group') corners.push(...offsetPolygon(c.hull!, c.pad!));
    else for (const dx of [-1, 1]) for (const dy of [-1, 1]) corners.push({ x: c.x + dx * c.halfW, y: c.y + dy * c.halfH });
  }
  const maxChildK = Math.max(...kids.map((c) => c.k));
  return {
    x: kids.reduce((a, c) => a + c.x, 0) / kids.length, y: kids.reduce((a, c) => a + c.y, 0) / kids.length, hull: convexHull(corners), maxChildK,
    pad: p.envelopePad * stepScale(maxChildK, p),
  };
}

/** Group i (an object of the caller's) takes its derived shape. */
export function deriveGroup(items: SceneItem[], i: number, p: RenderParams): void {
  Object.assign(items[i], groupShape(items, i, p));
}

/** The connection kind a plan draws: structure in a document, knowledge elsewhere (inclusions never). */
export const drawnKind = (plan: PlanRec): number => (plan.type === 'document' ? STRUCTURE : KNOWLEDGE);

/** Where a scene's items are, for deriving parts and badges (buildScene's tables, or updateScene's working copy). */
export interface SceneLookup {
  s: State;
  plan: PlanRec;
  planRow: number;
  kind: number;
  itemOfNode: Int32Array;
  phantomItem(id: Id): number;
  /** Connection row c's layout in this plan. */
  layoutOf(c: number): ConnectionLayout | undefined;
}

/** One part as derived: ends as triples (item, node row, meta), stubs or null. */
export interface PartSpec { far: boolean; center: number; ends: number[]; stubs: SceneStub[] | null; layout: ConnectionLayout | undefined; title: string }

/** Receives one part: `ends` holds `count` triples (item, node row, meta), and is reused once the call returns. */
export type PartSink = (
  far: boolean, center: number, ends: Int32Array, count: number, stubs: SceneStub[] | null, layout: ConnectionLayout | undefined, title: string,
) => void;

/** The members read, the ends being derived (as triples), the placed members shown: reused from one connection to the next. */
let members = new Int32Array(16), mainEnds = new Int32Array(48), shownPlaced = new Int32Array(16);
const farEnds = new Int32Array(3);

/**
 * The parts of connection row `c` in a plan (spec 8.5, 11.3), given to `sink`; returns how many. `shown`: the node rows
 * with a branch there; `phantoms`: its phantoms there, by identifier. The main part has the members shown, in member
 * order — placed, by an absent member's phantom (dashed), else a stub — then the far nodes' phantoms; it is drawn with
 * two solid ends at least. Each centre phantom whose node is placed makes a far part. Nothing for a connection of
 * another kind, or in the trash.
 *
 * `seen` (buildScene): for a knowledge connection, each placed member that sees it here is counted — shown in it when
 * it is drawn here, or its arm split here (badgeOf's rule, spec 11.3).
 */
export function emitParts(L: SceneLookup, c: number, shown: ArrayLike<number>, phantoms: readonly PhantomRec[], sink: PartSink, seen?: Int32Array): number {
  const s = L.s;
  if (c < 0) return 0;
  const kind = kindOf(s, c), trashed = trashedOf(s, c), counting = seen !== undefined && kind === KNOWLEDGE_KIND && !trashed;
  if ((kind !== L.kind || trashed) && !counting) return 0;
  const n = countOf(s, c), itemOfNode = L.itemOfNode, title = titleOf(s, c);
  // The members, read once.
  if (members.length < n) members = new Int32Array(2 * n);
  const ms = members;
  for (let k = 0; k < n; k++) ms[k] = memberAtOf(s, c, k);
  // A phantom's node row, only when the connection has phantoms here (few do).
  const rows = phantoms.length === 0 ? NO_ROWS : phantoms.map((ph) => rowOfNode(s, ph.of.node));
  if (kind !== L.kind || trashed) {
    // Not drawn here (a document draws structure): its members see it through a split arm only.
    if (phantoms.length > 0) countSplits(ms, n, itemOfNode, phantoms, rows, seen!, null);
    return 0;
  }
  // Room for every member and phantom.
  if (mainEnds.length < 3 * (n + phantoms.length)) mainEnds = new Int32Array(6 * (n + phantoms.length));
  if (shownPlaced.length < n) shownPlaced = new Int32Array(2 * n);
  const ends = mainEnds;
  let count = 0, solid = 0, parts = 0, placed = 0, stubs: SceneStub[] | null = null;
  for (let k = 0; k < n; k++) {
    const m = ms[k], r = m >> 2, role = m & 3;
    if (repeated(ms, k, r) || !includes(shown, r)) continue;
    const it = r < itemOfNode.length ? itemOfNode[r] : -1;
    if (it >= 0) { count = putEnd(ends, count, it, r, role); solid++; shownPlaced[placed++] = r; continue; }
    let absent = -1;
    for (let x = 0; x < phantoms.length && absent < 0; x++) if (phantoms[x].of.kind === 'absent' && rows[x] === r) absent = x;
    if (absent >= 0) count = putEnd(ends, count, L.phantomItem(phantoms[absent].id), r, role | END_DASHED);
    else (stubs ??= []).push({ role: ROLE_NAMES[role], node: idOfNode(s, r), title: recOf(s, r)?.title ?? '' });
  }
  if (phantoms.length > 0) {
    for (let k = 0; k < n; k++) {
      const m = ms[k], r = m >> 2;
      if (repeated(ms, k, r)) continue;
      for (let x = 0; x < phantoms.length; x++) {
        if (phantoms[x].of.kind === 'node' && rows[x] === r) { count = putEnd(ends, count, L.phantomItem(phantoms[x].id), r, m & 3); solid++; }
      }
    }
  }
  if (solid >= 2) { sink(false, -1, ends, count, stubs, L.layoutOf(c), title); parts++; }
  for (let x = 0; x < phantoms.length; x++) {
    const r = rows[x], it = r >= 0 && r < itemOfNode.length ? itemOfNode[r] : -1;
    if (phantoms[x].of.kind !== 'center' || it < 0) continue;
    // Its node's role: that of its first membership.
    for (let k = 0; k < n; k++) {
      if (ms[k] >> 2 !== r) continue;
      farEnds[0] = it; farEnds[1] = r; farEnds[2] = ms[k] & 3;
      sink(true, L.phantomItem(phantoms[x].id), farEnds, 1, null, undefined, title);
      parts++;
      break;
    }
  }
  if (counting) {
    if (parts > 0) for (let j = 0; j < placed; j++) seen![shownPlaced[j]]++;
    if (phantoms.length > 0) countSplits(ms, n, itemOfNode, phantoms, rows, seen!, parts > 0 ? shown : null);
  }
  return parts;
}

/**
 * Counts in `seen` the placed members (`ms`, the first `n`) whose arm is split here (a centre phantom of theirs), each
 * once, except those shown in `shownDrawn` (the connection drawn here: already counted).
 */
function countSplits(
  ms: Int32Array, n: number, itemOfNode: Int32Array, phantoms: readonly PhantomRec[], rows: readonly number[], seen: Int32Array, shownDrawn: ArrayLike<number> | null,
): void {
  for (let k = 0; k < n; k++) {
    const r = ms[k] >> 2;
    if (r >= itemOfNode.length || itemOfNode[r] < 0 || repeated(ms, k, r) || (shownDrawn !== null && includes(shownDrawn, r))) continue;
    for (let x = 0; x < phantoms.length; x++) if (phantoms[x].of.kind === 'center' && rows[x] === r) { seen[r]++; break; }
  }
}

/** The parts of connection row `c`, as objects (updateScene compares them with the scene's). */
export function partsOf(L: SceneLookup, c: number, shown: ArrayLike<number>, phantoms: readonly PhantomRec[]): PartSpec[] {
  const out: PartSpec[] = [];
  emitParts(L, c, shown, phantoms, (far, center, ends, count, stubs, layout, title) => {
    const copy = new Array<number>(3 * count);
    for (let k = 0; k < 3 * count; k++) copy[k] = ends[k];
    out.push({ far, center, ends: copy, stubs, layout, title });
  });
  return out;
}


/** Writes end number `count` (item, node row, meta) into `ends`; returns the new count. */
function putEnd(ends: Int32Array, count: number, item: number, r: number, meta: number): number {
  ends[3 * count] = item;
  ends[3 * count + 1] = r;
  ends[3 * count + 2] = meta;
  return count + 1;
}

/** Whether member k (of `ms`) repeats an earlier member's node (each node counts once, with its first role). */
function repeated(ms: Int32Array, k: number, r: number): boolean {
  for (let j = 0; j < k; j++) if (ms[j] >> 2 === r) return true;
  return false;
}

const includes = (list: ArrayLike<number>, v: number): boolean => {
  for (let i = 0; i < list.length; i++) if (list[i] === v) return true;
  return false;
};

/** The knowledge connections of node row `n` not in the trash: what a badge counts (spec 11.3). */
function knowledgeOf(s: State, n: number): number {
  let k = 0;
  for (let i = 0, end = inCount(s, n); i < end; i++) { const c = inAt(s, n, i); if (kindOf(s, c) === KNOWLEDGE_KIND && !trashedOf(s, c)) k++; }
  return k;
}

/** Whether a centre phantom of connection row `c` in this plan stands for node row `n`: its arm is split here, not absent. */
function splitHere(L: SceneLookup, c: number, n: number): boolean {
  const id = nodeId(L.s, n);
  for (const ph of phantomsOf(L.s, connId(L.s, c))) {
    const x = L.s.phantoms.get(ph);
    if (x && x.plan === L.plan.id && x.of.kind === 'center' && x.of.node === id) return true;
  }
  return false;
}

/**
 * A placed node is badged when one of its knowledge connections is not seen here (spec 11.3): no branch to it, or the
 * connection not drawn here (masked: no part); a split arm is seen. `partHead`: the parts by connection row.
 */
export function badgeOf(L: SceneLookup, n: number, partHead: Int32Array): boolean {
  const s = L.s;
  for (let i = 0, end = inCount(s, n); i < end; i++) if (unseen(L, inAt(s, n, i), n, partHead)) return true;
  return false;
}

/** Whether knowledge connection row `c` (of node row `n`) exists but is not seen by `n` here: what badges it. */
export function unseen(L: SceneLookup, c: number, n: number, partHead: Int32Array): boolean {
  const s = L.s;
  if (kindOf(s, c) !== KNOWLEDGE_KIND || trashedOf(s, c)) return false;
  if (c < partHead.length && partHead[c] >= 0 && branchIn(s, c, L.planRow, n)) return false;
  return !splitHere(L, c, n);
}

/** What an item adds to the scene's bounds: a top-level group its padded envelope, any other item its box; null for none. */
export function extentOf(it: SceneItem): Bounds | null {
  if (it === GONE_ITEM || (it.kind === 'group' && it.parent >= 0)) return null;
  if (it.kind !== 'group') return { minX: it.x - it.halfW, minY: it.y - it.halfH, maxX: it.x + it.halfW, maxY: it.y + it.halfH };
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const q of offsetPolygon(it.hull!, it.pad!)) {
    b.minX = Math.min(b.minX, q.x); b.maxX = Math.max(b.maxX, q.x);
    b.minY = Math.min(b.minY, q.y); b.maxY = Math.max(b.maxY, q.y);
  }
  return b;
}

/** The union of two bounds (null: none). */
export function union(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/** The union of every item's extent (extentOf), without building one per item. */
export function boundsOf(items: SceneItem[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const it of items) {
    if (it === GONE_ITEM || (it.kind === 'group' && it.parent >= 0)) continue;
    any = true;
    if (it.kind === 'group') for (const q of offsetPolygon(it.hull!, it.pad!)) grow(q.x, q.y);
    else { grow(it.x - it.halfW, it.y - it.halfH); grow(it.x + it.halfW, it.y + it.halfH); }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** The hue ranks: top-level groups by identifier. */
export function huesOf(items: SceneItem[], roots: number[]): Map<number, number> {
  const tops = roots.filter((i) => items[i].kind === 'group').sort((a, b) => (items[a].id < items[b].id ? -1 : items[a].id > items[b].id ? 1 : 0));
  return new Map(tops.map((i, r) => [i, r]));
}

// ———— Building

/** A copy of `a` of length `n`, `a` cut or padded. */
function resized<T extends Int32Array | Uint8Array>(a: T, n: number): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  b.set(a.length > n ? (a.subarray(0, n) as T) : a);
  return b;
}

/** The part columns while a scene is built: grown by doubling, then cut to their size and some room (capacityFor). */
class PartColumns {
  n = 0;
  connRows = new Int32Array(0);
  part = new Uint8Array(0);
  center = new Int32Array(0);
  endStart = new Int32Array(0);
  endCount = new Int32Array(0);
  partNext = new Int32Array(0);
  readonly layout: (ConnectionLayout | undefined)[];
  readonly ids: Id[];
  readonly titles: string[];
  readonly stubs = new Map<number, SceneStub[]>();
  ends: EndPool;
  readonly partHead: Int32Array;

  /** `parts`, `ends`: how many there may be (an upper bound: nothing to grow). */
  constructor(partHead: Int32Array, parts: number, ends: number) {
    this.partHead = partHead;
    this.resize(parts);
    this.layout = new Array(parts);
    this.ids = new Array(parts);
    this.titles = new Array(parts);
    this.ends = { item: new Int32Array(ends), key: new Int32Array(ends), meta: new Uint8Array(ends), top: 0, waste: 0 };
  }

  add(
    c: number, id: Id, far: boolean, center: number, ends: Int32Array, count: number, stubs: SceneStub[] | null, layout: ConnectionLayout | undefined,
    title: string,
  ): void {
    if (this.n === this.connRows.length) this.resize(Math.max(16, this.n * 2));
    const e = this.ends;
    if (e.top + count > e.item.length) {
      const m = Math.max(e.item.length * 2, e.top + count);
      this.ends = { item: resized(e.item, m), key: resized(e.key, m), meta: resized(e.meta, m), top: e.top, waste: 0 };
    }
    const i = this.n++, pool = this.ends, top = pool.top;
    this.connRows[i] = c;
    this.part[i] = far ? PART_FAR : PART_MAIN;
    this.center[i] = center;
    this.endStart[i] = top;
    this.endCount[i] = count;
    for (let k = 0; k < count; k++) { pool.item[top + k] = ends[3 * k]; pool.key[top + k] = ends[3 * k + 1]; pool.meta[top + k] = ends[3 * k + 2]; }
    pool.top = top + count;
    if (stubs) this.stubs.set(i, stubs);
    this.layout[i] = layout;
    this.ids[i] = id;
    this.titles[i] = title;
    this.partNext[i] = this.partHead[c];
    this.partHead[c] = i;
  }

  private resize(m: number): void {
    this.connRows = resized(this.connRows, m);
    this.part = resized(this.part, m);
    this.center = resized(this.center, m);
    this.endStart = resized(this.endStart, m);
    this.endCount = resized(this.endCount, m);
    this.partNext = resized(this.partNext, m);
  }

  /** The columns cut to their size and some room to grow, when they were sized much larger. */
  finish(): this {
    this.layout.length = this.ids.length = this.titles.length = this.n;
    const loose = (cap: number, n: number) => cap > capacityFor(n) + (n >> 3);
    if (loose(this.connRows.length, this.n)) this.resize(capacityFor(this.n));
    const e = this.ends, m = capacityFor(e.top);
    if (loose(e.item.length, e.top)) this.ends = { item: resized(e.item, m), key: resized(e.key, m), meta: resized(e.meta, m), top: e.top, waste: 0 };
    return this;
  }
}

/**
 * What a plan shows (spec 5.5, 7, 8, 10, 11.3), read from the state without changing it: placed nodes and phantoms
 * with their drawn hierarchy, groups with their derived centre and envelope, and the connections as parts. One pass
 * over the plan's branches (forEachInPlan); everything else by row.
 */
export function buildScene(s: State, planId: Id, measure: Measure, p: RenderParams): PlanScene {
  const plan = s.plans.get(planId);
  if (!plan) throw new Error(`Plan introuvable : ${planId}`);
  const pr = planRow(s, planId), linesOf = linesCache(measure);
  const items: SceneItem[] = [], rowOfSlot: number[] = [];
  const placements = placementsIn(s, pr);
  let maxRow = -1;
  for (const n of placements.keys()) if (n > maxRow) maxRow = n;
  const itemOfNode = new Int32Array(capacityFor(maxRow + 1)).fill(-1);
  for (const [n, pl] of placements) {
    const rec = recOf(s, n);
    if (!rec || rec.trashedAt !== undefined) continue;
    itemOfNode[n] = items.length;
    rowOfSlot.push(n);
    items.push(nodeItem(rec, pl, linesOf, p));
  }
  const nodeCount = items.length;
  // This plan's phantoms: their slots now, their items after the pass, which gives each connection's row (a centre
  // phantom shows its connection's title) without looking it up by identifier. Each connection's list by identifier.
  const phantoms: PhantomRec[] = [];
  for (const ph of s.phantoms.values()) if (ph.plan === planId) phantoms.push(ph);
  const phantomSlots = new Map<Id, number>(), listOf = new Map<Id, number>(), lists: PhantomRec[][] = [], listOfPhantom: number[] = [];
  phantoms.forEach((ph, i) => {
    phantomSlots.set(ph.id, nodeCount + i);
    let k = listOf.get(ph.connection);
    if (k === undefined) { listOf.set(ph.connection, (k = lists.length)); lists.push([]); }
    lists[k].push(ph);
    listOfPhantom.push(k);
  });
  for (const list of lists) if (list.length > 1) list.sort(idOrder);
  const listRows = lists.map(() => -1);

  // Parts, in columns, from the plan's branches; then the connections shown by their phantoms only.
  const layouts = new Map<Id, ConnectionLayout>();
  for (const l of s.connLayouts.values()) if (l.plan === planId) layouts.set(l.connection, l);
  const L: SceneLookup = {
    s, plan, planRow: pr, kind: drawnKind(plan), itemOfNode, phantomItem: (id) => phantomSlots.get(id) ?? -1,
    layoutOf: (c) => (layouts.size === 0 ? undefined : layouts.get(idOfConn(s, c))),
  };
  // At most: a main part per two solid ends (placed members or far nodes' phantoms), and a far part per centre phantom.
  let degrees = 0;
  for (let i = 0; i < nodeCount; i++) degrees += inCount(s, rowOfSlot[i]);
  const cols = new PartColumns(new Int32Array(capacityFor(connRowCount(s))).fill(-1), ((degrees + phantoms.length) >> 1) + phantoms.length + 1, degrees + 2 * phantoms.length + 1);
  // Badges (spec 11.3), counted in the same pass: for each node placed here, the knowledge connections it is seen in.
  const seen = new Int32Array(itemOfNode.length);
  let current = -1;
  const sink: PartSink = (far, center, ends, count, stubs, layout, title) => cols.add(current, idOfConn(s, current), far, center, ends, count, stubs, layout, title);
  const visit = (c: number, shown: ArrayLike<number>, list: readonly PhantomRec[]) => {
    current = c;
    emitParts(L, c, shown, list, sink, seen);
  };
  s.branches.forEachInPlan(planId, (c, nodeRows) => {
    const k = listOf.size === 0 ? undefined : listOf.get(idOfConn(s, c));
    if (k !== undefined) listRows[k] = c;
    visit(c, nodeRows, k !== undefined ? lists[k] : NO_PHANTOMS);
  });
  // The connections shown by their phantoms only (rare): looked up by identifier.
  lists.forEach((list, k) => { if (listRows[k] < 0) visit((listRows[k] = connRow(s, list[0].connection)), NO_ROWS, list); });
  phantoms.forEach((ph, i) => { items.push(phantomItem(s, ph, linesOf, p, ph.of.kind === 'center' ? centerTitle(s, listRows[listOfPhantom[i]]) : undefined)); });
  const { n, connRows, part, center, endStart, endCount, partNext, partHead, ends, layout, ids, titles, stubs } = cols.finish();
  for (let i = 0; i < nodeCount; i++) items[i].badge = seen[rowOfSlot[i]] < knowledgeOf(s, rowOfSlot[i]);

  // Drawn hierarchy: parents, children in draw order, roots, kinds; depths top-down, then groups bottom-up.
  for (let i = 0; i < items.length; i++) {
    items[i].parent = i < nodeCount ? nearestPlaced(s, pr, itemOfNode, groupOfRow(s, pr, rowOfSlot[i]), rowOfSlot[i]) : parentOf(s, pr, itemOfNode, items[i]);
  }
  items.forEach((it, i) => { if (it.parent >= 0) items[it.parent].children.push(i); });
  const order = drawOrder(items), roots: number[] = [];
  items.forEach((it, i) => {
    if (it.parent < 0) roots.push(i);
    if (it.children.length > 1) it.children.sort(order);
    if (it.kind === 'node' && it.children.length > 0) it.kind = 'group';
  });
  roots.sort(order);
  const visitOrder: number[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const i = stack.pop()!;
    visitOrder.push(i);
    for (const c of items[i].children) { items[c].depth = items[i].depth + 1; stack.push(c); }
  }
  for (let o = visitOrder.length - 1; o >= 0; o--) if (items[visitOrder[o]].kind === 'group') deriveGroup(items, visitOrder[o], p);

  const data: SceneData = {
    plan, items, itemOfNode, itemOfPhantom: new LayeredMap(phantomSlots), freeItems: [], roots, partCount: n, connRow: connRows, part, center, layout, ids, titles,
    endStart, endCount, ends, stubs: new LayeredMap(stubs), partHead, partNext, freeParts: [], hues: huesOf(items, roots), bounds: boundsOf(items),
  };
  for (const col of [connRows, part, center, endStart, endCount, partNext, layout, ids, titles]) tails.set(col, n);
  for (const col of [ends.item, ends.key, ends.meta]) tails.set(col, ends.top);
  return makeScene(s, data);
}

// ———— Previews

/**
 * The scene with some items moved (and their descendants), for the preview of a drag: moved items and the groups
 * above them are copied and derived again, everything else is shared. The original scene is left unchanged.
 */
export function withOffsets(scene: PlanScene, offsets: Map<number, Vec2>, p: RenderParams): PlanScene {
  const items = [...scene.items];
  const shift = (i: number, d: Vec2) => {
    const it = items[i];
    items[i] = { ...it, x: it.x + d.x, y: it.y + d.y, ...(it.hull ? { hull: it.hull.map((q) => ({ x: q.x + d.x, y: q.y + d.y })) } : {}) };
    for (const c of it.children) shift(c, d);
  };
  for (const [i, d] of offsets) shift(i, d);
  // Every group above a moved item, deepest first.
  const above = new Set<number>();
  for (const i of offsets.keys()) for (let a = items[i].parent; a >= 0; a = items[a].parent) above.add(a);
  for (const g of [...above].sort((a, b) => items[b].depth - items[a].depth)) {
    items[g] = { ...items[g] };
    deriveGroup(items, g, p);
  }
  return sceneWith(scene, { items, bounds: boundsOf(items) });
}

/**
 * The scene with some placements changed (positions, steps), for the preview of a scale gesture (I15 of the plan 3b
 * review): changed items and the groups above them are copied and derived again, everything else is shared, and the
 * scene is not rebuilt from the state. The original scene is left unchanged.
 */
export function withMoves(
  scene: PlanScene, m: { nodes: { node: Id; x?: number; y?: number; k?: number }[]; phantoms: { id: Id; x: number; y: number; k?: number }[] }, p: RenderParams,
): PlanScene {
  const items = [...scene.items];
  const touched: number[] = [];
  const update = (i: number | undefined, x: number | undefined, y: number | undefined, k: number | undefined) => {
    if (i === undefined) return;
    const it = items[i], nk = k ?? it.k;
    const disc = it.kind === 'phantom' && it.phantom !== 'node';
    const halves = nk === it.k ? {} : disc ? { halfW: p.centerRadius * stepScale(nk, p), halfH: p.centerRadius * stepScale(nk, p) } : boxHalves(it.lines, nk, p);
    items[i] = { ...it, x: x ?? it.x, y: y ?? it.y, k: nk, ...halves };
    touched.push(i);
  };
  for (const n of m.nodes) update(scene.byId.get(n.node), n.x, n.y, n.k);
  for (const ph of m.phantoms) update(scene.byId.get(ph.id), ph.x, ph.y, ph.k);
  const groups = new Set<number>();
  for (const i of touched) {
    if (items[i].kind === 'group') groups.add(i);
    for (let a = items[i].parent; a >= 0; a = items[a].parent) groups.add(a);
  }
  for (const g of [...groups].sort((a, b) => items[b].depth - items[a].depth)) {
    items[g] = { ...items[g] };
    deriveGroup(items, g, p);
  }
  return sceneWith(scene, { items, bounds: boundsOf(items) });
}
