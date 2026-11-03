import { type Id, type Role, ROLES } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import { END_DASHED, isLive, PART_GONE, type PlanScene, type SceneStub } from './scene.ts';

const ROOT = -1;
const ROLE_CODE: Record<Role, number> = { source: 0, target: 1, associate: 2 };
const NO_STUBS: SceneStub[] = [];

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
    if (!isLive(scene, i)) {
      // A free slot: out of every view, never an endpoint.
      minX[i] = minY[i] = Infinity; maxX[i] = maxY[i] = -Infinity;
    } else if (it.kind === 'group') {
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
  // The lowest group containing all of a part's ends (and its centre): the deepest common strict ancestor, by depths.
  const depth = new Int32Array(n);
  scene.items.forEach((it, i) => { depth[i] = it.depth; });
  /** The deepest group that is a or above a and b or above b (ROOT for none). */
  const meet = (a: number, b: number) => {
    while (a !== ROOT && b !== ROOT && a !== b) {
      if (depth[a] >= depth[b]) a = parent[a];
      else b = parent[b];
    }
    return a === b ? a : ROOT;
  };
  const lists = new Map<number, number[]>();
  const { endStart, endCount, center, part } = scene, endItem = scene.ends.item;
  for (let c = 0; c < scene.partCount; c++) {
    if (part[c] === PART_GONE) continue;
    const s0 = endStart[c], end = s0 + endCount[c];
    let lca = parent[endItem[s0]];
    for (let k = s0 + 1; k < end && lca !== ROOT; k++) lca = meet(lca, parent[endItem[k]]);
    if (center[c] >= 0 && lca !== ROOT) lca = meet(lca, parent[center[c]]);
    let list = lists.get(lca);
    if (!list) lists.set(lca, (list = []));
    list.push(c);
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
  const { endStart, endCount, items } = scene, endItem = scene.ends.item, endMeta = scene.ends.meta, roles = ROLES;
  for (const lca of [ROOT, ...expanded]) {
    const list = index.byLca.get(lca);
    if (!list) continue;
    for (let li = 0; li < list.length; li++) {
      const pi: number = list[li];
      const ends: VisibleEnd[] = [];
      let sliding = false, foldK = -Infinity, seen = false;
      for (let k = endStart[pi], end = k + endCount[pi]; k < end; k++) {
        const item = endItem[k], meta = endMeta[k];
        lift(item);
        const o = endO[item], c = endC[item];
        if (o !== c) { sliding = true; foldK = Math.max(foldK, maxChildK[c]); }
        if (!seen && (inView(o) || inView(c))) seen = true;
        ends.push({ item: o, item2: c, role: roles[meta & 3], key: items[item].node, hollow: o !== item, hollow2: c !== item, dashed: (meta & END_DASHED) !== 0 });
      }
      const center = scene.center[pi] >= 0 ? scene.center[pi] : undefined;
      if (center !== undefined) {
        lift(center);
        if (endO[center] !== center) continue; // the centre phantom is folded away with its group
        if (!seen && inView(center)) seen = true;
      }
      if (!seen) continue;
      const stubs = scene.stubs.size === 0 ? NO_STUBS : scene.stubs.get(pi) ?? NO_STUBS;
      const extra = stubs.length + (center !== undefined ? 1 : 0);
      const distinct = (key: 'item' | 'item2') => new Set(ends.map((e) => e[key])).size + extra;
      if (distinct('item') < 2) continue;
      const fade: VisibleConnection['fade'] = !sliding ? 'none' : distinct('item2') < 2 ? 'out' : 'slide';
      if (fade !== 'none') {
        out.connections.push({ conns: [pi], ends, stubs, ...(center !== undefined ? { center } : {}), fade, foldK });
        continue;
      }
      // Static: merge ends that land on the same (item, role), then merge whole connections between the same ends.
      const merged: VisibleEnd[] = [];
      for (const e of ends) if (!merged.some((m) => m.item === e.item && m.role === e.role)) merged.push(e);
      const vc: VisibleConnection = { conns: [pi], ends: merged, stubs, ...(center !== undefined ? { center } : {}), fade, foldK: Number.NaN };
      // Only ends lifted onto a closed group merge (spec 8.5, « Groupe replié »): open parallel connections stay apart.
      if (scene.layout[pi] || stubs.length > 0 || center !== undefined || merged.some((e) => e.dashed) || !merged.some((e) => e.hollow)) { out.connections.push(vc); continue; }
      const key = merged.map((e) => e.item * 3 + ROLE_CODE[e.role]).sort((a, b) => a - b).join(',');
      const existing = aggregated.get(key);
      if (existing) existing.conns.push(pi);
      else { aggregated.set(key, vc); out.connections.push(vc); }
    }
  }
  return out;
}
