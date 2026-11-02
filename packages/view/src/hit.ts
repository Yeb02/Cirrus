import type { Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { FrameGeometry } from './frame.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';
import type { VisibleSet } from './visibility.ts';

export type Hit =
  | { kind: 'item'; item: number }
  /** conn: visible connection index. */
  | { kind: 'connection'; conn: number }
  | { kind: 'stub'; conn: number; stub: number }
  | { kind: 'background' };

export interface HitIndex {
  /** What is under a world point: item (deepest first, closed groups included), stub end, connection, background. */
  hit(wx: number, wy: number, zoom: number): Hit;
  /** Open groups whose envelope contains the point, deepest first (the hierarchy reminder, spec 8.4). */
  openGroupsAt(wx: number, wy: number, zoom: number): number[];
}

function inPolygon(poly: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentDistance(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Built at each rebuild from what is drawn; queries take the current zoom, since groups fold between rebuilds. */
export function buildHitIndex(scene: PlanScene, visible: VisibleSet, frame: Pick<FrameGeometry, 'centerlines' | 'stubs'>, origin: Vec2, p: RenderParams): HitIndex {
  const items = scene.items;
  const abs = (q: Vec2): Vec2 => ({ x: q.x + origin.x, y: q.y + origin.y });

  const boxes = visible.items;
  const boxTree = boxes.length > 0 ? new Flatbush(boxes.length) : null;
  if (boxTree) {
    for (const i of boxes) { const it = items[i]; boxTree.add(it.x - it.halfW, it.y - it.halfH, it.x + it.halfW, it.y + it.halfH); }
    boxTree.finish();
  }
  const groups = visible.groups.map((g) => ({ g, poly: offsetPolygon(items[g].hull!, items[g].pad!) }));
  const groupTree = groups.length > 0 ? new Flatbush(groups.length) : null;
  if (groupTree) {
    for (const { poly } of groups) {
      const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
      groupTree.add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
    groupTree.finish();
  }
  const segs: { conn: number; a: Vec2; b: Vec2 }[] = [];
  for (const c of frame.centerlines) for (let i = 0; i < c.points.length - 1; i++) segs.push({ conn: c.conn, a: abs(c.points[i]), b: abs(c.points[i + 1]) });
  const segTree = segs.length > 0 ? new Flatbush(segs.length) : null;
  if (segTree) {
    for (const s of segs) segTree.add(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y));
    segTree.finish();
  }
  const stubs = frame.stubs.map((s) => ({ ...s, pos: abs(s.pos) }));

  const folded = (g: number, zoom: number) => foldT(items[g].maxChildK!, zoom, p) >= 0.5;
  /** Not inside a group that is more than half closed. */
  const reachable = (i: number, zoom: number) => {
    for (let a = items[i].parent; a >= 0; a = items[a].parent) if (folded(a, zoom)) return false;
    return true;
  };
  const deepest = (list: number[]) => list.reduce((best, i) => (best < 0 || items[i].depth > items[best].depth ? i : best), -1);
  const groupsAt = (wx: number, wy: number) =>
    groupTree ? groupTree.search(wx, wy, wx, wy).filter((j) => inPolygon(groups[j].poly, wx, wy)).map((j) => groups[j].g) : [];

  return {
    hit(wx, wy, zoom) {
      const tol = p.hitTolerancePx / zoom;
      const onBox = boxTree ? boxTree.search(wx, wy, wx, wy).map((j) => boxes[j]).filter((i) => reachable(i, zoom)) : [];
      if (onBox.length > 0) return { kind: 'item', item: deepest(onBox) };
      const closed = groupsAt(wx, wy).filter((g) => folded(g, zoom) && reachable(g, zoom));
      if (closed.length > 0) return { kind: 'item', item: deepest(closed) };
      let bestStub = -1, bestStubD = tol * 1.5;
      stubs.forEach((s, j) => { const d = Math.hypot(s.pos.x - wx, s.pos.y - wy); if (d <= bestStubD) { bestStubD = d; bestStub = j; } });
      if (bestStub >= 0) return { kind: 'stub', conn: stubs[bestStub].conn, stub: stubs[bestStub].stub };
      if (segTree) {
        let best = -1, bestD = tol;
        for (const j of segTree.search(wx - tol, wy - tol, wx + tol, wy + tol)) {
          const d = segmentDistance(wx, wy, segs[j].a, segs[j].b);
          if (d <= bestD) { bestD = d; best = j; }
        }
        if (best >= 0) return { kind: 'connection', conn: segs[best].conn };
      }
      return { kind: 'background' };
    },
    openGroupsAt(wx, wy, zoom) {
      return groupsAt(wx, wy)
        .filter((g) => !folded(g, zoom) && reachable(g, zoom))
        .sort((a, b) => items[b].depth - items[a].depth);
    },
  };
}
