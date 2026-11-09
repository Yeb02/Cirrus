import type { Id } from '@cirrus/core';
import {
  applyHandle, type BundleGeometry, bundleFor, handleAt, type HandleSpot, type Layout, type LayoutHandle, layoutHandles, layoutSplit, PART_MAIN, type PlanScene,
  type PreviewSplit, screenToWorld, worldToScreen,
} from '@cirrus/view';
import { useRef } from 'react';
import { layoutBuild } from '../../actions.ts';
import { type Graph, NOTHING_SHOWN } from './core.ts';

/**
 * The layout handles of the connection selected alone (spec 8.5): drawn over the canvas (`handlesSvg`), pressed and
 * dragged out of the gesture machine's way, the layout written once released.
 */
export function useLayoutHandles(graph: Graph) {
  const { engine, sceneRef, paramsRef, selectionRef, edit, feed, hitAt, restoreScene, redraw } = graph;
  /** The layout handles of the selected connection (spec 8.5), drawn over the canvas; one may be dragged. */
  const handlesSvg = useRef<SVGSVGElement>(null);
  const handleDrag = useRef<{
    handle: LayoutHandle; conn: number; id: Id; base: Layout | undefined; g: BundleGeometry; layout: Layout | undefined; scene: PlanScene;
    /** Where it was pressed; the drag begins beyond clickSlopPx, short of it the press is a plain click (I10 of the review). */
    from: { x: number; y: number }; armed: boolean;
    /** Its split for the visible set drawn (plan 3c task 9). */
    split?: PreviewSplit;
  } | null>(null);
  /**
   * The handles of the one connection selected, if it is drawn alone (spec 8.5): its marker, its trunk's rotation, the
   * Bézier handles of its branches — from the layout being dragged, if any.
   */
  const layoutSpots = (): { spots: HandleSpot[]; g: BundleGeometry; conn: number } | null => {
    const e = engine.current, sc = sceneRef.current, sel = selectionRef.current, vis = e?.renderer.visible;
    if (!e || !sc || !vis || sel.items.size > 0 || sel.connections.size !== 1) return null;
    const id = [...sel.connections][0];
    const vc = vis.connections.find((x) => x.conns.length === 1 && x.fade === 'none' && sc.ids[x.conns[0]] === id && sc.part[x.conns[0]] === PART_MAIN);
    if (!vc) return null;
    const g = bundleFor(sc, vc, paramsRef.current, { x: 0, y: 0 }, handleDrag.current?.layout);
    return { spots: layoutHandles(g, e.renderer.camera.zoom, paramsRef.current), g, conn: vc.conns[0] };
  };
  const drawHandles = () => {
    const svg = handlesSvg.current, e = engine.current;
    if (!svg || !e) return;
    const L = layoutSpots();
    if (!L) { if (svg.firstChild) svg.replaceChildren(); return; }
    const p = paramsRef.current, cam = e.renderer.camera;
    const rgb = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
    const ink = rgb(p.selectionColor), edge = rgb(p.skyColor);
    const at = L.spots.map((s) => worldToScreen(cam, s.at.x, s.at.y));
    let html = '';
    L.spots.forEach((s, i) => {
      if (!s.from) return;
      const f = worldToScreen(cam, s.from.x, s.from.y);
      html += `<line x1="${f.x}" y1="${f.y}" x2="${at[i].x}" y2="${at[i].y}" stroke="${ink}"/>`;
    });
    for (const a of at) html += `<circle cx="${a.x}" cy="${a.y}" r="${p.handleRadiusPx}" fill="${ink}" stroke="${edge}"/>`;
    svg.innerHTML = html;
  };
  /** A press on a handle starts dragging it, out of the gesture machine's way. */
  const grabHandle = (sx: number, sy: number): boolean => {
    const e = engine.current, sc = sceneRef.current, L = layoutSpots();
    if (!e || !sc || !L) return false;
    const cam = e.renderer.camera, w = screenToWorld(cam, sx, sy);
    const handle = handleAt(L.spots, w.x, w.y, cam.zoom, paramsRef.current);
    if (!handle) return false;
    const l = sc.layout[L.conn];
    const base = l && { handles: l.handles, ...(l.marker ? { marker: l.marker } : {}), ...(l.angle !== undefined ? { angle: l.angle } : {}) };
    handleDrag.current = { handle, conn: L.conn, id: sc.ids[L.conn], base, g: L.g, layout: base, scene: sc, from: { x: sx, y: sy }, armed: false };
    return true;
  };
  /** The connection redrawn with the handle under the cursor: a preview, nothing written. */
  const dragHandle = (sx: number, sy: number) => {
    const d = handleDrag.current, e = engine.current;
    if (!d || !e) return;
    if (!d.armed && Math.hypot(sx - d.from.x, sy - d.from.y) <= paramsRef.current.clickSlopPx) return;
    d.armed = true;
    d.layout = applyHandle(d.base, d.g, d.handle, screenToWorld(e.renderer.camera, sx, sy));
    // The layout stands in for the part's own (an override): the scene is not copied (plan 3c task 9).
    const visible = e.renderer.visible ?? NOTHING_SHOWN;
    if (d.split?.visible !== visible) d.split = layoutSplit(visible, d.conn);
    e.renderer.preview(d.scene, d.split, new Map([[d.conn, d.layout]]));
    redraw();
  };
  /** Released: the layout is written for this plan (one step); Escape or a refusal brings the old one back. */
  const dropHandle = (keep: boolean) => {
    const d = handleDrag.current;
    handleDrag.current = null;
    if (!d) return;
    // Released without moving: a click on what lies under the handle (the marker opens its connection's pop-up).
    if (!d.armed) {
      if (keep) {
        feed({ t: 'down', button: 0, sx: d.from.x, sy: d.from.y, ctrl: false, alt: false, shift: false, hit: hitAt(d.from.x, d.from.y) });
        feed({ t: 'up', button: 0, sx: d.from.x, sy: d.from.y });
      }
      return;
    }
    if (!keep || !d.layout || d.layout === d.base) { restoreScene(); return; }
    edit(layoutBuild(d.scene.plan.id, d.id, d.layout), restoreScene);
  };
  /** Whether a handle is pressed or dragged. */
  const held = () => handleDrag.current !== null;
  return { handlesSvg, held, drawHandles, grabHandle, dragHandle, dropHandle };
}

export type HandlesPart = ReturnType<typeof useLayoutHandles>;
