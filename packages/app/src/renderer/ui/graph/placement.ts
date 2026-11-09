import type { Id, Vec2 } from '@cirrus/core';
import { type Camera, type ConnectTarget, connectTarget, fitItem, type Intent, type Mode, otherPlans, type PlanScene, screenToWorld, worldToScreen } from '@cirrus/view';
import { useRef, useState } from 'react';
import { connectBuild, createBuild, importBuild, placeInPlanBuild, splitBuild } from '../../actions.ts';
import { BIB_WAITING } from './bibImport.ts';
import type { Engine, Graph } from './core.ts';

/** What a gesture without a held button will do once placed (spec 9.1). */
export type Placing =
  | { kind: 'newNode' }
  | { kind: 'exclude'; base: PlanScene; items: number[]; from: Vec2 }
  /** Drawing a connection from this node (spec 11.1). */
  | { kind: 'connect'; node: Id }
  /** Bringing in a node from a stub (spec 11.3), or into the lobby (spec 7). */
  | { kind: 'import'; node: Id; label?: string }
  /** Pasting the clip (spec 7). */
  | { kind: 'paste' }
  /** A node put down by hand in a plan its change of group reaches (spec 10); `extend`: the action it completes. */
  | { kind: 'repercussion'; node: Id; to: Id | null; extend: Id }
  /** Splitting an arm (spec 8.5): the far node's phantom near the bundle, then the centre's near the far node. */
  | { kind: 'split'; step: 1 | 2; connection: Id; node: Id; title: string; home: Camera; near?: Vec2 }
  /** A .bib's block of publications (plan 4c, D9): what it brings is the graph's `bib` (BibImport). */
  | { kind: 'bib' };
const MODE: Record<Placing['kind'], Mode> = {
  newNode: 'place', exclude: 'exclude', connect: 'connect', import: 'place', paste: 'paste', split: 'split', repercussion: 'place', bib: 'paste',
};

/**
 * The gestures without a held button (spec 9.1): what is placed (`placing`), its ghost following the cursor (a
 * connection: its line), a gesture waiting for another plan to be shown, and the click that puts it down (`place`).
 */
