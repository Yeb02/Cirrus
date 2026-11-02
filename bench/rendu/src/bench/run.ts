import type { Application, WebGLRenderer } from 'pixi.js';
import type { SceneRenderer } from '../render/sceneRenderer';
import type { Scene } from '../scene/types';
import { CRITERIA, evaluate, summarize, type RunResult } from './metrics';

/** The first second (window showing, fullscreen transition) is left out of every statistic. */
const WARMUP_S = 1;
import { toMarkdown } from './report';
import { benchScenario, cameraAt } from './scenario';

function gpuName(app: Application): string {
  const gl = (app.renderer as WebGLRenderer).gl;
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'inconnue';
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Plays the scenario once, records per-frame timings, appends the result; the final pass writes the report. */
export async function runBenchPass(app: Application, scene: Scene, renderer: SceneRenderer, label: RunResult['label'], loadMs: number, final: boolean): Promise<void> {
  if (label === 'throttled-x4') await window.bench.setCpuThrottle(4);
  const kf = benchScenario(scene, app.screen.width, app.screen.height);
  const intervals: number[] = [], steady: number[] = [], cpu: number[] = [], gpu: number[] = [];
  let rebuilds = 0, ribbonVerticesMax = 0;
  // GPU time per frame: a TIME_ELAPSED query around each frame, read back a few frames later when available.
  const gl = (app.renderer as WebGLRenderer).gl as WebGL2RenderingContext;
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const pending: { q: WebGLQuery; t: number }[] = [];
  let worstFrame: RunResult['worstFrame'];
  let worstRebuild: RunResult['worstRebuild'];
  const collect = () => {
    while (timer && pending.length > 0 && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, t } = pending.shift()!;
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
      if (!disjoint && t >= WARMUP_S) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };
  await new Promise<void>((done) => {
    let start = -1, last = -1, sinceRebuild = 99;
    const frame = (now: number) => {
      if (start < 0) start = now;
      const t = (now - start) / 1000;
      // The interval ending now covers the previous frame's work: skip the two after a rebuild for the GPU proxy.
      const counted = t >= WARMUP_S;
      // An interval belongs to the warm-up if it started there (it may end just after, e.g. a fullscreen transition).
      if (last >= 0 && (last - start) / 1000 >= WARMUP_S) {
        intervals.push(now - last);
        if (sinceRebuild >= 2) steady.push(now - last);
      }
      const interval = last >= 0 && (last - start) / 1000 >= WARMUP_S ? now - last : 0;
      last = now;
      const cam = cameraAt(kf, t);
      renderer.setCamera({ ...cam, widthPx: app.screen.width, heightPx: app.screen.height });
      const q = timer ? gl.createQuery() : null;
      if (timer && q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
      const r = renderer.renderFrame();
      if (timer && q) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push({ q, t }); }
      collect();
      if (counted) {
        cpu.push(r.cpuMs);
        if (!worstFrame || interval > worstFrame.intervalMs) worstFrame = { t, intervalMs: interval, cpuMs: r.cpuMs, rebuilt: r.rebuilt };
        if (r.rebuilt && (!worstRebuild || r.cpuMs > worstRebuild.totalMs)) worstRebuild = { t, totalMs: r.cpuMs, renderMs: renderer.lastRenderMs, ...renderer.lastRebuild };
      }
      if (r.cpuMs > 200) {
        const d = renderer.lastRebuild;
        console.log(`slow ${r.rebuilt ? "rebuild" : "frame"} t=${t.toFixed(1)}s zoom=${cam.zoom.toExponential(2)} total=${r.cpuMs.toFixed(0)}ms render=${renderer.lastRenderMs.toFixed(0)}ms heapDelta=${renderer.lastHeapDeltaMb.toFixed(0)}MB ${Object.entries(d).map(([k, v]) => `${k}=${Math.round(v)}`).join(' ')}`);
      }
      sinceRebuild = r.rebuilt ? 0 : sinceRebuild + 1;
      if (r.rebuilt) rebuilds++;
      ribbonVerticesMax = Math.max(ribbonVerticesMax, renderer.ribbonVertices);
      if (t < kf[kf.length - 1].t) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
  // Let the last queries complete.
  for (let i = 0; i < 30 && pending.length > 0; i++) { await new Promise((r) => requestAnimationFrame(r)); collect(); }
  if (label === 'throttled-x4') await window.bench.setCpuThrottle(1);

  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const result: RunResult = {
    label,
    gpuName: gpuName(app),
    canvasPx: [app.canvas.width, app.canvas.height],
    frameIntervalMs: summarize(intervals),
    steadyIntervalMs: summarize(steady),
    gpuMs: summarize(gpu),
    cpuMs: summarize(cpu),
    ribbonVerticesMax,
    worstFrame,
    worstRebuild,
    rebuilds,
    loadMs,
    memoryMb: memory ? memory.usedJSHeapSize / 1e6 : NaN,
    display: await window.bench.displayInfo(),
  };
  await window.bench.appendRun(JSON.stringify(result));
  if (final) {
    const runs = JSON.parse(await window.bench.loadRuns()) as RunResult[];
    const verdict = evaluate(runs, CRITERIA);
    const date = today();
    const suffix = new URLSearchParams(location.search).get('name');
    await window.bench.saveReport(suffix ? `rendu-${date}-${suffix}` : `rendu-${date}`, JSON.stringify({ date, runs, verdict }, null, 2), toMarkdown(runs, verdict, date));
  }
  window.bench.quit();
}
