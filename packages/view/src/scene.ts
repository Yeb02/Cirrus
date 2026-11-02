import {
  ancestors, branchKey, type ConnectionLayout, type ConnectionRec, groupIndex, type Id, layoutKey, parseBranchKey, type PhantomRec, placementKey,
  type PlanRec, type Role, type State, type Vec2,
} from '@cirrus/core';
import type { Bounds } from './camera.ts';
import { convexHull, offsetPolygon } from './geometry/hull.ts';
import { stepScale } from './lod.ts';
import type { RenderParams } from './params.ts';

/** Lines of a title at base size: font baseFontPx, wrap width boxWidth − 2·boxPadX (the layout is scale-invariant). */
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

export interface PlanScene {
  plan: PlanRec;
  items: SceneItem[];
  byId: Map<Id, number>;
  roots: number[];
  connections: SceneConnection[];
  bounds: Bounds | null;
}

/** The parameters buildScene reads: the scene is rebuilt only when one of them changes (settings panel). */
export function sceneParamsKey(p: RenderParams): string {
  return JSON.stringify([p.factor, p.textScale, p.baseFontPx, p.boxWidth, p.boxPadX, p.boxPadY, p.lineHeight, p.envelopePad, p.centerRadius]);
}

const boxHalves = (lines: number, k: number, p: RenderParams) => {
  const s = stepScale(k, p);
  return { halfW: (p.boxWidth / 2) * s, halfH: ((lines * p.lineHeight * p.baseFontPx + 2 * p.boxPadY) / 2) * s };
};

/**
 * What a plan shows (spec 5.5, 7, 8, 10, 11.3), read from the state without changing it: placed nodes and phantoms
 * with their drawn hierarchy, groups with their derived centre and envelope, and the connections as bundles.
 */
export function buildScene(s: State, planId: Id, measure: Measure, p: RenderParams): PlanScene {
  const plan = s.plans.get(planId);
  if (!plan) throw new Error(`Plan introuvable : ${planId}`);
  const items: SceneItem[] = [];
  const byId = new Map<Id, number>();
  const lines = new Map<string, number>();
  const linesOf = (title: string) => {
    let n = lines.get(title);
    if (n === undefined) lines.set(title, (n = Math.max(1, measure(title))));
    return n;
  };
  const add = (item: SceneItem) => { byId.set(item.id, items.length); items.push(item); };
  const isPlaced = (node: Id) => s.placements.has(placementKey(planId, node));

  for (const pl of s.placements.values()) {
    if (pl.plan !== planId) continue;
    const n = s.nodes.get(pl.node);
    if (!n || n.trashedAt !== undefined) continue;
    const l = linesOf(n.title);
    add({ id: n.id, kind: 'node', node: n.id, title: n.title, lines: l, x: pl.x, y: pl.y, k: pl.k, ...boxHalves(l, pl.k, p), parent: -1, children: [], depth: 0, badge: false });
  }
  const phantoms: PhantomRec[] = [];
  for (const ph of s.phantoms.values()) {
    if (ph.plan !== planId) continue;
    const c = s.connections.get(ph.connection);
    const represented = s.nodes.get(ph.of.node);
    const title = ph.of.kind === 'center' ? (c?.title || 'Connexion') : (represented?.title ?? '');
    const l = linesOf(title);
    const halves = ph.of.kind === 'node'
      ? boxHalves(l, ph.k, p)
      : { halfW: p.centerRadius * stepScale(ph.k, p), halfH: p.centerRadius * stepScale(ph.k, p) };
    phantoms.push(ph);
    add({
      id: ph.id, kind: 'phantom', node: ph.of.node, phantom: ph.of.kind, connection: ph.connection, title, lines: l,
      x: ph.x, y: ph.y, k: ph.k, ...halves, parent: -1, children: [], depth: 0, badge: false,
    });
  }

  // Drawn hierarchy: the nearest placed ancestor (a group removed from the plan keeps its links, spec 7).
  const gIndex = groupIndex(s);
  const nearestPlaced = (chain: Id[]) => {
    for (const g of chain) if (byId.has(g) && items[byId.get(g)!].kind !== 'phantom') return byId.get(g)!;
    return -1;
  };
  for (const item of items) {
    if (item.kind === 'node') item.parent = nearestPlaced(ancestors(s, planId, item.id, gIndex));
    else {
      const g = (s.phantoms.get(item.id) as PhantomRec).group;
      item.parent = g === undefined ? -1 : nearestPlaced([g, ...ancestors(s, planId, g, gIndex)]);
    }
  }
  items.forEach((item, i) => { if (item.parent >= 0) items[item.parent].children.push(i); });
  const roots: number[] = [];
  items.forEach((item, i) => { if (item.parent < 0) roots.push(i); });
  for (const item of items) if (item.kind === 'node' && item.children.length > 0) item.kind = 'group';

  // Depths top-down, then groups bottom-up: derived centre, hull of the members' footprints, padding.
  const order: number[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const i = stack.pop()!;
    order.push(i);
    for (const c of items[i].children) { items[c].depth = items[i].depth + 1; stack.push(c); }
  }
  for (let o = order.length - 1; o >= 0; o--) {
    const g = items[order[o]];
    if (g.kind !== 'group') continue;
    const kids = g.children.map((c) => items[c]);
    const corners: Vec2[] = [];
    for (const c of kids) {
      if (c.kind === 'group') corners.push(...offsetPolygon(c.hull!, c.pad!));
      else for (const dx of [-1, 1]) for (const dy of [-1, 1]) corners.push({ x: c.x + dx * c.halfW, y: c.y + dy * c.halfH });
    }
    g.x = kids.reduce((a, c) => a + c.x, 0) / kids.length;
    g.y = kids.reduce((a, c) => a + c.y, 0) / kids.length;
    g.hull = convexHull(corners);
    g.maxChildK = Math.max(...kids.map((c) => c.k));
    g.pad = p.envelopePad * stepScale(g.maxChildK, p);
  }

  const connections = sceneConnections(s, plan, items, byId, phantoms, isPlaced);
  markBadges(s, planId, items, byId, phantoms);
  return { plan, items, byId, roots, connections, bounds: boundsOf(items) };
}

