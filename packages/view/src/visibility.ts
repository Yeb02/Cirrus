import type { Id, Role } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene, SceneStub } from './scene.ts';

const ROOT = -1;
const ROLE_CODE: Record<Role, number> = { source: 0, target: 1, associate: 2 };

/** Flat, contiguous copies of what the per-rebuild visibility pass reads (bench lesson), plus connections by LCA. */
export interface SceneIndex {
  parent: Int32Array;
  /** Bounding box of each item: its box, or a group's padded envelope. */
  minX: Float64Array;
  minY: Float64Array;
  maxX: Float64Array;
  maxY: Float64Array;
  /** Largest member step of a group, -Infinity otherwise. */
  maxChildK: Float64Array;
  roots: number[];
  rootTree: Flatbush | null;
  /** Scene connection indices keyed by the lowest drawn group containing all their ends (-1: top level). */
  byLca: Map<number, Int32Array>;
  /** Distinct maxChildK values, ascending: the fold state of the whole plan is one letter per value. */
  levels: number[];
}

export function buildIndex(scene: PlanScene, _p: RenderParams): SceneIndex {
  const n = scene.items.length;
  const parent = new Int32Array(n), maxChildK = new Float64Array(n).fill(-Infinity);
  const minX = new Float64Array(n), minY = new Float64Array(n), maxX = new Float64Array(n), maxY = new Float64Array(n);
  scene.items.forEach((it, i) => {
    parent[i] = it.parent;
    if (it.kind === 'group') {
      maxChildK[i] = it.maxChildK!;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of offsetPolygon(it.hull!, it.pad!)) {
        x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
      }
      minX[i] = x0; minY[i] = y0; maxX[i] = x1; maxY[i] = y1;
    } else {
      minX[i] = it.x - it.halfW; maxX[i] = it.x + it.halfW; minY[i] = it.y - it.halfH; maxY[i] = it.y + it.halfH;
    }
  });
  const roots = scene.roots;
  let rootTree: Flatbush | null = null;
  if (roots.length > 0) {
    rootTree = new Flatbush(roots.length);
    for (const i of roots) rootTree.add(minX[i], minY[i], maxX[i], maxY[i]);
    rootTree.finish();
  }
  const chain = (i: number) => {
    const out: number[] = [];
    for (let a = parent[i]; a !== ROOT; a = parent[a]) out.push(a);
    return out;
  };
  const lists = new Map<number, number[]>();
  for (const c of scene.connections) {
    const members = [...c.ends.map((e) => e.item), ...(c.center !== undefined ? [c.center] : [])];
    let common = chain(members[0]);
    for (let i = 1; i < members.length && common.length > 0; i++) {
      const other = new Set(chain(members[i]));
      common = common.filter((g) => other.has(g));
    }
    const lca = common.length > 0 ? common[0] : ROOT;
    let list = lists.get(lca);
    if (!list) lists.set(lca, (list = []));
    list.push(c.index);
  }
  const byLca = new Map<number, Int32Array>();
  for (const [lca, list] of lists) byLca.set(lca, Int32Array.from(list));
  const levels = [...new Set([...maxChildK].filter((k) => k > -Infinity))].sort((a, b) => a - b);
  return { parent, minX, minY, maxX, maxY, maxChildK, roots, rootTree, byLca, levels };
}

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

/**
 * What a camera shows (spec 8.2, 8.5): items in the view (widened by viewMarginPx) down to closed groups, and the
 * connections with at least one endpoint there, their ends lifted to the highest closed ancestor (hollow arrows). While
 * a level folds, ends glide toward its border; a connection internal to the folding group fades with it.
 */
