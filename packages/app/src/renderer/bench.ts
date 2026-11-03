import type { Id } from '@cirrus/core';
import { type Camera, fitBounds, type Input, type PlanScene, type RenderParams } from '@cirrus/view';
import type { Application, WebGLRenderer } from 'pixi.js';
import { type Build, connectBuild, createBuild, renameBuild } from './actions.ts';
import type { PlanRenderer } from './render/PlanRenderer.ts';
import type { Result } from './session.ts';

/**
 * The app's rendering bench (spec 21, plan 3 task 9, plan 3c task 1): the camera path of the plan 1 bench (overview, a
 * descent through every group level, a sideways pan, back out), on the real renderer. GPU time per frame by timer
 * queries, CPU time of renderFrame; the first second is left out (window showing). The vsync pass ends with an edit
 * pass; every pass ends with the JS heap measured after two collections.
 */
export interface Stats { p50: number; p95: number; p99: number; max: number; n: number }

/** The interface's steps of the load, in absolute time (the main process makes them ms since its own start). */
export type LoadMark = 'dataReceived' | 'stateReady' | 'sceneReady' | 'engineReady' | 'firstFrame';
const marks: Partial<Record<LoadMark, number>> = {};
/** Records the first time a load step is reached (cheap: called in every mode). */
export function mark(name: LoadMark): void {
  if (marks[name] === undefined) marks[name] = performance.timeOrigin + performance.now();
}

export interface EditMeasures {
  /** The title of the node edited: the one nearest the deep camera's centre. */
  node: string;
  /** Main-thread time of each frame that drew a drag preview. */
  dragFrameMs: Stats;
  /** From the call (drop, session.run, undo) to the end of the first frame of the new scene; NaN if refused or late. */
  dropMs: number;
  renameMs: number;
  createMs: number;
  connectMs: number;
  undoMs: number[];
  notes: string[];
}

export interface BenchRun {
  label: string;
  gpuName: string;
  /** Whether the GPU timer extension exists: without it, no GPU time. */
  timer: boolean;
  /** GPU measures thrown away because the timer was disjoint. */
  disjoint: number;
  canvasPx: [number, number];
  gpuMs: Stats;
  /** GPU time of the frames without a rebuild (nor right after one): the drawing alone, without buffer uploads. */
  gpuSteadyMs: Stats;
  cpuMs: Stats;
  intervalMs: Stats;
  rebuilds: number;
  worstFrame: { t: number; cpuMs: number; rebuilt: boolean };
  /** Why each rebuild happened: view left the prepared rectangle, a level changed state, zoom outgrew the curves. */
  reasons: Record<string, number>;
  marks: Partial<Record<LoadMark, number>>;
  /** usedJSHeapSize after two gc() (Mo). */
  heapMb: number;
  /** Whether gc() was there (bench mode starts the interface with --expose-gc). */
  gc: boolean;
  edits: EditMeasures | null;
}

/** What the bench drives in the view (GraphView): its camera, the gesture machine, the session and the drawing loop. */
export interface BenchView {
  app: Application;
  renderer: PlanRenderer;
  params(): RenderParams;
  /** The scene of the state on screen (not a preview). */
  scene(): PlanScene;
  moveCamera(c: Camera): void;
  /** Feeds the gesture machine as the pointer would, then asks for a frame. */
  feed(input: Input): void;
  /** An edit through the session, as a menu choice runs it. */
  edit(build: Build): Promise<Result | null>;
  undo(): Promise<Result>;
  /** Hands the drawing back to the view's loop, which then draws on demand (never paused in bench mode). */
  resume(): void;
  /** Resolves once the view's loop has drawn a frame for which `until()` holds: that step's main-thread time, its end. */
  drawn(until: () => boolean): Promise<{ ms: number; end: number; preview: boolean }>;
}

type Key = { t: number; cam: Omit<Camera, 'widthPx' | 'heightPx'> };

/** Drag of the edit pass: 300 px in 60 frames. */
const DRAG_PX = 300;
const DRAG_FRAMES = 60;
/** An edit whose scene has not come after this is noted and skipped. */
const EDIT_TIMEOUT_MS = 180_000;

export function summarize(samples: number[]): Stats {
  if (samples.length === 0) return { p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: s[s.length - 1], n: s.length };
}

