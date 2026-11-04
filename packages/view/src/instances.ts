import type { Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { FloatList, IntList } from './geometry/arrays.ts';
import type { Branch } from './geometry/bundle.ts';
import { appendEnvelope, clearEnvelopeMeshes, type EnvelopeMeshes, newEnvelopeMeshes, NO_PARENT } from './geometry/envelope.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { appendBundleGlyphs, bezierSegments, clearGlyphMeshes, type GlyphMeshes, newGlyphMeshes, sampleBranch } from './geometry/ribbon.ts';
import { simpleBranches, simpleMarker } from './geometry/simple.ts';
import {
  appendConnectionTitles, appendItemTitles, bundleEnd, bundleFor, type CoreAt, groupColors, placeConnectionTitles, type PlacedTitle, titleReadableFrom,
} from './frame.ts';
import type { RenderParams } from './params.ts';
import { GONE_ITEM, type PlanScene, type SceneItem } from './scene.ts';
import type { SceneChanges } from './sceneUpdate.ts';
import type { FontData } from './text.ts';
import type { TitleSide } from './titles.ts';
import type { VisibleConnection, VisibleSet } from './visibility.ts';

// ———— The item texture (plan 3c task 8)

/** Texels per row of the item texture. */
export const ITEM_TEXTURE_WIDTH = 1024;
/** Each slot has two RGBA32F texels side by side: eight floats. */
export const SLOT_FLOATS = 8;
const SLOT_ROW_SHIFT = 9; // 512 slots per row
/** A slot's flags (its second texel's w): its box style (0 node, 1 node phantom, 2 centre, 3 absent), a badge, a group. */
export const ITEM_STYLE = 3, ITEM_BADGE = 4, ITEM_GROUP = 8;
const STYLE_NODE = 1, STYLE_CENTER = 2, STYLE_ABSENT = 3;

/**
 * Writes each slot's two texels into `out` (SLOT_FLOATS per slot, slot after slot: the texture's rows in order):
 * x − ox, y − oy, halfW, halfH; then k, the parent group's maxChildK (NO_PARENT at top level), its own as a group
 * (NO_PARENT otherwise), flags. A freed slot is zeros. Without `slots`, every slot; with, only those (the rows they are
 * in are then sent again, rowRuns).
 */
export function itemTexels(scene: PlanScene, origin: Vec2, out: Float32Array, slots?: Iterable<number>): void {
  // Imported bindings read once: under vitest each use is a getter (T2 of the registry).
  const items = scene.items, ox = origin.x, oy = origin.y, gone = GONE_ITEM, none = NO_PARENT;
  if (slots) for (const i of slots) writeSlot(items, i, out, ox, oy, gone, none);
  else for (let i = 0, n = items.length; i < n; i++) writeSlot(items, i, out, ox, oy, gone, none);
}

function writeSlot(items: SceneItem[], i: number, out: Float32Array, ox: number, oy: number, gone: SceneItem, none: number): void {
  const it = items[i], o = i * SLOT_FLOATS;
  if (it === gone) { for (let k = 0; k < SLOT_FLOATS; k++) out[o + k] = 0; return; }
  const kind = it.kind, parent = it.parent;
  out[o] = it.x - ox;
  out[o + 1] = it.y - oy;
  out[o + 2] = it.halfW;
  out[o + 3] = it.halfH;
  out[o + 4] = it.k;
  out[o + 5] = parent >= 0 ? items[parent].maxChildK! : none;
  let flags = it.badge ? ITEM_BADGE : 0;
  if (kind === 'group') {
    out[o + 6] = it.maxChildK!;
    flags |= ITEM_GROUP;
  } else {
    out[o + 6] = none;
    if (kind === 'phantom') flags |= it.phantom === 'node' ? STYLE_NODE : it.phantom === 'center' ? STYLE_CENTER : STYLE_ABSENT;
  }
  out[o + 7] = flags;
}

/** Rows of the item texture that `slots` occupy. */
export const textureRows = (slots: number): number => (slots + (1 << SLOT_ROW_SHIFT) - 1) >> SLOT_ROW_SHIFT;

/** The rows the slots are in, as runs [from, to) in order: one texSubImage2D each. */
export function rowRuns(slots: Iterable<number>): [number, number][] {
  const rows = new Set<number>();
  for (const s of slots) rows.add(s >> SLOT_ROW_SHIFT);
  const sorted = [...rows].sort((a, b) => a - b), runs: [number, number][] = [];
  for (const r of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === r) last[1] = r + 1;
    else runs.push([r, r + 1]);
  }
  return runs;
}

