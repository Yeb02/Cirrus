import type { Id, State } from '@cirrus/core';
import { buildScene, type Camera, fitBounds, fitItem, navigate, type NavInput, type PlanScene, type RenderParams, sceneParamsKey, screenToWorld } from '@cirrus/view';
import 'pixi.js/unsafe-eval'; // eval-free shader and uniform code paths: the page's CSP forbids eval
import { Application, Assets } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
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
  const drag = useRef<{ x: number; y: number } | null>(null);
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
      engine.current = { app, renderer };
      setReady(true);
      let launchHover = window.cirrus.launch.hover?.split(',').map(Number);
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
              else { firstPending.current = false; props.onFirstFrame(); }
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

  return (
    <div
      className="graph"
      ref={root}
      tabIndex={0}
      onPointerDown={(ev) => {
        root.current!.focus();
        if (ev.button !== 0) return;
        const e = engine.current, hits = e?.renderer.hitIndex;
        if (!e || !hits) return;
        const { sx, sy } = local(ev);
        const w = screenToWorld(e.renderer.camera, sx, sy);
        // Background (open groups' included, spec 9.1) pans the view; moving elements comes with plan 3b.
        if (hits.hit(w.x, w.y, e.renderer.camera.zoom).kind !== 'background') return;
        drag.current = { x: ev.clientX, y: ev.clientY };
        root.current!.setPointerCapture(ev.pointerId);
      }}
      onPointerMove={(ev) => {
        if (drag.current) {
          nav({ t: 'drag', dxPx: ev.clientX - drag.current.x, dyPx: ev.clientY - drag.current.y });
          drag.current = { x: ev.clientX, y: ev.clientY };
          return;
        }
        const { sx, sy } = local(ev);
        hover(sx, sy);
      }}
      onPointerUp={(ev) => {
        if (drag.current) root.current!.releasePointerCapture(ev.pointerId);
        drag.current = null;
      }}
      onPointerLeave={() => { if (!drag.current) clearHover(); }}
      onKeyDown={(ev) => {
        if (!NAV_KEYS.has(ev.key)) return;
        ev.preventDefault();
        nav({ t: 'key', key: ev.key });
      }}
    >
      <div className="canvas-host" ref={host} />
      <HierarchyCorner
        chain={chain}
        onPick={(item) => { const e = engine.current, sc = sceneRef.current; if (e && sc) moveCamera(fitItem(sc, item, e.renderer.camera, paramsRef.current)); }}
      />
      <Tooltip tip={tip} />
    </div>
  );
}
