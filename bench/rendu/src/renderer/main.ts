import 'pixi.js/unsafe-eval'; // eval-free shader/uniform code paths: the page's CSP forbids eval
import { Application, Assets } from 'pixi.js';
import { runBenchPass } from '../bench/run';
import type { RunResult } from '../bench/metrics';
import { overviewCamera } from '../bench/scenario';
import { generateScene } from '../scene/generate';
import { BENCH_SCENE, DEFAULT_PARAMS } from '../scene/params';
import { SceneRenderer } from '../render/sceneRenderer';

const status = document.getElementById('status')!;

async function start(): Promise<void> {
  const app = new Application();
  const diag = new URLSearchParams(location.search);
  await app.init({ resizeTo: window, antialias: diag.get('aa') !== '0', background: '#0a1120', resolution: window.devicePixelRatio, autoDensity: true, preference: 'webgl', autoStart: false });
  document.body.appendChild(app.canvas);
  app.ticker.stop();
  Assets.setPreferences({ preferWorkers: false }); // no blob workers: the page's CSP forbids them
  await Assets.load('font/inter-msdf.fnt');

  await new Promise((r) => setTimeout(r, 0)); // let the status text paint
  const scene = generateScene(BENCH_SCENE, DEFAULT_PARAMS);
  const loadStart = performance.now(); // a plan's load: index, first visible set, first frame
  const params = diag.has('tol') ? { ...DEFAULT_PARAMS, curveTolerancePx: Number(diag.get('tol')) } : DEFAULT_PARAMS;
  const renderer = new SceneRenderer(app, scene, params);
  for (const layer of (diag.get('hide') ?? '').split(',').filter(Boolean)) renderer.hidden.add(layer);
  const warmUpMs = renderer.warmUp();
  const gl = (app.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
  console.log(`warm-up ${warmUpMs.toFixed(0)} ms; timer query ext: ${!!gl.getExtension('EXT_disjoint_timer_query_webgl2')}`);
  let cam = overviewCamera(scene, app.screen.width, app.screen.height);
  renderer.setCamera(cam);
  renderer.renderFrame();
  const loadMs = performance.now() - loadStart;

  const q = new URLSearchParams(location.search);
  if (q.get('bench') === '1') {
    status.textContent = `Mesure en cours : ${q.get('label')}`;
    await runBenchPass(app, scene, renderer, q.get('label') as RunResult['label'], loadMs, q.get('final') === '1');
    return;
  }
  // ?focusK=<step>&zoom=<z>: start on the first node of that step (visual checks at a given depth).
  if (q.has('focusK')) {
    const target = scene.nodes.find((n) => n.k === Number(q.get('focusK')) && n.parent >= 0)!;
    cam = { ...cam, x: target.x, y: target.y, zoom: Number(q.get('zoom') ?? 1) };
  }
  console.log(`screen ${app.screen.width}x${app.screen.height} css, dpr ${window.devicePixelRatio}, canvas ${app.canvas.width}x${app.canvas.height}`);

  // Interactive navigation for the visual check: left button held = pan, wheel = zoom around the cursor.
  let drag: { x: number; y: number } | null = null;
  app.canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    cam = { ...cam, x: cam.x - (e.clientX - drag.x) / cam.zoom, y: cam.y - (e.clientY - drag.y) / cam.zoom };
    drag = { x: e.clientX, y: e.clientY };
  });
  app.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    const wx = cam.x + (e.clientX - cam.widthPx / 2) / cam.zoom, wy = cam.y + (e.clientY - cam.heightPx / 2) / cam.zoom;
    const zoom = cam.zoom * f;
    cam = { ...cam, zoom, x: wx - (e.clientX - cam.widthPx / 2) / zoom, y: wy - (e.clientY - cam.heightPx / 2) / zoom };
  }, { passive: false });

  status.textContent = `${scene.nodes.length} nœuds, ${scene.connections.length} connexions — clic gauche enfoncé : déplacer, molette : zoom, F12 : capture`;
  const loop = () => {
    cam = { ...cam, widthPx: app.screen.width, heightPx: app.screen.height };
    renderer.setCamera(cam);
    renderer.renderFrame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void start();