/**
 * The slots whose texels differ between `prev` and `scene`, which `changes` lead from one to the other: the items
 * written, and the children of each group whose maxChildK changed (their texels carry it as their parent's).
 */
export function texelSlots(prev: PlanScene, scene: PlanScene, changes: SceneChanges): number[] {
  const out = new Set(changes.items);
  for (const i of changes.items) {
    const it = scene.items[i];
    if (it.kind !== 'group') continue;
    const before = prev.items[i];
    if (before && before.kind === 'group' && before.maxChildK === it.maxChildK) continue;
    for (const c of it.children) out.add(c);
  }
  return [...out];
}

// ———— Instances

/**
 * A simple connection's instance, as ints: its two items' slots, its flags, its visible index (the hover), and the
 * fading group's slot for an 'out' fade (−1 otherwise). The renderer's attributes are `a` + each field's name.
 */
export const SIMPLE_FIELDS = [['ends', 4], ['fade', 1]] as const;
export const SIMPLE_INTS: number = SIMPLE_FIELDS.reduce((n, [, size]) => n + size, 0);
/** Flags of a simple connection: each end's role code (source 0, target 1, associate 2) in two bits, then these. */
export const SIMPLE_DASHED_A = 16, SIMPLE_DASHED_B = 32, SIMPLE_FADE_OUT = 64;
const ROLE_CODE = { source: 0, target: 1, associate: 2 } as const;

/**
 * A complex bundle's branch (or trunk) instance, as floats: the cubic with the fading level open (p0, b1 then b2, p3)
 * and closed (the same without a slide); width: the step at t = 0 and t = 1 (the scale goes from one to the other),
 * dashed (1 or 0), the visible index; the two endpoints of the off-screen fade (x, y, half extent); fold (mode, foldK).
 * All relative to the origin. Its glyphs are the `glyphs` mesh.
 */
export const CURVE_FIELDS = [['open0', 4], ['open1', 4], ['closed0', 4], ['closed1', 4], ['width', 4], ['end0', 3], ['end1', 3], ['fold', 2]] as const;
export type CurveField = (typeof CURVE_FIELDS)[number][0];
const curveStarts = {} as Record<CurveField, number>;
let curveFloats = 0;
for (const [f, size] of CURVE_FIELDS) { curveStarts[f] = curveFloats; curveFloats += size; }
export const CURVE_AT: Readonly<Record<CurveField, number>> = curveStarts;
export const CURVE_FLOATS = curveFloats;

export interface MarkerAt extends CoreAt { multi: boolean }
export interface StubAt { conn: number; stub: number; pos: Vec2; title: string }

/**
 * What the GPU draws of a visible set (plan 3c task 8), relative to `origin`; the items themselves are read from the
 * item texture by slot. Simple connections are instances computed in the shaders; complex bundles are their cubics,
 * computed here, and a glyph mesh. A rebuild with a budget may leave complex bundles `pending`: resumeInstances builds
 * them at the next frames, in order; the connection titles are placed once they all are.
 */
export interface Instances {
  origin: Vec2;
  /** The visible boxes' slots, in drawing order. */
  boxes: IntList;
  /** SIMPLE_INTS per simple connection. */
  simple: IntList;
  /** CURVE_FLOATS per branch or trunk of a complex bundle. */
  curves: FloatList;
  /** Per curve instance: the member its branch leads to, null for a trunk (hit testing). */
  curveKeys: (Id | null)[];
  glyphs: GlyphMeshes;
  envelopes: EnvelopeMeshes;
  /** Title glyphs (GLYPH_FLOATS each, text.ts), in drawing order: items, then connections. */
  texts: FloatList;
  /** The complex bundles' markers, in visible order; a simple connection's is midway between its boxes. */
  markers: MarkerAt[];
  stubs: StubAt[];
  titles: PlacedTitle[];
  /** The smallest zoom at which something left out as unreadable or too thin would be built: reaching it rebuilds. */
  revealZoom: number;
  pending: boolean;
  /** What resumeInstances needs: null once complete. */
  work: Work | null;
}

