import { combine, createPlan, type Id, placeNode, type State, type Vec2 } from '@cirrus/core';
import {
  benchPath, type Camera, cameraAt, dropEffects, dropTarget, type Input, isLive, type PathKey, type PlanScene, type RenderParams, type SceneIndex,
  screenToWorld, stepScale, textPx, worldToScreen,
} from '@cirrus/view';
import { type Build, connectBuild, createBuild, renameBuild } from './actions.ts';
import type { Gl } from './gl/context.ts';
import { GpuTimer } from './gl/timer.ts';
import type { PlanRenderer } from './render/PlanRenderer.ts';
import type { Result } from './session.ts';

/**
 * The app's rendering bench (spec 21, plan 3 task 9, plan 3c task 1): the camera path of the plan 1 bench (overview, a
 * descent through every group level, a sideways pan, back out), on the real renderer. GPU time per frame by timer
 * queries, CPU time of renderFrame; the first second is left out (window showing). The vsync pass ends with an edit
 * pass; every pass ends with the JS heap measured after two collections. The dense pass (plan 3c task 10) drives the
 * camera over a grid of titles at the readability threshold instead of the path.
 */
export interface Stats { p50: number; p95: number; p99: number; max: number; n: number }

/** The interface's steps of the load, in absolute time (the main process makes them ms since its own start). */
type LoadMark = 'dataReceived' | 'stateReady' | 'sceneReady' | 'engineReady' | 'firstFrame';
const marks: Partial<Record<LoadMark, number>> = {};
/**
 * Records the first time a load step is reached (cheap: called in every mode), and marks it in the page's timeline
 * (`cirrus:load:<step>`), where the measures of a session out of bench mode read it (scripts/mesures-recherche.mjs:
 * the first frame, with and without the search index's build, plan 6a).
 */
export function mark(name: LoadMark): void {
  if (marks[name] !== undefined) return;
  marks[name] = performance.timeOrigin + performance.now();
  performance.mark(`cirrus:load:${name}`);
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
  /**
   * Plan 3c task 10 (absent from earlier runs): per drag preview frame, the bytes sent to the GPU (all of them, and to
   * the item texture), and the time spent making the rings and markers again (their share of the frame, 0 to 1).
   */
  dragBytes?: Stats;
  dragTextureBytes?: Stats;
  /** The bytes per frame by mesh (meshBuffers' names), and each mesh's buffers as last sent whole, when the drag began. */
  dragBytesBy?: Record<string, Stats>;
  meshBytes?: Record<string, number>;
  dragRingsMs?: Stats;
  dragRingsShare?: Stats;
  /** The node dropped with Alt into another group drawn at the deep camera: the latency, the group's title. */
  groupDropMs?: number;
  groupDropInto?: string;
  /** The lobby opened again once its scene had left the tabs' cache: its scene and its index built. */
  lobbyColdMs?: number;
  notes: string[];
}

/** The dense pass's plan (plan 3c task 10): its nodes in a grid, and the zooms its camera goes through. */
interface DenseInfo { nodes: number; cols: number; rows: number; zoomLo: number; zoomHi: number }

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
  /**
   * The most title glyph instances built for one frame of the path (faded ones included), and when (plan 3c task 7:
   * absent from earlier runs); the items of the visible set then (task 10).
   */
  glyphs?: { max: number; t: number; items?: number };
  /** The dense pass's plan (plan 3c task 10). */
  dense?: DenseInfo;
  /** What went wrong in the pass itself (a plan refused). */
  notes?: string[];
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

/** Drag of the edit pass: 300 px in 60 frames; the drag into another group, in 30 frames. */
const DRAG_PX = 300;
const DRAG_FRAMES = 60;
const GROUP_DRAG_FRAMES = 30;
/** An edit whose scene has not come after this is noted and skipped. */
const EDIT_TIMEOUT_MS = 180_000;

function summarize(samples: number[]): Stats {
  if (samples.length === 0) return { p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: s[s.length - 1], n: s.length };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves true once `cond()` holds (looked at every 16 ms), false past `timeoutMs`. */
async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > end) return false;
    await sleep(16);
  }
  return true;
}

type Method = (...args: unknown[]) => unknown;

