import type { Action, Id, State, Vec2 } from '@cirrus/core';
import {
  type Bounds, type Camera, emptySelection, fitBounds, fitItem, GestureMachine, type Hit, type Input, inRectangle, type Intent, navigate,
  type NavInput,
  type PlanScene, type RenderParams, screenToWorld, type Selection, toggle, withOffsets, worldToScreen,
  dropEffects, dropTarget, type MenuItem, menuFor, otherPlans,
  isPinch, newlyPressed, renderPaused, type SceneIndex, type FontData, previewSplit, type PreviewSplit,
} from '@cirrus/view';
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { type BenchView, mark, runBench } from '../bench.ts';
import { connectionDrafts, consultations, jumpDraft } from '../consultations.ts';
import { createGl, type Gl } from '../gl/context.ts';
import { navKeyOf, sideButton } from '../navigation.ts';
import { loadFont } from '../render/font.ts';
import { overlayClosesSearch, type Overlays } from '../search/overlay.ts';
import { restoreRefusal, trashCloseGivesUp } from '../trash.ts';
import { PlanRenderer } from '../render/PlanRenderer.ts';
import { HierarchyCorner, Tooltip } from './Overlays.tsx';
import type { EditSession, Result } from '../session.ts';
import { absentBuild, addMemberBuild, type Build } from '../actions.ts';
import { ContextMenu, Ghost, TitleEditor } from './ContextMenu.tsx';
import { ConnectionPopup } from './ConnectionPopup.tsx';
import { AskDialog } from './Dialogs.tsx';
import { nodeOpenedBy } from './panels/Panels.tsx';
import type { Rect } from './panels/geometry.ts';
import type { Refusal } from '../files/nodeFiles.ts';
import type { LatexRegistry } from '../latex/registry.ts';
import { PublicationDialog } from './PublicationDialog.tsx';
import { BIB_WAITING, useBibImport } from './graph/bibImport.ts';
import { useCopyPaste } from './graph/copyPaste.ts';
import { type Editor, type Engine, type Graph, NOTHING_SHOWN } from './graph/core.ts';
import { useGraphDrop } from './graph/drop.ts';
import { useHover } from './graph/hover.ts';
import { ignored, measuring, replayPointer } from './graph/launch.ts';
import { useLayoutHandles } from './graph/layoutHandles.ts';
import { pickMenuAction } from './graph/menuActions.ts';
import { usePlacement } from './graph/placement.ts';
import { usePublicationImport } from './graph/publication.ts';
import { useQuestions } from './graph/questions.ts';
import { useRepercussion } from './graph/repercussion.ts';
import { Jumps } from './graph/jumps.ts';
import { Revealer, type RevealTarget } from './graph/reveal.ts';
import { useScaleWheel } from './graph/scaleWheel.ts';
import { useScenes } from './graph/scenes.ts';

/**
 * What App asks of the graph: files dropped at a point of it, as a drop of the user's (CIRRUS_IMPORT, captures); a jump
 * to an object (plan 6a, D2: Revealer), false at once for one gone, which pushes the place it leaves on the stack of
 * « précédent » et « suivant » (`back` and `forward`, false when there is nowhere to go); the focus back (the search closed);
 * a node of the trash to put down in the plan shown (`restore`, plan 6a, D5: « Restaurer » in the trash's panel), and that placement
 * given up (`cancelRestore`: the panel is closed).
 */
export interface GraphHandle {
  dropFilesAt(sx: number, sy: number, paths: string[], refused?: Refusal[]): Promise<void>;
  reveal(target: RevealTarget): boolean;
  back(): boolean;
  forward(): boolean;
  focus(): void;
  restore(node: Id): void;
  cancelRestore(): void;
}
/** Nothing found: the ring of the search drawn around nothing. */
const NOTHING_FOUND: readonly Id[] = Object.freeze([]);

