import { type Camera, fitBounds, type PlanScene, type RenderParams } from '@cirrus/view';
import type { Application, WebGLRenderer } from 'pixi.js';
import type { PlanRenderer } from './render/PlanRenderer.ts';

/**
 * The app's rendering bench (spec 21, plan 3 task 9): the camera path of the plan 1 bench (overview, a descent through
 * every group level, a sideways pan, back out), on the real renderer. GPU time per frame by timer queries, CPU time of
 * renderFrame. The first second is left out (window showing).
 */
export interface Stats { p50: number; p95: number; max: number; n: number }
export interface BenchRun {
  label: string;
  gpuName: string;
  canvasPx: [number, number];
  gpuMs: Stats;
  /** GPU time of the frames without a rebuild (nor right after one): the drawing alone, without buffer uploads. */
  gpuSteadyMs: Stats;
  cpuMs: Stats;
  intervalMs: Stats;
  rebuilds: number;
  worstFrame: { t: number; cpuMs: number; rebuilt: boolean };
  loadMs: number;
  memoryMb: number;
  /** Why each rebuild happened: view left the prepared rectangle, a level changed state, zoom outgrew the curves. */
  reasons: Record<string, number>;
}

type Key = { t: number; cam: Omit<Camera, 'widthPx' | 'heightPx'> };

export function summarize(samples: number[]): Stats {
  if (samples.length === 0) return { p50: Number.NaN, p95: Number.NaN, max: Number.NaN, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), max: s[s.length - 1], n: s.length };
}

function path(scene: PlanScene, w: number, h: number, p: RenderParams): Key[] {
  const over = fitBounds(scene.bounds, w, h, p);
  const overview = { x: over.x, y: over.y, zoom: over.zoom };
  // The first of the deepest leaves (as the plan 1 bench): the descent crosses every level above it.
  let target = 0;
  scene.items.forEach((it, i) => { if (it.kind !== 'group' && it.depth > scene.items[target].depth) target = i; });
  const chain: number[] = [];
  for (let a = scene.items[target].parent; a >= 0; a = scene.items[a].parent) chain.unshift(a);
  const zoomFor = (memberK: number) => 8 / (p.baseFontPx * p.textScale * p.factor ** memberK);
  const keys: Key[] = [{ t: 0, cam: overview }, { t: 4, cam: overview }];
  const descent = [...chain.map((g) => ({ i: g, zoom: zoomFor(scene.items[g].maxChildK!) })), { i: target, zoom: 1.2 }];
  descent.forEach((d, j) => {
    const it = scene.items[d.i];
    keys.push({ t: 4 + (16 * (j + 1)) / descent.length, cam: { x: it.x, y: it.y, zoom: Math.max(d.zoom, overview.zoom) } });
  });
  const deep = keys[keys.length - 1].cam;
  keys.push({ t: 28, cam: { ...deep, x: deep.x + (3 * w) / deep.zoom } }, { t: 32, cam: deep }, { t: 40, cam: overview });
  return keys;
}

function cameraAt(keys: Key[], t: number): Key['cam'] {
  if (t <= keys[0].t) return keys[0].cam;
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i].t) continue;
    const a = keys[i - 1], b = keys[i], u = (t - a.t) / (b.t - a.t);
    return { x: a.cam.x + (b.cam.x - a.cam.x) * u, y: a.cam.y + (b.cam.y - a.cam.y) * u, zoom: a.cam.zoom ** (1 - u) * b.cam.zoom ** u };
  }
  return keys[keys.length - 1].cam;
}

export async function runBench(app: Application, renderer: PlanRenderer, scene: PlanScene, p: RenderParams, label: string, loadMs: number): Promise<BenchRun> {
  const gl = (app.renderer as WebGLRenderer).gl as WebGL2RenderingContext;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'inconnue';
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const keys = path(scene, app.screen.width, app.screen.height, p);
  const end = keys[keys.length - 1].t;
  const gpu: number[] = [], gpuSteady: number[] = [], cpu: number[] = [], intervals: number[] = [];
  const pending: { q: WebGLQuery; t: number; steady: boolean }[] = [];
  let previousRebuilt = false;
  let rebuilds = 0, worst = { t: 0, cpuMs: 0, rebuilt: false };
  const collect = () => {
    while (timer && pending.length > 0 && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, t, steady } = pending.shift()!;
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT) && t >= 1) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gpu.push(ms);
        if (steady) gpuSteady.push(ms);
      }
      gl.deleteQuery(q);
    }
  };
  await new Promise<void>((done) => {
    let start = -1, last = -1;
    const frame = (now: number) => {
      if (start < 0) start = now;
      const t = (now - start) / 1000;
      if (last >= 0 && (last - start) / 1000 >= 1) intervals.push(now - last);
      last = now;
      renderer.setCamera({ ...cameraAt(keys, t), widthPx: app.screen.width, heightPx: app.screen.height });
      const q = timer ? gl.createQuery() : null;
      if (timer && q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
      const t0 = performance.now();
      const rebuilt = renderer.renderFrame();
      const ms = performance.now() - t0;
      if (timer && q) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push({ q, t, steady: !rebuilt && !previousRebuilt }); }
      previousRebuilt = rebuilt;
      collect();
      if (t >= 1) {
        cpu.push(ms);
        if (ms > worst.cpuMs) worst = { t, cpuMs: ms, rebuilt };
      }
      if (rebuilt) rebuilds++;
      if (t < end) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  for (let i = 0; i < 30 && pending.length > 0; i++) { await new Promise((r) => requestAnimationFrame(r)); collect(); }

  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    label, gpuName, canvasPx: [app.canvas.width, app.canvas.height], gpuMs: summarize(gpu), gpuSteadyMs: summarize(gpuSteady), cpuMs: summarize(cpu),
    intervalMs: summarize(intervals), rebuilds, worstFrame: worst, loadMs, memoryMb: memory ? memory.usedJSHeapSize / 1e6 : Number.NaN,
    reasons: { ...renderer.reasons },
  };
}