function sceneConnections(
  s: State, plan: PlanRec, items: SceneItem[], byId: Map<Id, number>, phantoms: PhantomRec[], isPlaced: (n: Id) => boolean,
): SceneConnection[] {
  const kind = plan.type === 'document' ? 'structure' : 'knowledge';
  const shown = new Map<Id, Id[]>();
  for (const key of s.branches) {
    const b = parseBranchKey(key);
    if (b.plan !== plan.id) continue;
    const list = shown.get(b.connection);
    if (list) list.push(b.node);
    else shown.set(b.connection, [b.node]);
  }
  const phantomsOf = new Map<Id, PhantomRec[]>();
  for (const ph of phantoms) phantomsOf.set(ph.connection, [...(phantomsOf.get(ph.connection) ?? []), ph]);

  const out: SceneConnection[] = [];
  const roleIn = (c: ConnectionRec, node: Id) => c.members.find((m) => m.node === node)?.role;
  for (const id of new Set([...shown.keys(), ...phantomsOf.keys()])) {
    const c = s.connections.get(id);
    if (!c || c.trashedAt !== undefined || c.kind !== kind) continue;
    const layout = s.connLayouts.get(layoutKey(plan.id, id));
    const ph = phantomsOf.get(id) ?? [];
    const main: SceneConnection = { index: 0, id, part: 'main', title: c.title, ends: [], stubs: [], ...(layout ? { layout } : {}) };
    for (const node of shown.get(id) ?? []) {
      const role = roleIn(c, node);
      if (!role) continue;
      const absent = ph.find((x) => x.of.kind === 'absent' && x.of.node === node);
      if (isPlaced(node) && byId.has(node)) main.ends.push({ item: byId.get(node)!, role, key: node, dashed: false });
      else if (absent) main.ends.push({ item: byId.get(absent.id)!, role, key: node, dashed: true });
      else main.stubs.push({ role, node, title: s.nodes.get(node)?.title ?? '' });
    }
    for (const x of ph) {
      const role = roleIn(c, x.of.node);
      if (x.of.kind === 'node' && role) main.ends.push({ item: byId.get(x.id)!, role, key: x.of.node, dashed: false });
    }
    if (main.ends.filter((e) => !e.dashed).length >= 2) out.push(main);
    for (const x of ph) {
      const role = roleIn(c, x.of.node);
      if (x.of.kind !== 'center' || !role || !byId.has(x.of.node)) continue;
      out.push({ index: 0, id, part: 'far', title: c.title, ends: [{ item: byId.get(x.of.node)!, role, key: x.of.node, dashed: false }], stubs: [], center: byId.get(x.id)! });
    }
  }
  out.forEach((c, i) => { c.index = i; });
  return out;
}

/** A placed node is badged when one of its knowledge connections shows no branch to it here (and no split arm). */
function markBadges(s: State, planId: Id, items: SceneItem[], byId: Map<Id, number>, phantoms: PhantomRec[]): void {
  const split = new Set(phantoms.filter((ph) => ph.of.kind === 'center').map((ph) => `${ph.connection}|${ph.of.node}`));
  for (const c of s.connections.values()) {
    if (c.kind !== 'knowledge' || c.trashedAt !== undefined) continue;
    for (const m of c.members) {
      const i = byId.get(m.node);
      if (i === undefined || items[i].kind === 'phantom' || items[i].badge) continue;
      if (!s.branches.has(branchKey({ plan: planId, connection: c.id, node: m.node })) && !split.has(`${c.id}|${m.node}`)) items[i].badge = true;
    }
  }
}

function boundsOf(items: SceneItem[]): Bounds | null {
  if (items.length === 0) return null;
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number) => {
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
  };
  for (const i of items) {
    if (i.kind === 'group') { if (i.parent < 0) for (const q of offsetPolygon(i.hull!, i.pad!)) grow(q.x, q.y); }
    else { grow(i.x - i.halfW, i.y - i.halfH); grow(i.x + i.halfW, i.y + i.halfH); }
  }
  return b;
}