/**
 * Replaces methods of `target` by what `wrap` makes of each; returns what puts them back (an own method assigned again,
 * an inherited one deleted, so that the prototype's shows again). A name that is not a method throws: the bench must
 * not measure nothing in silence after a rename.
 */
function patch(target: object, names: string[], wrap: (name: string, own: Method) => Method): () => void {
  const t = target as Record<string, unknown>;
  const saved = names.map((name) => {
    const own = t[name];
    if (typeof own !== 'function') throw new Error(`Méthode absente : ${name}`);
    return { name, own: own as Method, had: Object.hasOwn(target, name) };
  });
  for (const { name, own } of saved) t[name] = wrap(name, own);
  return () => {
    for (const { name, own, had } of saved) {
      if (had) t[name] = own;
      else delete t[name];
    }
  };
}

/** The WebGL calls that send data to the GPU, the one that binds a buffer, and the constants that size a texel. */
type UploadGl = Pick<
  WebGL2RenderingContext, 'bindBuffer' | 'bufferData' | 'bufferSubData' | 'texImage2D' | 'texSubImage2D' | 'RGBA' | 'RG' | 'RED' | 'FLOAT' | 'HALF_FLOAT'
>;

/** Bytes sent to the GPU since the counter was made or reset: to buffers, to textures, and to each buffer object. */
interface UploadCounter {
  readonly buffers: number;
  readonly textures: number;
  readonly byBuffer: ReadonlyMap<unknown, number>;
  reset(): void;
  /** The context's own methods back. */
  restore(): void;
}

/** Bytes of `data` an upload sends: `length` elements from `srcOffset` (0: to the end), all of it without them; a size (an allocation): none. */
function dataBytes(data: unknown, srcOffset = 0, length = 0): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (!ArrayBuffer.isView(data)) return 0;
  const per = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  return (length > 0 ? length : data.byteLength / per - srcOffset) * per;
}

/**
 * Counts what the context sends to the GPU (bench, plan 3c task 10: the bytes of a drag frame), by wrapping its upload
 * calls until `restore`: buffer data (bufferData with data, bufferSubData) and texels (texImage2D and texSubImage2D with
 * data or an image); an allocation without data counts nothing. Only the bench calls it: nothing else is wrapped.
 */
export function countUploads(gl: UploadGl): UploadCounter {
  let buffers = 0, textures = 0;
  const byBuffer = new Map<unknown, number>(), bound = new Map<unknown, unknown>();
  const toBuffer = (target: unknown, bytes: number) => {
    if (bytes === 0) return;
    buffers += bytes;
    const b = bound.get(target) ?? null;
    byBuffer.set(b, (byBuffer.get(b) ?? 0) + bytes);
  };
  const texel = (format: unknown, type: unknown) =>
    (format === gl.RGBA ? 4 : format === gl.RG ? 2 : format === gl.RED ? 1 : 3) * (type === gl.FLOAT ? 4 : type === gl.HALF_FLOAT ? 2 : 1);
  const area = (source: unknown) => { const s = source as { width?: number; height?: number } | null; return (s?.width ?? 0) * (s?.height ?? 0); };
  /** Client data or an image (not null, not an offset in a bound pixel buffer). */
  const sent = (x: unknown) => x !== null && x !== undefined && typeof x !== 'number';
  const count: Record<string, (a: unknown[]) => void> = {
    bindBuffer: (a) => { bound.set(a[0], a[1]); },
    bufferData: (a) => { toBuffer(a[0], dataBytes(a[1], a[3] as number | undefined, a[4] as number | undefined)); },
    bufferSubData: (a) => { toBuffer(a[0], dataBytes(a[2], a[3] as number | undefined, a[4] as number | undefined)); },
    // (target, level, internalformat, width, height, border, format, type, pixels…) or (target, level, internalformat, format, type, source).
    texImage2D: (a) => { textures += a.length >= 9 ? (sent(a[8]) ? (a[3] as number) * (a[4] as number) * texel(a[6], a[7]) : 0) : area(a[5]) * texel(a[3], a[4]); },
    // (target, level, x, y, width, height, format, type, pixels…) or (target, level, x, y, format, type, source).
    texSubImage2D: (a) => { textures += a.length >= 9 ? (sent(a[8]) ? (a[4] as number) * (a[5] as number) * texel(a[6], a[7]) : 0) : area(a[6]) * texel(a[4], a[5]); },
  };
  const restore = patch(gl, Object.keys(count), (name, own) => function (this: unknown, ...a: unknown[]) {
    count[name](a);
    return own.apply(this, a);
  });
  return {
    get buffers() { return buffers; },
    get textures() { return textures; },
    byBuffer,
    reset() { buffers = 0; textures = 0; byBuffer.clear(); },
    restore,
  };
}

