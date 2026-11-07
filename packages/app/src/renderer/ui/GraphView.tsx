import { type Action, type FileRef, type Id, phantomsOf, type State, type Vec2 } from '@cirrus/core';
import {
  bibBlock, blockHalves, type Bounds, buildScene, type Camera, emptySelection, fitBounds, fitItem, GestureMachine, type Hit, type Input, inRectangle, type Intent, navigate,
  type NavInput,
  type PlanScene, type RenderParams, sceneParamsKey, screenToWorld, type Selection, toggle, withOffsets, worldToScreen,
  dropEffects, dropTarget, type MenuAction, type MenuItem, menuFor, stepWheel, type WheelSteps, type ConnectTarget, connectTarget, otherPlans,
  type Mode, type Clip, copyClip, deleteSummary, applyHandle, type BundleGeometry, bundleFor, handleAt, type HandleSpot, type Layout,
  type LayoutHandle, layoutHandles, dropScenes, repercussion, isPinch, scaleMoves, withMoves, newlyPressed, renderPaused, updateScene, partOf, PART_FAR,
  PART_MAIN, partEnds, type Measure, mergeChanges, type SceneChanges, type SceneIndex, updateIndex, type FontData, measureLines, layoutSplit, previewSplit,
  type PreviewSplit, type VisibleSet,
} from '@cirrus/view';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type BenchView, mark, runBench } from '../bench.ts';
import { createGl, type Gl } from '../gl/context.ts';
import { loadFont } from '../render/font.ts';
import { PlanRenderer } from '../render/PlanRenderer.ts';
import { HierarchyCorner, Tooltip } from './Overlays.tsx';
import type { EditSession, Result } from '../session.ts';
import {
  absentBuild, addMemberBuild, ALREADY_HERE, type Build, connectBuild, createBuild, deleteBuild, deleteConnectionBuild, dropBuild, hideBuild, importBuild,
  joinBuild, dropMemberships, lastPlanNodes, layoutBuild, lobbyConnectionBuild, pasteBuild, placeDroppedBuild, placeInPlanBuild, readableStep, removeMemberBuild,
  renameBuild, scaleBuild, splitBuild, withRepercussion,
} from '../actions.ts';
import type { BibFile } from '../../main/bib.ts';
import { ContextMenu, Ghost, TitleEditor } from './ContextMenu.tsx';
import { ConnectionPopup } from './ConnectionPopup.tsx';
import { AskDialog, type Question } from './Dialogs.tsx';
import { nodeOpenedBy } from './panels/Panels.tsx';
import type { Rect } from './panels/geometry.ts';
import { NODE_MIME } from '../files/annotations.ts';
import { backgroundNotice, carried, carriesFiles, droppedPaths, dropRoute, dropZone, type Refusal } from '../files/nodeFiles.ts';
import type { LatexRegistry } from '../latex/registry.ts';
import { bibImportBuild, bibNotice, bibText, planBib, type PlannedBib, storeBibs } from '../publications/bib.ts';
import { type ImportDeps, publicationBuild } from '../publications/build.ts';
import { PublicationDialog } from './PublicationDialog.tsx';

/** What App asks of the graph: files dropped at a point of it, as a drop of the user's (CIRRUS_IMPORT, captures). */
export interface GraphHandle { dropFilesAt(sx: number, sy: number, paths: string[], refused?: Refusal[]): Promise<void> }

/**
 * Bench and capture modes (plan 3c, task 1): their windows may not hold the OS focus, and nothing they measure or show
 * may depend on it, nor on where the user's mouse lies. They lift the pause of the drawing and the gesture abandoned on
 * a lost focus, and ignore the physical pointer and keyboard; the normal mode keeps all three.
 */
