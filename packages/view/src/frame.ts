import type { ConnectionLayout, Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { groupPalette } from './color.ts';
import { type BundleEnd, type BundleGeometry, bundleGeometry } from './geometry/bundle.ts';
import { appendEnvelope, clearEnvelopeMeshes, type EnvelopeMeshes, newEnvelopeMeshes, NO_PARENT } from './geometry/envelope.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { appendBundle, clearConnectionMeshes, type ConnectionMeshes, newConnectionMeshes } from './geometry/ribbon.ts';
import { foldT, stepScale } from './lod.ts';
import type { RenderParams, Rgb } from './params.ts';
import type { PlanScene, SceneItem } from './scene.ts';
import { placeTitle, type Rect, type TitleSide } from './titles.ts';
import type { VisibleConnection, VisibleSet } from './visibility.ts';

/** Everything a rebuild draws, in world units relative to `origin` (float32 precision at any zoom). Pure: Task 9 runs it in a worker. */
export interface FrameGeometry {
  origin: Vec2;
  connections: ConnectionMeshes;
  envelopes: EnvelopeMeshes;
  /** key: the member the line leads to, null for a trunk. */
  centerlines: { conn: number; points: Vec2[]; key: Id | null }[];
  markers: { conn: number; pos: Vec2; kMax: number; multi: boolean }[];
  titles: { conn: number; id: Id; text: string; box: Rect; kMax: number; side: TitleSide }[];
  stubs: { conn: number; stub: number; pos: Vec2; title: string }[];
}

/**
 * A group's colours (spec 8.4): top-level groups take groupHues in their order of creation (the scene's hue ranks),
 * their subgroups the same hue with a lightness offset per level.
 */
export function groupColors(scene: PlanScene, g: number, p: RenderParams): { open: Rgb; closed: Rgb } {
  let root = g;
  while (scene.items[root].parent >= 0) root = scene.items[root].parent;
  const hue = p.groupHues[(scene.hues.get(root) ?? 0) % p.groupHues.length];
  return groupPalette({ depth: scene.items[g].depth, hue }, p);
}

/**
 * Builds the meshes of a visible set (spec 8.4, 8.5). `prevSides` keeps connection titles on the side they had;
 * `reuse` refills the typed arrays of a previous frame instead of allocating new ones.
 */
export function buildFrame(
  scene: PlanScene, visible: VisibleSet, cam: Camera, origin: Vec2, p: RenderParams,
  prevSides?: Map<Id, TitleSide>, reuse?: FrameGeometry,
): FrameGeometry {
  const connections = reuse?.connections ?? newConnectionMeshes();
  const envelopes = reuse?.envelopes ?? newEnvelopeMeshes();
  clearConnectionMeshes(connections);
  clearEnvelopeMeshes(envelopes);
  const frame: FrameGeometry = { origin, connections, envelopes, centerlines: [], markers: [], titles: [], stubs: [] };
  const rel = (q: Vec2): Vec2 => ({ x: q.x - origin.x, y: q.y - origin.y });
  const items = scene.items;

  // Envelopes, parents first so nested levels are drawn on top.
  for (const g of visible.groups) {
    const it = items[g];
    appendEnvelope(envelopes, it.hull!.map(rel), it.pad!, groupColors(scene, g, p), it.maxChildK!, it.parent >= 0 ? items[it.parent].maxChildK! : NO_PARENT);
  }

  const padded = new Map<number, Vec2[]>();
  const paddedOf = (i: number) => {
    let poly = padded.get(i);
    if (!poly) padded.set(i, (poly = offsetPolygon(items[i].hull!, items[i].pad!)));
    return poly;
  };
  const extentOf = (it: SceneItem, i: number) =>
    it.kind === 'group' ? Math.max(...paddedOf(i).map((q) => Math.hypot(q.x - it.x, q.y - it.y))) : Math.max(it.halfW, it.halfH);
  const geometry = (vc: VisibleConnection, closed: boolean): BundleGeometry => bundleFor(scene, vc, p, origin, undefined, closed);

  const camRel = rel(cam);
  const pxPerUnit = cam.zoom * p.curveZoomHeadroom;
  visible.connections.forEach((vc, ci) => {
    const open = geometry(vc, false);
    const closed = vc.fade === 'slide' ? geometry(vc, true) : null;
    // The two endpoints nearest the camera carry the off-screen fade (spec 8.5); a far part: its node and its centre.
    const pts = [...vc.ends.map((e) => e.item), ...(vc.center !== undefined ? [vc.center] : [])]
      .map((i) => { const q = rel(items[i]); return { q, e: extentOf(items[i], i), d: Math.hypot(q.x - camRel.x, q.y - camRel.y) }; })
      .sort((a, b) => a.d - b.d);
    const e0 = pts[0], e1 = pts[1] ?? pts[0];
    const lines = appendBundle(connections, open, closed, {
      pxPerUnit, end0: [e0.q.x, e0.q.y, e0.e], end1: [e1.q.x, e1.q.y, e1.e], fade: vc.fade, foldK: vc.foldK, conn: ci,
    }, p);
    if (lines.length === 0) return;
    for (const l of lines) frame.centerlines.push({ conn: ci, points: l.points, key: l.key });
    frame.markers.push({ conn: ci, pos: open.marker, kMax: open.kMax, multi: open.multi });
    open.branches.filter((b) => b.stub).forEach((b, si) => {
      frame.stubs.push({ conn: ci, stub: si, pos: b.nodeEnd === 'p0' ? b.p0 : b.p3, title: vc.stubs[si].title });
    });
  });

  placeTitles(scene, visible, frame, cam, p, prevSides, rel);
  return frame;
}

/**
 * The bundle of a visible connection (spec 8.5), relative to `origin`. `layout` stands in for the plan's own (a handle
 * being dragged, spec 8.5); `closed` draws it with its fading level closed.
 */
export function bundleFor(
  scene: PlanScene, vc: VisibleConnection, p: RenderParams, origin: Vec2 = { x: 0, y: 0 },
  layout?: Omit<ConnectionLayout, 'plan' | 'connection'>, closed = false,
): BundleGeometry {
  const items = scene.items;
  const rel = (q: Vec2): Vec2 => ({ x: q.x - origin.x, y: q.y - origin.y });
  const end = (i: number, role: BundleEnd['role'], hollow: boolean, dashed: boolean, key: Id): BundleEnd => {
    const it = items[i];
    const e: BundleEnd = { pos: rel(it), halfW: it.halfW, halfH: it.halfH, role, k: it.k, hollow, dashed, key };
    if (it.kind === 'group') e.hull = { poly: it.hull!.map(rel), centre: rel(it), pad: it.pad! };
    return e;
  };
  const own = layout ?? (vc.conns.length === 1 ? scene.layout[vc.conns[0]] : undefined);
  return bundleGeometry({
    ends: vc.ends.map((e) => end(closed ? e.item2 : e.item, e.role, closed ? e.hollow2 : e.hollow, e.dashed, e.key)),
    stubs: vc.stubs.map((s) => ({ role: s.role, key: s.node })),
    ...(vc.center !== undefined ? { centre: rel(items[vc.center]) } : {}),
    ...(own ? { layout: { ...own, marker: own.marker ? rel(own.marker) : undefined } } : {}),
  }, p);
}

function placeTitles(
  scene: PlanScene, visible: VisibleSet, frame: FrameGeometry, cam: Camera, p: RenderParams,
  prevSides: Map<Id, TitleSide> | undefined, rel: (q: Vec2) => Vec2,
): void {
  const items = scene.items;
  // Obstacles: visible boxes, and groups more than half closed.
  const obstacles: Rect[] = [];
  for (const i of visible.items) {
    const it = items[i], c = rel(it);
    obstacles.push({ x: c.x - it.halfW, y: c.y - it.halfH, w: 2 * it.halfW, h: 2 * it.halfH });
  }
  for (const g of visible.groups) {
    const it = items[g];
    if (foldT(it.maxChildK!, cam.zoom, p) < p.foldClickable) continue;
    const poly = offsetPolygon(it.hull!, it.pad!).map(rel);
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    obstacles.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }
  const pts: Vec2[] = frame.centerlines.flatMap((c) => c.points);
  const ptTree = pts.length > 0 ? new Flatbush(pts.length) : null;
  if (ptTree) { for (const q of pts) ptTree.add(q.x, q.y, q.x, q.y); ptTree.finish(); }
  const obTree = obstacles.length > 0 ? new Flatbush(obstacles.length) : null;
  if (obTree) { for (const o of obstacles) obTree.add(o.x, o.y, o.x + o.w, o.y + o.h); obTree.finish(); }
  const placed: Rect[] = [];

  for (const m of frame.markers) {
    const vc = visible.connections[m.conn];
    const text = vc.conns.length > 1 ? `${vc.conns.length} connexions` : scene.titles[vc.conns[0]];
    if (!text) continue;
    const size = p.titleFontPx * stepScale(m.kMax, p);
    // Unreadable until the next rebuild even at the deepest zoom it serves: skip (spec 8.2).
    if (size * cam.zoom * p.curveZoomHeadroom < p.titleFade[0]) continue;
    const w = p.titleCharWidth * size * text.length, h = size * p.titleBoxHeight, gap = p.titleGap * stepScale(m.kMax, p);
    const reach = w + gap * 4 + h;
    const near = (x0: number, y0: number, x1: number, y1: number) => [x0 - reach, y0 - reach, x1 + reach, y1 + reach] as const;
    const [qx0, qy0, qx1, qy1] = near(m.pos.x, m.pos.y, m.pos.x, m.pos.y);
    const samples = ptTree ? ptTree.search(qx0, qy0, qx1, qy1).map((i) => pts[i]) : [];
    const obs = [...(obTree ? obTree.search(qx0, qy0, qx1, qy1).map((i) => obstacles[i]) : []), ...placed];
    const id = vc.conns.map((i) => scene.ids[i]).join('+');
    const { side, rect } = placeTitle(m.pos, w, h, gap, samples, obs, prevSides?.get(id));
    placed.push(rect);
    frame.titles.push({ conn: m.conn, id, text, box: rect, kMax: m.kMax, side });
  }
}