/**
 * The renderer's GPU buffers by the name of their mesh (curve, arrow, text, envelope, previewEnvelope, marker, outline,
 * drop, intruder, sky…), and the bytes each instance or vertex buffer held at its last whole upload: what a drag frame
 * sends is told apart by them. Bench only: it reads the renderer's private meshes, and gives nothing if they change shape.
 */
export function meshBuffers(renderer: object): { names: Map<unknown, string>; sizes: Map<string, number> } {
  type Buffer = { buffer?: unknown; used?: number };
  const names = new Map<unknown, string>(), sizes = new Map<string, number>();
  const meshes = (renderer as { meshes?: Record<string, unknown> }).meshes ?? {};
  for (const [name, mesh] of Object.entries(meshes)) {
    for (const m of Array.isArray(mesh) ? mesh : [mesh]) {
      const x = m as { buffers?: Map<string, { buffer: Buffer }>; index?: Buffer; instances?: Buffer };
      const all = [...(x.buffers?.values() ?? [])].map((b) => b.buffer).concat(x.instances ? [x.instances] : []);
      for (const b of [...all, ...(x.index ? [x.index] : [])]) if (b.buffer !== undefined) names.set(b.buffer, name);
      sizes.set(name, (sizes.get(name) ?? 0) + all.reduce((n, b) => n + (b.used ?? 0), 0));
    }
  }
  return { names, sizes };
}

/**
 * The time spent in methods of `target` (bench, plan 3c task 10: the renderer's rings and markers made again in a drag
 * frame), by wrapping them until `restore`; a call made inside another one counted counts in its time only.
 */
export function timeMethods(target: object, names: string[], now: () => number = () => performance.now()): { readonly ms: number; reset(): void; restore(): void } {
  let ms = 0, depth = 0;
  const restore = patch(target, names, (_name, own) => function (this: unknown, ...a: unknown[]) {
    if (depth > 0) return own.apply(this, a);
    depth++;
    const t0 = now();
    try {
      return own.apply(this, a);
    } finally {
      ms += now() - t0;
      depth--;
    }
  });
  return { get ms() { return ms; }, reset() { ms = 0; }, restore };
}

/** The screen points the group-changing drop looks at, this many CSS px apart. Bench only. */
const DROP_GRID_PX = 24;

/**
 * Where to drop `item` with Alt so that it changes groups (the edit pass, plan 3c task 10): a point of the screen, on a
 * grid, farther than a click from the item, where the drop's own rule (dropTarget, dropEffects) makes it leave its group
 * and enter an existing group other than its own; the nearest to the item. Null if none on screen takes it.
 */
export function groupChangingDrop(scene: PlanScene, item: number, cam: Camera, p: RenderParams, index?: SceneIndex): { at: Vec2; target: number } | null {
  const it = scene.items[item], from = worldToScreen(cam, it.x, it.y);
  let best: { at: Vec2; target: number } | null = null, bestD = Infinity;
  for (let sy = DROP_GRID_PX / 2; sy < cam.heightPx; sy += DROP_GRID_PX) {
    for (let sx = DROP_GRID_PX / 2; sx < cam.widthPx; sx += DROP_GRID_PX) {
      const d = Math.hypot(sx - from.x, sy - from.y);
      if (d >= bestD || d <= p.clickSlopPx) continue;
      const at = screenToWorld(cam, sx, sy), t = dropTarget(scene, at, [item], cam.zoom, p, index);
      if (t === null || t === it.parent || scene.items[t].kind !== 'group') continue;
      const [e] = dropEffects(scene, [item], t, true);
      if (!e.leave || e.enter !== t) continue;
      best = { at, target: t };
      bestD = d;
    }
  }
  return best;
}

