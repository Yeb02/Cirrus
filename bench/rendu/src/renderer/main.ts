import 'pixi.js/unsafe-eval'; // eval-free shader/uniform code paths: the page's CSP forbids eval
import { Application, Assets } from 'pixi.js';
import { generateScene } from '../scene/generate';
import { BENCH_SCENE, BOX_WORLD_WIDTH, DEFAULT_PARAMS } from '../scene/params';
import type { Camera, Scene } from '../scene/types';
import { SceneRenderer } from '../render/sceneRenderer';

const status = document.getElementById('status')!;

export function overviewCamera(s: Scene, widthPx: number, heightPx: number): Camera {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of s.nodes) {
    if (n.parent >= 0) continue;
    const r = Math.max(n.r, (BOX_WORLD_WIDTH / 2) * DEFAULT_PARAMS.factor ** n.k);
    minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
    minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
  }
  const zoom = 0.95 * Math.min(widthPx / (maxX - minX), heightPx / (maxY - minY));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, widthPx, heightPx };
}

async function start(): Promise<void> {
  const app = new Application();
  await app.init({ resizeTo: window, antialias: true, background: '#0a1120', resolution: window.devicePixelRatio, autoDensity: true, preference: 'webgl', autoStart: false });
  document.body.appendChild(app.canvas);
  app.ticker.stop();
  Assets.setPreferences({ preferWorkers: false }); // no blob workers: the page's CSP forbids them
  await Assets.load('font/inter-msdf.fnt');

  await new Promise((r) => setTimeout(r, 0)); // let the status text paint
  const scene = generateScene(BENCH_SCENE, DEFAULT_PARAMS);
  const renderer = new SceneRenderer(app, scene, DEFAULT_PARAMS);
  let cam = overviewCamera(scene, app.screen.width, app.screen.height);
  // ?focusK=<step>&zoom=<z>: start on the first node of that step (visual checks at a given depth).
  const q = new URLSearchParams(location.search);
  if (q.has('focusK')) {
    const target = scene.nodes.find((n) => n.k === Number(q.get('focusK')) && n.parent >= 0)!;
    cam = { ...cam, x: target.x, y: target.y, zoom: Number(q.get('zoom') ?? 1) };
    console.log(`focus ${target.id} k=${target.k} parent=${target.parent} at ${target.x.toFixed(1)},${target.y.toFixed(1)}`);
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