/** The camera path, and its deepest camera (null for a plan without nodes: the overview only, five seconds). */
function path(scene: PlanScene, w: number, h: number, p: RenderParams): { keys: Key[]; deep: Key['cam'] | null } {
  const over = fitBounds(scene.bounds, w, h, p);
  const overview = { x: over.x, y: over.y, zoom: over.zoom };
  // The first of the deepest leaves (as the plan 1 bench): the descent crosses every level above it.
  let target = -1;
  scene.items.forEach((it, i) => { if (it.kind !== 'group' && (target < 0 || it.depth > scene.items[target].depth)) target = i; });
  if (target < 0) return { keys: [{ t: 0, cam: overview }, { t: 5, cam: overview }], deep: null };
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
  return { keys, deep };
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The edit pass (plan 3c task 1), on the node nearest the deep camera's centre: a drag of 300 px in 60 frames through
 * the gesture machine, then the drop; a rename; a node created at the centre; the two connected; three undos.
 */
async function editPass(v: BenchView, deep: Camera): Promise<EditMeasures | null> {
  const notes: string[] = [];
  /** From the call to the end of the first frame of a scene other than the one on screen; NaN if refused or late. */
  const timed = async (what: string, act: () => Promise<Result | null> | void): Promise<number> => {
    const before = v.scene(), t0 = performance.now();
    const drawn = v.drawn(() => v.scene() !== before);
    const r = await act();
    if (r === null || (r && !r.ok)) { notes.push(`${what} refusé${r ? ` : ${r.message}` : ''}.`); return Number.NaN; }
    const end = await Promise.race([drawn.then((d) => d.end), sleep(EDIT_TIMEOUT_MS).then(() => Number.NaN)]);
    if (Number.isNaN(end)) notes.push(`${what} : pas de nouvelle scène après ${EDIT_TIMEOUT_MS / 1000} s.`);
    return end - t0;
  };
  v.moveCamera(deep);
  v.resume();
  await v.drawn(() => true);
  const sc = v.scene(), p = v.params();
  let item = -1, best = Infinity;
  sc.items.forEach((it, i) => {
    const d = Math.hypot(it.x - deep.x, it.y - deep.y);
    if (it.kind === 'node' && d < best) { best = d; item = i; }
  });
  if (item < 0) return null;
  const it = sc.items[item], node = it.node;
  const cam = v.renderer.camera;
  const sx = (it.x - cam.x) * cam.zoom + cam.widthPx / 2, sy = (it.y - cam.y) * cam.zoom + cam.heightPx / 2;

  // 1. The drag: pressed on the node itself, then moved a few pixels a frame; each preview frame is timed.
  v.feed({ t: 'down', button: 0, sx, sy, ctrl: false, alt: false, shift: false, hit: { kind: 'item', item, id: it.id } });
  const frames: number[] = [];
  for (let k = 1; k <= DRAG_FRAMES; k++) {
    const next = v.drawn(() => true);
    v.feed({ t: 'move', sx: sx + (DRAG_PX * k) / DRAG_FRAMES, sy });
    const f = await next;
    if (f.preview) frames.push(f.ms);
  }
  const dropMs = await timed('Dépôt', () => v.feed({ t: 'up', button: 0, sx: sx + DRAG_PX, sy }));
  // 2. to 4. Rename, create at the centre, connect the two, as their menu entries run them.
  const renameMs = await timed('Renommage', () => v.edit(renameBuild(node, `${it.title} (renommé)`)));
  const created: { id: Id | null } = { id: null };
  const createMs = await timed('Création', async () => {
    const c = v.renderer.camera;
    const r = await v.edit(createBuild(v.scene(), 'Nœud du banc', { x: c.x, y: c.y }, c.zoom, p));
    if (r?.ok) created.id = (r.action.ops.find((o) => o.t === 'node' && o.before === null) as { after: { id: Id } }).after.id;
    return r;
  });
  const connectMs = created.id === null ? Number.NaN : await timed('Connexion', () => {
    const s = v.scene(), from = s.byId.get(node), to = s.byId.get(created.id!);
    if (from === undefined || to === undefined) return Promise.resolve({ ok: false as const, message: 'nœuds absents de la scène' });
    return v.edit(connectBuild(s, from, { kind: 'node', item: to }, []));
  });
  // 5. Three Ctrl+Z.
  const undoMs: number[] = [];
  for (let i = 1; i <= 3; i++) undoMs.push(await timed(`Ctrl+Z n° ${i}`, () => v.undo()));
  return { node: it.title, dragFrameMs: summarize(frames), dropMs, renameMs, createMs, connectMs, undoMs, notes };
}

/** The interface's JS heap after two full collections (gc() exists with --js-flags=--expose-gc, bench mode). */
function heapAfterGc(): { heapMb: number; gc: boolean } {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return { heapMb: memory ? memory.usedJSHeapSize / 1e6 : Number.NaN, gc: gc !== undefined };
}

export async function runBench(v: BenchView, label: string): Promise<BenchRun> {
  const { app, renderer } = v;
  const gl = (app.renderer as WebGLRenderer).gl as WebGL2RenderingContext;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'inconnue';
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const { keys, deep } = path(v.scene(), app.screen.width, app.screen.height, v.params());
  const end = keys[keys.length - 1].t;
  const gpu: number[] = [], gpuSteady: number[] = [], cpu: number[] = [], intervals: number[] = [];
  const pending: { q: WebGLQuery; t: number; steady: boolean }[] = [];
  let previousRebuilt = false, disjoint = 0;
  let rebuilds = 0, worst = { t: 0, cpuMs: 0, rebuilt: false };
  const collect = () => {
    while (timer && pending.length > 0 && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, t, steady } = pending.shift()!;
      if (gl.getParameter(timer.GPU_DISJOINT_EXT)) disjoint++;
      else if (t >= 1) {
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
  const reasons = { ...renderer.reasons };

  const edits = label === 'vsync' && deep ? await editPass(v, { ...deep, widthPx: app.screen.width, heightPx: app.screen.height }) : null;
  return {
    label, gpuName, timer: timer !== null, disjoint, canvasPx: [app.canvas.width, app.canvas.height], gpuMs: summarize(gpu), gpuSteadyMs: summarize(gpuSteady),
    cpuMs: summarize(cpu), intervalMs: summarize(intervals), rebuilds, worstFrame: worst, reasons, marks: { ...marks }, ...heapAfterGc(), edits,
  };
}
