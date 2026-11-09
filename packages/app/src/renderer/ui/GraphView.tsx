import { type Action, type FileRef, type Id, phantomsOf, type State, type Vec2 } from '@cirrus/core';
import {
  bibBlock, blockHalves, type Bounds, type Camera, emptySelection, fitBounds, fitItem, GestureMachine, type Hit, type Input, inRectangle, type Intent, navigate,
  type NavInput,
  type PlanScene, type RenderParams, screenToWorld, type Selection, toggle, withOffsets, worldToScreen,
  dropEffects, dropTarget, type MenuAction, type MenuItem, menuFor, type ConnectTarget, connectTarget, otherPlans,
  type Clip, copyClip, isPinch, newlyPressed, renderPaused, partOf, PART_FAR,
  partEnds, type SceneIndex, type FontData, previewSplit, type PreviewSplit,
} from '@cirrus/view';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type BenchView, mark, runBench } from '../bench.ts';
import { createGl, type Gl } from '../gl/context.ts';
import { loadFont } from '../render/font.ts';
import { PlanRenderer } from '../render/PlanRenderer.ts';
import { HierarchyCorner, Tooltip } from './Overlays.tsx';
import type { EditSession, Result } from '../session.ts';
import {
  absentBuild, addMemberBuild, ALREADY_HERE, type Build, connectBuild, createBuild, importBuild,
  joinBuild, layoutBuild, lobbyConnectionBuild, pasteBuild, placeDroppedBuild, placeInPlanBuild, readableStep,
  renameBuild, scaleBuild, splitBuild,
} from '../actions.ts';
import type { BibFile } from '../../main/bib.ts';
import { ContextMenu, Ghost, TitleEditor } from './ContextMenu.tsx';
import { ConnectionPopup } from './ConnectionPopup.tsx';
import { AskDialog } from './Dialogs.tsx';
import { nodeOpenedBy } from './panels/Panels.tsx';
import type { Rect } from './panels/geometry.ts';
import { NODE_MIME } from '../files/annotations.ts';
import { backgroundNotice, carried, carriesFiles, droppedPaths, dropRoute, dropZone, type Refusal } from '../files/nodeFiles.ts';
import { loading } from '../files/read.ts';
import type { LatexRegistry } from '../latex/registry.ts';
import { bibImportBuild, bibNotice, bibStoreFailure, bibText, planBib, type PlannedBib, storeBibs } from '../publications/bib.ts';
import { type ImportDeps, publicationBuild } from '../publications/build.ts';
import { PublicationDialog } from './PublicationDialog.tsx';
import { type Engine, type Graph, NOTHING_SHOWN, plural } from './graph/core.ts';
import { useHover } from './graph/hover.ts';
import { ignored, measuring, replayPointer } from './graph/launch.ts';
import { useLayoutHandles } from './graph/layoutHandles.ts';
import { MODE, type PendingPlace, type Placing } from './graph/placement.ts';
import { useQuestions } from './graph/questions.ts';
import { useRepercussion } from './graph/repercussion.ts';
import { useScaleWheel } from './graph/scaleWheel.ts';
import { useScenes } from './graph/scenes.ts';

/** What App asks of the graph: files dropped at a point of it, as a drop of the user's (CIRRUS_IMPORT, captures). */
export interface GraphHandle { dropFilesAt(sx: number, sy: number, paths: string[], refused?: Refusal[]): Promise<void> }