export function computeVisible(scene: PlanScene, index: SceneIndex, cam: Camera, p: RenderParams): VisibleSet {
  const { parent, minX, minY, maxX, maxY, maxChildK } = index;
  const n = parent.length;
  const halfW = (cam.widthPx / 2 + p.viewMarginPx) / cam.zoom, halfH = (cam.heightPx / 2 + p.viewMarginPx) / cam.zoom;
  const vx0 = cam.x - halfW, vx1 = cam.x + halfW, vy0 = cam.y - halfH, vy1 = cam.y + halfH;
  const inView = (i: number) => maxX[i] >= vx0 && minX[i] <= vx1 && maxY[i] >= vy0 && minY[i] <= vy1;

  // 0 unknown, 1 open, 2 fading, 3 closed.
  const state = new Int8Array(n);
  const st = (g: number) => {
    if (state[g] === 0) {
      const t = maxChildK[g] === -Infinity ? 0 : foldT(maxChildK[g], cam.zoom, p);
      state[g] = t >= 1 ? 3 : t > 0 ? 2 : 1;
    }
    return state[g];
  };
  const isGroup = (i: number) => maxChildK[i] !== -Infinity;

  const out: VisibleSet = { items: [], groups: [], connections: [], signature: foldSignature(index, cam.zoom, p) };
  const expanded: number[] = [];
  const stack = index.rootTree ? index.rootTree.search(vx0, vy0, vx1, vy1).map((r) => index.roots[r]).reverse() : [];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (!isGroup(i)) { out.items.push(i); continue; }
    out.groups.push(i);
    if (st(i) === 3) continue;
    expanded.push(i);
    const kids = scene.items[i].children;
    for (let c = kids.length - 1; c >= 0; c--) if (inView(kids[c])) stack.push(kids[c]);
  }

  // Endpoints: highest closed ancestor (open state), highest closed-or-fading ancestor (closed state). Memoized.
  const endO = new Int32Array(n).fill(-2), endC = new Int32Array(n).fill(-2);
  const lift = (m: number) => {
    if (endO[m] !== -2) return;
    let o = m, c = m;
    for (let a = parent[m]; a !== ROOT; a = parent[a]) {
      const s = st(a);
      if (s === 3) o = a;
      if (s >= 2) c = a;
    }
    endO[m] = o; endC[m] = c;
  };

  const aggregated = new Map<string, VisibleConnection>();
  for (const lca of [ROOT, ...expanded]) {
    const list = index.byLca.get(lca);
    if (!list) continue;
    for (let li = 0; li < list.length; li++) {
      const sc = scene.connections[list[li]];
      const ends: VisibleEnd[] = [];
      let sliding = false, foldK = -Infinity, seen = false;
      for (const e of sc.ends) {
        lift(e.item);
        const o = endO[e.item], c = endC[e.item];
        if (o !== c) { sliding = true; foldK = Math.max(foldK, maxChildK[c]); }
        if (!seen && (inView(o) || inView(c))) seen = true;
        ends.push({ item: o, item2: c, role: e.role, key: e.key, hollow: o !== e.item, hollow2: c !== e.item, dashed: e.dashed });
      }
      let center = sc.center;
      if (center !== undefined) {
        lift(center);
        if (endO[center] !== center) continue; // the centre phantom is folded away with its group
        if (!seen && inView(center)) seen = true;
      }
      if (!seen) continue;
      const extra = sc.stubs.length + (center !== undefined ? 1 : 0);
      const distinct = (key: 'item' | 'item2') => new Set(ends.map((e) => e[key])).size + extra;
      if (distinct('item') < 2) continue;
      const fade: VisibleConnection['fade'] = !sliding ? 'none' : distinct('item2') < 2 ? 'out' : 'slide';
      if (fade !== 'none') {
        out.connections.push({ conns: [sc.index], ends, stubs: sc.stubs, ...(center !== undefined ? { center } : {}), fade, foldK });
        continue;
      }
      // Static: merge ends that land on the same (item, role), then merge whole connections between the same ends.
      const merged: VisibleEnd[] = [];
      for (const e of ends) if (!merged.some((m) => m.item === e.item && m.role === e.role)) merged.push(e);
      const vc: VisibleConnection = { conns: [sc.index], ends: merged, stubs: sc.stubs, ...(center !== undefined ? { center } : {}), fade, foldK: Number.NaN };
      // Only ends lifted onto a closed group merge (spec 8.5, « Groupe replié »): open parallel connections stay apart.
      if (sc.layout || sc.stubs.length > 0 || center !== undefined || merged.some((e) => e.dashed) || !merged.some((e) => e.hollow)) { out.connections.push(vc); continue; }
      const key = merged.map((e) => e.item * 3 + ROLE_CODE[e.role]).sort((a, b) => a - b).join(',');
      const existing = aggregated.get(key);
      if (existing) existing.conns.push(sc.index);
      else { aggregated.set(key, vc); out.connections.push(vc); }
    }
  }
  return out;
}
