import type { Id, State } from '@cirrus/core';
import { buildScene, type Camera, fitBounds, type PlanScene, type RenderParams } from '@cirrus/view';
import 'pixi.js/unsafe-eval'; // eval-free shader and uniform code paths: the page's CSP forbids eval
import { Application, Assets } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
import { PlanRenderer } from '../render/PlanRenderer.ts';
import { FONT_URL, measureTitle } from '../render/texts.ts';

const hexNumber = (c: [number, number, number]) => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);

/** The camera a plan opens with: the launch option "x,y,zoom" for visual checks, else the plan framed. */
function initialCamera(scene: PlanScene, widthPx: number, heightPx: number, p: RenderParams, launchView?: string): Camera {
  const v = launchView?.split(',').map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) return { x: v[0], y: v[1], zoom: v[2], widthPx, heightPx };
  return fitBounds(scene.bounds, widthPx, heightPx, p);
}

/** Hosts the PixiJS canvas and draws the active plan (spec 8). */
export function GraphView(props: { state: State; plan: Id; params: RenderParams; onFirstFrame(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<{ app: Application; renderer: PlanRenderer } | null>(null);
  const cameras = useRef(new Map<Id, Camera>());
  const dirty = useRef(true);
  const first = useRef(true);
  const [ready, setReady] = useState(false);
  const [scene, setScene] = useState<PlanScene | null>(null);

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
      const warm = renderer.warmUp();
      console.log(`Shaders préchauffés en ${warm.toFixed(0)} ms.`);
      engine.current = { app, renderer };
      setReady(true);
      const loop = () => {
        const e = engine.current;
        if (e) {
          const cam = e.renderer.camera;
          if (cam.widthPx !== e.app.screen.width || cam.heightPx !== e.app.screen.height) {
            e.renderer.setCamera({ ...cam, widthPx: e.app.screen.width, heightPx: e.app.screen.height });
            dirty.current = true;
          }
          if (dirty.current) {
            dirty.current = false;
            e.renderer.renderFrame();
            if (first.current) { first.current = false; props.onFirstFrame(); }
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

  // The scene depends on the state, the plan and the parameters (box sizes); the measure needs the font loaded.
  useEffect(() => {
    if (!ready) return;
    setScene(buildScene(props.state, props.plan, measureTitle(props.params), props.params));
  }, [ready, props.state, props.plan, props.params]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !ready) return;
    e.renderer.setParams(props.params);
    dirty.current = true;
  }, [ready, props.params]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !scene) return;
    e.renderer.setScene(scene);
    const { width, height } = e.app.screen;
    const known = cameras.current.get(scene.plan.id);
    const cam = known ? { ...known, widthPx: width, heightPx: height } : initialCamera(scene, width, height, props.params, window.cirrus.launch.view);
    cameras.current.set(scene.plan.id, cam);
    e.renderer.setCamera(cam);
    dirty.current = true;
  }, [scene]);

  return <div className="graph" ref={host} tabIndex={0} />;
}