const NAV_KEYS = new Set(['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** The camera a plan opens with: the launch option "x,y,zoom" for visual checks, else the plan framed. */
function initialCamera(scene: PlanScene, widthPx: number, heightPx: number, p: RenderParams, launchView?: string): Camera {
  const v = launchView?.split(',').map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) return { x: v[0], y: v[1], zoom: v[2], widthPx, heightPx };
  return fitBounds(scene.bounds, widthPx, heightPx, p);
}

const fr =(n: number) => n.toLocaleString('fr-FR');

/**
 * A .bib being imported (plan 4c, D9, task 6), from the ghost of its block to the action: what it plans, in its plan;
 * each title's lines (the block's rows); its entries' .bib stored meanwhile — `stored` so far, `refs` once all are,
 * `failed` why not —, which `stop` (Escape, another plan, a lost focus) ends; `settled` resolves once storing is over.
 * `put`: where a click put it down and at what zoom, the action waiting for every .bib stored — Escape no longer gives
 * it up, another plan does, and no gesture that puts something down begins meanwhile (review of task 6, M4). The
 * block's half sizes at step 0, for its outline (they scale with the step).
 */
interface BibImport {
  planned: PlannedBib; plan: Id; lines: number[]; halves: { halfW: number; halfH: number };
  stored: number; refs: FileRef[] | null; failed: string | null; stop: boolean; settled: Promise<void>; put: { at: Vec2; zoom: number } | null;
}
/** What a gesture begun while a .bib's import waits for its .bib is told (review of task 6, M4). */
const BIB_WAITING = 'Import du .bib en cours : attends que ses publications soient posées.';
/**
 * The import's marks for its measures (scripts/interface.mjs, scripts/mesures-annotations.mjs): the drop or the choice,
 * the file read by the main process, its entries read and planned (decoded, parsed, compared with the base), the ghost
 * shown, every .bib stored, the click, the action applied.
 */
const bibMark = (name: 'drop' | 'read' | 'planned' | 'ghost' | 'stored' | 'click' | 'placed') => {
  performance.clearMarks(`cirrus:bib:${name}`);
  performance.mark(`cirrus:bib:${name}`);
};

/**
 * Hosts the WebGL canvas and draws the active plan (spec 8). Navigation (spec 8.1, 9.1): wheel zoom around the cursor,
 * drag on the background, + − and arrows when the graph has the focus. Hover lights a connection, names stubs and
 * phantoms, and shows the groups under the cursor.
 */
export function GraphView(props: {
  /**
   * The state, changed in place by the edits: `rev` counts them, and what depends on the state follows `rev`, not the
   * state's identity (plan 3c). `action`: the last one applied, null at load.
   */
  state: State; rev: number; action: Action | null;
  plan: Id; params: RenderParams; onFirstFrame(): void;
  /**
   * Edits go through the session (written, undoable); their outcome is reported (toasts). `onLongNotice`: the
   * notification of a .bib's import (plan 4c, D9), which stays bibNoticeMs unless a click or Escape closes it.
   */
  session: EditSession | null; onResult(r: Result): void; onLongNotice(text: string): void;
  /** Shows a plan in its tab (« ajouter au lobby » opens the lobby, spec 7). */
  onOpenPlan(plan: Id): void;
  /**
   * A click without Ctrl on a node or a group, or on a far node's phantom (spec 8.5), opens that node's pop-up there, in
   * window coordinates (plan 4a, D7).
   */
  onOpenNode(node: Id, client: { x: number; y: number }): void;
  /** Any other click (background, connection, stub, absent or centre phantom, Ctrl+click) closes the loose pop-ups. */
  onClickAway(): void;
  /** Files dropped on a node or a group (plan 4a, task 4): their paths, and those refused already (App's importInto). */
  onDropFiles(node: Id, paths: string[], refused?: Refusal[]): Promise<void>;
  /**
   * The labels and keys of the base, for a connection's relation compiled in its pop-up (plan 4b: App's, null until
   * built); a link to a node clicked in it opens that node's pop-up beside it (`onNodeLink`, App's).
   */
  registry: LatexRegistry | null; onNodeLink(node: Id, near: Rect): void;
  ref?: Ref<GraphHandle>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const cameras = useRef(new Map<Id, Camera>());
  const sceneRef = useRef<PlanScene | null>(null);
  const paramsRef = useRef(props.params);
  const dirty = useRef(true);
  /** Wakes the drawing loop; set once the loop exists. */
  const wake = useRef<() => void>(() => {});
  /** Asks for a frame: the loop only runs while there is something to draw. */
  const redraw = () => { dirty.current = true; wake.current(); };
  const firstPending = useRef(true);
  /** The bench waits for frames of the drawing loop: each is called after a drawn frame until `until()` holds. */
  const frameWaiters = useRef<{ until(): boolean; done(f: { ms: number; end: number; preview: boolean }): void }[]>([]);
  const gestures = useRef(new GestureMachine(props.params));
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [rect, setRect] = useState<Bounds | null>(null);
  /**
   * A drag in progress: the moved items (top-most), the scene it started from, the world offset so far; its last
   * preview (whose storage the next one takes) and its split for the visible set drawn (plan 3c task 9).
   */
  const dragging = useRef<{
    items: number[]; base: PlanScene; dx: number; dy: number; sx: number; sy: number; alt: boolean; dirty: boolean; preview?: PlanScene; split?: PreviewSplit;
  } | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  /**
   * A press the graph took (no pop-up or field over it stopped its pointerdown), until its mousedown: the graph gives
   * itself the focus on the pointerdown, so the browser's own focus move on the mousedown that follows is cancelled —
   * it would take the focus from what the press opened, the title editor of a node put down (spec 12), which closed.
   */
  const graphPress = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: Hit; items: MenuItem[] } | null>(null);
  const [editor, setEditor] = useState<{ x: number; y: number; width: number; initial: string; done(title: string | null): void } | null>(null);
  /** What follows the cursor: its label, and a .bib's block its outline (`box`, in pixels, centred on the cursor). */
  const [ghost, setGhost] = useState<{ x: number; y: number; text: string; box?: { w: number; h: number } } | null>(null);
  const placing = useRef<Placing | null>(null);
  /** A .bib being imported (plan 4c, D9), from its ghost to its action; null otherwise. */
  const bib = useRef<BibImport | null>(null);
  /** The straight line that follows the cursor while a connection is drawn (screen coordinates). */
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [popup, setPopup] = useState<{ x: number; y: number; connections: Id[] } | null>(null);
  /**
   * « Importer une publication… » (plan 4c, task 5): the dialog, and where its node goes — the world point and the zoom
   * of the right click that opened it, in its plan. Another plan shown closes it (a result still to come dropped).
   */
  const [publication, setPublication] = useState<{ key: number; plan: Id; at: Vec2; zoom: number } | null>(null);
  useEffect(() => { setPublication((d) => (d !== null && d.plan !== props.plan ? null : d)); }, [props.plan]);
  /** A stub being dragged to a place of its own (spec 8.5). */
  const stubDrag = useRef<{ connection: Id; node: Id; title: string } | null>(null);
  /** What Ctrl+C copied (spec 7): it survives a change of plan, to be pasted elsewhere. */
  const clip = useRef<Clip | null>(null);
  /** A gesture to begin once another plan is shown (« ajouter au lobby », a repercussion's plans); `frame`: the item to frame. */
  const pendingPlace = useRef<PendingPlace | null>(null);
  /**
   * A gesture, a question, a repercussion or a .bib's import under way: Ctrl+Z and Ctrl+Y wait for it (I6 of the plan
   * 3b review), and so do a node dropped from a list and another .bib.
   */
  const busy = () => gestures.current.busy || dragging.current !== null || handles.held() || stubDrag.current !== null
    || repercussion.queued() || questions.asking() || bib.current !== null;
  /** A .bib put down, waiting for its .bib (M4): no gesture that puts something down begins, the menus do not open. */
  const bibWaiting = () => bib.current?.put != null;
  /** Why `what` waits: the .bib's import put down (Escape does not give it up), or a gesture in progress. */
  const busyReason = (what: string) => (bibWaiting() ? BIB_WAITING : `Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant ${what}.`);

  /**
   * Back to the scene of the state, after a preview given up or refused (Escape, a lost focus, a right click, a
   * refusal: Review Focus 5): the renderer's preview ended, its texels and instances written back from the state's
   * scene — the current plan's, never one kept from before a change of tab (I7 of the plan 3b review).
   */
  const restoreScene = () => {
    const e = engine.current, sc = sceneRef.current;
    if (e && sc) { if (e.renderer.held?.scene === sc) e.renderer.endPreview(); else e.renderer.setScene(sc); }
    redraw();
  };
  /**
   * The preview of the drag at this offset (plan 3c task 9): its scene at the cost of what moves (the previous
   * preview's storage taken again), its split made once for the visible set drawn.
   */
  const previewDrag = (r: PlanRenderer, d: NonNullable<typeof dragging.current>, dx: number, dy: number) => {
    const visible = r.visible ?? NOTHING_SHOWN;
    if (d.split?.visible !== visible) d.split = previewSplit(d.base, visible, d.items);
    d.preview = withOffsets(d.base, new Map(d.items.map((i) => [i, { x: dx, y: dy }])), paramsRef.current, d.preview);
    r.preview(d.preview, d.split);
  };
  /**
   * The visibility index of this scene when it is the state's scene the engine holds, by which what lies under a point
   * is found without reading the whole plan (a drop's target, a node put down: plan 3c task 9, I2 of the final review).
   */
  const indexOf = (scene: PlanScene): SceneIndex | undefined => {
    const held = engine.current?.renderer.held;
    return held?.scene === scene ? held.index : undefined;
  };
  /**
   * Runs an edit; a refusal is reported (toast) and `onRefused` restores what the preview had changed. `extend`: the
   * earlier action it completes, as one undo step (spec 10).
   */
  const edit = (build: Build, onRefused?: () => void, extend?: Id): Promise<Result | null> => {
    const session = sessionRef.current;
    if (!build || !session) { onRefused?.(); return Promise.resolve(null); }
    return session.run(build, extend ? { extend } : {}).then((r) => {
      if (!r.ok) onRefused?.();
      onResultRef.current(r);
      return r;
    });
  };
  // Handlers registered once (wheel, render loop) read the current state through this ref, never a stale closure.
  const stateRef = useRef(props.state);
  stateRef.current = props.state;
  const sessionRef = useRef(props.session);
  sessionRef.current = props.session;
  const onResultRef = useRef(props.onResult);
  onResultRef.current = props.onResult;
  const onOpenPlanRef = useRef(props.onOpenPlan);
  onOpenPlanRef.current = props.onOpenPlan;
  // The clicks replayed for captures go through the handlers of the first render: the pop-ups' callbacks are read here.
  const panelsRef = useRef({ open: props.onOpenNode, away: props.onClickAway });
  panelsRef.current = { open: props.onOpenNode, away: props.onClickAway };
  /** A notice in a toast, not an edit's outcome. */
  const notify = (message: string) => onResultRef.current({ ok: false, message });
  const onLongNoticeRef = useRef(props.onLongNotice);
  onLongNoticeRef.current = props.onLongNotice;
  const [ready, setReady] = useState(false);
  /** Why the engine could not start (no WebGL 2, a font file absent or unreadable…): shown in place of the graph. */
  const [failure, setFailure] = useState<string | null>(null);
  paramsRef.current = props.params;

  const moveCamera = (next: Camera) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    e.renderer.setCamera(next);
    cameras.current.set(sc.plan.id, next);
    redraw();
    // Wheel and arrows stay active while a connection is drawn: its line follows the node; a .bib's block, its outline.
    if (placing.current?.kind === 'connect' && lastPointer.current) aimLine(lastPointer.current.x, lastPointer.current.y);
    if (placing.current?.kind === 'bib' || bibWaiting()) showBib();
  };
  const nav = (input: NavInput) => {
    const e = engine.current;
    if (e) moveCamera(navigate(e.renderer.camera, input, paramsRef.current));
  };
  const local = (ev: { clientX: number; clientY: number }) => {
    const r = root.current!.getBoundingClientRect();
    return { sx: ev.clientX - r.left, sy: ev.clientY - r.top };
  };
  const hitAt = (sx: number, sy: number): Hit => {
    const e = engine.current, hits = e?.renderer.hitIndex;
    if (!e || !hits) return { kind: 'background' };
    const w = screenToWorld(e.renderer.camera, sx, sy);
    return hits.hit(w.x, w.y, e.renderer.camera.zoom);
  };
  const feed = (input: Input) => {
    const e = engine.current;
    if (!e) return;
    for (const intent of gestures.current.feed(input, e.renderer.camera)) handle(intent);
  };

  /** The view as its parts see it (graph/core.ts): the parts, made just below, are read once a handler runs. */
  const graph: Graph = {
    root, engine, sceneRef, paramsRef, stateRef, sessionRef, selectionRef, gestures, onOpenPlan: props.onOpenPlan, redraw, notify, edit, indexOf, hitAt,
    restoreScene, feed,
    get scenes() { return scenes; }, get questions() { return questions; }, get repercussion() { return repercussion; }, get handles() { return handles; },
    // Still GraphView's: what is placed, and the gesture waiting for another plan.
    get placement() { return { placing, pendingPlace, startPending }; },
  };
  const scenes = useScenes(graph, props, ready);
  const scene = scenes.scene;
  const { tip, chain, hover, clearHover } = useHover(graph);
  const questions = useQuestions(graph);
  const repercussion = useRepercussion(graph);
  const handles = useLayoutHandles(graph);
  const { settleWheel, wheelScale } = useScaleWheel(graph);

  /** A gesture without a held button begins (spec 9.1): `text` follows the cursor, if any. */
  const startPlacing = (what: Placing, text: string | null, at: { x: number; y: number }) => {
    // Not while a .bib put down waits for its .bib: its ghost is shown (review of task 6, M4).
    if (bibWaiting()) { notify(BIB_WAITING); return; }
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
  /** The items of the selection, as indices of this scene. */
  const selectedItems = (sc: PlanScene) => [...selectionRef.current.items].flatMap((id) => { const i = sc.byId.get(id); return i === undefined ? [] : [i]; });
  /** Ctrl+C (spec 7): the selection, or what was clicked, with this plan and zoom. */
  const copy = (sc: PlanScene, items: number[]) => {
    const c = copyClip(stateRef.current, sc, items, engine.current?.renderer.camera.zoom ?? 1);
    if (!c) return;
    clip.current = c;
    notify(`${c.nodes.length} ${plural(c.nodes.length, 'nœud copié', 'nœuds copiés')}.`);
  };
  /** Ctrl+V (spec 7): the clip follows the cursor until a click puts it down. */
  const startPaste = (at: { x: number; y: number }) => {
    const c = clip.current;
    if (!c) { notify('Rien à coller : copiez d’abord une sélection (Ctrl+C).'); return; }
    startPlacing({ kind: 'paste' }, `Coller ${c.nodes.length} ${plural(c.nodes.length, 'nœud', 'nœuds')}`, at);
  };
  /** What a .bib's ghost says: its publications, and its .bib being stored, if they are. */
  const bibLabel = (b: BibImport) => {
    const n = b.planned.items.length, what = `Importer ${n === 1 ? 'une publication' : `${fr(n)} publications`}`;
    if (b.refs !== null) return what;
    return b.put ? `Enregistrement des fichiers .bib : ${fr(b.stored)} / ${fr(n)}…` : `${what} · fichiers .bib : ${fr(b.stored)} / ${fr(n)}`;
  };
  /**
   * The ghost of the .bib's block (D9, the paste's ghost of plan 3b): its label, and its outline as the block would be
   * put down at the zoom shown — at the readable step, so about the same size on screen at any zoom —, at `at` or where
   * it was. Put down and waiting for its .bib: where it was put down, at the step of then, whatever the view does.
   */
  const showBib = (at?: { x: number; y: number }) => {
    const b = bib.current, e = engine.current;
    if (!b || !e) return;
    const p = paramsRef.current, cam = e.renderer.camera, s = p.factor ** readableStep(b.put?.zoom ?? cam.zoom, p);
    const box = { w: 2 * b.halves.halfW * s * cam.zoom, h: 2 * b.halves.halfH * s * cam.zoom };
    const there = b.put ? worldToScreen(cam, b.put.at.x, b.put.at.y) : at;
    setGhost((g) => ({ x: there?.x ?? g?.x ?? 0, y: there?.y ?? g?.y ?? 0, text: bibLabel(b), box }));
  };
  /** The import given up (Escape, another plan, a lost focus, a refusal): its .bib no longer stored; what is stored stays. */
  const dropBib = () => {
    const b = bib.current;
    if (!b) return;
    b.stop = true;
    bib.current = null;
  };
  /**
   * A .bib the main process read (D9: dropped on the background, or chosen), for the plan `plan` shown then: decoded,
   * planned against the base (planBib), its block following the cursor from `at` until a click puts it down (placeBib),
   * its entries' .bib stored meanwhile, by batches (storeBibs). Nothing to import: the notification says why, and
   * nothing follows the cursor. Another plan shown or a gesture begun while it was read: given up, said.
   */
  const startBib = (file: BibFile | null, at: { x: number; y: number }, plan: Id) => {
    bibMark('read');
    const e = engine.current, sc = sceneRef.current;
    if (file === null || !e || !sc) return;
    if ('refused' in file) { notify(file.refused); return; }
    if (sc.plan.id !== plan || busy()) { notify(`Le plan a changé, ou un geste a commencé, pendant la lecture du fichier .bib : rien n’est importé.`); return; }
    const text = bibText(file);
    if ('refused' in text) { notify(text.refused); return; }
    const p = paramsRef.current, planned = planBib(stateRef.current, file.name, text.text, p.publicationMaxAuthors);
    bibMark('planned');
    if (planned.items.length === 0) { onLongNoticeRef.current(bibNotice(planned, 0, p.bibNoticeLines)); return; }
    const measure = scenes.measureOf(p);
    const lines = planned.items.map((x) => measure(x.plan.title));
    const b: BibImport = {
      planned, plan, lines, halves: blockHalves(bibBlock(lines.length, 0, p, lines), 0, p, lines),
      stored: 0, refs: null, failed: null, stop: false, settled: Promise.resolve(), put: null,
    };
    bib.current = b;
    // Only the block's ghost is redrawn: no other gesture begins while it follows the cursor or waits (M4).
    const shown = () => bib.current === b && (placing.current?.kind === 'bib' || b.put !== null);
    // Counted among what the views load (viewsSettled): a capture shows the ghost once its .bib are stored (plan 4c,
    // task 7, « bloc-bib »), never halfway.
    b.settled = loading(storeBibs(planned.items.map((x) => x.plan.bib!), (batch) => window.cirrus.storeTexts(batch), (n) => {
      b.stored = n;
      if (shown()) showBib();
    }, () => b.stop).then((refs) => {
      b.refs = refs;
      if (refs) bibMark('stored');
      if (shown() && b.put === null) showBib();
    }, (err: unknown) => {
      console.error('Enregistrement des fichiers .bib :', err);
      b.failed = bibStoreFailure(err);
      // Still following the cursor: the gesture is given up, said.
      if (bib.current === b && b.put === null) { feed({ t: 'cancel' }); notify(b.failed); }
    }));
    startPlacing({ kind: 'bib' }, bibLabel(b), at);
    showBib(at);
    bibMark('ghost');
  };
  /**
   * The block put down at `at` (D9), at the zoom of the click, once its .bib are all stored (the ghost stays there and
   * says so while they are not): one action, « Importer <n> publications », then the notification of the import
   * (bibNotice), which stays bibNoticeMs. Another plan shown meanwhile gives it up (the scene's effect); the store
   * failed: nothing is made, said.
   */
  const placeBib = (at: Vec2, zoom: number) => {
    const b = bib.current;
    if (!b) return;
    bibMark('click');
    b.put = { at, zoom };
    if (b.refs === null) showBib();
    void b.settled.then(async () => {
      if (bib.current !== b) return;
      bib.current = null;
      setGhost(null);
      const sc = sceneRef.current;
      if (b.failed || b.refs === null) { notify(b.failed ?? 'Les fichiers .bib n’ont pas été enregistrés : rien n’est importé.'); return; }
      if (!sc || sc.plan.id !== b.plan) { notify('Le plan de l’import n’est plus affiché : rien n’est importé.'); return; }
      const p = paramsRef.current, refs = b.refs;
      const r = await edit(bibImportBuild(b.planned.items.map((x, i) => ({ plan: x.plan, file: refs[i] })), sc, at, zoom, p, b.lines, indexOf(sc)));
      bibMark('placed');
      if (r?.ok) onLongNoticeRef.current(bibNotice(b.planned, b.planned.items.length, p.bibNoticeLines));
    });
  };
  /** A .bib dropped on the graph's background at (sx, sy) (D9): read by the main process, then its block follows the cursor. */
  const dropBibFile = async (path: string, at: { x: number; y: number }) => {
    const plan = sceneRef.current?.plan.id;
    if (!plan) return;
    if (busy()) { notify(busyReason('d’importer un fichier .bib')); return; }
    bibMark('drop');
    let file: BibFile;
    try {
      file = await window.cirrus.readBib(path);
    } catch (e) {
      console.error('Lecture du fichier .bib :', e);
      notify('Le fichier .bib n’a pas pu être lu : rien n’est importé.');
      return;
    }
    startBib(file, at, plan);
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
  /** The pop-up of a connection (or of the connections a line stands for), next to the click (spec 8.5). */
  const openPopup = (connections: Id[], sx: number, sy: number) => {
    const r = root.current!.getBoundingClientRect();
    setPopup({ connections, x: Math.max(8, Math.min(sx + 12, r.width - 332)), y: Math.max(8, Math.min(sy + 12, r.height - 340)) });
  };

  // One WebGL context for the window's lifetime; the font is read before the first scene (its boxes are measured with it).
  useEffect(() => {
    let cancelled = false, raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.current!.appendChild(canvas);
    let g: Gl | null = null;
    void (async () => {
      // The engine's start: no WebGL 2, a font file absent or unreadable, a shader that does not compile. A failure is
      // shown in place of the graph, and the start goes on (the first frame is announced: captures, snapshots).
      let renderer: PlanRenderer | undefined, font: FontData, atlas: ImageBitmap | undefined;
      try {
        g = createGl(canvas);
        const loaded = await loadFont((url) => fetch(url), (b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
        ({ font, atlas } = loaded);
        if (cancelled) { atlas.close(); return; }
        g.resize();
        renderer = new PlanRenderer(g, props.params, font, atlas);
        console.log(`Shaders préchauffés en ${renderer.warmUp().toFixed(0)} ms.`);
      } catch (e) {
        // What was made is let go: the renderer (its textures, its atlas), else the atlas alone.
        if (renderer) renderer.destroy(); else atlas?.close();
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        console.error(`Moteur de rendu indisponible : ${message}`);
        g?.destroy();
        g = null;
        canvas.remove();
        setFailure(message);
        props.onFirstFrame();
        return;
      }
      // The host resizes with the window and without it (the settings panel opening): a resized canvas is cleared,
      // so it is drawn again even if its CSS size (the camera's) did not change (C2).
      resizeObserver = new ResizeObserver(() => { g?.resize(); redraw(); });
      resizeObserver.observe(host.current!);
      for (const layer of (window.cirrus.launch.hide ?? '').split(',').filter(Boolean)) renderer.hidden.add(layer);
      renderer.onUpdate = () => { redraw(); };
      engine.current = { gl: g, renderer, font };
      mark('engineReady');
      setReady(true);
      let launchHover = window.cirrus.launch.hover?.split(',').map(Number);
      // Visual checks: CIRRUS_POINTER="down 700 370 ctrl; move 900 500; up 900 500" replays pointer events; phases
      // separated by "|" are replayed a few frames apart (a menu opened, then chosen: "click .context-menu button").
      const launchPhases = (window.cirrus.launch.pointer ?? '').split('|').map((x) => x.trim()).filter(Boolean);
      let settle = 0;
      // Frames are drawn on demand: the loop waits for the screen only while something is to be drawn, and not at all
      // while the window is hidden or, by default, without the focus (battery). The first frame is drawn regardless,
      // and every frame in bench and capture modes (measuring()). One exception must not stop the drawing for good (C1
      // of the plan 3 review): it is reported.
      const unpaused = measuring();
      let stopped = false, scheduled = false;
      const paused = () => !unpaused && !firstPending.current && renderPaused({ hidden: document.hidden, focused: document.hasFocus() }, paramsRef.current);
      const schedule = () => {
        if (scheduled || stopped || paused()) return;
        scheduled = true;
        raf = requestAnimationFrame(loop);
      };
      const loop = () => {
        scheduled = false;
        if (stopped || paused()) return;
        const t0 = performance.now();
        let drawn: { preview: boolean } | null = null;
        try { drawn = step(); } catch (err) { console.error('Erreur de rendu :', err); }
        if (drawn && frameWaiters.current.length > 0) {
          const end = performance.now(), f = { ms: end - t0, end, preview: drawn.preview };
          frameWaiters.current = frameWaiters.current.filter((w) => { if (!w.until()) return true; w.done(f); return false; });
        }
        if (dirty.current || dragging.current?.dirty) schedule();
      };
      wake.current = schedule;
      /** One turn of the loop; returns whether it drew a frame, and whether that frame was a drag preview. */
      const step = (): { preview: boolean } | null => {
        const e = engine.current;
        let drawn: { preview: boolean } | null = null;
        if (e && sceneRef.current) {
          const cam = e.renderer.camera;
          if (cam.widthPx !== e.gl.width || cam.heightPx !== e.gl.height) {
            moveCamera(navigate(cam, { t: 'resize', widthPx: e.gl.width, heightPx: e.gl.height }, paramsRef.current));
          }
          // A drag in progress: its preview is drawn at most once per frame.
          const d = dragging.current;
          const preview = d !== null && d.dirty;
          if (d && d.dirty) {
            d.dirty = false;
            previewDrag(e.renderer, d, d.dx, d.dy);
            // The group that would receive the drop lights up (spec 10), only if the drop would enter it; found by the
            // state's index when it is the drag's scene's (what is under the point only, not the plan: plan 3c task 9).
            const at = screenToWorld(e.renderer.camera, d.sx, d.sy);
            const t = dropTarget(d.base, at, d.items, e.renderer.camera.zoom, paramsRef.current, indexOf(d.base));
            e.renderer.setDropTarget(t !== null && dropEffects(d.base, d.items, t, d.alt).some((f) => f.enter === t) ? t : null);
            dirty.current = true;
          }
          if (dirty.current) {
            dirty.current = false;
            const rebuilt = e.renderer.renderFrame();
            drawn = { preview };
            handles.drawHandles();
            // What is under a resting pointer changes with the drawn set (I1 of the review): look again — not while a
            // handle is dragged (each of its frames is patched in place; the hover comes back once it is released).
            if (rebuilt && lastPointer.current && !gestures.current.busy && !handles.held()) hover(lastPointer.current.x, lastPointer.current.y);
            if (firstPending.current) {
              mark('firstFrame');
              // Visual checks: a simulated hover is drawn before the capture is taken.
              if (launchHover && launchHover.length === 2) { hover(launchHover[0], launchHover[1]); launchHover = undefined; }
              else if (settle > 0) { settle--; dirty.current = true; }
              else if (launchPhases.length > 0) { replayPointer(graph, launchPhases.shift()!); settle = 5; dirty.current = true; }
              else {
                firstPending.current = false;
                props.onFirstFrame();
                const label = window.cirrus.launch.bench;
                if (label) {
                  // The bench drives the camera along its path itself, the regular loop waiting; the edit pass then
                  // hands the drawing back to the loop, whose frames it awaits.
                  stopped = true;
                  const view: BenchView = {
                    gl: e.gl, renderer: e.renderer, params: () => paramsRef.current, scene: () => sceneRef.current!, moveCamera,
                    feed: (input) => { feed(input); redraw(); },
                    edit: (build) => edit(build),
                    undo: () => sessionRef.current!.undo(),
                    openPlan: (plan) => onOpenPlanRef.current(plan),
                    resume: () => { stopped = false; redraw(); },
                    drawn: (until) => new Promise((done) => { frameWaiters.current.push({ until, done }); }),
                  };
                  void runBench(view, label).then((run) => window.cirrus.benchDone(run));
                }
              }
            }
          }
        }
        return drawn;
      };
      schedule();
    })();
    return () => {
      cancelled = true;
      wake.current = () => {};
      resizeObserver?.disconnect();
      cancelAnimationFrame(raf);
      engine.current?.renderer.destroy();
      engine.current = null;
      g?.destroy();
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    const e = engine.current;
    if (!e || !ready) return;
    e.renderer.setParams(props.params);
    redraw();
  }, [ready, props.params]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !scene) return;
    // Another plan: the gesture in progress, the selection, a question and a dragged handle do not follow; the scale
    // gesture waiting for its pause is written for its plan (I7 of the review).
    if (sceneRef.current && sceneRef.current.plan.id !== scene.plan.id) {
      repercussion.planShown(scene.plan.id);
      settleWheel();
      handles.dropHandle(false);
      questions.setQuestion(null);
      feed({ t: 'cancel' });
      setSelection(emptySelection());
      setPopup(null);
      // A .bib put down and waiting for its .bib: given up, its ghost gone with its plan (review of task 6, M4).
      if (bibWaiting()) {
        dropBib();
        setGhost(null);
        notify('Le plan de l’import n’est plus affiché : rien n’est importé.');
      }
    }
    sceneRef.current = scene;
    scenes.showScene(e.renderer, scene);
    clearHover();
    const { width, height } = e.gl;
    const known = cameras.current.get(scene.plan.id);
    moveCamera(known ? { ...known, widthPx: width, heightPx: height } : initialCamera(scene, width, height, props.params, window.cirrus.launch.view));
    startPending();
  }, [scene]);

  // Wheel: a native, non-passive listener (React's is passive and could not keep the page from scrolling).
  useEffect(() => {
    const el = root.current!;
    const onWheel = (ev: WheelEvent) => {
      // A pop-up or a question scrolls its own content.
      if (ignored(ev) || (ev.target as Element).closest?.('.popup, .ask')) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      // A touchpad pinch comes as Ctrl+wheel with fractional deltas: it zooms the view (I13 of the review).
      if (ev.ctrlKey && !isPinch(ev.deltaY)) { wheelScale(sx, sy, ev.deltaY); return; }
      nav({ t: 'wheel', sx, sy, deltaY: ev.deltaY, ctrl: false });
      hover(sx, sy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * Files dropped at (sx, sy) (plan 4a, task 4): the node or the group under the point receives them — the node whose
   * pop-up a click there would open (nodeOpenedBy: a far node's phantom stands for it); a .bib alone on the background
   * is imported (plan 4c, D9); elsewhere, a notice (dropRoute).
   */
  const dropFilesAt = (sx: number, sy: number, paths: string[], refused: Refusal[] = []): Promise<void> => {
    const h = hitAt(sx, sy), i = h.kind === 'item' ? sceneRef.current?.byId.get(h.id) : undefined;
    const under = nodeOpenedBy(i === undefined ? undefined : sceneRef.current!.items[i], false);
    const route = dropRoute('graph', under, 'files', refused.length === 0 ? paths : undefined);
    if (route.to === 'node') return props.onDropFiles(route.node, paths, refused);
    if (route.to === 'bib') return dropBibFile(paths[0], { x: sx, y: sy });
    notify(backgroundNotice([...paths, ...refused.map((r) => r.name)]));
    return Promise.resolve();
  };
  useImperativeHandle(props.ref, () => ({ dropFilesAt }));
  /** Files the graph takes: not on what floats over it and refuses them (dropZone). */
  const takesFiles = (ev: React.DragEvent) => carriesFiles(ev) && dropZone(ev.target) === 'graph';
  /** A node dragged out of a list of annotations that the graph takes (plan 4c, task 3): its own route, never files (dropRoute). */
  const takesNode = (ev: React.DragEvent) => carried(ev) === 'node' && dropRoute(dropZone(ev.target), null, 'node').to === 'place';
  /** What a node dragged over the graph would enter, lit (spec 10: the group under the cursor lights up); null: none. */
  const lit = useRef<number | null>(null);
  const lightHost = (pt: { sx: number; sy: number } | null) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc || dragging.current) return;
    const cam = e.renderer.camera;
    const t = pt === null ? null : dropTarget(sc, screenToWorld(cam, pt.sx, pt.sy), [], cam.zoom, paramsRef.current, indexOf(sc));
    if (t === lit.current) return;
    lit.current = t;
    e.renderer.setDropTarget(t);
    redraw();
  };
  /**
   * A node dragged out of a list of annotations (NODE_MIME), let go at (sx, sy) (plan 4c, D4): placed in this plan where
   * it is let go, at the readable step, entering the group or the simple node under the point (placeDroppedBuild), with
   * the « partout ou ici seulement » question when that inclusion exists elsewhere or may (spec 10: askRepercussion).
   * Already here: said, and the view framed on it. Not while a gesture, a question or a repercussion is under way.
   */
  const dropNodeAt = (sx: number, sy: number, node: Id) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    if (busy()) { notify(busyReason('de poser ce nœud')); return; }
    const p = paramsRef.current, cam = e.renderer.camera, at = screenToWorld(cam, sx, sy), index = indexOf(sc);
    const here = sc.byId.get(node);
    if (here !== undefined) {
      notify(ALREADY_HERE);
      moveCamera(fitItem(sc, here, cam, p));
      return;
    }
    const build = placeDroppedBuild(sc, node, at, cam.zoom, p, index);
    const host = dropTarget(sc, at, [], cam.zoom, p, index);
    if (host === null) void edit(build);
    else repercussion.askRepercussion(sc.plan.id, [{ node, from: null, to: sc.items[host].id }], build, () => {});
  };
  /** The object a hit designates, for the selection: an item, or a connection (by its stub too). */
  const targetOf = (h: Hit): { kind: 'item' | 'connection'; id: Id } | null => {
    if (h.kind === 'item') return { kind: 'item', id: h.id };
    if (h.kind === 'connection') return { kind: 'connection', id: h.ids[0] };
    if (h.kind === 'stub') return { kind: 'connection', id: h.connection };
    return null;
  };

  const handle = (intent: Intent) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    switch (intent.t) {
      case 'pan':
        nav({ t: 'drag', dxPx: intent.dxPx, dyPx: intent.dyPx });
        break;
      case 'click': {
        // Click selects; Ctrl+click adds or removes; a click on the background lets go (spec 9.1).
        // By ids, not indices: a frame may have been rebuilt between the press and the release (I9 of the review).
        const target = targetOf(intent.hit);
        const i = intent.hit.kind === 'item' ? sc.byId.get(intent.hit.id) : undefined, it = i === undefined ? undefined : sc.items[i];
        // A node's pop-up opens (plan 4a, spec 8.5: a far node's phantom opens that node's), or the loose ones close.
        const opened = nodeOpenedBy(it, intent.ctrl);
        if (opened === null) panelsRef.current.away();
        if (intent.ctrl) { if (target) setSelection((sel) => toggle(sel, target)); break; }
        setSelection(target ? toggle(emptySelection(), target) : emptySelection());
        // A stub or an absent phantom brings its node in (spec 11.3); a connection or a centre phantom opens its pop-up (spec 8.5).
        const here = { x: intent.sx, y: intent.sy };
        if (intent.hit.kind === 'stub') startPlacing({ kind: 'import', node: intent.hit.node }, intent.hit.title, here);
        else if (intent.hit.kind === 'connection') openPopup(intent.hit.ids, intent.sx, intent.sy);
        else if (it?.phantom === 'absent') startPlacing({ kind: 'import', node: it.node }, it.title, here);
        else if (it?.phantom === 'center') openPopup([it.connection!], intent.sx, intent.sy);
        else if (opened !== null) {
          const r = root.current!.getBoundingClientRect();
          panelsRef.current.open(opened, { x: r.left + intent.sx, y: r.top + intent.sy });
        }
        break;
      }
      case 'context': {
        // No menu while a .bib put down waits for its .bib: its choices put something down (review of task 6, M4).
        if (bibWaiting()) { notify(BIB_WAITING); break; }
        // A right click outside the selection lets it go (spec 9.1), then opens the menu of what is under it.
        const target = targetOf(intent.hit);
        let sel = selectionRef.current;
        if (!target || !(target.kind === 'item' ? sel.items : sel.connections).has(target.id)) { sel = emptySelection(); setSelection(sel); }
        // On the background of an open group: that group's menu first (spec 9.1, I11 of the review).
        const w = screenToWorld(e.renderer.camera, intent.sx, intent.sy);
        const under = intent.hit.kind === 'background' ? e.renderer.hitIndex?.openGroupsAt(w.x, w.y, e.renderer.camera.zoom)[0] : undefined;
        const items = menuFor(stateRef.current, sc, intent.hit, sel, clip.current !== null, under === undefined ? undefined : sc.items[under].id);
        const hit: Hit = under === undefined ? intent.hit : { kind: 'item', item: under, id: sc.items[under].id };
        if (items.length > 0) setMenu({ x: intent.sx, y: intent.sy, hit, items });
        break;
      }
      case 'rectMove':
        setRect(intent.rect);
        break;
      case 'rectEnd': {
        // Ctrl+drag adds what the rectangle holds (spec 9.1, 9.3).
        const ids = inRectangle(sc, intent.rect, e.renderer.camera.zoom, paramsRef.current);
        setSelection((sel) => ({ items: new Set([...sel.items, ...ids]), connections: sel.connections }));
        setRect(null);
        break;
      }
      case 'rectCancel':
        setRect(null);
        break;
      case 'dragStart': {
        // A stub dragged gets a place of its own: an absent phantom (spec 8.5); not while a .bib's ghost waits (M4).
        if (intent.hit.kind === 'stub') {
          if (bibWaiting()) { notify(BIB_WAITING); break; }
          stubDrag.current = { connection: intent.hit.connection, node: intent.hit.node, title: intent.hit.title };
          break;
        }
        // An element moves with the whole selection if it belongs to it (spec 9.1); a group with all it contains.
        if (intent.hit.kind !== 'item') break;
        const id = intent.hit.id, pressed = sc.byId.get(id);
        if (pressed === undefined) break;
        const sel = selectionRef.current;
        const chosen = sel.items.has(id) ? [...sel.items].flatMap((x) => { const i = sc.byId.get(x); return i === undefined ? [] : [i]; }) : [pressed];
        const set = new Set(chosen);
        const top = chosen.filter((i) => { for (let a = sc.items[i].parent; a >= 0; a = sc.items[a].parent) if (set.has(a)) return false; return true; });
        dragging.current = { items: top, base: sc, dx: 0, dy: 0, sx: 0, sy: 0, alt: intent.alt, dirty: false };
        break;
      }
      case 'dragMove': {
        const sd = stubDrag.current;
        if (sd) { setGhost({ x: intent.sx, y: intent.sy, text: sd.title }); break; }
        const d = dragging.current;
        if (!d) break;
        d.dx = intent.dx;
        d.dy = intent.dy;
        d.sx = intent.sx;
        d.sy = intent.sy;
        d.dirty = true;
        break;
      }
      case 'dragEnd': {
        const sd = stubDrag.current;
        if (sd) {
          stubDrag.current = null;
          setGhost(null);
          edit(absentBuild(sc, sd.connection, sd.node, intent.at));
          break;
        }
        const d = dragging.current;
        dragging.current = null;
        if (!d) break;
        e.renderer.setDropTarget(null);
        // The preview stays exactly where it was dropped while a question may be asked.
        previewDrag(e.renderer, d, intent.dx, intent.dy);
        // One action for the whole drop (spec 6.4): the moves, then the groups left and entered; refused or given up,
        // back to where it was; written, the scene follows the state.
        repercussion.dropAsking(d.base, d.items, intent.dx, intent.dy, intent.at, intent.alt, restoreScene);
        break;
      }
      case 'placeMove':
        setGhost((g) => (g ? { ...g, x: intent.sx, y: intent.sy } : g));
        if (placing.current?.kind === 'connect') { aimLine(intent.sx, intent.sy); aimTarget(intent.sx, intent.sy); }
        break;
      case 'place': {
        const what = placing.current;
        if (!what) break;
        const zoom = e.renderer.camera.zoom, p = paramsRef.current;
        const sp = worldToScreen(e.renderer.camera, intent.at.x, intent.at.y);
        if (what.kind === 'connect') {
          const t = aimTarget(sp.x, sp.y);
          // Elsewhere than on a valid target, the line keeps following the cursor.
          if (!t) { gestures.current.start('connect'); break; }
          placing.current = null;
          endConnect();
          const from = sc.byId.get(what.node);
          if (from === undefined) break;
          const s = stateRef.current;
          if (t.kind === 'node') {
            questions.askWhere('Montrer aussi cette connexion dans les autres plans où ses deux nœuds sont présents ?',
              otherPlans(s, sc.plan.id, [what.node, sc.items[t.item].node]), (everywhere) => edit(connectBuild(sc, from, t, everywhere)));
          } else {
            questions.askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
              otherPlans(s, sc.plan.id, [what.node], sc.ids[t.conn]), (everywhere) => edit(connectBuild(sc, from, t, everywhere)));
          }
          break;
        }
        if (what.kind === 'split') {
          if (what.step === 1) {
            // The view jumps to the far node, where the centre's phantom is put down; then it comes back (spec 8.5).
            const far = sc.byId.get(what.node);
            if (far === undefined) { placing.current = null; setGhost(null); break; }
            placing.current = { ...what, step: 2, near: intent.at };
            moveCamera({ ...e.renderer.camera, x: sc.items[far].x, y: sc.items[far].y });
            setGhost((g) => (g ? { ...g, text: 'centre de la connexion' } : g));
            gestures.current.start('split');
            break;
          }
          placing.current = null;
          setGhost(null);
          moveCamera({ ...what.home, widthPx: e.renderer.camera.widthPx, heightPx: e.renderer.camera.heightPx });
          edit(splitBuild(sc, what.connection, what.node, what.near!, intent.at, zoom, p));
          break;
        }
        placing.current = null;
        // A .bib's block (D9): its ghost stays where it is put down while its .bib are stored.
        if (what.kind === 'bib') { placeBib(intent.at, zoom); break; }
        setGhost(null);
        if (what.kind === 'import') edit(importBuild(sc, what.node, intent.at, zoom, p, what.label, indexOf(sc)));
        else if (what.kind === 'repercussion') {
          // Put down here, it takes its new group in this plan; the whole stays one undo step.
          void edit(placeInPlanBuild(sc, what.node, intent.at, what.to), undefined, what.extend).then(() => repercussion.nextRepercussion());
        }
        else if (what.kind === 'paste' && clip.current) {
          const r = pasteBuild(stateRef.current, clip.current, sc, intent.at, zoom, p, indexOf(sc));
          edit(r.build);
          // Nodes already here keep their place and group; selected, they are ready to be moved (spec 7).
          if (r.present.length > 0) {
            const n = r.present.length;
            notify(`${questions.titles(r.present)} ${plural(n, 'était déjà', 'étaient déjà')} dans ce plan : ${plural(n, 'il garde sa', 'ils gardent leur')} place (${plural(n, 'sélectionné', 'sélectionnés')}, à déplacer au besoin).`);
            setSelection({ items: new Set(r.present), connections: new Set() });
          }
        }
        else if (what.kind === 'newNode') {
          // The node is placed, then named in place (spec 12); the creation is written with its title, as one step. The
          // index is asked for once named: an action in between would have moved it on to another scene.
          const width = Math.max(140, (p.boxWidth - 2 * p.boxPadX) * p.textScale * zoom * p.factor ** Math.round(Math.log(1 / (zoom * p.textScale)) / Math.log(p.factor)));
          setEditor({ x: sp.x, y: sp.y, width, initial: '', done: (title) => { if (title) edit(createBuild(sc, title, intent.at, zoom, p, indexOf(sc))); } });
        } else if (what.kind === 'exclude') {
          // Out of its group, put down where clicked; entering the group under the cursor if it is another (spec 10).
          repercussion.dropAsking(what.base, what.items, intent.at.x - what.from.x, intent.at.y - what.from.y, intent.at, true, restoreScene);
        }
        break;
      }
      case 'placeCancel': {
        const what = placing.current;
        placing.current = null;
        setGhost(null);
        if (what?.kind === 'connect') endConnect();
        // A .bib's block (D9): nothing is made, its .bib no longer stored.
        if (what?.kind === 'bib') dropBib();
        // Escape leaves this plan as it is; the next one opens (spec 10).
        if (what?.kind === 'repercussion') repercussion.nextRepercussion();
        if (what?.kind === 'split' && what.step === 2) moveCamera({ ...what.home, widthPx: e.renderer.camera.widthPx, heightPx: e.renderer.camera.heightPx });
        break;
      }
      case 'dragCancel': {
        if (stubDrag.current) { stubDrag.current = null; setGhost(null); break; }
        const d = dragging.current;
        dragging.current = null;
        e.renderer.setDropTarget(null);
        if (d) restoreScene();
        break;
      }
      default:
        break;
    }
    redraw();
  };

  /**
   * A menu choice (spec 9.1): on the element clicked, or on the whole selection when it belongs to it. The focus comes
   * back to the graph, as after the title editor or a question: the item pressed had it, and went with the menu. The
   * next Escape is then the graph's, and cancels the gesture the choice started instead of closing a loose pop-up (I1
   * of the final review); a title editor or a question opened by the choice takes it next.
   */
  const pick = (action: MenuAction, hit: Hit, at: { x: number; y: number }) => {
    root.current?.focus({ preventScroll: true });
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    // A menu left open while a .bib put down waits for its .bib: nothing it offers begins (review of task 6, M4).
    if (bibWaiting()) { notify(BIB_WAITING); return; }
    const p = paramsRef.current, sel = selectionRef.current;
    // The menu may have stayed open across a rebuild: what it was opened on is found again by id (I9 of the review).
    const clicked = hit.kind === 'item' ? sc.byId.get(hit.id) ?? -1 : -1;
    const line = hit.kind === 'connection' && hit.ids.length === 1 ? hit.ids[0] : null;
    const clickedId = clicked >= 0 ? sc.items[clicked].id : null;
    const targets = clickedId && sel.items.has(clickedId)
      ? [...sel.items].flatMap((id) => { const i = sc.byId.get(id); return i === undefined ? [] : [i]; })
      : clicked >= 0 ? [clicked] : [];
    switch (action) {
      case 'newNode':
        placing.current = { kind: 'newNode' };
        setGhost({ x: at.x, y: at.y, text: 'Nouveau nœud' });
        gestures.current.start('place');
        break;
      case 'importPublication': {
        const cam = e.renderer.camera;
        setPublication({ key: performance.now(), plan: sc.plan.id, at: screenToWorld(cam, at.x, at.y), zoom: cam.zoom });
        break;
      }
      case 'importBib': {
        // The system's dialog, by the main process (D9): the .bib chosen follows the cursor from the menu's point.
        if (busy()) { notify(busyReason('d’importer un fichier .bib')); break; }
        const plan = sc.plan.id;
        bibMark('drop');
        window.cirrus.pickBib().then((file) => startBib(file, at, plan), (err: unknown) => {
          console.error('Lecture du fichier .bib :', err);
          notify('Le fichier .bib n’a pas pu être lu : rien n’est importé.');
        });
        break;
      }
      case 'rename': {
        if (clicked < 0) break;
        const it = sc.items[clicked], sp = worldToScreen(e.renderer.camera, it.x, it.y);
        setEditor({ x: sp.x, y: sp.y, width: Math.max(140, 2 * it.halfW * e.renderer.camera.zoom), initial: it.title, done: (title) => { if (title !== null && title.trim() !== it.title) edit(renameBuild(it.id, title)); } });
        break;
      }
      case 'exclude':
        if (clicked < 0) break;
        placing.current = { kind: 'exclude', base: sc, items: [clicked], from: { x: sc.items[clicked].x, y: sc.items[clicked].y } };
        setGhost({ x: at.x, y: at.y, text: sc.items[clicked].title });
        gestures.current.start('exclude');
        break;
      case 'scaleDown':
      case 'scaleUp':
        edit(scaleBuild(sc, targets, action === 'scaleUp' ? 1 : -1, p));
        break;
      case 'hide':
        questions.askHide(sc, targets);
        break;
      case 'delete':
        questions.askDelete(sc, targets);
        break;
      case 'copy':
        copy(sc, targets);
        break;
      case 'paste':
        startPaste(at);
        break;
      case 'layout':
      case 'resetLayout': {
        // Selected, a connection shows its handles; « rétablir » forgets this plan's layout (spec 8.5).
        if (line === null) break;
        const id = line;
        if (action === 'resetLayout') edit(layoutBuild(sc.plan.id, id, null));
        else {
          setSelection({ items: new Set(), connections: new Set([id]) });
          notify('Tirez le marqueur, la poignée de rotation ou les poignées des branches.');
        }
        break;
      }
      case 'deleteConnection': {
        if (line !== null) questions.askDeleteConnection(sc.plan.id, line);
        break;
      }
      case 'addToLobby': {
        // A connection places itself; a node follows the cursor in the lobby until a click (spec 7).
        const lobby = [...stateRef.current.plans.values()].find((x) => x.type === 'lobby');
        if (!lobby) break;
        if (hit.kind === 'connection') {
          if (line !== null) edit(lobbyConnectionBuild(lobby.id, line));
          break;
        }
        if (clicked < 0) break;
        const it = sc.items[clicked];
        pendingPlace.current = { plan: lobby.id, what: { kind: 'import', node: it.node, label: 'Ajouter au lobby' }, text: it.title, at };
        props.onOpenPlan(lobby.id);
        break;
      }
      case 'connect':
        // A straight line follows the cursor from the node; 1-to-1 connections show their centre, a target too (spec 11.1).
        if (clicked < 0) break;
        e.renderer.setCoresShown(true);
        startPlacing({ kind: 'connect', node: sc.items[clicked].node }, null, at);
        aimLine(at.x, at.y);
        break;
      case 'splitArm': {
        const far = hit.kind === 'connection' && hit.key !== null ? sc.byId.get(hit.key) : undefined;
        if (line === null || far === undefined) break;
        const it = sc.items[far];
        startPlacing({ kind: 'split', step: 1, connection: line, node: it.id, title: it.title, home: e.renderer.camera }, `fantôme : ${it.title}`, at);
        break;
      }
      case 'joinArm': {
        if (clicked >= 0 && sc.items[clicked].kind === 'phantom') {
          const it = sc.items[clicked];
          edit(joinBuild(sc.plan.id, it.connection!, it.node));
        } else if (hit.kind === 'connection' && line !== null) {
          const far = partOf(sc, line).find((i) => sc.part[i] === PART_FAR);
          if (far !== undefined) edit(joinBuild(sc.plan.id, line, partEnds(sc, far)[0].key));
        }
        break;
      }
      case 'teleport': {
        // To the original (spec 8.5): the far node; for the centre, the far node's phantom by the bundle. Its place in
        // the navigation history comes with plan 6.
        if (clicked < 0) break;
        const it = sc.items[clicked];
        // The centre's: the far node's phantom of the same arm, among its connection's phantoms.
        const twin = phantomsOf(stateRef.current, it.connection!).find((id) => {
          const ph = stateRef.current.phantoms.get(id);
          return ph?.plan === sc.plan.id && ph.of.kind === 'node' && ph.of.node === it.node;
        });
        const dest = it.phantom === 'node' ? sc.byId.get(it.node) ?? -1 : twin === undefined ? -1 : sc.byId.get(twin) ?? -1;
        if (dest < 0) { onResultRef.current({ ok: false, message: 'L’original n’est pas dans ce plan.' }); break; }
        moveCamera({ ...e.renderer.camera, x: sc.items[dest].x, y: sc.items[dest].y });
        break;
      }
      case 'importNode': {
        const st = hit.kind === 'stub' ? hit : undefined;
        const node = st ? st.node : clicked >= 0 ? sc.items[clicked].node : null;
        if (node) startPlacing({ kind: 'import', node }, st ? st.title : sc.items[clicked].title, at);
        break;
      }
      default:
        break;
    }
    redraw();
  };
  /**
   * What the import dialog asks of the graph (plan 4c, D5 to D8): the IPC, and the node put down where the menu was
   * opened (publicationBuild), at the zoom of then, through the session — one action. Its plan no longer shown, nothing.
   */
  const publicationDeps = (d: { plan: Id; at: Vec2; zoom: number }): Omit<ImportDeps, 'open'> => ({
    state: () => stateRef.current,
    fetch: (text, options) => window.cirrus.publicationFetch(text, options),
    storeText: (name, text) => window.cirrus.storeText(name, text),
    maxAuthors: () => paramsRef.current.publicationMaxAuthors,
    put: async (plan, files) => {
      const sc = sceneRef.current, session = sessionRef.current;
      if (!sc || !session || sc.plan.id !== d.plan) return { ok: false, message: 'Le plan de l’import n’est plus affiché : rien n’est importé.' };
      const r = await session.run(publicationBuild(plan, files, sc, d.at, d.zoom, paramsRef.current, indexOf(sc)));
      if (r.ok) onResultRef.current(r);
      return r;
    },
    log: (what, e) => console.error(what, e),
  });
  const buttonOf = (b: number): 0 | 1 | 2 => (b === 2 ? 2 : b === 1 ? 1 : 0);
  /** The buttons held, as the last pointer event gave them. */
  const buttons = useRef(0);

  // The loop sleeps when idle: an input (a drag's preview is drawn from the loop), the window shown again or focused
  // again, and any render of this view (a new state) wake it.
  useEffect(() => {
    const onInput = () => wake.current();
    const onBack = () => redraw();
    const inputs = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup'] as const;
    for (const ev of inputs) window.addEventListener(ev, onInput, true);
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      for (const ev of inputs) window.removeEventListener(ev, onInput, true);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, []);
  useEffect(() => wake.current());
  // A lost focus abandons the gesture in progress (Review Focus 2 of plan 3b).
  useEffect(() => {
    // A plan of a repercussion waits instead: Alt+Tab must not skip it (I8 of the review). Not in bench and capture modes.
    const onBlur = () => {
      if (measuring()) return;
      handles.dropHandle(false);
      if (placing.current?.kind !== 'repercussion') feed({ t: 'cancel' });
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);
  // Ctrl+Z and Ctrl+Y (spec 6.4) wait for what is under way: a scale gesture before its pause is written first; a
  // gesture, a question or a repercussion in progress refuses them (I6 of the plan 3b review).
  useEffect(() => {
    props.session?.setGuard(() => {
      settleWheel();
      return busy() ? busyReason('d’annuler ou de rétablir') : null;
    });
  }, [props.session]);
  useEffect(() => {
    engine.current?.renderer.setSelection(selection);
    redraw();
  }, [selection, scene]);

  const rectStyle = (() => {
    const e = engine.current;
    if (!rect || !e) return null;
    const a = worldToScreen(e.renderer.camera, rect.minX, rect.minY), b = worldToScreen(e.renderer.camera, rect.maxX, rect.maxY);
    return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  })();

  return (
    <div
      className="graph"
      ref={root}
      tabIndex={0}
      onContextMenu={(ev) => ev.preventDefault()}
      // Files dropped on the graph (not on a connection's pop-up or a question over it: those refuse them); a node dragged
      // out of a list of annotations, by its own route (plan 4c, task 3), the node or group it would enter lit meanwhile.
      onDragOver={(ev) => {
        const node = takesNode(ev);
        if (!node && !takesFiles(ev)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        if (node && !ignored(ev)) lightHost(local(ev));
      }}
      onDragLeave={(ev) => { if (!root.current!.contains(ev.relatedTarget as Node | null)) lightHost(null); }}
      onDrop={(ev) => {
        if (takesNode(ev)) {
          ev.preventDefault();
          lightHost(null);
          if (ignored(ev)) return;
          const node = ev.dataTransfer.getData(NODE_MIME), { sx, sy } = local(ev);
          root.current!.focus();
          if (node) dropNodeAt(sx, sy, node);
          return;
        }
        if (!takesFiles(ev)) return;
        ev.preventDefault();
        if (ignored(ev)) return;
        const { sx, sy } = local(ev), d = droppedPaths(ev.dataTransfer.files, (f) => window.cirrus.pathForFile(f));
        if (d.paths.length + d.refused.length > 0) void dropFilesAt(sx, sy, d.paths, d.refused);
      }}
      onPointerDown={(ev) => {
        if (ignored(ev)) return;
        root.current!.focus();
        graphPress.current = true;
        buttons.current = ev.buttons;
        const { sx, sy } = local(ev);
        root.current!.setPointerCapture(ev.pointerId);
        if (ev.button === 0 && !ev.ctrlKey && !gestures.current.busy && handles.grabHandle(sx, sy)) return;
        feed({ t: 'down', button: buttonOf(ev.button), sx, sy, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, hit: hitAt(sx, sy) });
      }}
      onMouseDown={(ev) => {
        if (graphPress.current) ev.preventDefault();
        graphPress.current = false;
      }}
      onPointerMove={(ev) => {
        if (ignored(ev)) return;
        const { sx, sy } = local(ev);
        lastPointer.current = { x: sx, y: sy };
        // A second button pressed during a gesture (a right click cancelling a drag) only shows here (I1 of the review).
        const pressed = newlyPressed(buttons.current, ev.buttons);
        buttons.current = ev.buttons;
        for (const b of pressed) {
          if (handles.held() && b !== 0) { handles.dropHandle(false); continue; }
          feed({ t: 'down', button: b, sx, sy, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, hit: hitAt(sx, sy) });
        }
        if (handles.held()) { handles.dragHandle(sx, sy); return; }
        if (!gestures.current.busy) hover(sx, sy);
        feed({ t: 'move', sx, sy });
      }}
      onPointerUp={(ev) => {
        if (ignored(ev)) return;
        buttons.current = ev.buttons;
        const { sx, sy } = local(ev);
        if (root.current!.hasPointerCapture(ev.pointerId)) root.current!.releasePointerCapture(ev.pointerId);
        if (handles.held()) { handles.dropHandle(true); return; }
        feed({ t: 'up', button: buttonOf(ev.button), sx, sy });
      }}
      onPointerLeave={(ev) => { if (ignored(ev)) return; lastPointer.current = null; if (!gestures.current.busy) clearHover(); }}
      onKeyDown={(ev) => {
        if (ignored(ev)) return;
        if (ev.key === 'Escape') {
          // Taken by the gesture it cancels, or by the menu or connection pop-up it closes, it is not the floating panels'
          // (they close on an Escape nothing took).
          if (handles.held() || gestures.current.busy || menu || popup) ev.preventDefault();
          if (handles.held()) handles.dropHandle(false); else feed({ t: 'key', key: 'Escape' });
          return;
        }
        const sc = sceneRef.current;
        // Ctrl+C, Ctrl+V and Suppr (spec 7), outside a gesture in progress.
        if (sc && !gestures.current.busy) {
          const key = ev.key.toLowerCase();
          if (ev.ctrlKey && key === 'c') { ev.preventDefault(); copy(sc, selectedItems(sc)); return; }
          if (ev.ctrlKey && key === 'v') { ev.preventDefault(); startPaste(lastPointer.current ?? { x: 0, y: 0 }); return; }
          if (ev.key === 'Delete') {
            const items = selectedItems(sc), conns = [...selectionRef.current.connections];
            if (items.length > 0) questions.askDelete(sc, items);
            else if (conns.length === 1) questions.askDeleteConnection(sc.plan.id, conns[0]);
            return;
          }
        }
        if (!NAV_KEYS.has(ev.key)) return;
        ev.preventDefault();
        nav({ t: 'key', key: ev.key });
      }}
    >
      <div className="canvas-host" ref={host} />
      {failure && <div className="placeholder">Le graphe ne peut pas être dessiné : {failure}</div>}
      <svg className="handles" ref={handles.handlesSvg} />
      {rectStyle && <div className="select-rect" style={rectStyle} />}
      <HierarchyCorner
        chain={chain}
        onPick={(item) => { const e = engine.current, sc = sceneRef.current; if (e && sc) moveCamera(fitItem(sc, item, e.renderer.camera, paramsRef.current)); }}
      />
      <Tooltip tip={tip} />
      {ghost && <Ghost x={ghost.x} y={ghost.y} text={ghost.text} box={ghost.box} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} onPick={(a) => pick(a, menu.hit, { x: menu.x, y: menu.y })} />}
      {editor && <TitleEditor x={editor.x} y={editor.y} width={editor.width} initial={editor.initial} onDone={(t) => { setEditor(null); editor.done(t); root.current?.focus(); }} />}
      {line && <svg className="connect-line"><line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} /></svg>}
      {popup && (
        <ConnectionPopup
          key={`${popup.connections.join()}|${popup.x}|${popup.y}`} state={props.state} plan={props.plan} connections={popup.connections} x={popup.x} y={popup.y}
          registry={props.registry} params={props.params} onNodeLink={props.onNodeLink}
          onEdit={(b) => edit(b).then((r) => r !== null && r.ok)} onClose={() => setPopup(null)} onRemoveMember={questions.removeMember}
          onAddMember={(connection, node) => questions.askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
            otherPlans(stateRef.current, props.plan, [node], connection), (everywhere) => edit(addMemberBuild(props.plan, connection, node, everywhere)))}
        />
      )}
      {questions.question && <AskDialog q={questions.question} onClose={() => { questions.setQuestion(null); root.current?.focus(); }} />}
      {publication && (
        <PublicationDialog
          key={publication.key} params={props.params} deps={publicationDeps(publication)} onNotify={notify}
          onClose={() => { setPublication(null); root.current?.focus({ preventScroll: true }); }}
        />
      )}
    </div>
  );
}