const measuring = () => window.cirrus.launch.bench !== undefined || window.cirrus.launch.capture === true;
/** A real input event in bench or capture mode: ignored (their replayed events are not trusted, the user's are). */
const ignored = (ev: { isTrusted: boolean }) => ev.isTrusted && measuring();
const NAV_KEYS = new Set(['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** The camera a plan opens with: the launch option "x,y,zoom" for visual checks, else the plan framed. */
function initialCamera(scene: PlanScene, widthPx: number, heightPx: number, p: RenderParams, launchView?: string): Camera {
  const v = launchView?.split(',').map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) return { x: v[0], y: v[1], zoom: v[2], widthPx, heightPx };
  return fitBounds(scene.bounds, widthPx, heightPx, p);
}

type Tip = { x: number; y: number; text: string } | null;
/** The visible set of a renderer that has drawn nothing yet: a preview's split made for it is built whole. */
const NOTHING_SHOWN: VisibleSet = { items: [], groups: [], connections: [], signature: '' };
type Chain = { item: number; title: string }[];
/** What a gesture without a held button will do once placed (spec 9.1). */
type Placing =
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
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const fr = (n: number) => n.toLocaleString('fr-FR');

/**
 * A .bib being imported (plan 4c, D9, task 6), from the ghost of its block to the action: what it plans, in its plan;
 * each title's lines (the block's rows); its entries' .bib stored meanwhile — `stored` so far, `refs` once all are,
 * `failed` why not —, which `stop` (Escape, another plan, a lost focus) ends; `settled` resolves once storing is over.
 * `waiting`: put down by a click, the action waits for every .bib stored (Escape no longer gives it up). The block's
 * half sizes at step 0, for its outline (they scale with the step).
 */
interface BibImport {
  planned: PlannedBib; plan: Id; lines: number[]; halves: { halfW: number; halfH: number };
  stored: number; refs: FileRef[] | null; failed: string | null; stop: boolean; settled: Promise<void>; waiting: boolean;
}
/**
 * The import's marks for its measures (scripts/interface.mjs): the drop or the choice, the ghost shown, every .bib
 * stored, the click, the action applied.
 */
const bibMark = (name: 'drop' | 'ghost' | 'stored' | 'click' | 'placed') => {
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
  /** Edits go through the session (written, undoable); their outcome is reported (toasts). */
  session: EditSession | null; onResult(r: Result): void;
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
  const engine = useRef<{ gl: Gl; renderer: PlanRenderer; font: FontData } | null>(null);
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
  const [question, setQuestion] = useState<Question | null>(null);
  const questionRef = useRef(question);
  questionRef.current = question;
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
  /** The layout handles of the selected connection (spec 8.5), drawn over the canvas; one may be dragged. */
  const handlesSvg = useRef<SVGSVGElement>(null);
  const handleDrag = useRef<{
    handle: LayoutHandle; conn: number; id: Id; base: Layout | undefined; g: BundleGeometry; layout: Layout | undefined; scene: PlanScene;
    /** Where it was pressed; the drag begins beyond clickSlopPx, short of it the press is a plain click (I10 of the review). */
    from: { x: number; y: number }; armed: boolean;
    /** Its split for the visible set drawn (plan 3c task 9). */
    split?: PreviewSplit;
  } | null>(null);
  /** A gesture to begin once another plan is shown (« ajouter au lobby », a repercussion's plans); `frame`: the item to frame. */
  const pendingPlace = useRef<{ plan: Id; what: Placing; text: string; at: { x: number; y: number }; frame?: Id } | null>(null);
  /** The plans a repercussion still has to place by hand, one after the other (spec 10), then the plan to come back to. */
  const repQueue = useRef<{ extend: Id; home: Id; items: { plan: Id; node: Id; to: Id | null }[]; expected: Id } | null>(null);
  /**
   * A gesture, a question, a repercussion or a .bib's import under way: Ctrl+Z and Ctrl+Y wait for it (I6 of the plan
   * 3b review), and so do a node dropped from a list and another .bib.
   */
  const busy = () => gestures.current.busy || dragging.current !== null || handleDrag.current !== null || stubDrag.current !== null
    || repQueue.current !== null || questionRef.current !== null || bib.current !== null;

  /**
   * Gives the renderer the scene to show (plan 3c, task 6): when it follows the renderer's own by the changes gathered
   * since (sceneChanges), those changes, so that its index is updated rather than built; else the scene with the index
   * its tab kept, if any — the index of the scene the renderer leaves going back to its tab's entry.
   */
  const showScene = (r: PlanRenderer, scene: PlanScene) => {
    const gathered = sceneChanges.current;
    sceneChanges.current = null;
    if (gathered && r.held && gathered.prev === r.held.scene) r.updateScene(gathered.scene, gathered.changes);
    const held = r.held;
    if (held?.scene === scene) return;
    const byPlan = scenes.current.byPlan;
    const own = held ? byPlan.get(held.scene.plan.id) : undefined;
    if (held && own?.scene === held.scene) own.index = held.index;
    const entry = byPlan.get(scene.plan.id), kept = entry?.scene === scene ? entry.index : null;
    r.setScene(scene, false, kept ?? undefined);
    if (entry && entry.scene === scene) entry.index = null;
  };
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
  const [ready, setReady] = useState(false);
  /** Why the engine could not start (no WebGL 2, a font file absent or unreadable…): shown in place of the graph. */
  const [failure, setFailure] = useState<string | null>(null);
  const [scene, setScene] = useState<PlanScene | null>(null);
  /**
   * The scenes of the last tabs shown (cachedPlans, the current one last), all at revision `rev` of the state: each
   * action updates them by its operations (plan 3c, task 5), so that going back to one of these tabs is immediate.
   * `key`: the parameters they were made with (sceneParamsKey), and their measure of titles. Each keeps its visibility
   * index too (plan 3c, task 6), kept up to date with it — except the scene the renderer holds, whose index is the
   * renderer's (null here) until another tab is shown.
   */
  const scenes = useRef<{ rev: number; key: string; measure: Measure | null; byPlan: Map<Id, { scene: PlanScene; index: SceneIndex | null }> }>({
    rev: 0, key: '', measure: null, byPlan: new Map(),
  });
  /**
   * The renderer's scene once updated by the actions since it was given (`prev`, `scene`) and their changes, merged: the
   * effect that shows the scene gives them to the renderer, which updates its index instead of building it again.
   */
  const sceneChanges = useRef<{ prev: PlanScene; scene: PlanScene; changes: SceneChanges } | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  const [chain, setChain] = useState<Chain>([]);
  paramsRef.current = props.params;

  const moveCamera = (next: Camera) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    e.renderer.setCamera(next);
    cameras.current.set(sc.plan.id, next);
    redraw();
    // Wheel and arrows stay active while a connection is drawn: its line follows the node; a .bib's block, its outline.
    if (placing.current?.kind === 'connect' && lastPointer.current) aimLine(lastPointer.current.x, lastPointer.current.y);
    if (placing.current?.kind === 'bib') showBib();
  };
  const nav = (input: NavInput) => {
    const e = engine.current;
    if (e) moveCamera(navigate(e.renderer.camera, input, paramsRef.current));
  };

  /** What is under the screen point (sx, sy): hover light, tooltip, hierarchy reminder. */
  const hover = (sx: number, sy: number) => {
    const e = engine.current, sc = sceneRef.current, hits = e?.renderer.hitIndex;
    if (!e || !sc || !hits) return;
    const cam = e.renderer.camera;
    const w = screenToWorld(cam, sx, sy);
    const h = hits.hit(w.x, w.y, cam.zoom);
    e.renderer.setHover(h.kind === 'connection' || h.kind === 'stub' ? h.conn : null);
    redraw();
    let text: string | null = null;
    // The intruders found among what is drawn, with the same visible set as the hit index (spec 10, plan 3c task 6).
    const intruder = h.kind === 'item' ? e.renderer.intruders.get(h.item) : undefined;
    if (h.kind === 'stub') text = `absent : ${h.title}`;
    else if (intruder !== undefined) text = `intrus dans le groupe « ${sc.items[intruder].title} »`;
    else if (h.kind === 'item' && sc.items[h.item].kind === 'phantom') {
      const it = sc.items[h.item];
      text = `${it.phantom === 'node' ? 'fantôme' : it.phantom === 'center' ? 'centre' : 'absent'} : ${it.title}`;
    }
    setTip((old) => (text === null ? null : old && old.text === text && old.x === sx && old.y === sy ? old : { x: sx, y: sy, text }));
    const next = hits.openGroupsAt(w.x, w.y, cam.zoom).reverse().map((item) => ({ item, title: sc.items[item].title }));
    setChain((old) => (old.length === next.length && old.every((g, i) => g.item === next[i].item) ? old : next));
  };
  const clearHover = () => {
    engine.current?.renderer.setHover(null);
    redraw();
    setTip(null);
    setChain([]);
  };

  /** A gesture without a held button begins (spec 9.1): `text` follows the cursor, if any. */
  const startPlacing = (what: Placing, text: string | null, at: { x: number; y: number }) => {
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
  /** « Partout ou ici seulement » (spec 11, 19), asked only when other plans are concerned; `go` gets the plans chosen. */
  const askWhere = (text: string, plans: Id[], go: (everywhere: Id[]) => void) => {
    if (plans.length === 0) { go([]); return; }
    const names = plans.map((id) => stateRef.current.plans.get(id)?.name ?? '?');
    const n = plans.length, s = n > 1 ? 's' : '';
    const here = { value: 'here', label: 'Ici seulement' }, all = { value: 'everywhere', label: `Partout (${n} autre${s} plan${s})` };
    setQuestion({
      text, detail: `Autre${s} plan${s} concerné${s} : ${names.join(', ')}.`,
      choices: paramsRef.current.defaultAnswer === 'everywhere' ? [all, here] : [here, all],
      answer: (v) => { if (v !== null) go(v === 'everywhere' ? plans : []); },
    });
  };
  /** Removing a member of a connection (spec 11.2, 7): here only or everywhere, with its plans counted, a warning for the last ones. */
  const removeMember = (connection: Id, node: Id) => {
    const s = stateRef.current, plan = sceneRef.current?.plan.id, c = s.connections.get(connection);
    if (!c || !plan) return;
    const shownIn = [...s.plans.keys()].filter((p) => s.branches.has({ plan: p, connection, node }));
    const last = c.members.length <= 2;
    const choices = [
      ...(shownIn.includes(plan) ? [{ value: 'here', label: 'Ici seulement' }] : []),
      { value: 'everywhere', label: last ? 'Partout (supprime la connexion)' : 'Partout' },
    ];
    if (paramsRef.current.defaultAnswer === 'everywhere') choices.reverse();
    const n = shownIn.length;
    setQuestion({
      text: `Retirer « ${s.nodes.get(node)?.title ?? '?'} » de la connexion ?`,
      detail: `Ce membre est affiché dans ${n} plan${n > 1 ? 's' : ''}.${last ? ' La connexion n’aurait plus qu’un membre : « partout » la met à la corbeille.' : ''}`,
      choices,
      answer: (v) => { if (v !== null) edit(removeMemberBuild(plan, connection, node, v === 'everywhere')); },
    });
  };
  /** Node titles for a question: « A », « B » et 2 autres. */
  const titles = (ids: Id[]) => {
    const t = ids.slice(0, 2).map((id) => `« ${stateRef.current.nodes.get(id)?.title ?? '?'} »`).join(', ');
    return ids.length > 2 ? `${t} et ${ids.length - 2} autre${ids.length > 3 ? 's' : ''}` : t;
  };
  /** The items of the selection, as indices of this scene. */
  const selectedItems = (sc: PlanScene) => [...selectionRef.current.items].flatMap((id) => { const i = sc.byId.get(id); return i === undefined ? [] : [i]; });
  /** What goes to the trash, said for a question: nothing, or these nodes, this plan being their last (spec 7). */
  const trashNote = (last: Id[]) => (last.length === 0 ? 'rien ne part à la corbeille'
    : `${titles(last)} ${plural(last.length, 'ira', 'iront')} à la corbeille (dernier plan)`);
  /**
   * « Cacher » (spec 7): a group asks whether its content follows; what would leave its last plan is announced, for each
   * answer, content included (I12 of the plan 3b review).
   */
  const askHide = (sc: PlanScene, items: number[]) => {
    const ids = items.filter((i) => sc.items[i].kind !== 'phantom').map((i) => sc.items[i].id);
    if (ids.length === 0) return;
    const s = stateRef.current, groups = items.filter((i) => sc.items[i].kind === 'group');
    const alone = lastPlanNodes(s, sc, ids, false), all = lastPlanNodes(s, sc, ids, true);
    if (groups.length === 0 && alone.length === 0) { edit(hideBuild(sc, ids)); return; }
    setQuestion({
      text: groups.length > 0 ? `Cacher ${plural(groups.length, 'ce groupe', 'ces groupes')} : le contenu suit-il ?` : `Cacher ${titles(ids)} ?`,
      detail: groups.length > 0 ? `Avec le contenu, ${trashNote(all)}. Seul, ${trashNote(alone)}.` : `${trashNote(alone)[0].toUpperCase()}${trashNote(alone).slice(1)}.`,
      choices: groups.length > 0
        ? [{ value: 'content', label: 'Avec le contenu' }, { value: 'alone', label: plural(groups.length, 'Le groupe seul', 'Les groupes seuls') }]
        : [{ value: 'alone', label: 'Cacher' }],
      answer: (v) => { if (v !== null) edit(hideBuild(sc, ids, v === 'content')); },
    });
  };
  /**
   * Deletion (spec 7): always « partout » or « ici seulement », with the instances counted and the last ones announced;
   * « ici » for a group asks whether its content follows (I12 of the plan 3b review).
   */
  const askDelete = (sc: PlanScene, items: number[]) => {
    const ids = items.filter((i) => sc.items[i].kind !== 'phantom').map((i) => sc.items[i].id);
    if (ids.length === 0) return;
    const s = stateRef.current, { instances } = deleteSummary(s, ids);
    const groups = items.some((i) => sc.items[i].kind === 'group');
    const alone = lastPlanNodes(s, sc, ids, false), all = lastPlanNodes(s, sc, ids, true);
    const here = groups
      ? [{ value: 'content', label: 'Ici, avec le contenu' }, { value: 'here', label: 'Ici, le groupe seul' }]
      : [{ value: 'here', label: 'Ici seulement' }];
    const everywhere = { value: 'everywhere', label: 'Partout' };
    setQuestion({
      text: `Supprimer ${titles(ids)} ?`,
      detail: `${plural(ids.length, 'Il figure', 'Ils figurent')} dans ${instances} plan${instances > 1 ? 's' : ''} en tout. `
        + (groups ? `Ici avec le contenu, ${trashNote(all)} ; ici seul, ${trashNote(alone)}.` : `Ici, ${trashNote(alone)}.`),
      choices: paramsRef.current.defaultAnswer === 'everywhere' ? [everywhere, ...here] : [...here, everywhere],
      answer: (v) => { if (v !== null) edit(deleteBuild(sc, ids, v === 'everywhere', v === 'content')); },
    });
  };
  /** A connection's deletion (spec 7): « ici seulement » hides it here; when this is its last plan, it goes to the trash. */
  const askDeleteConnection = (plan: Id, connection: Id) => {
    const s = stateRef.current, c = s.connections.get(connection);
    if (!c) return;
    const phantoms = phantomsOf(s, connection).map((id) => s.phantoms.get(id));
    const shownIn = [...s.plans.keys()].filter((pl) => c.members.some((m) => s.branches.has({ plan: pl, connection, node: m.node }))
      || phantoms.some((ph) => ph?.plan === pl));
    const n = shownIn.length;
    const here = { value: 'here', label: 'Ici seulement' }, all = { value: 'everywhere', label: n <= 1 ? 'Supprimer' : 'Partout' };
    setQuestion({
      text: `Supprimer la connexion${c.title ? ` « ${c.title} »` : ''} ?`,
      detail: n <= 1 ? 'Elle n’est affichée dans aucun autre plan : elle ira à la corbeille.' : `Elle est affichée dans ${n} plans.`,
      choices: n <= 1 ? [all] : paramsRef.current.defaultAnswer === 'everywhere' ? [all, here] : [here, all],
      answer: (v) => { if (v !== null) edit(deleteConnectionBuild(plan, connection, v === 'everywhere')); },
    });
  };
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
    return b.waiting ? `Enregistrement des fichiers .bib : ${fr(b.stored)} / ${fr(n)}…` : `${what} · fichiers .bib : ${fr(b.stored)} / ${fr(n)}`;
  };
  /**
   * The ghost of the .bib's block (D9, the paste's ghost of plan 3b): its label, and its outline as the block would be
   * put down at the zoom shown — at the readable step, so about the same size on screen at any zoom. At `at`, or where
   * it was.
   */
  const showBib = (at?: { x: number; y: number }) => {
    const b = bib.current, e = engine.current;
    if (!b || !e) return;
    const p = paramsRef.current, zoom = e.renderer.camera.zoom, s = p.factor ** readableStep(zoom, p);
    const box = { w: 2 * b.halves.halfW * s * zoom, h: 2 * b.halves.halfH * s * zoom };
    setGhost((g) => ({ x: at?.x ?? g?.x ?? 0, y: at?.y ?? g?.y ?? 0, text: bibLabel(b), box }));
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
    const e = engine.current, sc = sceneRef.current;
    if (file === null || !e || !sc) return;
    if ('refused' in file) { notify(file.refused); return; }
    if (sc.plan.id !== plan || busy()) { notify(`Le plan a changé, ou un geste a commencé, pendant la lecture du fichier .bib : rien n’est importé.`); return; }
    const text = bibText(file);
    if ('refused' in text) { notify(text.refused); return; }
    const p = paramsRef.current, planned = planBib(stateRef.current, file.name, text.text, p.publicationMaxAuthors);
    if (planned.items.length === 0) { notify(bibNotice(planned, 0, p.bibNoticeLines)); return; }
    const measure = scenes.current.measure && scenes.current.key === sceneParamsKey(p) ? scenes.current.measure : measureLines(e.font, p);
    const lines = planned.items.map((x) => measure(x.plan.title));
    const b: BibImport = {
      planned, plan, lines, halves: blockHalves(bibBlock(lines.length, 0, p, lines), 0, p, lines),
      stored: 0, refs: null, failed: null, stop: false, settled: Promise.resolve(), waiting: false,
    };
    bib.current = b;
    b.settled = storeBibs(planned.items.map((x) => x.plan.bib!), (batch) => window.cirrus.storeTexts(batch), (n) => {
      b.stored = n;
      if (bib.current === b) showBib();
    }, () => b.stop).then((refs) => {
      b.refs = refs;
      if (refs) bibMark('stored');
      if (bib.current === b && !b.waiting) showBib();
    }, (err: unknown) => {
      console.error('Enregistrement des fichiers .bib :', err);
      b.failed = 'Les fichiers .bib des publications n’ont pas pu être enregistrés dans la base : rien n’est importé.';
      // Still following the cursor: the gesture is given up, said.
      if (bib.current === b && !b.waiting) { feed({ t: 'cancel' }); notify(b.failed); }
    });
    startPlacing({ kind: 'bib' }, bibLabel(b), at);
    showBib(at);
    bibMark('ghost');
  };
  /**
   * The block put down at `at` (D9), at the zoom of the click, once its .bib are all stored (the ghost says so while
   * they are not): one action, « Importer <n> publications », then the notification of the import (bibNotice). Its plan
   * no longer shown by then, or the store failed: nothing is made, said.
   */
  const placeBib = (at: Vec2, zoom: number) => {
    const b = bib.current;
    if (!b) return;
    bibMark('click');
    b.waiting = true;
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
      if (r?.ok) notify(bibNotice(b.planned, b.planned.items.length, p.bibNoticeLines));
    });
  };
  /** A .bib dropped on the graph's background at (sx, sy) (D9): read by the main process, then its block follows the cursor. */
  const dropBibFile = async (path: string, at: { x: number; y: number }) => {
    const plan = sceneRef.current?.plan.id;
    if (!plan) return;
    if (busy()) { notify('Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant d’importer un fichier .bib.'); return; }
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
  /**
   * A drop that changes groups (spec 10): « partout ou ici seulement » when other plans would change, with its cost
   * announced; « partout » writes the drop and the plans needing no hand, then opens the others one after the other.
   */
  const dropAsking = (base: PlanScene, items: number[], dx: number, dy: number, at: Vec2, alt: boolean, restore: () => void) => {
    const p = paramsRef.current, zoom = engine.current?.renderer.camera.zoom ?? 1;
    // Where the drop enters, found once for the action and the question (I2 of the final review).
    const target = dropTarget(base, at, items, zoom, p, indexOf(base));
    const build = dropBuild(base, items, dx, dy, target, alt, p);
    if (!build) { restore(); return; }
    askRepercussion(base.plan.id, dropMemberships(stateRef.current, base, items, target, alt), build, restore);
  };
  /**
   * The drop `build` in `plan`, whose nodes change group (`moves`), written (spec 10): at once when no other plan would
   * change; else after the « partout ou ici seulement » question, its cost announced — « partout » writes the drop and
   * the plans needing no hand, then opens the others one after the other. `restore`: what a refusal or no answer undoes.
   */
  const askRepercussion = (plan: Id, moves: { node: Id; from: Id | null; to: Id | null }[], build: Build, restore: () => void) => {
    const p = paramsRef.current, s = stateRef.current;
    // The other plans' scenes, for the whole drop: the cached ones when they are at the state's revision, else built
    // once, measured as the cached ones, with their measure's titles already laid out (I1 of the final review).
    const cache = scenes.current, key = sceneParamsKey(p), current = cache.key === key && cache.rev === sessionRef.current?.rev;
    const measure = cache.measure && cache.key === key ? cache.measure : measureLines(engine.current!.font, p);
    const sceneOf = dropScenes(s, measure, p, (q) => (current ? cache.byPlan.get(q)?.scene : undefined));
    const reps = moves.map((m) => ({ ...m, r: repercussion(s, plan, m.node, m.from, m.to, sceneOf) }));
    const changed = reps.flatMap((x) => x.r.changed.map((c) => ({ ...c, node: x.node })));
    if (changed.length === 0) { void edit(build, restore); return; }
    const names = (ids: Id[]) => [...new Set(ids)].map((id) => `« ${s.plans.get(id)?.name ?? '?'} »`).join(', ');
    const plans = new Set(changed.map((c) => c.plan)), manual = changed.filter((c) => c.manual);
    const third = reps.flatMap((x) => x.r.third), loops = reps.flatMap((x) => x.r.loops);
    const n = plans.size, m = new Set(manual.map((c) => c.plan)).size;
    const detail = [
      `Partout : ${n} plan${n > 1 ? 's' : ''}${m > 0 ? `, dont ${m} à placer à la main` : ''} (${names([...plans])}).`,
      third.length > 0 ? `Laissé${third.length > 1 ? 's' : ''} tel${third.length > 1 ? 's' : ''} quel${third.length > 1 ? 's' : ''}, un autre groupe y contient le nœud : ${names(third)}.` : '',
      loops.length > 0 ? `Ignoré${loops.length > 1 ? 's' : ''}, la répercussion y ferait une boucle : ${names(loops)}.` : '',
    ].filter(Boolean).join(' ');
    const here = { value: 'here', label: 'Ici seulement' }, all = { value: 'everywhere', label: 'Partout' };
    setQuestion({
      text: 'Répercuter ce changement de groupe dans les autres plans ?', detail,
      choices: p.defaultAnswer === 'everywhere' ? [all, here] : [here, all],
      answer: (v) => {
        if (v === null) { restore(); return; }
        if (v === 'here') { void edit(build, restore); return; }
        void edit(withRepercussion(build, changed.filter((c) => !c.manual)), restore).then((r) => {
          if (r?.ok && manual.length > 0) {
            repQueue.current = { extend: r.action.id, home: plan, items: manual.map((c) => ({ plan: c.plan, node: c.node, to: c.to })), expected: plan };
            nextRepercussion();
          }
        });
      },
    });
  };
  /** The next plan to place by hand (spec 10): opened, framed on the group joined, the node at the cursor; at the end, back home. */
  const nextRepercussion = () => {
    const q = repQueue.current;
    if (!q) return;
    const item = q.items.shift();
    if (!item) {
      repQueue.current = null;
      if (sceneRef.current?.plan.id !== q.home) props.onOpenPlan(q.home);
      return;
    }
    q.expected = item.plan;
    const s = stateRef.current, title = s.nodes.get(item.node)?.title ?? '?';
    const r = root.current?.getBoundingClientRect();
    pendingPlace.current = {
      plan: item.plan, what: { kind: 'repercussion', node: item.node, to: item.to, extend: q.extend },
      text: item.to ? `${title} → « ${s.nodes.get(item.to)?.title ?? '?'} »` : `${title} → hors du groupe`,
      at: { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 }, frame: item.to ?? item.node,
    };
    if (sceneRef.current?.plan.id === item.plan) startPending(); else props.onOpenPlan(item.plan);
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
      const replay = (script: string) => {
        for (const step of script.split(';').map((x) => x.trim()).filter(Boolean)) {
          if (step.startsWith('click ')) { document.querySelector<HTMLElement>(step.slice(6))?.click(); continue; }
          if (step.startsWith('press ')) {
            // Keys to the graph itself (Ctrl+C, Suppr…), where window-wide keys (--keys) do not go.
            const parts = step.slice(6).split('+');
            root.current?.dispatchEvent(new KeyboardEvent('keydown', { key: parts.pop()!, ctrlKey: parts.includes('ctrl'), bubbles: true }));
            continue;
          }
          const [t, xs, ys, ...mods] = step.split(/\s+/);
          const sx = Number(xs), sy = Number(ys), button = mods.includes('right') ? 2 : 0;
          // The same paths as the real pointer: a layout handle first, else the gesture machine.
          if (t === 'down') {
            if (button === 0 && !mods.includes('ctrl') && !gestures.current.busy && grabHandle(sx, sy)) continue;
            feed({ t: 'down', button, sx, sy, ctrl: mods.includes('ctrl'), alt: mods.includes('alt'), shift: mods.includes('shift'), hit: hitAt(sx, sy) });
          } else if (t === 'move') {
            if (handleDrag.current) dragHandle(sx, sy);
            else feed({ t: 'move', sx, sy });
          } else if (t === 'up') {
            if (handleDrag.current) dropHandle(true);
            else feed({ t: 'up', button, sx, sy });
          }
          else if (t === 'key') feed({ t: 'key', key: xs });
          else if (t === 'wheel') {
            const r = root.current!.getBoundingClientRect();
            root.current!.dispatchEvent(new WheelEvent('wheel', { clientX: sx + r.left, clientY: sy + r.top, deltaY: Number(mods[0] ?? -120), ctrlKey: mods.includes('ctrl'), cancelable: true }));
          }
        }
      };
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
            drawHandles();
            // What is under a resting pointer changes with the drawn set (I1 of the review): look again — not while a
            // handle is dragged (each of its frames is patched in place; the hover comes back once it is released).
            if (rebuilt && lastPointer.current && !gestures.current.busy && !handleDrag.current) hover(lastPointer.current.x, lastPointer.current.y);
            if (firstPending.current) {
              mark('firstFrame');
              // Visual checks: a simulated hover is drawn before the capture is taken.
              if (launchHover && launchHover.length === 2) { hover(launchHover[0], launchHover[1]); launchHover = undefined; }
              else if (settle > 0) { settle--; dirty.current = true; }
              else if (launchPhases.length > 0) { replay(launchPhases.shift()!); settle = 5; dirty.current = true; }
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

  // The scene depends on the state (its revision), the plan and the few parameters it reads (box sizes): a colour or a
  // threshold changed in the settings panel does not rebuild it. The measure needs the font loaded.
  const sceneKey = sceneParamsKey(props.params);
  useEffect(() => {
    if (!ready) return;
    const p = paramsRef.current, cache = scenes.current, s = props.state;
    if (cache.key !== sceneKey) { cache.byPlan.clear(); cache.key = sceneKey; cache.measure = measureLines(engine.current!.font, p); sceneChanges.current = null; }
    const measure = cache.measure!;
    if (props.rev !== cache.rev) {
      // One action since the scenes were made: its operations update every one (Review Focus 2). React may have
      // gathered several actions into this render, of which only the last is known: the scenes are made anew then.
      const ops = props.rev === cache.rev + 1 ? props.action?.ops : undefined;
      // The renderer's scene, or the one it will be given with the changes gathered so far.
      const held = sceneChanges.current?.scene ?? sceneRef.current;
      for (const [plan, entry] of [...cache.byPlan]) {
        if (!ops || !s.plans.has(plan)) { cache.byPlan.delete(plan); continue; }
        const { scene: next, changes } = updateScene(entry.scene, s, ops, measure, p);
        if (next === entry.scene) continue;
        if (entry.scene === held) {
          // Its index is the renderer's: the changes go to it with the scene ([scene] effect), merged if renders gather.
          const g = sceneChanges.current;
          sceneChanges.current = g && g.scene === entry.scene ? { prev: g.prev, scene: next, changes: mergeChanges(g.changes, changes) } : { prev: entry.scene, scene: next, changes };
        } else if (entry.index) entry.index = updateIndex(entry.index, next, changes, p);
        entry.scene = next;
      }
      if (!ops) sceneChanges.current = null;
      cache.rev = props.rev;
    }
    const entry = cache.byPlan.get(props.plan) ?? { scene: buildScene(s, props.plan, measure, p), index: null };
    // The tab shown last goes last; beyond cachedPlans, the one shown longest ago is forgotten.
    cache.byPlan.delete(props.plan);
    cache.byPlan.set(props.plan, entry);
    for (const plan of cache.byPlan.keys()) { if (cache.byPlan.size <= p.cachedPlans) break; cache.byPlan.delete(plan); }
    setScene(entry.scene);
    mark('sceneReady');
  }, [ready, props.state, props.rev, props.plan, sceneKey]);

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
      const q = repQueue.current;
      if (q && scene.plan.id !== q.expected) {
        // The user went elsewhere: the repercussion stops there (I8 of the review); what was placed stays.
        repQueue.current = null;
        const left = q.items.length + (placing.current?.kind === 'repercussion' ? 1 : 0);
        notify(`Répercussion interrompue : ${left} plan${left > 1 ? 's' : ''} non placé${left > 1 ? 's' : ''} à la main.`);
      }
      settleWheel();
      dropHandle(false);
      setQuestion(null);
      feed({ t: 'cancel' });
      setSelection(emptySelection());
      setPopup(null);
    }
    sceneRef.current = scene;
    showScene(e.renderer, scene);
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
    if (busy()) { notify('Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant de poser ce nœud.'); return; }
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
    else askRepercussion(sc.plan.id, [{ node, from: null, to: sc.items[host].id }], build, () => {});
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
        // A stub dragged gets a place of its own: an absent phantom (spec 8.5).
        if (intent.hit.kind === 'stub') {
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
        dropAsking(d.base, d.items, intent.dx, intent.dy, intent.at, intent.alt, restoreScene);
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
            askWhere('Montrer aussi cette connexion dans les autres plans où ses deux nœuds sont présents ?',
              otherPlans(s, sc.plan.id, [what.node, sc.items[t.item].node]), (everywhere) => edit(connectBuild(sc, from, t, everywhere)));
          } else {
            askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
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
          void edit(placeInPlanBuild(sc, what.node, intent.at, what.to), undefined, what.extend).then(() => nextRepercussion());
        }
        else if (what.kind === 'paste' && clip.current) {
          const r = pasteBuild(stateRef.current, clip.current, sc, intent.at, zoom, p, indexOf(sc));
          edit(r.build);
          // Nodes already here keep their place and group; selected, they are ready to be moved (spec 7).
          if (r.present.length > 0) {
            const n = r.present.length;
            notify(`${titles(r.present)} ${plural(n, 'était déjà', 'étaient déjà')} dans ce plan : ${plural(n, 'il garde sa', 'ils gardent leur')} place (${plural(n, 'sélectionné', 'sélectionnés')}, à déplacer au besoin).`);
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
          dropAsking(what.base, what.items, intent.at.x - what.from.x, intent.at.y - what.from.y, intent.at, true, restoreScene);
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
        if (what?.kind === 'repercussion') nextRepercussion();
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
   * Ctrl+wheel (spec 8.1): the step of the selection or of the element under the cursor. The notches of one gesture
   * are previewed at once and written as one action when the wheel pauses (stepWheel).
   */
  const wheelGesture = useRef<{ steps: WheelSteps; base: PlanScene; preview: PlanScene; items: number[]; timer: number } | null>(null);
  const commitScale = (g: { steps: WheelSteps; base: PlanScene; items: number[] }) => {
    if (g.steps.delta === 0) { restoreScene(); return; }
    edit(scaleBuild(g.base, g.items, g.steps.delta, paramsRef.current), restoreScene);
  };
  /** Writes now the Ctrl+wheel gesture waiting for its pause (before an undo, a change of plan). */
  const settleWheel = () => {
    const g = wheelGesture.current;
    if (!g) return;
    window.clearTimeout(g.timer);
    wheelGesture.current = null;
    commitScale(g);
  };
  const wheelScale = (sx: number, sy: number, deltaY: number) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    const h = hitAt(sx, sy);
    const prev = wheelGesture.current;
    if (h.kind !== 'item') return;
    const id = sc.items[h.item].id, sel = selectionRef.current;
    const ids = sel.items.has(id) ? [...sel.items] : [id];
    const steps = stepWheel(prev?.steps ?? null, [...ids].sort().join(','), deltaY, performance.now(), paramsRef.current);
    if (prev) window.clearTimeout(prev.timer);
    if (steps.flush && prev) commitScale(prev);
    // A new gesture starts from what the screen shows: after the one just written, its preview (I6 of the review).
    const base = !prev ? sc : steps.flush ? prev.preview : prev.base;
    const items = ids.flatMap((x) => { const i = base.byId.get(x); return i === undefined ? [] : [i]; });
    // Preview: the placements as the action would leave them, without rebuilding the scene (I15 of the review), the
    // gesture's previous preview's storage taken again (plan 3c task 9).
    const reuse = prev && !steps.flush ? prev.preview : undefined;
    const preview = steps.delta === 0 ? base : withMoves(base, scaleMoves(base, items, steps.delta, paramsRef.current), paramsRef.current, reuse);
    e.renderer.preview(preview, previewSplit(base, e.renderer.visible ?? NOTHING_SHOWN, items));
    const gesture = { steps, base, preview, items, timer: 0 };
    gesture.timer = window.setTimeout(() => { wheelGesture.current = null; commitScale(gesture); }, paramsRef.current.scaleGesturePauseMs);
    wheelGesture.current = gesture;
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
        if (busy()) { notify('Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant d’importer un fichier .bib.'); break; }
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
        askHide(sc, targets);
        break;
      case 'delete':
        askDelete(sc, targets);
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
        if (line !== null) askDeleteConnection(sc.plan.id, line);
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
  const feed = (input: Input) => {
    const e = engine.current;
    if (!e) return;
    for (const intent of gestures.current.feed(input, e.renderer.camera)) handle(intent);
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
      dropHandle(false);
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
      return busy() ? 'Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant d’annuler ou de rétablir.' : null;
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
        if (ev.button === 0 && !ev.ctrlKey && !gestures.current.busy && grabHandle(sx, sy)) return;
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
          if (handleDrag.current && b !== 0) { dropHandle(false); continue; }
          feed({ t: 'down', button: b, sx, sy, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, hit: hitAt(sx, sy) });
        }
        if (handleDrag.current) { dragHandle(sx, sy); return; }
        if (!gestures.current.busy) hover(sx, sy);
        feed({ t: 'move', sx, sy });
      }}
      onPointerUp={(ev) => {
        if (ignored(ev)) return;
        buttons.current = ev.buttons;
        const { sx, sy } = local(ev);
        if (root.current!.hasPointerCapture(ev.pointerId)) root.current!.releasePointerCapture(ev.pointerId);
        if (handleDrag.current) { dropHandle(true); return; }
        feed({ t: 'up', button: buttonOf(ev.button), sx, sy });
      }}
      onPointerLeave={(ev) => { if (ignored(ev)) return; lastPointer.current = null; if (!gestures.current.busy) clearHover(); }}
      onKeyDown={(ev) => {
        if (ignored(ev)) return;
        if (ev.key === 'Escape') {
          // Taken by the gesture it cancels, or by the menu or connection pop-up it closes, it is not the floating panels'
          // (they close on an Escape nothing took).
          if (handleDrag.current || gestures.current.busy || menu || popup) ev.preventDefault();
          if (handleDrag.current) dropHandle(false); else feed({ t: 'key', key: 'Escape' });
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
            if (items.length > 0) askDelete(sc, items);
            else if (conns.length === 1) askDeleteConnection(sc.plan.id, conns[0]);
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
      <svg className="handles" ref={handlesSvg} />
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
          onEdit={(b) => edit(b).then((r) => r !== null && r.ok)} onClose={() => setPopup(null)} onRemoveMember={removeMember}
          onAddMember={(connection, node) => askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
            otherPlans(stateRef.current, props.plan, [node], connection), (everywhere) => edit(addMemberBuild(props.plan, connection, node, everywhere)))}
        />
      )}
      {question && <AskDialog q={question} onClose={() => { setQuestion(null); root.current?.focus(); }} />}
      {publication && (
        <PublicationDialog
          key={publication.key} params={props.params} deps={publicationDeps(publication)} onNotify={notify}
          onClose={() => { setPublication(null); root.current?.focus({ preventScroll: true }); }}
        />
      )}
    </div>
  );
}