interface Work {
  scene: PlanScene;
  visible: VisibleSet;
  cam: Camera;
  p: RenderParams;
  font?: FontData;
  sides?: Map<Id, TitleSide>;
  /** The complex visible connections, in visible order; `next` is the first not built. */
  queue: number[];
  next: number;
  /** The simple connections with a title, by visible index, in order: theirs are placed with the complex bundles' ones. */
  titled: number[];
  padded: Map<number, Vec2[]>;
  extents: Map<number, number>;
  /** The last largest step culled against, and its visibleFrom. */
  cullK: number;
  cullFrom: number;
}

export function newInstances(): Instances {
  return {
    origin: { x: 0, y: 0 }, boxes: new IntList(), simple: new IntList(), curves: new FloatList(), curveKeys: [], glyphs: newGlyphMeshes(),
    envelopes: newEnvelopeMeshes(), texts: new FloatList(), markers: [], stubs: [], titles: [], revealZoom: Infinity, pending: false, work: null,
  };
}

/**
 * A simple connection: two ends on boxes (no group, closed or not), no stub, centre nor layout, no slide; its curves
 * are computed in the vertex shaders from its two items' texels (simpleBranches is their TS twin).
 */
export function isSimple(scene: PlanScene, vc: VisibleConnection): boolean {
  const ends = vc.ends;
  if (ends.length !== 2 || vc.fade === 'slide' || vc.stubs.length > 0 || vc.center !== undefined) return false;
  const a = ends[0], b = ends[1], conns = vc.conns;
  if (a.item === b.item || a.hollow || b.hollow || conns.length !== 1) return false;
  const items = scene.items;
  return items[a.item].kind !== 'group' && items[b.item].kind !== 'group' && scene.layout[conns[0]] === undefined;
}

/** The zoom under which a connection whose largest step is kTop is not drawn (ribbonCullAlpha at zoom × curveZoomHeadroom). */
export const visibleFrom = (kTop: number, p: RenderParams): number =>
  (p.ribbonCullAlpha * p.widthMinPx) / (p.widthBasePx * p.factor ** kTop * p.curveZoomHeadroom);

/**
 * The instances of a visible set (spec 8.2 to 8.6): envelopes (a mesh, as before), the boxes, every simple connection,
 * the items' titles, then the complex bundles in visible order until `budget.deadline` (performance.now(); at least one
 * is built), the others left pending. `font`: the titles are built with it (none without); `sides`: connection titles
 * keep the side they had; `reuse`: its storage is refilled.
 */
export function buildInstances(
  scene: PlanScene, visible: VisibleSet, cam: Camera, origin: Vec2, p: RenderParams, budget?: { deadline: number },
  font?: FontData, sides?: Map<Id, TitleSide>, reuse?: Instances,
): Instances {
  const inst = reuse ?? newInstances();
  inst.boxes.clear();
  inst.simple.clear();
  inst.curves.clear();
  inst.curveKeys.length = 0;
  clearGlyphMeshes(inst.glyphs);
  clearEnvelopeMeshes(inst.envelopes);
  inst.texts.clear();
  inst.markers = [];
  inst.stubs = [];
  inst.titles = [];
  inst.origin = origin;
  inst.revealZoom = Infinity;
  const items = scene.items, connections = visible.connections, n = connections.length, titles = scene.titles, none = NO_PARENT;
  const w: Work = { scene, visible, cam, p, font, sides, queue: [], next: 0, titled: [], padded: new Map(), extents: new Map(), cullK: Number.NaN, cullFrom: 0 };
  inst.work = w;
  inst.pending = true;

  // Envelopes, parents first so nested levels are drawn on top.
  for (const g of visible.groups) {
    const it = items[g];
    appendEnvelope(inst.envelopes, it.hull!.map((q) => ({ x: q.x - origin.x, y: q.y - origin.y })), it.pad!, groupColors(scene, g, p), it.maxChildK!,
      it.parent >= 0 ? items[it.parent].maxChildK! : none);
  }
  const boxesAt = inst.boxes.extend(visible.items.length);
  inst.boxes.storage.set(visible.items, boxesAt);
  // Every simple connection at once, the complex ones queued (one pass: the visible set is read once).
  const simple = inst.simple;
  let d = simple.storage;
  for (let ci = 0; ci < n; ci++) {
    const vc = connections[ci];
    if (!isSimple(scene, vc)) { w.queue.push(ci); continue; }
    const a = vc.ends[0], b = vc.ends[1];
    let fade = -1;
    if (vc.fade === 'out') {
      // The fading level: the end's lifted group of the largest maxChildK (vc.foldK).
      for (const e of vc.ends) if (e.item2 !== e.item && (fade < 0 || items[e.item2].maxChildK! > items[fade].maxChildK!)) fade = e.item2;
    }
    const o = simple.extend(SIMPLE_INTS);
    if (o + SIMPLE_INTS > d.length) d = simple.storage;
    d[o] = a.item;
    d[o + 1] = b.item;
    d[o + 2] = ROLE_CODE[a.role] | (ROLE_CODE[b.role] << 2) | (a.dashed ? SIMPLE_DASHED_A : 0) | (b.dashed ? SIMPLE_DASHED_B : 0) | (fade >= 0 ? SIMPLE_FADE_OUT : 0);
    d[o + 3] = ci;
    d[o + 4] = fade;
    if (titles[vc.conns[0]] !== '') w.titled.push(ci);
  }
  if (font) inst.revealZoom = Math.min(inst.revealZoom, appendItemTitles(inst.texts, scene, visible, cam, p, font, (g) => paddedOf(w, g)));
  resumeInstances(inst, budget);
  return inst;
}

