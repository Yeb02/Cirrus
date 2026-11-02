import type { Id, State } from '@cirrus/core';
import {
  type Bounds, buildScene, type Camera, emptySelection, fitBounds, fitItem, GestureMachine, type Hit, type Input, inRectangle, type Intent, navigate, type NavInput,
  type PlanScene, type RenderParams, sceneParamsKey, screenToWorld, type Selection, toggle, worldToScreen,
} from '@cirrus/view';
import 'pixi.js/unsafe-eval'; // eval-free shader and uniform code paths: the page's CSP forbids eval
import { Application, Assets } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
import { runBench } from '../bench.ts';
import { PlanRenderer } from '../render/PlanRenderer.ts';
import { FONT_URL, measureTitle } from '../render/texts.ts';
import { HierarchyCorner, Tooltip } from './Overlays.tsx';

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

/**
 * Hosts the PixiJS canvas and draws the active plan (spec 8). Navigation (spec 8.1, 9.1): wheel zoom around the cursor,
 * drag on the background, + − and arrows when the graph has the focus. Hover lights a connection, names stubs and
 * phantoms, and shows the groups under the cursor.
 */
export function GraphView(props: { state: State; plan: Id; params: RenderParams; onFirstFrame(): void }) {
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

  // One PixiJS application for the window's lifetime.
  useEffect(() => {
    let cancelled = false, raf = 0;
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
      // Visual checks: CIRRUS_POINTER="down 700 370 ctrl; move 900 500; up 900 500" replays pointer events.
      let launchPointer = window.cirrus.launch.pointer;
      let settle = 0;
      const replay = (script: string) => {
        for (const step of script.split(';').map((x) => x.trim()).filter(Boolean)) {
          const [t, xs, ys, ...mods] = step.split(/\s+/);
          const sx = Number(xs), sy = Number(ys), button = mods.includes('right') ? 2 : 0;
          if (t === 'down') feed({ t: 'down', button, sx, sy, ctrl: mods.includes('ctrl'), alt: mods.includes('alt'), shift: mods.includes('shift'), hit: hitAt(sx, sy) });
          else if (t === 'move') feed({ t: 'move', sx, sy });
          else if (t === 'up') feed({ t: 'up', button, sx, sy });
          else if (t === 'key') feed({ t: 'key', key: xs });
        }
      };
      const loop = () => {
        const e = engine.current;
        if (e && sceneRef.current) {
          const cam = e.renderer.camera;
          if (cam.widthPx !== e.app.screen.width || cam.heightPx !== e.app.screen.height) {
            moveCamera(navigate(cam, { t: 'resize', widthPx: e.app.screen.width, heightPx: e.app.screen.height }, paramsRef.current));
          }
          if (dirty.current) {
            dirty.current = false;
            e.renderer.renderFrame();
            if (firstPending.current) {
              // Visual checks: a simulated hover is drawn before the capture is taken.
              if (launchHover && launchHover.length === 2) { hover(launchHover[0], launchHover[1]); launchHover = undefined; }
              else if (launchPointer) { replay(launchPointer); launchPointer = undefined; settle = 5; dirty.current = true; }
              else if (settle > 0) { settle--; dirty.current = true; }
              else {
                firstPending.current = false;
                props.onFirstFrame();
                const label = window.cirrus.launch.bench;
                if (label) {
                  // The bench drives the camera itself; the regular loop stops.
                  const loadMs = performance.now();
                  cancelAnimationFrame(raf);
                  void runBench(e.app, e.renderer, sceneRef.current, paramsRef.current, label, loadMs).then((run) => window.cirrus.benchDone(run));
                  return;
                }
              }
            }
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      cancelled = true;
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
    }
    sceneRef.current = scene;
    e.renderer.setScene(scene);
    clearHover();
    const { width, height } = e.app.screen;
    const known = cameras.current.get(scene.plan.id);
    moveCamera(known ? { ...known, widthPx: width, heightPx: height } : initialCamera(scene, width, height, props.params, window.cirrus.launch.view));
  }, [scene]);

  // Wheel: a native, non-passive listener (React's is passive and could not keep the page from scrolling).
  useEffect(() => {
    const el = root.current!;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      nav({ t: 'wheel', sx: ev.clientX - r.left, sy: ev.clientY - r.top, deltaY: ev.deltaY, ctrl: ev.ctrlKey });
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
        if (intent.ctrl) { if (target) setSelection((sel) => toggle(sel, target)); }
        else setSelection(target ? toggle(emptySelection(), target) : emptySelection());
        break;
      }
      case 'context': {
        // A right click outside the selection lets it go (spec 9.1); the menus come with task 7.
        const target = targetOf(intent.hit);
        const sel = selectionRef.current;
        if (!target || !(target.kind === 'item' ? sel.items : sel.connections).has(target.id)) setSelection(emptySelection());
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
      default:
        break;
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
        if (!gestures.current.busy) hover(sx, sy);
        feed({ t: 'move', sx, sy });
      }}
      onPointerUp={(ev) => {
        const { sx, sy } = local(ev);
        if (root.current!.hasPointerCapture(ev.pointerId)) root.current!.releasePointerCapture(ev.pointerId);
        feed({ t: 'up', button: buttonOf(ev.button), sx, sy });
      }}
      onPointerLeave={() => { if (!gestures.current.busy) clearHover(); }}
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
    </div>
  );
}