export function usePlacement(graph: Graph) {
  const { engine, sceneRef, paramsRef, stateRef, gestures, setEditor, redraw, notify, edit, indexOf, hitAt, restoreScene, moveCamera } = graph;
  const placing = useRef<Placing | null>(null);
  /** What follows the cursor: its label, and a .bib's block its outline (`box`, in pixels, centred on the cursor). */
  const [ghost, setGhost] = useState<{ x: number; y: number; text: string; box?: { w: number; h: number } } | null>(null);
  /** The straight line that follows the cursor while a connection is drawn (screen coordinates). */
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  /** A gesture to begin once another plan is shown (« ajouter au lobby », a repercussion's plans); `frame`: the item to frame. */
  const pendingPlace = useRef<{ plan: Id; what: Placing; text: string; at: { x: number; y: number }; frame?: Id } | null>(null);

  /** A gesture without a held button begins (spec 9.1): `text` follows the cursor, if any. */
  const startPlacing = (what: Placing, text: string | null, at: { x: number; y: number }) => {
    // Not while a .bib put down waits for its .bib: its ghost is shown (review of task 6, M4).
    if (graph.bib.bibWaiting()) { notify(BIB_WAITING); return; }
    placing.current = what;
    setGhost(text === null ? null : { x: at.x, y: at.y, text });
    gestures.current.start(MODE[what.kind]);
  };
  /** The line of a connection being drawn: from the border of the node's box to the cursor (spec 11.1). */
  const aimLine = (sx: number, sy: number) => {
    const e = engine.current, sc = sceneRef.current, what = placing.current;
    if (!e || !sc || what?.kind !== 'connect') return;
    const i = sc.byId.get(what.node);
    if (i === undefined) return;
    const it = sc.items[i], cam = e.renderer.camera, c = worldToScreen(cam, it.x, it.y);
    const dx = sx - c.x, dy = sy - c.y;
    const f = Math.min(1, Math.abs(dx) > 1e-6 ? (it.halfW * cam.zoom) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? (it.halfH * cam.zoom) / Math.abs(dy) : Infinity);
    setLine({ x1: c.x + dx * f, y1: c.y + dy * f, x2: sx, y2: sy });
  };
  /** The valid target under (sx, sy) while a connection is drawn, lit: a node's ring, or the connection (spec 11.1). */
  const aimTarget = (sx: number, sy: number): ConnectTarget | null => {
    const e = engine.current, sc = sceneRef.current, what = placing.current;
    if (!e || !sc || what?.kind !== 'connect') return null;
    const from = sc.byId.get(what.node);
    const cam = e.renderer.camera, w = screenToWorld(cam, sx, sy);
    const m = e.renderer.hitIndex?.markerAt(w.x, w.y, cam.zoom) ?? null;
    const vc = m === null ? undefined : e.renderer.visible?.connections[m];
    const t = from === undefined ? null : connectTarget(stateRef.current, sc, from, hitAt(sx, sy), vc && vc.conns.length === 1 ? vc.conns[0] : null);
    e.renderer.setDropTarget(t?.kind === 'node' ? t.item : null);
    e.renderer.setHover(t?.kind === 'connection' ? m : null);
    redraw();
    return t;
  };
  const endConnect = () => {
    const r = engine.current?.renderer;
    setLine(null);
    r?.setCoresShown(false);
    r?.setDropTarget(null);
    r?.setHover(null);
    redraw();
  };
  /** Begins the gesture waiting for this plan, framing what it concerns. */
  const startPending = () => {
    const pend = pendingPlace.current, e = engine.current, sc = sceneRef.current;
    if (!pend || !e || !sc || pend.plan !== sc.plan.id) return;
    pendingPlace.current = null;
    const f = pend.frame !== undefined ? sc.byId.get(pend.frame) : undefined;
    if (f !== undefined) moveCamera(fitItem(sc, f, e.renderer.camera, paramsRef.current));
    startPlacing(pend.what, pend.text, pend.at);
  };
  /** The cursor moved (spec 9.1): the ghost follows it; a connection being drawn aims at what is under it. */
  const followCursor = (sx: number, sy: number) => {
    setGhost((g) => (g ? { ...g, x: sx, y: sy } : g));
    if (placing.current?.kind === 'connect') { aimLine(sx, sy); aimTarget(sx, sy); }
  };
  /** The click that puts down what is placed, at `intent.at` in the scene `sc` (spec 9.1); a split's first step jumps to its second. */
  const place = (e: Engine, sc: PlanScene, intent: Extract<Intent, { t: 'place' }>) => {
    const what = placing.current;
    if (!what) return;
    const zoom = e.renderer.camera.zoom, p = paramsRef.current;
    const sp = worldToScreen(e.renderer.camera, intent.at.x, intent.at.y);
    if (what.kind === 'connect') {
      const t = aimTarget(sp.x, sp.y);
      // Elsewhere than on a valid target, the line keeps following the cursor.
      if (!t) { gestures.current.start('connect'); return; }
      placing.current = null;
      endConnect();
      const from = sc.byId.get(what.node);
      if (from === undefined) return;
      const s = stateRef.current;
      if (t.kind === 'node') {
        graph.questions.askWhere('Montrer aussi cette connexion dans les autres plans où ses deux nœuds sont présents ?',
          otherPlans(s, sc.plan.id, [what.node, sc.items[t.item].node]), (everywhere) => edit(connectBuild(sc, from, t, everywhere)));
      } else {
        graph.questions.askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
          otherPlans(s, sc.plan.id, [what.node], sc.ids[t.conn]), (everywhere) => edit(connectBuild(sc, from, t, everywhere)));
      }
      return;
    }
    if (what.kind === 'split') {
      if (what.step === 1) {
        // The view jumps to the far node, where the centre's phantom is put down; then it comes back (spec 8.5).
        const far = sc.byId.get(what.node);
        if (far === undefined) { placing.current = null; setGhost(null); return; }
        placing.current = { ...what, step: 2, near: intent.at };
        moveCamera({ ...e.renderer.camera, x: sc.items[far].x, y: sc.items[far].y });
        setGhost((g) => (g ? { ...g, text: 'centre de la connexion' } : g));
        gestures.current.start('split');
        return;
      }
      placing.current = null;
      setGhost(null);
      moveCamera({ ...what.home, widthPx: e.renderer.camera.widthPx, heightPx: e.renderer.camera.heightPx });
      edit(splitBuild(sc, what.connection, what.node, what.near!, intent.at, zoom, p));
      return;
    }
    placing.current = null;
    // A .bib's block (D9): its ghost stays where it is put down while its .bib are stored.
    if (what.kind === 'bib') { graph.bib.placeBib(intent.at, zoom); return; }
    setGhost(null);
    if (what.kind === 'import') edit(importBuild(sc, what.node, intent.at, zoom, p, what.label, indexOf(sc)));
    else if (what.kind === 'repercussion') {
      // Put down here, it takes its new group in this plan; the whole stays one undo step.
      void edit(placeInPlanBuild(sc, what.node, intent.at, what.to), undefined, what.extend).then(() => graph.repercussion.nextRepercussion());
    }
    else if (what.kind === 'paste') graph.copyPaste.pasteAt(sc, intent.at, zoom, p);
    else if (what.kind === 'newNode') {
      // The node is placed, then named in place (spec 12); the creation is written with its title, as one step. The
      // index is asked for once named: an action in between would have moved it on to another scene.
      const width = Math.max(140, (p.boxWidth - 2 * p.boxPadX) * p.textScale * zoom * p.factor ** Math.round(Math.log(1 / (zoom * p.textScale)) / Math.log(p.factor)));
      setEditor({ x: sp.x, y: sp.y, width, initial: '', done: (title) => { if (title) edit(createBuild(sc, title, intent.at, zoom, p, indexOf(sc))); } });
    } else if (what.kind === 'exclude') {
      // Out of its group, put down where clicked; entering the group under the cursor if it is another (spec 10).
      graph.repercussion.dropAsking(what.base, what.items, intent.at.x - what.from.x, intent.at.y - what.from.y, intent.at, true, restoreScene);
    }
  };
  /** What is placed given up (Escape, a right click, a lost focus: spec 9.1). */
  const cancelPlacing = (e: Engine) => {
    const what = placing.current;
    placing.current = null;
    setGhost(null);
    if (what?.kind === 'connect') endConnect();
    // A .bib's block (D9): nothing is made, its .bib no longer stored.
    if (what?.kind === 'bib') graph.bib.dropBib();
    // Escape leaves this plan as it is; the next one opens (spec 10).
    if (what?.kind === 'repercussion') graph.repercussion.nextRepercussion();
    if (what?.kind === 'split' && what.step === 2) moveCamera({ ...what.home, widthPx: e.renderer.camera.widthPx, heightPx: e.renderer.camera.heightPx });
  };
  return { placing, ghost, setGhost, line, pendingPlace, startPlacing, aimLine, startPending, followCursor, place, cancelPlacing };
}

export type PlacementPart = ReturnType<typeof usePlacement>;