/** Builds the complex bundles left pending, until `budget.deadline` (at least one); once all are, the connection titles. */
export function resumeInstances(inst: Instances, budget?: { deadline: number }): void {
  const w = inst.work;
  if (!w) return;
  for (let built = 0; w.next < w.queue.length; built++) {
    if (budget && built > 0 && performance.now() >= budget.deadline) return;
    appendComplex(inst, w, w.queue[w.next++]);
  }
  finishTitles(inst, w);
  inst.pending = false;
  inst.work = null;
}

function paddedOf(w: Work, g: number): Vec2[] {
  let poly = w.padded.get(g);
  if (!poly) { const it = w.scene.items[g]; w.padded.set(g, (poly = offsetPolygon(it.hull!, it.pad!))); }
  return poly;
}

/** An end's half extent for the off-screen fade: a box's larger half size, a group's padded envelope's reach from its centre. */
function extentOf(w: Work, i: number): number {
  const it = w.scene.items[i];
  if (it.kind !== 'group') return Math.max(it.halfW, it.halfH);
  let e = w.extents.get(i);
  if (e === undefined) w.extents.set(i, (e = Math.max(...paddedOf(w, i).map((q) => Math.hypot(q.x - it.x, q.y - it.y)))));
  return e;
}

/** One complex bundle: its curves, glyphs, marker and stubs; nothing if too thin at the deepest zoom a rebuild serves. */
function appendComplex(inst: Instances, w: Work, ci: number): void {
  const { scene, visible, cam, p } = w, items = scene.items, o = inst.origin, vc = visible.connections[ci];
  const slide = vc.fade === 'slide';
  let kOpen = vc.ends.length > 0 ? -Infinity : 0, kClosed = slide && vc.ends.length === 0 ? 0 : -Infinity;
  for (const e of vc.ends) {
    if (items[e.item].k > kOpen) kOpen = items[e.item].k;
    if (slide && items[e.item2].k > kClosed) kClosed = items[e.item2].k;
  }
  // Bundles mostly share their largest step: its threshold is computed again only when it changes.
  const kTop = Math.max(kOpen, kClosed);
  if (kTop !== w.cullK) { w.cullK = kTop; w.cullFrom = visibleFrom(kTop, p); }
  const from = w.cullFrom;
  if (cam.zoom < from) { if (from < inst.revealZoom) inst.revealZoom = from; return; }
  const open = bundleFor(scene, vc, p, o, undefined, false), closed = slide ? bundleFor(scene, vc, p, o, undefined, true) : null;
  // The two endpoints nearest the camera carry the off-screen fade (spec 8.5); a far part: its node and its centre.
  const cx = cam.x - o.x, cy = cam.y - o.y;
  const pts = [...vc.ends.map((e) => e.item), ...(vc.center !== undefined ? [vc.center] : [])]
    .map((i) => { const x = items[i].x - o.x, y = items[i].y - o.y; return { x, y, e: extentOf(w, i), d: Math.hypot(x - cx, y - cy) }; })
    .sort((a, b) => a.d - b.d);
  const e0 = pts[0], e1 = pts[1] ?? pts[0];
  const mode = slide ? 1 : vc.fade === 'out' ? 2 : 0, foldK = Number.isFinite(vc.foldK) ? vc.foldK : 0;
  const curve = (a: Pick<Branch, 'p0' | 'b1' | 'b2' | 'p3'>, b: Pick<Branch, 'p0' | 'b1' | 'b2' | 'p3'>, k0: number, k1: number, dashed: boolean, key: Id | null) => {
    const at = inst.curves.extend(CURVE_FLOATS), d = inst.curves.storage;
    d.set([a.p0.x, a.p0.y, a.b1.x, a.b1.y, a.b2.x, a.b2.y, a.p3.x, a.p3.y, b.p0.x, b.p0.y, b.b1.x, b.b1.y, b.b2.x, b.b2.y, b.p3.x, b.p3.y,
      k0, k1, dashed ? 1 : 0, ci, e0.x, e0.y, e0.e, e1.x, e1.y, e1.e, mode, foldK], at);
    inst.curveKeys.push(key);
  };
  /** A trunk as a cubic: its control points a third of the way along. */
  const straight = (t: [Vec2, Vec2]) => {
    const [A, B] = t, dx = B.x - A.x, dy = B.y - A.y;
    return { p0: A, b1: { x: A.x + dx / 3, y: A.y + dy / 3 }, b2: { x: A.x + (2 * dx) / 3, y: A.y + (2 * dy) / 3 }, p3: B };
  };
  if (open.trunk) curve(straight(open.trunk), straight(closed?.trunk ?? open.trunk), open.kMax, open.kMax, false, null);
  open.branches.forEach((a, i) => {
    const b = closed?.branches[i] ?? a;
    const [k0, k1] = a.nodeEnd === 'p0' ? [a.kNode, a.kMarker] : [a.kMarker, a.kNode];
    curve(a, b, k0, k1, a.dashed, a.key);
  });
  appendBundleGlyphs(inst.glyphs, open, closed, { end0: [e0.x, e0.y, e0.e], end1: [e1.x, e1.y, e1.e], fade: vc.fade, foldK: vc.foldK, conn: ci }, p);
  inst.markers.push({ conn: ci, pos: open.marker, kMax: open.kMax, multi: open.multi });
  open.branches.filter((b) => b.stub).forEach((b, si) => {
    inst.stubs.push({ conn: ci, stub: si, pos: b.nodeEnd === 'p0' ? b.p0 : b.p3, title: vc.stubs[si].title });
  });
}