/** The camera a plan opens with: the launch option "x,y,zoom" for visual checks, else the plan framed. */
function initialCamera(scene: PlanScene, widthPx: number, heightPx: number, p: RenderParams, launchView?: string): Camera {
  const v = launchView?.split(',').map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) return { x: v[0], y: v[1], zoom: v[2], widthPx, heightPx };
  return fitBounds(scene.bounds, widthPx, heightPx, p);
}

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
  /** Opens the tag registry's panel, from the background's menu (plan 6a, D4: App's). */
  onTagRegistry(): void;
  /** Opens the trash's panel, from the background's menu (plan 6a, D5: App's). */
  onTrash(): void;
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
  /** The open tabs in their order (App's): « Voir dans un autre plan » lists the plans in it (plan 6a, D3). */
  tabs: readonly Id[];
  /**
   * What the search box found in this plan, ringed in searchFoundColor while it is open (plan 6a, D1); the box itself
   * (`overlay`, App's), over the graph like the publication dialog.
   */
  found?: readonly Id[]; overlay?: ReactNode;
  /** A question or the graph's menu has opened: App closes the search box, so that none is hidden under its list. */
  onOverlay(): void;
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [popup, setPopup] = useState<{ x: number; y: number; connections: Id[] } | null>(null);
  /** A stub being dragged to a place of its own (spec 8.5). */
  const stubDrag = useRef<{ connection: Id; node: Id; title: string } | null>(null);
  /**
   * A gesture, a question, a repercussion or a .bib's import under way: Ctrl+Z and Ctrl+Y wait for it (I6 of the plan
   * 3b review), and so do a node dropped from a list and another .bib.
   */
  const busy = () => gestures.current.busy || dragging.current !== null || handles.held() || stubDrag.current !== null
    || repercussion.queued() || questions.asking() || bib.importing();
  /** Why `what` waits: the .bib's import put down (Escape does not give it up), or a gesture in progress. */
  const busyReason = (what: string) => (bib.bibWaiting() ? BIB_WAITING : `Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant ${what}.`);

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
   * preview's storage taken again), its split made once for the visible set drawn. `leaving`: the dragged items the
   * drop would take out of their group (Alt), which it does not follow (dropAt).
   */
  const previewDrag = (r: PlanRenderer, d: NonNullable<typeof dragging.current>, dx: number, dy: number, leaving: number[]) => {
    const visible = r.visible ?? NOTHING_SHOWN;
    if (d.split?.visible !== visible) d.split = previewSplit(d.base, visible, d.items);
    d.preview = withOffsets(d.base, new Map(d.items.map((i) => [i, { x: dx, y: dy }])), paramsRef.current, d.preview, leaving);
    r.preview(d.preview, d.split);
  };
  /**
   * What a drop of the drag at world point `at` would do (spec 10): the group it enters, lit while dragging, and the
   * dragged items it takes out of their group (Alt). Found by the state's index when it is the drag's scene's (what is
   * under the point only, not the plan: plan 3c task 9).
   */
  const dropAt = (d: NonNullable<typeof dragging.current>, at: Vec2, zoom: number): { entered: number | null; leaving: number[] } => {
    const t = dropTarget(d.base, at, d.items, zoom, paramsRef.current, indexOf(d.base));
    const effects = dropEffects(d.base, d.items, t, d.alt);
    return { entered: t !== null && effects.some((f) => f.enter === t) ? t : null, leaving: effects.filter((f) => f.leave).map((f) => f.item) };
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
  const tabsRef = useRef(props.tabs);
  tabsRef.current = props.tabs;
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
    if (placement.placing.current?.kind === 'connect' && lastPointer.current) placement.aimLine(lastPointer.current.x, lastPointer.current.y);
    if (placement.placing.current?.kind === 'bib' || bib.bibWaiting()) bib.showBib();
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
    root, engine, sceneRef, paramsRef, stateRef, sessionRef, onResultRef, onLongNoticeRef, selectionRef, setSelection, setEditor, gestures,
    dragging: () => dragging.current !== null, onOpenPlan: props.onOpenPlan, onTagRegistry: props.onTagRegistry, onTrash: props.onTrash, redraw, notify, edit, indexOf, hitAt, local,
    restoreScene, moveCamera, feed,
    busy, busyReason, tabsRef,
    get jumps() { return jumps.current!; },
    get scenes() { return scenes; }, get questions() { return questions; }, get placement() { return placement; }, get copyPaste() { return copyPaste; },
    get bib() { return bib; }, get publication() { return publication; }, get repercussion() { return repercussion; }, get handles() { return handles; },
  };
  const scenes = useScenes(graph, props, ready);
  const scene = scenes.scene;
  const { tip, chain, hover, clearHover } = useHover(graph);
  const questions = useQuestions(graph);
  // A question or the menu that opens over the search box closes it: it would be live under the list (overlayClosesSearch).
  const overlays = useRef<Overlays>({ question: false, menu: false });
  const onOverlay = useRef(props.onOverlay);
  onOverlay.current = props.onOverlay;
  const asked = questions.question !== null, menuOpen = menu !== null;
  useEffect(() => {
    const now = { question: asked, menu: menuOpen };
    if (overlayClosesSearch(overlays.current, now)) onOverlay.current();
    overlays.current = now;
  }, [asked, menuOpen]);
  const placement = usePlacement(graph);
  const copyPaste = useCopyPaste(graph);
  const bib = useBibImport(graph);
  const publication = usePublicationImport(graph, props.plan);
  const repercussion = useRepercussion(graph);
  const handles = useLayoutHandles(graph);
  const { settleWheel, wheelScale } = useScaleWheel(graph);
  const drop = useGraphDrop(graph, props.onDropFiles);
  /** The view as of the last render, for the revealer made once. */
  const latest = useRef(graph);
  latest.current = graph;
  const planRef = useRef(props.plan);
  planRef.current = props.plan;
  /** The object a jump framed, ringed searchFlashMs (plan 6a, D2), in place of what the search box found. */
  const [flash, setFlash] = useState<readonly Id[] | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  /** The ring of a jump ended before its time: a step back or forward leaves nothing blinking (fix round 1, M1). */
  const stopFlash = () => { clearTimeout(flashTimer.current); setFlash(null); };
  /** The jumps (D2): the plan opened, then its scene framed once shown (the [scene] effect below). */
  const revealer = useRef<Revealer | null>(null);
  revealer.current ??= new Revealer({
    state: () => stateRef.current, scene: () => sceneRef.current, plan: () => planRef.current,
    camera: () => engine.current?.renderer.camera ?? null, params: () => paramsRef.current,
    openPlan: (plan) => onOpenPlanRef.current(plan), moveCamera: (c) => latest.current.moveCamera(c),
    flash: (ids) => {
      clearTimeout(flashTimer.current);
      const ms = paramsRef.current.searchFlashMs;
      setFlash(ms > 0 ? ids : null);
      if (ms > 0) flashTimer.current = setTimeout(() => setFlash(null), ms);
    },
  });

  /**
   * The stack of « précédent » et « suivant » (plan 6a, D2) around the revealer: a jump pushes the place it leaves (the
   * plan shown and its camera); going back or forward restores a plan and its camera exactly (`cameras`: the scene
   * effect puts a plan's camera back as it shows it).
   */
  const jumps = useRef<Jumps | null>(null);
  jumps.current ??= new Jumps({
    state: () => stateRef.current,
    place: () => { const sc = sceneRef.current, cam = engine.current?.renderer.camera; return sc && cam ? { plan: sc.plan.id, camera: cam } : null; },
    max: () => paramsRef.current.navHistoryMax, busy: () => latest.current.busy(), stopFlash,
    remember: (plan, camera) => { cameras.current.set(plan, camera); },
    openPlan: (plan) => onOpenPlanRef.current(plan), moveCamera: (c) => latest.current.moveCamera(c),
    jumped: (j) => consultations.record(jumpDraft(j)),
  }, revealer.current);

  /** The items of the selection, as indices of this scene. */
  const selectedItems = (sc: PlanScene) => [...selectionRef.current.items].flatMap((id) => { const i = sc.byId.get(id); return i === undefined ? [] : [i]; });
  /** The pop-up of a connection (or of the connections a line stands for), next to the click (spec 8.5). */
  const openPopup = (connections: Id[], sx: number, sy: number) => {
    for (const draft of connectionDrafts(connections)) consultations.record(draft);
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
            // The group that would receive the drop lights up (spec 10), only if the drop would enter it; an item Alt
            // takes out of its group is drawn without it, which stays where it is (2026-11-11).
            const drop = dropAt(d, screenToWorld(e.renderer.camera, d.sx, d.sy), e.renderer.camera.zoom);
            previewDrag(e.renderer, d, d.dx, d.dy, drop.leaving);
            e.renderer.setDropTarget(drop.entered);
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
                  void runBench(view, label).then((run) => window.cirrus.benchDone!(run));
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
      bib.planLeft();
    }
    sceneRef.current = scene;
    scenes.showScene(e.renderer, scene);
    clearHover();
    const { width, height } = e.gl;
    const known = cameras.current.get(scene.plan.id);
    moveCamera(known ? { ...known, widthPx: width, heightPx: height } : initialCamera(scene, width, height, props.params, window.cirrus.launch.view));
    // A jump waiting for this plan frames its object now (plan 6a, D2); only the camera moves.
    revealer.current!.sceneShown();
    placement.startPending();
  }, [scene]);

  // The ring of what was found (plan 6a, D1, D2): a jump's object while it blinks, else what the search box found here.
  const ring = flash ?? props.found ?? NOTHING_FOUND, ringKey = ring.join('|');
  useEffect(() => {
    const e = engine.current;
    if (!e || !ready) return;
    e.renderer.setFound([...ring]);
    redraw();
  }, [ringKey, ready]);

  // Wheel: a native, non-passive listener (React's is passive and could not keep the page from scrolling).
  useEffect(() => {
    const el = root.current!;
    const onWheel = (ev: WheelEvent) => {
      // A pop-up, a question or the search box scrolls its own content.
      if (ignored(ev) || (ev.target as Element).closest?.('.popup, .ask, .search-box')) return;
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

  useImperativeHandle(props.ref, () => ({
    dropFilesAt: drop.dropFilesAt,
    reveal: (target) => jumps.current!.reveal(target),
    back: () => jumps.current!.back(),
    forward: () => jumps.current!.forward(),
    focus: () => root.current?.focus({ preventScroll: true }),
    restore: (node) => {
      // Its title follows the cursor as a paste's does, from where the pointer last was over the graph (else its centre),
      // until a click puts it down (restoreBuild) or Escape gives it up: the graph takes the focus for that Escape. Another
      // « Restaurer » replaces one under way; any other gesture is finished or given up first.
      const n = stateRef.current.nodes.get(node), el = root.current;
      if (!n || !el || !engine.current || !sceneRef.current) return;
      // A stale row: the node is back in a plan since (restored elsewhere, a sync, an undo) — no ghost follows the cursor for it.
      const refusal = restoreRefusal(n);
      if (refusal !== null) { notify(refusal); return; }
      if (busy() && placement.placing.current?.kind !== 'restore') { notify(busyReason('de restaurer')); return; }
      const r = el.getBoundingClientRect();
      placement.startPlacing({ kind: 'restore', node }, n.title || 'Sans titre', lastPointer.current ?? { x: r.width / 2, y: r.height / 2 });
      el.focus({ preventScroll: true });
      redraw();
    },
    // The trash's panel closed (× or Escape): the placement of a node being restored goes with it, as with its own Escape.
    cancelRestore: () => { if (trashCloseGivesUp(placement.placing.current)) feed({ t: 'cancel' }); },
  }));
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
        if (intent.hit.kind === 'stub') placement.startPlacing({ kind: 'import', node: intent.hit.node }, intent.hit.title, here);
        else if (intent.hit.kind === 'connection') openPopup(intent.hit.ids, intent.sx, intent.sy);
        else if (it?.phantom === 'absent') placement.startPlacing({ kind: 'import', node: it.node }, it.title, here);
        else if (it?.phantom === 'center') openPopup([it.connection!], intent.sx, intent.sy);
        else if (opened !== null) {
          const r = root.current!.getBoundingClientRect();
          panelsRef.current.open(opened, { x: r.left + intent.sx, y: r.top + intent.sy });
        }
        break;
      }
      case 'context': {
        // No menu while a .bib put down waits for its .bib: its choices put something down (review of task 6, M4).
        if (bib.bibWaiting()) { notify(BIB_WAITING); break; }
        // A right click outside the selection lets it go (spec 9.1), then opens the menu of what is under it.
        const target = targetOf(intent.hit);
        let sel = selectionRef.current;
        if (!target || !(target.kind === 'item' ? sel.items : sel.connections).has(target.id)) { sel = emptySelection(); setSelection(sel); }
        // On the background of an open group: that group's menu first (spec 9.1, I11 of the review).
        const w = screenToWorld(e.renderer.camera, intent.sx, intent.sy);
        const under = intent.hit.kind === 'background' ? e.renderer.hitIndex?.openGroupsAt(w.x, w.y, e.renderer.camera.zoom)[0] : undefined;
        const items = menuFor(stateRef.current, sc, intent.hit, sel, copyPaste.clip.current !== null, under === undefined ? undefined : sc.items[under].id);
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
          if (bib.bibWaiting()) { notify(BIB_WAITING); break; }
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
        if (sd) { placement.setGhost({ x: intent.sx, y: intent.sy, text: sd.title }); break; }
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
          placement.setGhost(null);
          edit(absentBuild(sc, sd.connection, sd.node, intent.at));
          break;
        }
        const d = dragging.current;
        dragging.current = null;
        if (!d) break;
        e.renderer.setDropTarget(null);
        // The preview stays exactly where it was dropped while a question may be asked.
        previewDrag(e.renderer, d, intent.dx, intent.dy, dropAt(d, intent.at, e.renderer.camera.zoom).leaving);
        // One action for the whole drop (spec 6.4): the moves, then the groups left and entered; refused or given up,
        // back to where it was; written, the scene follows the state.
        repercussion.dropAsking(d.base, d.items, intent.dx, intent.dy, intent.at, intent.alt, restoreScene);
        break;
      }
      case 'placeMove':
        placement.followCursor(intent.sx, intent.sy);
        break;
      case 'place':
        placement.place(e, sc, intent);
        break;
      case 'placeCancel':
        placement.cancelPlacing(e);
        break;
      case 'dragCancel': {
        if (stubDrag.current) { stubDrag.current = null; placement.setGhost(null); break; }
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
      if (placement.placing.current?.kind !== 'repercussion') feed({ t: 'cancel' });
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
      // Files, and nodes out of a list of annotations, dropped on the graph (graph/drop.ts).
      {...drop.handlers}
      onPointerDown={(ev) => {
        if (ignored(ev)) return;
        // The mouse's side buttons are « précédent » et « suivant » (plan 6a, D2), acted on by the window when released: not
        // a left press here, which would begin a gesture.
        if (sideButton(ev.button)) return;
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
        if (ignored(ev) || sideButton(ev.button)) return;
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
          if (ev.ctrlKey && key === 'c') { ev.preventDefault(); copyPaste.copy(sc, selectedItems(sc)); return; }
          if (ev.ctrlKey && key === 'v') { ev.preventDefault(); copyPaste.startPaste(lastPointer.current ?? { x: 0, y: 0 }); return; }
          if (ev.key === 'Delete') {
            const items = selectedItems(sc), conns = [...selectionRef.current.connections];
            if (items.length > 0) questions.askDelete(sc, items);
            else if (conns.length === 1) questions.askDeleteConnection(sc.plan.id, conns[0]);
            return;
          }
        }
        // The arrows with Alt move nothing (plan 6a, D2): Alt+← and Alt+→ are the window's.
        const key = navKeyOf(ev);
        if (key === null) return;
        ev.preventDefault();
        nav({ t: 'key', key });
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
      {placement.ghost && <Ghost x={placement.ghost.x} y={placement.ghost.y} text={placement.ghost.text} box={placement.ghost.box} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} onPick={(a) => pickMenuAction(graph, a, menu.hit, { x: menu.x, y: menu.y })} />}
      {editor && <TitleEditor x={editor.x} y={editor.y} width={editor.width} initial={editor.initial} onDone={(t) => { setEditor(null); editor.done(t); root.current?.focus(); }} />}
      {placement.line && <svg className="connect-line"><line x1={placement.line.x1} y1={placement.line.y1} x2={placement.line.x2} y2={placement.line.y2} /></svg>}
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
      {publication.dialog && (
        <PublicationDialog
          key={publication.dialog.key} params={props.params} deps={publication.publicationDeps(publication.dialog)} onNotify={notify}
          onClose={publication.closePublication} initialPdf={publication.dialog.pdf}
        />
      )}
      {props.overlay}
    </div>
  );
}
