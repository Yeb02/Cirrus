import { applyOp, branchKey, cloneState, type Id, type State, type Vec2 } from '@cirrus/core';
import {
  type Bounds, buildScene, type Camera, emptySelection, fitBounds, fitItem, GestureMachine, type Hit, type Input, inRectangle, type Intent, navigate, type NavInput,
  type PlanScene, type RenderParams, sceneParamsKey, screenToWorld, type Selection, toggle, withOffsets, worldToScreen,
  dropEffects, dropTarget, intruders, type MenuAction, type MenuItem, menuFor, stepWheel, type WheelSteps, type ConnectTarget, connectTarget, otherPlans,
  type Mode,
} from '@cirrus/view';
import 'pixi.js/unsafe-eval'; // eval-free shader and uniform code paths: the page's CSP forbids eval
import { Application, Assets } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
import { runBench } from '../bench.ts';
import { PlanRenderer } from '../render/PlanRenderer.ts';
import { FONT_URL, measureTitle } from '../render/texts.ts';
import { HierarchyCorner, Tooltip } from './Overlays.tsx';
import type { EditSession, Result } from '../session.ts';
import {
  absentBuild, addMemberBuild, type Build, connectBuild, createBuild, dropBuild, hideBuild, importBuild, joinBuild, removeMemberBuild, renameBuild,
  scaleBuild, splitBuild,
} from '../actions.ts';
import { ContextMenu, Ghost, TitleEditor } from './ContextMenu.tsx';
import { ConnectionPopup } from './ConnectionPopup.tsx';
import { AskDialog, type Question } from './Dialogs.tsx';