/** A simple connection's two ends as bundle ends, relative to `origin`. */
export function simpleEnds(scene: PlanScene, vc: VisibleConnection, origin: Vec2): [ReturnType<typeof bundleEnd>, ReturnType<typeof bundleEnd>] {
  const [a, b] = vc.ends;
  return [bundleEnd(scene, a.item, a.role, false, a.dashed, a.key, origin), bundleEnd(scene, b.item, b.role, false, b.dashed, b.key, origin)];
}

/**
 * The connection titles, in visible order, once every bundle is built: each core (a simple connection's, or a complex
 * bundle's marker) among the curves' samples, as the old flattening gave them (bezierSegments at zoom ×
 * curveZoomHeadroom), so that a title sits where it always did.
 */
function finishTitles(inst: Instances, w: Work): void {
  const { scene, visible, cam, p } = w, items = scene.items, o = inst.origin;
  // The complex bundles' markers and the titled simple connections, both in visible order, merged.
  const cores: CoreAt[] = [], markers = inst.markers, titled = w.titled;
  for (let m = 0, t = 0; m < markers.length || t < titled.length;) {
    if (t >= titled.length || (m < markers.length && markers[m].conn < titled[t])) { cores.push(markers[m++]); continue; }
    const ci = titled[t++], vc = visible.connections[ci];
    const a = items[vc.ends[0].item], b = items[vc.ends[1].item], kMax = Math.max(a.k, b.k);
    // Too thin at the deepest zoom a rebuild serves: no core, as no curve (the title waits for that zoom).
    const from = visibleFrom(kMax, p);
    if (cam.zoom < from) { inst.revealZoom = Math.min(inst.revealZoom, Math.max(from, titleReadableFrom(kMax, p))); continue; }
    cores.push({ conn: ci, pos: simpleMarker({ x: a.x - o.x, y: a.y - o.y }, { x: b.x - o.x, y: b.y - o.y }), kMax });
  }
  if (cores.length > 0) {
    const samples = curveSamples(inst, w);
    inst.revealZoom = Math.min(inst.revealZoom, placeConnectionTitles(scene, visible, cores, cam, o, p, samples, w.sides, inst.titles));
  }
  if (w.font) appendConnectionTitles(inst.texts, visible, inst.titles, p, w.font);
}

