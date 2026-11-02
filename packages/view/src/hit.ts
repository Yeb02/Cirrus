import type { Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { FrameGeometry } from './frame.ts';
import { insidePolygon, offsetPolygon } from './geometry/hull.ts';
import { foldT, stepScale, textPx } from './lod.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';
import type { VisibleSet } from './visibility.ts';

/**
 * What is under a point. Indices (item, conn, stub) serve at once (hover light); what acts later — a click handled at
 * the release, a menu chosen after a zoom — goes by the stable ids, the indices changing at each rebuild (I9 of the
 * plan 3b review).
 */
export type Hit =
  | { kind: 'item'; item: number; id: Id }
  /** conn: visible connection index; key: the member whose branch is under the point (null: the trunk); ids: the scene connections it stands for. */
  | { kind: 'connection'; conn: number; key: Id | null; ids: Id[]; part: 'main' | 'far' }
  /** connection, node: the absent member's; title: its node's. */
  | { kind: 'stub'; conn: number; stub: number; connection: Id; node: Id; title: string }
  | { kind: 'background' };

export interface HitIndex {
  /** What is under a world point: item (deepest first, closed groups included), stub end, connection, background. */
  hit(wx: number, wy: number, zoom: number): Hit;
  /** Open groups whose envelope contains the point, deepest first (the hierarchy reminder, spec 8.4). */
  openGroupsAt(wx: number, wy: number, zoom: number): number[];
  /** The visible connection whose core (marker, or centre of a 1-to-1 curve) is under the point (spec 11.1), or null. */
  markerAt(wx: number, wy: number, zoom: number): number | null;
}

function segmentDistance(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Built at each rebuild from what is drawn; queries take the current zoom, since groups fold between rebuilds. */
export function buildHitIndex(
  scene: PlanScene, visible: VisibleSet, frame: Pick<FrameGeometry, 'centerlines' | 'stubs' | 'markers'>, origin: Vec2, p: RenderParams,
): HitIndex {
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
  const segs: { conn: number; key: Id | null; a: Vec2; b: Vec2 }[] = [];
  for (const c of frame.centerlines) for (let i = 0; i < c.points.length - 1; i++) segs.push({ conn: c.conn, key: c.key, a: abs(c.points[i]), b: abs(c.points[i + 1]) });
  const segTree = segs.length > 0 ? new Flatbush(segs.length) : null;
  if (segTree) {
    for (const s of segs) segTree.add(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y));
    segTree.finish();
  }
  const stubs = frame.stubs.map((s) => ({ ...s, pos: abs(s.pos) }));
  const markers = frame.markers.map((m) => ({ conn: m.conn, pos: abs(m.pos) }));

  const folded = (g: number, zoom: number) => foldT(items[g].maxChildK!, zoom, p) >= p.foldClickable;
  // An open group's title, above its envelope as drawn: it stands for the group (spec 9.1, I11 of the plan 3b review).
  const titles = groups.map(({ g, poly }) => {
    const it = items[g], size = p.baseFontPx * stepScale(it.k, p) * p.groupTitleOpenScale;
    const cy = Math.min(...poly.map((q) => q.y)) - size * p.groupTitleOffset;
    const hw = (p.titleCharWidth * size * it.title.length) / 2, hh = (size * p.lineHeight) / 2;
    return { g, x0: it.x - hw, x1: it.x + hw, y0: cy - hh, y1: cy + hh };
  });
  /** Not inside a group that is more than half closed. */
  const reachable = (i: number, zoom: number) => {
    for (let a = items[i].parent; a >= 0; a = items[a].parent) if (folded(a, zoom)) return false;
    return true;
  };
  const deepest = (list: number[]) => list.reduce((best, i) => (best < 0 || items[i].depth > items[best].depth ? i : best), -1);
  const groupsAt = (wx: number, wy: number) =>
    groupTree ? groupTree.search(wx, wy, wx, wy).filter((j) => insidePolygon(groups[j].poly, wx, wy)).map((j) => groups[j].g) : [];

  return {
    hit(wx, wy, zoom) {
      const tol = p.hitTolerancePx / zoom;
      const onBox = boxTree ? boxTree.search(wx, wy, wx, wy).map((j) => boxes[j]).filter((i) => reachable(i, zoom)) : [];
      const item = (i: number): Hit => ({ kind: 'item', item: i, id: items[i].id });
      if (onBox.length > 0) return item(deepest(onBox));
      const closed = groupsAt(wx, wy).filter((g) => folded(g, zoom) && reachable(g, zoom));
      if (closed.length > 0) return item(deepest(closed));
      const titled = titles.filter((r) => wx >= r.x0 && wx <= r.x1 && wy >= r.y0 && wy <= r.y1 && !folded(r.g, zoom) && reachable(r.g, zoom)
        && textPx(items[r.g].k, zoom, p) * p.groupTitleOpenScale >= p.textFade[0]).map((r) => r.g);
      if (titled.length > 0) return item(deepest(titled));
      let bestStub = -1, bestStubD = tol * p.stubHitFactor;
      stubs.forEach((s, j) => { const d = Math.hypot(s.pos.x - wx, s.pos.y - wy); if (d <= bestStubD) { bestStubD = d; bestStub = j; } });
      if (bestStub >= 0) {
        const st = stubs[bestStub], vc = visible.connections[st.conn];
        return { kind: 'stub', conn: st.conn, stub: st.stub, connection: scene.connections[vc.conns[0]].id, node: vc.stubs[st.stub].node, title: vc.stubs[st.stub].title };
      }
      if (segTree) {
        let best = -1, bestD = tol;
        for (const j of segTree.search(wx - tol, wy - tol, wx + tol, wy + tol)) {
          const d = segmentDistance(wx, wy, segs[j].a, segs[j].b);
          if (d <= bestD) { bestD = d; best = j; }
        }
        if (best >= 0) {
          const vc = visible.connections[segs[best].conn];
          return { kind: 'connection', conn: segs[best].conn, key: segs[best].key, ids: vc.conns.map((c) => scene.connections[c].id), part: scene.connections[vc.conns[0]].part };
        }
      }
      return { kind: 'background' };
    },
    openGroupsAt(wx, wy, zoom) {
      return groupsAt(wx, wy)
        .filter((g) => !folded(g, zoom) && reachable(g, zoom))
        .sort((a, b) => items[b].depth - items[a].depth);
    },
    markerAt(wx, wy, zoom) {
      // Markers keep their on-screen size: the reach is in pixels.
      let best: number | null = null, bestD = (p.markerRadiusPx + p.hitTolerancePx) / zoom;
      for (const m of markers) { const d = Math.hypot(m.pos.x - wx, m.pos.y - wy); if (d <= bestD) { bestD = d; best = m.conn; } }
      return best;
    },
  };
}