/**
 * The dense pass's grid (plan 3c task 10: the bench never drew dense titles, its densest view built 157 glyphs): cells
 * of one-line boxes at step 0 with half a box's padding between them, as many as the prepared rectangle holds at the
 * readability threshold plus one screen of pan; and the camera's path over it.
 */
interface DenseLayout {
  cols: number;
  rows: number;
  /** World units between two box centres. */
  cellW: number;
  cellH: number;
  /** Zooms where a title at step 0 is textFade[0] px (the readability threshold) and textFade[1] px (whole). */
  zoomLo: number;
  zoomHi: number;
  keys: PathKey[];
}

/** The dense path (s): held at the threshold, one screen of pan there, a zoom in to whole titles, the pan back. Bench only. */
const DENSE_HOLD_S = 2, DENSE_PAN_S = 8, DENSE_ZOOM_S = 4, DENSE_BACK_S = 6;

export function denseLayout(widthPx: number, heightPx: number, p: RenderParams): DenseLayout {
  const unit = textPx(0, 1, p), zoomLo = p.textFade[0] / unit, zoomHi = p.textFade[1] / unit, s = stepScale(0, p);
  const cellW = (p.boxWidth + p.boxPadX) * s, cellH = (p.lineHeight * p.baseFontPx + 3 * p.boxPadY) * s;
  // The prepared rectangle (viewMarginPx around the screen) at the threshold, from the grid's corner, then one screen on.
  const hx = (widthPx / 2 + p.viewMarginPx) / zoomLo, hy = (heightPx / 2 + p.viewMarginPx) / zoomLo, pan = widthPx / zoomLo;
  const cols = Math.ceil((2 * hx + pan) / cellW) + 1, rows = Math.ceil((2 * hy) / cellH) + 1;
  const a = { x: hx, y: hy, zoom: zoomLo }, b = { x: hx + pan, y: hy, zoom: zoomLo };
  const t1 = DENSE_HOLD_S, t2 = t1 + DENSE_PAN_S, t3 = t2 + DENSE_ZOOM_S;
  const keys = [{ t: 0, cam: a }, { t: t1, cam: a }, { t: t2, cam: b }, { t: t3, cam: { ...b, zoom: zoomHi } }, { t: t3 + DENSE_BACK_S, cam: { ...a, zoom: zoomHi } }];
  return { cols, rows, cellW, cellH, zoomLo, zoomHi, keys };
}

/** The centre of the grid's j-th box, row by row. */
export const denseAt = (d: DenseLayout, j: number): Vec2 => ({ x: (j % d.cols) * d.cellW, y: Math.floor(j / d.cols) * d.cellH });

/** The plan a createPlan action made. */
const madePlan = (r: Result | null): Id | null => (r?.ok ? (r.action.ops[0] as { after: { id: Id } }).after.id : null);

/**
 * The dense pass's plan: a new plan holding the lobby's first nodes in the grid (one action), then shown; null if an
 * action is refused or the plan is not shown in time.
 */
async function denseView(v: BenchView): Promise<{ layout: DenseLayout; nodes: number } | null> {
  const lobby = v.scene(), layout = denseLayout(v.gl.width, v.gl.height, v.params()), n = layout.cols * layout.rows, nodes: Id[] = [];
  for (let i = 0; i < lobby.items.length && nodes.length < n; i++) if (isLive(lobby, i) && lobby.items[i].kind === 'node') nodes.push(lobby.items[i].node);
  const plan = madePlan(await v.edit((st) => createPlan(st, 'Plan dense du banc', 'plan')));
  if (plan === null) return null;
  const steps = nodes.map((node, j) => (x: State) => { const q = denseAt(layout, j); return placeNode(x, plan, node, q.x, q.y, 0); });
  const placed = await v.edit((st) => combine(st, 'Grille du banc', steps));
  if (!placed?.ok) return null;
  v.openPlan(plan);
  return (await until(() => v.scene().plan.id === plan, EDIT_TIMEOUT_MS)) ? { layout, nodes: nodes.length } : null;
}