/** The curves' samples in a rectangle (relative to the origin), from an index of their extents made at the first call. */
function curveSamples(inst: Instances, w: Work): (x0: number, y0: number, x1: number, y1: number) => Vec2[] {
  const { scene, visible, cam, p } = w, o = inst.origin, pxPerUnit = cam.zoom * p.curveZoomHeadroom;
  let tree: Flatbush | null | undefined;
  /** Per entry: a curve instance (≥ 0), or a simple connection (−1 − its visible index). */
  const entries: number[] = [];
  const cache = new Map<number, Vec2[]>();
  const make = () => {
    const c = inst.curves.storage, nCurves = inst.curves.length / CURVE_FLOATS;
    const boxes: number[] = [];
    for (let j = 0; j < nCurves; j++) {
      const at = j * CURVE_FLOATS;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let q = 0; q < 8; q += 2) { x0 = Math.min(x0, c[at + q]); y0 = Math.min(y0, c[at + q + 1]); x1 = Math.max(x1, c[at + q]); y1 = Math.max(y1, c[at + q + 1]); }
      entries.push(j);
      boxes.push(x0, y0, x1, y1);
    }
    const s = inst.simple.view();
    for (let j = 0; j < s.length; j += SIMPLE_INTS) {
      const a = scene.items[s[j]], b = scene.items[s[j + 1]];
      if (cam.zoom < visibleFrom(Math.max(a.k, b.k), p)) continue;
      const m = simpleMarker(a, b), r = Math.max(1, p.trunkTension) * Math.hypot(a.x - m.x, a.y - m.y);
      entries.push(-1 - s[j + 3]);
      boxes.push(m.x - o.x - r, m.y - o.y - r, m.x - o.x + r, m.y - o.y + r);
    }
    tree = entries.length > 0 ? new Flatbush(entries.length) : null;
    if (tree) { for (let k = 0; k < entries.length; k++) tree.add(boxes[4 * k], boxes[4 * k + 1], boxes[4 * k + 2], boxes[4 * k + 3]); tree.finish(); }
  };
  const pointsOf = (entry: number): Vec2[] => {
    let pts = cache.get(entry);
    if (pts) return pts;
    pts = [];
    if (entry >= 0) {
      const c = inst.curves.storage, at = entry * CURVE_FLOATS;
      const cubic = (from: number) => ({ p0: { x: c[from], y: c[from + 1] }, b1: { x: c[from + 2], y: c[from + 3] }, b2: { x: c[from + 4], y: c[from + 5] }, p3: { x: c[from + 6], y: c[from + 7] } });
      const a = cubic(at + CURVE_AT.open0), b = cubic(at + CURVE_AT.closed0);
      if (inst.curveKeys[entry] === null) pts = [a.p0, a.p3]; // a trunk
      else {
        const segs = Math.max(bezierSegments(a.p0, a.b1, a.b2, a.p3, pxPerUnit, p.curveTolerancePx),
          c[at + CURVE_AT.fold] === 1 ? bezierSegments(b.p0, b.b1, b.b2, b.p3, pxPerUnit, p.curveTolerancePx) : 0);
        pts = sampleBranch(a, segs);
      }
    } else {
      const [ea, eb] = simpleEnds(scene, visible.connections[-1 - entry], o);
      for (const br of simpleBranches(ea, eb, p)) pts.push(...sampleBranch(br, bezierSegments(br.p0, br.b1, br.b2, br.p3, pxPerUnit, p.curveTolerancePx)));
    }
    cache.set(entry, pts);
    return pts;
  };
  return (x0, y0, x1, y1) => {
    if (tree === undefined) make();
    if (!tree) return [];
    const out: Vec2[] = [];
    for (const k of tree.search(x0, y0, x1, y1)) out.push(...pointsOf(entries[k]));
    return out;
  };
}