const hexNumber = (c: [number, number, number]) => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
const NAV_KEYS = new Set(['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** The camera a plan opens with: the launch option "x,y,zoom" for visual checks, else the plan framed. */
function initialCamera(scene: PlanScene, widthPx: number, heightPx: number, p: RenderParams, launchView?: string): Camera {
  const v = launchView?.split(',').map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) return { x: v[0], y: v[1], zoom: v[2], widthPx, heightPx };
  return fitBounds(scene.bounds, widthPx, heightPx, p);
}

type Tip = { x: number; y: number; text: string } | null;
type Chain = { item: number; title: string }[];
/** What a gesture without a held button will do once placed (spec 9.1). */
type Placing =
  | { kind: 'newNode' }
  | { kind: 'exclude'; base: PlanScene; items: number[]; from: Vec2 }
  /** Drawing a connection from this node (spec 11.1). */
  | { kind: 'connect'; node: Id }
  /** Bringing in a node from a stub (spec 11.3). */
  | { kind: 'import'; node: Id }
  /** Splitting an arm (spec 8.5): the far node's phantom near the bundle, then the centre's near the far node. */
  | { kind: 'split'; step: 1 | 2; connection: Id; node: Id; title: string; home: Camera; near?: Vec2 };
const MODE: Record<Placing['kind'], Mode> = { newNode: 'place', exclude: 'exclude', connect: 'connect', import: 'place', split: 'split' };

/**
 * Hosts the PixiJS canvas and draws the active plan (spec 8). Navigation (spec 8.1, 9.1): wheel zoom around the cursor,
 * drag on the background, + − and arrows when the graph has the focus. Hover lights a connection, names stubs and
 * phantoms, and shows the groups under the cursor.
 */
export function GraphView(props: {
  state: State; plan: Id; params: RenderParams; onFirstFrame(): void;
  /** Edits go through the session (written, undoable); their outcome is reported (toasts). */
  session: EditSession | null; onResult(r: Result): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<{ app: Application; renderer: PlanRenderer } | null>(null);
  const cameras = useRef(new Map<Id, Camera>());
  const sceneRef = useRef<PlanScene | null>(null);
  const paramsRef = useRef(props.params);
  const dirty = useRef(true);
  const firstPending = useRef(true);
  const gestures = useRef(new GestureMachine(props.params));
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [rect, setRect] = useState<Bounds | null>(null);
  /** A drag in progress: the moved items (top-most), the scene it started from, the world offset so far. */
  const dragging = useRef<{ items: number[]; base: PlanScene; dx: number; dy: number; sx: number; sy: number; alt: boolean; dirty: boolean } | null>(null);
  const intrudersRef = useRef(new Map<number, number>());
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hit: Hit; items: MenuItem[] } | null>(null);
  const [editor, setEditor] = useState<{ x: number; y: number; width: number; initial: string; done(title: string | null): void } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; text: string } | null>(null);
  const placing = useRef<Placing | null>(null);
  /** The straight line that follows the cursor while a connection is drawn (screen coordinates). */
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [popup, setPopup] = useState<{ x: number; y: number; connections: Id[] } | null>(null);
  /** A stub being dragged to a place of its own (spec 8.5). */
  const stubDrag = useRef<{ connection: Id; node: Id; title: string } | null>(null);

  /** Runs an edit; a refusal is reported (toast) and `onRefused` restores what the preview had changed. */
  const edit = (build: Build, onRefused?: () => void) => {
    const session = sessionRef.current;
    if (!build || !session) { onRefused?.(); return; }
    void session.run(build).then((r) => {
      if (!r.ok) onRefused?.();
      onResultRef.current(r);
    });
  };
  // Handlers registered once (wheel, render loop) read the current state through this ref, never a stale closure.
  const stateRef = useRef(props.state);
  stateRef.current = props.state;
  const sessionRef = useRef(props.session);
  sessionRef.current = props.session;
  const onResultRef = useRef(props.onResult);
  onResultRef.current = props.onResult;
  const [ready, setReady] = useState(false);
  const [scene, setScene] = useState<PlanScene | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  const [chain, setChain] = useState<Chain>([]);
  paramsRef.current = props.params;

  const moveCamera = (next: Camera) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    e.renderer.setCamera(next);
    cameras.current.set(sc.plan.id, next);
    dirty.current = true;
    // Wheel and arrows stay active while a connection is drawn: its line follows the node.
    if (placing.current?.kind === 'connect' && lastPointer.current) aimLine(lastPointer.current.x, lastPointer.current.y);
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
    dirty.current = true;
    let text: string | null = null;
    if (h.kind === 'stub') text = `absent : ${e.renderer.visible!.connections[h.conn].stubs[h.stub].title}`;
    else if (h.kind === 'item' && intrudersRef.current.has(h.item)) text = `intrus dans le groupe « ${sc.items[intrudersRef.current.get(h.item)!].title} »`;
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
    dirty.current = true;
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
    dirty.current = true;
    return t;
  };
  const endConnect = () => {
    const r = engine.current?.renderer;
    setLine(null);
    r?.setCoresShown(false);
    r?.setDropTarget(null);
    r?.setHover(null);
    dirty.current = true;
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
    const shownIn = [...s.plans.keys()].filter((p) => s.branches.has(branchKey({ plan: p, connection, node })));
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
  /** The pop-up of a connection (or of the connections a line stands for), next to the click (spec 8.5). */
  const openPopup = (connections: Id[], sx: number, sy: number) => {
    const r = root.current!.getBoundingClientRect();
    setPopup({ connections, x: Math.max(8, Math.min(sx + 12, r.width - 332)), y: Math.max(8, Math.min(sy + 12, r.height - 340)) });
  };

  // One PixiJS application for the window's lifetime.
  useEffect(() => {
    let cancelled = false, raf = 0;
    let resizeObserver: ResizeObserver | null = null;
    const app = new Application();
    void (async () => {
      await app.init({
        resizeTo: host.current!, antialias: false, background: hexNumber(props.params.skyColor), resolution: window.devicePixelRatio || 1,
        autoDensity: true, preference: 'webgl', autoStart: false,
      });
      if (cancelled) { app.destroy(true); return; }
      app.ticker.stop();
      // A resized canvas is cleared: draw again even if the CSS size (the camera's) did not change.
      app.renderer.on('resize', () => { dirty.current = true; });
      // The host also resizes without the window (the settings panel opening): Pixi only listens to the window (C2).
      resizeObserver = new ResizeObserver(() => { app.resize(); dirty.current = true; });
      resizeObserver.observe(host.current!);
      host.current!.appendChild(app.canvas);
      Assets.setPreferences({ preferWorkers: false }); // no blob workers: the page's CSP forbids them
      await Assets.load(FONT_URL);
      const renderer = new PlanRenderer(app, props.params);
      console.log(`Shaders préchauffés en ${renderer.warmUp().toFixed(0)} ms.`);
      for (const layer of (window.cirrus.launch.hide ?? '').split(',').filter(Boolean)) renderer.hidden.add(layer);
      renderer.onUpdate = () => { dirty.current = true; };
      engine.current = { app, renderer };
      setReady(true);
      let launchHover = window.cirrus.launch.hover?.split(',').map(Number);
      // Visual checks: CIRRUS_POINTER="down 700 370 ctrl; move 900 500; up 900 500" replays pointer events; phases
      // separated by "|" are replayed a few frames apart (a menu opened, then chosen: "click .context-menu button").
      const launchPhases = (window.cirrus.launch.pointer ?? '').split('|').map((x) => x.trim()).filter(Boolean);
      let settle = 0;
      const replay = (script: string) => {
        for (const step of script.split(';').map((x) => x.trim()).filter(Boolean)) {
          if (step.startsWith('click ')) { document.querySelector<HTMLElement>(step.slice(6))?.click(); continue; }
          const [t, xs, ys, ...mods] = step.split(/\s+/);
          const sx = Number(xs), sy = Number(ys), button = mods.includes('right') ? 2 : 0;
          if (t === 'down') feed({ t: 'down', button, sx, sy, ctrl: mods.includes('ctrl'), alt: mods.includes('alt'), shift: mods.includes('shift'), hit: hitAt(sx, sy) });
          else if (t === 'move') feed({ t: 'move', sx, sy });
          else if (t === 'up') feed({ t: 'up', button, sx, sy });
          else if (t === 'key') feed({ t: 'key', key: xs });
          else if (t === 'wheel') {
            const r = root.current!.getBoundingClientRect();
            root.current!.dispatchEvent(new WheelEvent('wheel', { clientX: sx + r.left, clientY: sy + r.top, deltaY: Number(mods[0] ?? -120), ctrlKey: mods.includes('ctrl'), cancelable: true }));
          }
        }
      };
      // One exception must not stop the drawing for good (C1 of the plan 3 review): it is reported and the loop goes on.
      const loop = () => {
        try { step(); } catch (err) { console.error('Erreur de rendu :', err); }
        if (!stopped) raf = requestAnimationFrame(loop);
      };
      let stopped = false;
      const step = () => {
        const e = engine.current;
        if (e && sceneRef.current) {
          const cam = e.renderer.camera;
          if (cam.widthPx !== e.app.screen.width || cam.heightPx !== e.app.screen.height) {
            moveCamera(navigate(cam, { t: 'resize', widthPx: e.app.screen.width, heightPx: e.app.screen.height }, paramsRef.current));
          }
          // A drag in progress: its preview is drawn at most once per frame.
          const d = dragging.current;
          if (d && d.dirty) {
            d.dirty = false;
            e.renderer.setScene(withOffsets(d.base, new Map(d.items.map((i) => [i, { x: d.dx, y: d.dy }])), paramsRef.current), true);
            // The group that would receive the drop lights up (spec 10), only if the drop would enter it.
            const at = screenToWorld(e.renderer.camera, d.sx, d.sy);
            const t = dropTarget(d.base, at, d.items, e.renderer.camera.zoom, paramsRef.current);
            e.renderer.setDropTarget(t !== null && dropEffects(d.base, d.items, t, d.alt).some((f) => f.enter === t) ? t : null);
            dirty.current = true;
          }
          if (dirty.current) {
            dirty.current = false;
            const rebuilt = e.renderer.renderFrame();
            // What is under a resting pointer changes with the drawn set (I1 of the review): look again.
            if (rebuilt && lastPointer.current && !gestures.current.busy) hover(lastPointer.current.x, lastPointer.current.y);
            if (firstPending.current) {
              // Visual checks: a simulated hover is drawn before the capture is taken.
              if (launchHover && launchHover.length === 2) { hover(launchHover[0], launchHover[1]); launchHover = undefined; }
              else if (settle > 0) { settle--; dirty.current = true; }
              else if (launchPhases.length > 0) { replay(launchPhases.shift()!); settle = 5; dirty.current = true; }
              else {
                firstPending.current = false;
                props.onFirstFrame();
                const label = window.cirrus.launch.bench;
                if (label) {
                  // The bench drives the camera itself; the regular loop stops.
                  const loadMs = performance.now();
                  stopped = true;
                  void runBench(e.app, e.renderer, sceneRef.current, paramsRef.current, label, loadMs).then((run) => window.cirrus.benchDone(run));
                  return;
                }
              }
            }
          }
        }
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      cancelAnimationFrame(raf);
      engine.current?.renderer.destroy();
      engine.current?.app.destroy(true);
      engine.current = null;
    };
  }, []);

  // The scene depends on the state, the plan and the few parameters it reads (box sizes): a colour or a threshold
  // changed in the settings panel does not rebuild it. The measure needs the font loaded.
  const sceneKey = sceneParamsKey(props.params);
  useEffect(() => {
    if (!ready) return;
    setScene(buildScene(props.state, props.plan, measureTitle(paramsRef.current), paramsRef.current));
  }, [ready, props.state, props.plan, sceneKey]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !ready) return;
    e.renderer.setParams(props.params);
    dirty.current = true;
  }, [ready, props.params]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !scene) return;
    // Another plan: the gesture in progress and the selection do not follow.
    if (sceneRef.current && sceneRef.current.plan.id !== scene.plan.id) {
      feed({ t: 'cancel' });
      setSelection(emptySelection());
      setPopup(null);
    }
    sceneRef.current = scene;
    e.renderer.setScene(scene);
    // Items covered by an envelope they do not belong to: an orange ring and a tooltip (spec 10).
    intrudersRef.current = intruders(scene);
    e.renderer.setIntruders([...intrudersRef.current.keys()]);
    clearHover();
    const { width, height } = e.app.screen;
    const known = cameras.current.get(scene.plan.id);
    moveCamera(known ? { ...known, widthPx: width, heightPx: height } : initialCamera(scene, width, height, props.params, window.cirrus.launch.view));
  }, [scene]);

  // Wheel: a native, non-passive listener (React's is passive and could not keep the page from scrolling).
  useEffect(() => {
    const el = root.current!;
    const onWheel = (ev: WheelEvent) => {
      // A pop-up or a question scrolls its own content.
      if ((ev.target as Element).closest?.('.popup, .ask')) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      if (ev.ctrlKey) { wheelScale(sx, sy, ev.deltaY); return; }
      nav({ t: 'wheel', sx, sy, deltaY: ev.deltaY, ctrl: false });
      hover(sx, sy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (ev: React.PointerEvent) => {
    const r = root.current!.getBoundingClientRect();
    return { sx: ev.clientX - r.left, sy: ev.clientY - r.top };
  };
  const hitAt = (sx: number, sy: number): Hit => {
    const e = engine.current, hits = e?.renderer.hitIndex;
    if (!e || !hits) return { kind: 'background' };
    const w = screenToWorld(e.renderer.camera, sx, sy);
    return hits.hit(w.x, w.y, e.renderer.camera.zoom);
  };
  /** The object a hit designates, for the selection: an item, or a connection (by its stub too). */
  const targetOf = (h: Hit): { kind: 'item' | 'connection'; id: Id } | null => {
    const sc = sceneRef.current, vis = engine.current?.renderer.visible;
    if (!sc) return null;
    if (h.kind === 'item') return { kind: 'item', id: sc.items[h.item].id };
    if ((h.kind === 'connection' || h.kind === 'stub') && vis) return { kind: 'connection', id: sc.connections[vis.connections[h.conn].conns[0]].id };
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
        const target = targetOf(intent.hit);
        if (intent.ctrl) { if (target) setSelection((sel) => toggle(sel, target)); break; }
        setSelection(target ? toggle(emptySelection(), target) : emptySelection());
        // A stub or an absent phantom brings its node in (spec 11.3); a connection or a centre phantom opens its pop-up (spec 8.5).
        const vis = e.renderer.visible, here = { x: intent.sx, y: intent.sy };
        if (intent.hit.kind === 'stub' && vis) {
          const st = vis.connections[intent.hit.conn].stubs[intent.hit.stub];
          startPlacing({ kind: 'import', node: st.node }, st.title, here);
        } else if (intent.hit.kind === 'connection' && vis) {
          openPopup(vis.connections[intent.hit.conn].conns.map((c) => sc.connections[c].id), intent.sx, intent.sy);
        } else if (intent.hit.kind === 'item') {
          const it = sc.items[intent.hit.item];
          if (it.phantom === 'absent') startPlacing({ kind: 'import', node: it.node }, it.title, here);
          else if (it.phantom === 'center') openPopup([it.connection!], intent.sx, intent.sy);
        }
        break;
      }
      case 'context': {
        // A right click outside the selection lets it go (spec 9.1), then opens the menu of what is under it.
        const target = targetOf(intent.hit);
        let sel = selectionRef.current;
        if (!target || !(target.kind === 'item' ? sel.items : sel.connections).has(target.id)) { sel = emptySelection(); setSelection(sel); }
        const items = menuFor(stateRef.current, sc, intent.hit, sel, false, e.renderer.visible);
        if (items.length > 0) setMenu({ x: intent.sx, y: intent.sy, hit: intent.hit, items });
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
          const vc = e.renderer.visible?.connections[intent.hit.conn], st = vc?.stubs[intent.hit.stub];
          if (vc && st) stubDrag.current = { connection: sc.connections[vc.conns[0]].id, node: st.node, title: st.title };
          break;
        }
        // An element moves with the whole selection if it belongs to it (spec 9.1); a group with all it contains.
        if (intent.hit.kind !== 'item') break;
        const id = sc.items[intent.hit.item].id;
        const sel = selectionRef.current;
        const chosen = sel.items.has(id) ? [...sel.items].flatMap((x) => { const i = sc.byId.get(x); return i === undefined ? [] : [i]; }) : [intent.hit.item];
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
        // One action for the whole drop (spec 6.4): the moves, then the groups left and entered.
        const build = dropBuild(d.base, d.items, intent.dx, intent.dy, intent.at, intent.alt, e.renderer.camera.zoom, paramsRef.current);
        if (!build) { e.renderer.setScene(d.base); break; }
        // Refused: back to where it was. Written: the scene follows the state.
        edit(build, () => { engine.current?.renderer.setScene(d.base); dirty.current = true; });
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
              otherPlans(s, sc.plan.id, [what.node], sc.connections[t.conn].id), (everywhere) => edit(connectBuild(sc, from, t, everywhere)));
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
          edit(splitBuild(sc, what.connection, what.node, what.near!, intent.at));
          break;
        }
        placing.current = null;
        setGhost(null);
        if (what.kind === 'import') edit(importBuild(sc, what.node, intent.at, zoom, p));
        else if (what.kind === 'newNode') {
          // The node is placed, then named in place (spec 12); the creation is written with its title, as one step.
          const width = Math.max(140, (p.boxWidth - 2 * p.boxPadX) * p.textScale * zoom * p.factor ** Math.round(Math.log(1 / (zoom * p.textScale)) / Math.log(p.factor)));
          setEditor({ x: sp.x, y: sp.y, width, initial: '', done: (title) => { if (title) edit(createBuild(sc, title, intent.at, zoom, p)); } });
        } else if (what.kind === 'exclude') {
          // Out of its group, put down where clicked; entering the group under the cursor if it is another (spec 10).
          edit(dropBuild(what.base, what.items, intent.at.x - what.from.x, intent.at.y - what.from.y, intent.at, true, zoom, p));
        }
        break;
      }
      case 'placeCancel': {
        const what = placing.current;
        placing.current = null;
        setGhost(null);
        if (what?.kind === 'connect') endConnect();
        if (what?.kind === 'split' && what.step === 2) moveCamera({ ...what.home, widthPx: e.renderer.camera.widthPx, heightPx: e.renderer.camera.heightPx });
        break;
      }
      case 'dragCancel': {
        if (stubDrag.current) { stubDrag.current = null; setGhost(null); break; }
        const d = dragging.current;
        dragging.current = null;
        e.renderer.setDropTarget(null);
        if (d) e.renderer.setScene(d.base);
        break;
      }
      default:
        break;
    }
    dirty.current = true;
  };
  /**
   * Ctrl+wheel (spec 8.1): the step of the selection or of the element under the cursor. The notches of one gesture
   * are previewed at once and written as one action when the wheel pauses (stepWheel).
   */
  const wheelGesture = useRef<{ steps: WheelSteps; base: PlanScene; items: number[]; timer: number } | null>(null);
  const commitScale = (g: { steps: WheelSteps; base: PlanScene; items: number[] }) => {
    if (g.steps.delta === 0) { engine.current?.renderer.setScene(g.base); return; }
    edit(scaleBuild(g.base, g.items, g.steps.delta, paramsRef.current), () => { engine.current?.renderer.setScene(g.base); dirty.current = true; });
  };
  const wheelScale = (sx: number, sy: number, deltaY: number) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    const h = hitAt(sx, sy);
    const prev = wheelGesture.current;
    // Within a gesture the scene shown is a preview: the target is read on the scene the gesture started from.
    const base = prev ? prev.base : sc;
    if (h.kind !== 'item') return;
    const id = sc.items[h.item].id, sel = selectionRef.current;
    const ids = sel.items.has(id) ? [...sel.items] : [id];
    const items = ids.flatMap((x) => { const i = base.byId.get(x); return i === undefined ? [] : [i]; });
    const steps = stepWheel(prev?.steps ?? null, [...ids].sort().join(','), deltaY, performance.now(), paramsRef.current);
    if (prev) window.clearTimeout(prev.timer);
    if (steps.flush && prev) commitScale(prev);
    const gesture = { steps, base: steps.flush || !prev ? sc : prev.base, items, timer: 0 };
    gesture.items = ids.flatMap((x) => { const i = gesture.base.byId.get(x); return i === undefined ? [] : [i]; });
    // Preview: the state as the action would leave it, drawn without writing anything.
    const build = scaleBuild(gesture.base, gesture.items, steps.delta, paramsRef.current);
    if (build) {
      const preview = cloneState(stateRef.current);
      for (const op of build(preview).ops) applyOp(preview, op);
      e.renderer.setScene(buildScene(preview, gesture.base.plan.id, measureTitle(paramsRef.current), paramsRef.current), true);
    } else e.renderer.setScene(gesture.base, true);
    gesture.timer = window.setTimeout(() => { wheelGesture.current = null; commitScale(gesture); }, paramsRef.current.scaleGesturePauseMs);
    wheelGesture.current = gesture;
    dirty.current = true;
  };

  /** A menu choice (spec 9.1): on the element clicked, or on the whole selection when it belongs to it. */
  const pick = (action: MenuAction, hit: Hit, at: { x: number; y: number }) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    const p = paramsRef.current, sel = selectionRef.current;
    const clicked = hit.kind === 'item' ? hit.item : -1;
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
        edit(hideBuild(sc, targets.map((i) => sc.items[i].id)));
        break;
      case 'connect':
        // A straight line follows the cursor from the node; 1-to-1 connections show their centre, a target too (spec 11.1).
        if (clicked < 0) break;
        e.renderer.setCoresShown(true);
        startPlacing({ kind: 'connect', node: sc.items[clicked].node }, null, at);
        aimLine(at.x, at.y);
        break;
      case 'splitArm': {
        const vc = hit.kind === 'connection' ? e.renderer.visible?.connections[hit.conn] : undefined;
        const far = hit.kind === 'connection' && hit.key !== null ? sc.byId.get(hit.key) : undefined;
        if (!vc || far === undefined) break;
        const it = sc.items[far];
        startPlacing({ kind: 'split', step: 1, connection: sc.connections[vc.conns[0]].id, node: it.id, title: it.title, home: e.renderer.camera }, `fantôme : ${it.title}`, at);
        break;
      }
      case 'joinArm': {
        if (clicked >= 0 && sc.items[clicked].kind === 'phantom') {
          const it = sc.items[clicked];
          edit(joinBuild(sc.plan.id, it.connection!, it.node));
        } else if (hit.kind === 'connection') {
          const vc = e.renderer.visible?.connections[hit.conn], c = vc && sc.connections[vc.conns[0]];
          if (c && c.part === 'far') edit(joinBuild(sc.plan.id, c.id, c.ends[0].key));
        }
        break;
      }
      case 'teleport': {
        // To the original (spec 8.5): the far node; for the centre, the far node's phantom by the bundle. Its place in
        // the navigation history comes with plan 6.
        if (clicked < 0) break;
        const it = sc.items[clicked];
        const dest = it.phantom === 'node'
          ? sc.byId.get(it.node) ?? -1
          : sc.items.findIndex((x) => x.phantom === 'node' && x.connection === it.connection && x.node === it.node);
        if (dest < 0) { onResultRef.current({ ok: false, message: 'L’original n’est pas dans ce plan.' }); break; }
        moveCamera({ ...e.renderer.camera, x: sc.items[dest].x, y: sc.items[dest].y });
        break;
      }
      case 'importNode': {
        const st = hit.kind === 'stub' ? e.renderer.visible?.connections[hit.conn].stubs[hit.stub] : undefined;
        const node = st ? st.node : clicked >= 0 ? sc.items[clicked].node : null;
        if (node) startPlacing({ kind: 'import', node }, st ? st.title : sc.items[clicked].title, at);
        break;
      }
      default:
        // Copy and paste, deletion, adding to the lobby, a connection's layout: plan 3b, tasks 10 and 11.
        onResultRef.current({ ok: false, message: 'Cette action arrive avec une prochaine étape du plan 3b.' });
    }
    dirty.current = true;
  };
  const feed = (input: Input) => {
    const e = engine.current;
    if (!e) return;
    for (const intent of gestures.current.feed(input, e.renderer.camera)) handle(intent);
  };
  const buttonOf = (b: number): 0 | 1 | 2 => (b === 2 ? 2 : b === 1 ? 1 : 0);

  // A lost focus abandons the gesture in progress (Review Focus 2 of plan 3b).
  useEffect(() => {
    const onBlur = () => feed({ t: 'cancel' });
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);
  useEffect(() => {
    engine.current?.renderer.setSelection(selection);
    dirty.current = true;
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
      onPointerDown={(ev) => {
        root.current!.focus();
        const { sx, sy } = local(ev);
        root.current!.setPointerCapture(ev.pointerId);
        feed({ t: 'down', button: buttonOf(ev.button), sx, sy, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, hit: hitAt(sx, sy) });
      }}
      onPointerMove={(ev) => {
        const { sx, sy } = local(ev);
        lastPointer.current = { x: sx, y: sy };
        if (!gestures.current.busy) hover(sx, sy);
        feed({ t: 'move', sx, sy });
      }}
      onPointerUp={(ev) => {
        const { sx, sy } = local(ev);
        if (root.current!.hasPointerCapture(ev.pointerId)) root.current!.releasePointerCapture(ev.pointerId);
        feed({ t: 'up', button: buttonOf(ev.button), sx, sy });
      }}
      onPointerLeave={() => { lastPointer.current = null; if (!gestures.current.busy) clearHover(); }}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') { feed({ t: 'key', key: 'Escape' }); return; }
        if (!NAV_KEYS.has(ev.key)) return;
        ev.preventDefault();
        nav({ t: 'key', key: ev.key });
      }}
    >
      <div className="canvas-host" ref={host} />
      {rectStyle && <div className="select-rect" style={rectStyle} />}
      <HierarchyCorner
        chain={chain}
        onPick={(item) => { const e = engine.current, sc = sceneRef.current; if (e && sc) moveCamera(fitItem(sc, item, e.renderer.camera, paramsRef.current)); }}
      />
      <Tooltip tip={tip} />
      {ghost && <Ghost x={ghost.x} y={ghost.y} text={ghost.text} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} onPick={(a) => pick(a, menu.hit, { x: menu.x, y: menu.y })} />}
      {editor && <TitleEditor x={editor.x} y={editor.y} width={editor.width} initial={editor.initial} onDone={(t) => { setEditor(null); editor.done(t); root.current?.focus(); }} />}
      {line && <svg className="connect-line"><line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} /></svg>}
      {popup && (
        <ConnectionPopup
          key={`${popup.connections.join()}|${popup.x}|${popup.y}`} state={props.state} plan={props.plan} connections={popup.connections} x={popup.x} y={popup.y}
          onEdit={(b) => edit(b)} onClose={() => setPopup(null)} onRemoveMember={removeMember}
          onAddMember={(connection, node) => askWhere('Ajouter aussi ce nœud à la connexion dans les autres plans où elle est affichée ?',
            otherPlans(stateRef.current, props.plan, [node], connection), (everywhere) => edit(addMemberBuild(props.plan, connection, node, everywhere)))}
        />
      )}
      {question && <AskDialog q={question} onClose={() => { setQuestion(null); root.current?.focus(); }} />}
    </div>
  );
}