/**
 * The edit pass (plan 3c task 1), on the node nearest the deep camera's centre: a drag of 300 px in 60 frames through
 * the gesture machine, then the drop; a rename; a node created at the centre; the two connected; three undos; a drop
 * into another group (task 10); tabs.
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

  // 1. The drag: pressed on the node itself, then moved a few pixels a frame; each preview frame is timed, with what it
  // sends to the GPU and the time it spends making the rings and markers again (task 10: Ruling R23 of task 9 on the
  // ranges sent, M1 of the final review on updateMarkers and updateOutline).
  v.feed({ t: 'down', button: 0, sx, sy, ctrl: false, alt: false, shift: false, hit: { kind: 'item', item, id: it.id } });
  const frames: number[] = [], bytes: number[] = [], texels: number[] = [], rings: number[] = [], share: number[] = [], perMesh: Map<string, number>[] = [];
  const { names, sizes } = meshBuffers(v.renderer);
  const uploads = countUploads(v.gl.gl), meshes = timeMethods(v.renderer, ['updateMarkers', 'updateOutline']);
  try {
    for (let k = 1; k <= DRAG_FRAMES; k++) {
      uploads.reset();
      meshes.reset();
      const next = v.drawn(() => true);
      v.feed({ t: 'move', sx: sx + (DRAG_PX * k) / DRAG_FRAMES, sy });
      const f = await next;
      if (!f.preview) continue;
      frames.push(f.ms);
      bytes.push(uploads.buffers + uploads.textures);
      texels.push(uploads.textures);
      rings.push(meshes.ms);
      share.push(meshes.ms / f.ms);
      const by = new Map<string, number>();
      for (const [buffer, n] of uploads.byBuffer) { const name = names.get(buffer) ?? 'autres'; by.set(name, (by.get(name) ?? 0) + n); }
      perMesh.push(by);
    }
  } finally {
    uploads.restore();
    meshes.restore();
  }
  const sent = [...new Set(perMesh.flatMap((by) => [...by.keys()]))].sort();
  const dragBytesBy = Object.fromEntries(sent.map((name) => [name, summarize(perMesh.map((by) => by.get(name) ?? 0))]));
  const dropMs = await timed('Dépôt', () => v.feed({ t: 'up', button: 0, sx: sx + DRAG_PX, sy }));
  // 2. to 4. Rename, create at the centre, connect the two, as their menu entries run them.
  const renameMs = await timed('Renommage', () => v.edit(renameBuild(node, `${it.title} (renommé)`)));
  const created: { id: Id | null } = { id: null };
  const createMs = await timed('Création', async () => {
    // As GraphView puts a node down: the group under it found by the engine's index (I2 of the final review).
    const c = v.renderer.camera, sc = v.scene(), held = v.renderer.held;
    const r = await v.edit(createBuild(sc, 'Nœud du banc', { x: c.x, y: c.y }, c.zoom, p, held?.scene === sc ? held.index : undefined));
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
  // 6. A drop that changes groups (task 10): the node dragged with Alt into another group drawn at the deep camera, to
  // a point where the drop's own rule takes it there; no other plan holds it, so nothing is asked.
  let groupDropMs = Number.NaN, groupDropInto = '';
  const s6 = v.scene(), i6 = s6.byId.get(node), c6 = v.renderer.camera, held6 = v.renderer.held;
  const into = i6 === undefined ? null : groupChangingDrop(s6, i6, c6, p, held6?.scene === s6 ? held6.index : undefined);
  if (i6 === undefined || !into) notes.push('Dépôt dans un autre groupe : aucun groupe dessiné à la caméra profonde ne reçoit le nœud.');
  else {
    groupDropInto = s6.items[into.target].title;
    const from = worldToScreen(c6, s6.items[i6].x, s6.items[i6].y), to = worldToScreen(c6, into.at.x, into.at.y);
    v.feed({ t: 'down', button: 0, sx: from.x, sy: from.y, ctrl: false, alt: true, shift: false, hit: { kind: 'item', item: i6, id: s6.items[i6].id } });
    for (let k = 1; k <= GROUP_DRAG_FRAMES; k++) {
      const next = v.drawn(() => true);
      v.feed({ t: 'move', sx: from.x + ((to.x - from.x) * k) / GROUP_DRAG_FRAMES, sy: from.y + ((to.y - from.y) * k) / GROUP_DRAG_FRAMES });
      await next;
    }
    groupDropMs = await timed('Dépôt dans un autre groupe', () => v.feed({ t: 'up', button: 0, sx: to.x, sy: to.y }));
  }
  // 7. A new plan opened in its tab (its scene built), then back to the lobby: its scene was kept, updated by every
  // action (cachedPlans).
  const lobby = v.scene().plan.id, plan = madePlan(await v.edit((st) => createPlan(st, 'Plan du banc', 'plan')));
  if (!plan) notes.push('Plan du banc refusé.');
  const tabNewMs = plan === null ? Number.NaN : await timed('Onglet neuf', () => v.openPlan(plan));
  const tabBackMs = plan === null ? Number.NaN : await timed('Retour au lobby', () => v.openPlan(lobby));
  // 8. The lobby once its scene has left the tabs' cache (task 10): as many other plans shown as the cache keeps
  // (cachedPlans, the one shown longest ago forgotten first), then the lobby, its scene and its index built again.
  let lobbyColdMs = Number.NaN;
  for (let k = 0; k < p.cachedPlans; k++) {
    const other = madePlan(await v.edit((st) => createPlan(st, `Plan du banc ${k + 2}`, 'plan')));
    if (other === null) { notes.push(`Plan du banc ${k + 2} refusé.`); break; }
    await timed(`Onglet ${k + 2}`, () => v.openPlan(other));
    if (k === p.cachedPlans - 1) lobbyColdMs = await timed('Lobby sans cache', () => v.openPlan(lobby));
  }
  return {
    node: it.title, dragFrameMs: summarize(frames), dropMs, renameMs, createMs, connectMs, undoMs, tabNewMs, tabBackMs, dragBytes: summarize(bytes),
    dragTextureBytes: summarize(texels), dragBytesBy, meshBytes: Object.fromEntries(sizes), dragRingsMs: summarize(rings), dragRingsShare: summarize(share),
    groupDropMs, groupDropInto, lobbyColdMs, notes,
  };
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
  // The dense pass (plan 3c task 10): its plan made and shown first, its camera over the grid instead of the path.
  const dense = label === 'dense' ? await denseView(v) : null, notes: string[] = [];
  if (label === 'dense' && !dense) notes.push('vue dense : le plan dense n’a pas pu être fait ni montré, parcours du lobby à la place.');
  const { keys, deep } = dense ? { keys: dense.layout.keys, deep: null } : benchPath(v.scene(), g.width, g.height, v.params());
  const end = keys[keys.length - 1].t;
  const gpu: number[] = [], gpuSteady: number[] = [], cpu: number[] = [], intervals: number[] = [], rebuildCpu: number[] = [];
  let previousRebuilt = false;
  let rebuilds = 0, worst = { t: 0, cpuMs: 0, rebuilt: false }, glyphs = { max: 0, t: 0, items: 0 };
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
      if (renderer.glyphCount > glyphs.max) glyphs = { max: renderer.glyphCount, t, items: renderer.visible?.items.length ?? 0 };
      if (rebuilt) rebuilds++;
      if (t < end) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  for (let i = 0; i < 30 && timer && timer.waiting > 0; i++) { await new Promise((r) => requestAnimationFrame(r)); collect(); }
  const reasons = { ...renderer.reasons };

  // The memory is read before the edit pass too: what the load keeps, apart from what the edits add.
  const editFrom = label === 'vsync' && deep ? { ...deep, widthPx: g.width, heightPx: g.height } : null;
  // benchMemory is there in bench mode (launch.bench), the only one that runs this.
  const beforeEdits = editFrom ? { heapMb: heapAfterGc().heapMb, processMb: await window.cirrus.benchMemory!() } : null;
  const edits = editFrom ? await editPass(v, editFrom) : null;
  return {
    label, gpuName, timer: timer !== null, disjoint: timer?.disjoint ?? 0, canvasPx: [g.canvas.width, g.canvas.height], gpuMs: summarize(gpu),
    gpuSteadyMs: summarize(gpuSteady), cpuMs: summarize(cpu), intervalMs: summarize(intervals), rebuilds, rebuildMs: summarize(rebuildCpu), worstFrame: worst, reasons, marks: { ...marks },
    ...heapAfterGc(), edits, beforeEdits, glyphs, notes,
    ...(dense ? { dense: { nodes: dense.nodes, cols: dense.layout.cols, rows: dense.layout.rows, zoomLo: dense.layout.zoomLo, zoomHi: dense.layout.zoomHi } } : {}),
  };
}
