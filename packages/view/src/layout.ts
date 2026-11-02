import type { ConnectionLayout, Id, Vec2 } from '@cirrus/core';
import type { BundleGeometry } from './geometry/bundle.ts';
import { add, mul, sub } from './geometry/vec.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';

/** A connection's layout in one plan, without its keys (spec 5.5). */
export type Layout = Omit<ConnectionLayout, 'plan' | 'connection'>;
export type LayoutHandle = { kind: 'marker' } | { kind: 'rotation' } | { kind: 'bezier'; key: Id; which: 'b1' | 'b2' };
/** A handle where it is drawn (world), and the point its guide line starts from. */
export interface HandleSpot { handle: LayoutHandle; at: Vec2; from?: Vec2 }

/**
 * The handles of a selected connection (spec 8.5, as in the maquette): two Bézier handles per branch leading to a
 * node (stubs aside), a rotation handle rotationHandlePx beyond the trunk, and the marker itself.
 */
export function layoutHandles(g: BundleGeometry, zoom: number, p: RenderParams): HandleSpot[] {
  const out: HandleSpot[] = [];
  for (const b of g.branches) {
    if (b.stub || b.key === null) continue;
    out.push({ handle: { kind: 'bezier', key: b.key, which: 'b1' }, at: b.b1, from: b.p0 });
    out.push({ handle: { kind: 'bezier', key: b.key, which: 'b2' }, at: b.b2, from: b.p3 });
  }
  const B = g.trunk ? g.trunk[1] : g.marker;
  out.push({ handle: { kind: 'rotation' }, at: add(B, mul(g.u, p.rotationHandlePx / zoom)), from: g.marker });
  out.push({ handle: { kind: 'marker' }, at: g.marker });
  return out;
}

/**
 * The layout with a handle dragged to `at` (world), from the geometry drawn with `layout`: the marker is pinned there,
 * the trunk turns toward it, a Bézier handle lands under the cursor. What was set before stays.
 */
export function applyHandle(layout: Layout | undefined, g: BundleGeometry, h: LayoutHandle, at: Vec2): Layout {
  const out: Layout = { ...layout, handles: { ...layout?.handles } };
  if (h.kind === 'marker') return { ...out, marker: at };
  if (h.kind === 'rotation') return { ...out, angle: Math.atan2(at.y - g.marker.y, at.x - g.marker.x) };
  const b = g.branches.find((x) => x.key === h.key && !x.stub);
  if (!b) return out;
  const old = out.handles[h.key] ?? { b1: { x: 0, y: 0 }, b2: { x: 0, y: 0 } };
  out.handles[h.key] = { ...old, [h.which]: sub(at, sub(b[h.which], old[h.which])) };
  return out;
}

/** The handle under a world point, at its on-screen size. */
export function handleAt(spots: HandleSpot[], wx: number, wy: number, zoom: number, p: RenderParams): LayoutHandle | null {
  let best: LayoutHandle | null = null, bestD = (p.handleRadiusPx + p.hitTolerancePx) / zoom;
  for (const s of spots) {
    const d = Math.hypot(s.at.x - wx, s.at.y - wy);
    if (d <= bestD) { bestD = d; best = s.handle; }
  }
  return best;
}

/** The scene with one connection's layout replaced (a handle being dragged: the preview), everything else shared. */
export function withLayout(scene: PlanScene, conn: number, layout: Layout): PlanScene {
  return {
    ...scene,
    connections: scene.connections.map((c) => (c.index === conn ? { ...c, layout: { plan: scene.plan.id, connection: c.id, ...layout } } : c)),
  };
}
