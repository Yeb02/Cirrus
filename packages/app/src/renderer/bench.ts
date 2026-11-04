import { createPlan, type Id } from '@cirrus/core';
import { benchPath, type Camera, cameraAt, type Input, isLive, type PlanScene, type RenderParams } from '@cirrus/view';
import { type Build, connectBuild, createBuild, renameBuild } from './actions.ts';
import type { Gl } from './gl/context.ts';
import { GpuTimer } from './gl/timer.ts';
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
  /** A tab opened on a new plan (its scene built), then back to the lobby, whose scene was kept (plan 3c, task 5). */
  tabNewMs: number;
  tabBackMs: number;
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
  /** Why each rebuild happened: view left the prepared rectangle, a level changed state, zooming out far, something left out
   * becoming visible (reveal), the origin moved (origin); zoomIn before plan 3c task 8. */
  reasons: Record<string, number>;
  /** Main-thread time of the frames that rebuilt (or built pending bundles: plan 3c task 8; absent from earlier runs). */
  rebuildMs?: Stats;
  marks: Partial<Record<LoadMark, number>>;
  /** usedJSHeapSize after two gc() (Mo). */
  heapMb: number;
  /** Whether gc() was there (bench mode starts the interface with --expose-gc). */
  gc: boolean;
  edits: EditMeasures | null;
  /** The memory after the load and the camera path, read before the edit pass (null without one): the heap and the processes (Mo). */
  beforeEdits: { heapMb: number; processMb: ProcessMb } | null;
  /** The most title glyph instances built for one frame of the path (faded ones included), and when (plan 3c task 7: absent from earlier runs). */
  glyphs?: { max: number; t: number };
}

/** Private memory (Mo) of the main process (Browser), the interface (Tab) and the GPU process, from app.getAppMetrics(). */
export interface ProcessMb { browser: number; tab: number; gpu: number }

/** What the bench drives in the view (GraphView): its camera, the gesture machine, the session and the drawing loop. */
export interface BenchView {
  gl: Gl;
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
  /** Shows a plan in its tab, as a click on the tab does. */
  openPlan(plan: Id): void;
  /** Hands the drawing back to the view's loop, which then draws on demand (never paused in bench mode). */
  resume(): void;
  /** Resolves once the view's loop has drawn a frame for which `until()` holds: that step's main-thread time, its end. */
  drawn(until: () => boolean): Promise<{ ms: number; end: number; preview: boolean }>;
}

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
    if (isLive(sc, i) && it.kind === 'node' && d < best) { best = d; item = i; }
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
  // 6. A new plan opened in its tab (its scene built), then back to the lobby: its scene was kept, updated by every
  // action (cachedPlans).
  const lobby = v.scene().plan.id, made = await v.edit((st) => createPlan(st, 'Plan du banc', 'plan'));
  const plan = made?.ok ? (made.action.ops[0] as { after: { id: Id } }).after.id : null;
  if (!plan) notes.push('Plan du banc refusé.');
  const tabNewMs = plan === null ? Number.NaN : await timed('Onglet neuf', () => v.openPlan(plan));
  const tabBackMs = plan === null ? Number.NaN : await timed('Retour au lobby', () => v.openPlan(lobby));
  return { node: it.title, dragFrameMs: summarize(frames), dropMs, renameMs, createMs, connectMs, undoMs, tabNewMs, tabBackMs, notes };
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
  const { gl: g, renderer } = v, gl = g.gl;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'inconnue';
  // Without the timer extension, the GPU time is reported unavailable (timer: false, no samples).
  const timer = GpuTimer.create<{ t: number; steady: boolean }>(g);
  const { keys, deep } = benchPath(v.scene(), g.width, g.height, v.params());
  const end = keys[keys.length - 1].t;
  const gpu: number[] = [], gpuSteady: number[] = [], cpu: number[] = [], intervals: number[] = [], rebuildCpu: number[] = [];
  let previousRebuilt = false;
  let rebuilds = 0, worst = { t: 0, cpuMs: 0, rebuilt: false }, glyphs = { max: 0, t: 0 };
  const collect = () => timer?.poll((ms, { t, steady }) => {
    if (t < 1) return;
    gpu.push(ms);
    if (steady) gpuSteady.push(ms);
  });
  await new Promise<void>((done) => {
    let start = -1, last = -1;
    const frame = (now: number) => {
      if (start < 0) start = now;
      const t = (now - start) / 1000;
      if (last >= 0 && (last - start) / 1000 >= 1) intervals.push(now - last);
      last = now;
      renderer.setCamera({ ...cameraAt(keys, t), widthPx: g.width, heightPx: g.height });
      timer?.begin();
      const t0 = performance.now();
      const rebuilt = renderer.renderFrame();
      const ms = performance.now() - t0;
      timer?.end({ t, steady: !rebuilt && !previousRebuilt });
      previousRebuilt = rebuilt;
      collect();
      if (t >= 1) {
        cpu.push(ms);
        if (rebuilt) rebuildCpu.push(ms);
        if (ms > worst.cpuMs) worst = { t, cpuMs: ms, rebuilt };
      }
      if (renderer.glyphCount > glyphs.max) glyphs = { max: renderer.glyphCount, t };
      if (rebuilt) rebuilds++;
      if (t < end) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  for (let i = 0; i < 30 && timer && timer.waiting > 0; i++) { await new Promise((r) => requestAnimationFrame(r)); collect(); }
  const reasons = { ...renderer.reasons };

  // The memory is read before the edit pass too: what the load keeps, apart from what the edits add.
  const editFrom = label === 'vsync' && deep ? { ...deep, widthPx: g.width, heightPx: g.height } : null;
  const beforeEdits = editFrom ? { heapMb: heapAfterGc().heapMb, processMb: await window.cirrus.benchMemory() } : null;
  const edits = editFrom ? await editPass(v, editFrom) : null;
  return {
    label, gpuName, timer: timer !== null, disjoint: timer?.disjoint ?? 0, canvasPx: [g.canvas.width, g.canvas.height], gpuMs: summarize(gpu),
    gpuSteadyMs: summarize(gpuSteady), cpuMs: summarize(cpu), intervalMs: summarize(intervals), rebuilds, rebuildMs: summarize(rebuildCpu), worstFrame: worst, reasons, marks: { ...marks },
    ...heapAfterGc(), edits, beforeEdits, glyphs,
  };
}
