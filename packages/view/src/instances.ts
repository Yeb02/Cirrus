import type { ConnectionLayout, Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { FloatList, IntList } from './geometry/arrays.ts';
import type { Branch, BundleGeometry } from './geometry/bundle.ts';
import { appendEnvelope, clearEnvelopeMeshes, type EnvelopeMeshes, newEnvelopeMeshes, NO_PARENT } from './geometry/envelope.ts';
import { masksOf } from './geometry/mask.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { appendBundleGlyphs, bezierSegments, bundleGlyphCount, clearGlyphMeshes, type GlyphMeshes, newGlyphMeshes, sampleBranch } from './geometry/ribbon.ts';
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
export const TEXELS_PER_SLOT = 2, SLOT_FLOATS = 4 * TEXELS_PER_SLOT;
/** A slot's row is its index shifted by this (512 slots per row); the shaders read the texture by the same layout. */
export const SLOT_ROW_SHIFT = Math.log2(ITEM_TEXTURE_WIDTH / TEXELS_PER_SLOT);
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
 * A simple connection's instance, as ints: its two items' slots, its flags, its visible index (the hover); the folding
 * group it fades out with (−1 otherwise); the groups whose fill is laid over it (masksOf). The renderer's attributes are
 * `a` + each field's name.
 */
export const SIMPLE_FIELDS = [['ends', 4], ['fade', 1], ['masks', 4]] as const;
export const SIMPLE_INTS: number = SIMPLE_FIELDS.reduce((n, [, size]) => n + size, 0);
/**
 * Flags of a simple connection: each end's role code (source 0, target 1, associate 2) in SIMPLE_ROLE_BITS bits, a's
 * then b's, then these.
 */
export const SIMPLE_ROLE_BITS = 2, SIMPLE_DASHED_A = 16, SIMPLE_DASHED_B = 32, SIMPLE_FADE_OUT = 64;
const ROLE_CODE = { source: 0, target: 1, associate: 2 } as const;

/**
 * A complex bundle's branch (or trunk) instance, as floats: the cubic (p0, b1 then b2, p3); width: the step at t = 0
 * and t = 1 (the scale goes from one to the other), dashed (1 or 0), the visible index; the two endpoints of the
 * off-screen fade (x, y, half extent); fold (2 when it fades out with a folding group, else 0; that group's maxChildK);
 * the groups whose fill is laid over it (masksOf, slots, −1 for none). All relative to the origin. Its glyphs are the
 * `glyphs` mesh.
 */
export const CURVE_FIELDS = [['open0', 4], ['open1', 4], ['width', 4], ['end0', 3], ['end1', 3], ['fold', 2], ['masks', 4]] as const;
type CurveField = (typeof CURVE_FIELDS)[number][0];
const curveStarts = {} as Record<CurveField, number>;
let curveFloats = 0;
for (const [f, size] of CURVE_FIELDS) { curveStarts[f] = curveFloats; curveFloats += size; }
export const CURVE_AT: Readonly<Record<CurveField, number>> = curveStarts;
export const CURVE_FLOATS = curveFloats;

interface MarkerAt extends CoreAt { multi: boolean; masks: number[] }

/** A part's layout standing in for the plan's own (a handle being dragged, spec 8.5), by part slot. */
export type LayoutOverrides = ReadonlyMap<number, Omit<ConnectionLayout, 'plan' | 'connection'>>;
interface StubAt { conn: number; stub: number; pos: Vec2; title: string }

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
  // Where each part sits, for what rewrites it in place (plan 3c task 9: previews and edits).
  /** BUNDLE_INTS per complex bundle, in visible order, built or left out as too thin: see BUNDLE_AT. */
  bundles: IntList;
  /** Per visible connection: its row in `bundles`, -1 for a simple one. */
  bundleOf: IntList;
  /** Per visible group, two ints: its envelope's first index and index count. */
  envelopeAt: IntList;
  /** Per visible group, two ints: the first glyph of its open title and their count (0: not built). */
  groupTitles: IntList;
  /** The floats of the items' titles in `texts`: the connections' come after. */
  itemTexts: number;
  /** Per placed title (`titles`), two ints: its first glyph and their count. */
  titleGlyphs: IntList;
  /** The simple connections with a title, by visible index, in order. */
  titled: IntList;
}

/**
 * A complex bundle's row in Instances.bundles: its visible index, its first curve instance and their count, its first
 * glyph vertex and their count, its marker's index (-1: left out as too thin), its first stub and their count.
 */
export const BUNDLE_AT = { conn: 0, curve: 1, curves: 2, glyph: 3, glyphs: 4, marker: 5, stub: 6, stubs: 7 } as const;
export const BUNDLE_INTS = 8;

interface Work {
  scene: PlanScene;
  visible: VisibleSet;
  cam: Camera;
  /** The instances' origin: everything is written relative to it. */
  origin: Vec2;
  p: RenderParams;
  font?: FontData;
  sides?: Map<Id, TitleSide>;
  layouts?: LayoutOverrides;
  /** The complex visible connections, in visible order; `next` is the first not built. */
  queue: number[];
  next: number;
  /** The simple connections with a title, by visible index, in order: theirs are placed with the complex bundles' ones. */
  titled: number[];
  padded: Map<number, Vec2[]>;
  extents: Map<number, number>;
  /** The groups' hulls relative to the origin, for the bundles that end on them (bundleEnd). */
  hulls: Map<number, Vec2[]>;
  /** The last largest step culled against, and its visibleFrom. */
  cullK: number;
  cullFrom: number;
}

function newInstances(): Instances {
  return {
    origin: { x: 0, y: 0 }, boxes: new IntList(), simple: new IntList(), curves: new FloatList(), curveKeys: [], glyphs: newGlyphMeshes(),
    envelopes: newEnvelopeMeshes(), texts: new FloatList(), markers: [], stubs: [], titles: [], revealZoom: Infinity, pending: false, work: null,
    bundles: new IntList(), bundleOf: new IntList(), envelopeAt: new IntList(), groupTitles: new IntList(), itemTexts: 0, titleGlyphs: new IntList(),
    titled: new IntList(),
  };
}

const newWork = (
  scene: PlanScene, visible: VisibleSet, cam: Camera, origin: Vec2, p: RenderParams, font?: FontData, sides?: Map<Id, TitleSide>, layouts?: LayoutOverrides,
): Work => ({
  scene, visible, cam, origin, p, font, sides, layouts, queue: [], next: 0, titled: [], padded: new Map(), extents: new Map(), hulls: new Map(), cullK: Number.NaN,
  cullFrom: 0,
});

/**
 * A simple connection: two ends on boxes (no group node; the members of a closed group are boxes too, hidden under its
 * fill), no stub, centre nor layout (its own, or one in `layouts`); its curves are computed in the vertex shaders from
 * its two items' texels (simpleBranches is their TS twin).
 */
export function isSimple(scene: PlanScene, vc: VisibleConnection, layouts?: LayoutOverrides): boolean {
  const ends = vc.ends;
  if (ends.length !== 2 || vc.stubs.length > 0 || vc.center !== undefined) return false;
  const a = ends[0], b = ends[1];
  if (a.item === b.item) return false;
  const items = scene.items;
  return items[a.item].kind !== 'group' && items[b.item].kind !== 'group' && scene.layout[vc.part] === undefined && !layouts?.has(vc.part);
}

/** The zoom under which a connection whose largest step is kTop is not drawn (ribbonCullAlpha at zoom × curveZoomHeadroom). */
export const visibleFrom = (kTop: number, p: RenderParams): number =>
  (p.ribbonCullAlpha * p.widthMinPx) / (p.widthBasePx * p.factor ** kTop * p.curveZoomHeadroom);

/**
 * The instances of a visible set (spec 8.2 to 8.6): envelopes (a mesh, as before), the boxes, every simple connection,
 * the items' titles, then the complex bundles in visible order until `budget.deadline` (performance.now(); at least one
 * is built), the others left pending. `font`: the titles are built with it (none without); `sides`: connection titles
 * keep the side they had; `reuse`: its storage is refilled; `layouts`: parts drawn with another layout than their own
 * (a handle being dragged).
 */
export function buildInstances(
  scene: PlanScene, visible: VisibleSet, cam: Camera, origin: Vec2, p: RenderParams, budget?: { deadline: number },
  font?: FontData, sides?: Map<Id, TitleSide>, reuse?: Instances, layouts?: LayoutOverrides,
): Instances {
  const inst = reuse ?? newInstances();
  inst.boxes.clear();
  inst.simple.clear();
  inst.curves.clear();
  inst.curveKeys.length = 0;
  clearGlyphMeshes(inst.glyphs);
  inst.texts.clear();
  inst.markers = [];
  inst.stubs = [];
  inst.titles = [];
  inst.origin = origin;
  inst.revealZoom = Infinity;
  for (const l of [inst.bundles, inst.bundleOf, inst.groupTitles, inst.titleGlyphs, inst.titled]) l.clear();
  const connections = visible.connections, n = connections.length, titles = scene.titles;
  const w = newWork(scene, visible, cam, origin, p, font, sides, layouts);
  inst.work = w;
  inst.pending = true;

  appendEnvelopes(inst, scene, visible, p);
  const unbuilt = inst.bundleOf.extend(n);
  inst.bundleOf.storage.fill(-1, unbuilt, unbuilt + n);
  const boxesAt = inst.boxes.extend(visible.items.length);
  inst.boxes.storage.set(visible.items, boxesAt);
  // Every simple connection at once, the complex ones queued (one pass: the visible set is read once).
  const simple = inst.simple;
  let d = simple.storage;
  for (let ci = 0; ci < n; ci++) {
    const vc = connections[ci];
    if (!isSimple(scene, vc, layouts)) { w.queue.push(ci); continue; }
    const a = vc.ends[0], b = vc.ends[1], fade = vc.fade;
    const o = simple.extend(SIMPLE_INTS);
    if (o + SIMPLE_INTS > d.length) d = simple.storage;
    d[o] = a.item;
    d[o + 1] = b.item;
    d[o + 2] = ROLE_CODE[a.role] | (ROLE_CODE[b.role] << SIMPLE_ROLE_BITS) | (a.dashed ? SIMPLE_DASHED_A : 0) | (b.dashed ? SIMPLE_DASHED_B : 0) | (fade >= 0 ? SIMPLE_FADE_OUT : 0);
    d[o + 3] = ci;
    d[o + 4] = fade;
    const m = masksOf(vc, -1);
    d[o + 5] = m[0]; d[o + 6] = m[1]; d[o + 7] = m[2]; d[o + 8] = m[3];
    if (titles[vc.part] !== '') { w.titled.push(ci); inst.titled.push1(ci); }
  }
  if (font) inst.revealZoom = Math.min(inst.revealZoom, appendItemTitles(inst.texts, scene, visible, cam, p, font, (g) => paddedOf(w, g), inst.groupTitles));
  inst.itemTexts = inst.texts.length;
  resumeInstances(inst, budget);
  return inst;
}

/**
 * The envelopes of visible groups (all of them, or those at visible indices `groups`), parents first so nested levels
 * are drawn on top, relative to the instances' origin, into `out` (by default the instances' own, each one's indices
 * noted in `envelopeAt`), made anew; `each`: told each envelope's index range [from, to).
 */
export function appendEnvelopes(
  inst: Instances, scene: PlanScene, visible: VisibleSet, p: RenderParams, out: EnvelopeMeshes = inst.envelopes, groups?: Iterable<number>,
  each?: (from: number, to: number) => void,
): void {
  const items = scene.items, origin = inst.origin, none = NO_PARENT, at = out === inst.envelopes ? inst.envelopeAt : null;
  clearEnvelopeMeshes(out);
  at?.clear();
  for (const j of groups ?? visible.groups.keys()) {
    const g = visible.groups[j], it = items[g], start = out.index.length;
    appendEnvelope(out, it.hull!.map((q) => ({ x: q.x - origin.x, y: q.y - origin.y })), it.pad!, groupColors(scene, g, p), it.maxChildK!,
      it.parent >= 0 ? items[it.parent].maxChildK! : none);
    at?.push2(start, out.index.length - start);
    each?.(start, out.index.length);
  }
}

/** Builds the complex bundles left pending, until `budget.deadline` (at least one); once all are, the connection titles. */
export function resumeInstances(inst: Instances, budget?: { deadline: number }): void {
  const w = inst.work;
  if (!w) return;
  for (let built = 0; w.next < w.queue.length; built++) {
    if (budget && built > 0 && performance.now() >= budget.deadline) return;
    appendBundle(inst, w, w.queue[w.next++]);
  }
  finishTitles(inst, w);
  inst.pending = false;
  inst.work = null;
}

/** One complex bundle appended, and its row in `bundles`. */
function appendBundle(inst: Instances, w: Work, ci: number): void {
  const curves = inst.curves.length, glyphs = inst.glyphs.scale.length, markers = inst.markers.length, stubs = inst.stubs.length;
  appendComplex(inst, w, ci);
  const row = inst.bundles.length / BUNDLE_INTS, o = inst.bundles.extend(BUNDLE_INTS), b = inst.bundles.storage;
  b[o] = ci;
  b[o + 1] = curves / CURVE_FLOATS;
  b[o + 2] = (inst.curves.length - curves) / CURVE_FLOATS;
  b[o + 3] = glyphs;
  b[o + 4] = inst.glyphs.scale.length - glyphs;
  b[o + 5] = inst.markers.length > markers ? markers : -1;
  b[o + 6] = stubs;
  b[o + 7] = inst.stubs.length - stubs;
  inst.bundleOf.storage[ci] = row;
}

/** Ranges [from, to) of instances (or of vertices) rewritten in place: what is to be sent again. */
export type Ranges = [number, number][];

/**
 * The complex bundles `list` (visible indices) written again for `scene`, in place (plan 3c task 9: previews and
 * edits), with the camera and origin they were built with: their curves, glyphs, markers and stubs. Each one must keep
 * its counts, which its ends, roles, stubs and steps give; null when one does not (or was not built as a complex
 * bundle), and then nothing was changed. Returns the curve instances and glyph vertices rewritten.
 */
export function rewriteBundles(
  inst: Instances, scene: PlanScene, visible: VisibleSet, cam: Camera, p: RenderParams, list: Iterable<number>, layouts?: LayoutOverrides,
): { curves: Ranges; glyphs: Ranges } | null {
  const w = newWork(scene, visible, cam, inst.origin, p, undefined, undefined, layouts), b = inst.bundles.storage;
  // Every bundle's geometry first, its counts checked against its row: written only if all of them kept theirs.
  const rows: number[] = [], made: (Complex | null)[] = [];
  for (const ci of new Set(list)) {
    const row = ci >= 0 && ci < inst.bundleOf.length ? inst.bundleOf.storage[ci] : -1;
    if (row < 0) return null;
    const c = complexOf(w, ci), o = row * BUNDLE_INTS;
    if (c ? b[o + 5] < 0 || c.curves !== b[o + 2] || c.glyphs !== b[o + 4] || c.stubs !== b[o + 7] : b[o + 5] >= 0) return null;
    rows.push(row);
    made.push(c);
  }
  const curves: Ranges = [], glyphs: Ranges = [];
  rows.forEach((row, q) => {
    const c = made[q], o = row * BUNDLE_INTS;
    if (!c) return;
    writeComplex(inst, w, b[o], c, row);
    if (b[o + 2] > 0) curves.push([b[o + 1], b[o + 1] + b[o + 2]]);
    if (b[o + 4] > 0) glyphs.push([b[o + 3], b[o + 3] + b[o + 4]]);
  });
  return { curves, glyphs };
}

/**
 * The connection titles placed anew for `scene` over the bundles drawn (an edit that moved items, plan 3c task 9), as
 * a rebuild places them; their glyphs after the items' titles.
 */
export function placeTitlesAnew(inst: Instances, scene: PlanScene, visible: VisibleSet, cam: Camera, p: RenderParams, font?: FontData, sides?: Map<Id, TitleSide>): void {
  const w = newWork(scene, visible, cam, inst.origin, p, font, sides);
  w.titled = [...inst.titled.view()];
  inst.texts.truncate(inst.itemTexts);
  inst.titles = [];
  inst.titleGlyphs.clear();
  finishTitles(inst, w);
}

/**
 * The cores drawn as markers (spec 8.5, 11.1), relative to the origin: the complex bundles' with several members, and
 * with `all` (while a connection is drawn) every core, a simple connection's midway between its boxes where the GPU
 * draws it at `zoom`. `scene` is the one the instances were built for: their slots are its own (a scene updated since,
 * compacted, holds others).
 */
export function markerCores(
  scene: PlanScene, inst: Instances, zoom: number, p: RenderParams, all: boolean,
): { x: number; y: number; kMax: number; conn: number; masks: ArrayLike<number>; maskAt: number }[] {
  // Its masks: MASKS from maskAt in `masks` (a simple connection's in its instance: no view made per core, M4 of the review).
  const out: { x: number; y: number; kMax: number; conn: number; masks: ArrayLike<number>; maskAt: number }[] = [];
  for (const m of inst.markers) if (m.multi || all) out.push({ x: m.pos.x, y: m.pos.y, kMax: m.kMax, conn: m.conn, masks: m.masks, maskAt: 0 });
  if (!all) return out;
  const s = inst.simple.view(), o = inst.origin, items = scene.items;
  for (let q = 0; q < s.length; q += SIMPLE_INTS) {
    const a = items[s[q]], b = items[s[q + 1]], kMax = Math.max(a.k, b.k);
    if (zoom < visibleFrom(kMax, p)) continue;
    const m = simpleMarker(a, b);
    out.push({ x: m.x - o.x, y: m.y - o.y, kMax, conn: s[q + 3], masks: s, maskAt: q + 5 });
  }
  return out;
}

/**
 * What is drawn and what is being built (plan 3c task 8, fix 1): a rebuild left pending does not touch the instances
 * shown, which stay drawn and hit-tested whole, their visible set with them, until it completes; then the two swap at
 * once, as the render worker's frames did. Each holds its own storage: the next rebuild refills the instances shown
 * before last (or a pending build given up), never those on screen. `T`: what goes with the instances (their scene and
 * visible set).
 */
export class InstanceBuffers<T extends { inst: Instances }> {
  /** Drawn and hit-tested: always complete. */
  front: T | null = null;
  /** Pending, built at the next frames. */
  building: T | null = null;
  private spare: Instances | null = null;

  /** Storage for a new rebuild, never the front's: a pending build given up, or the instances shown before. */
  storage(): Instances | undefined {
    if (this.building) {
      const inst = this.building.inst;
      this.building = null;
      return inst;
    }
    const inst = this.spare;
    this.spare = null;
    return inst ?? undefined;
  }

  /** A rebuild just made: shown at once if complete (returns true), else built on by resume. */
  start(next: T): boolean {
    this.building = next;
    return next.inst.pending ? false : this.swap();
  }

  /** A pending rebuild given up (what it was built for changed): its storage serves the next one. */
  cancel(): void {
    if (!this.building) return;
    this.spare = this.building.inst;
    this.building = null;
  }

  /** The pending rebuild built on until the deadline; returns whether it completed and is now shown. */
  resume(budget?: { deadline: number }): boolean {
    if (!this.building) return false;
    resumeInstances(this.building.inst, budget);
    return this.building.inst.pending ? false : this.swap();
  }

  private swap(): boolean {
    this.spare = this.front?.inst ?? null;
    this.front = this.building;
    this.building = null;
    return true;
  }
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
  const c = complexOf(w, ci);
  if (!c) { if (w.cullFrom < inst.revealZoom) inst.revealZoom = w.cullFrom; return; }
  writeComplex(inst, w, ci, c);
}

/** A complex bundle's geometry, and what it writes: curve instances, glyph vertices, stubs. */
interface Complex {
  open: BundleGeometry;
  /** The two endpoints nearest the camera (x, y, half extent), relative to the origin. */
  e0: { x: number; y: number; e: number };
  e1: { x: number; y: number; e: number };
  curves: number;
  glyphs: number;
  stubs: number;
}

/** Visible connection ci's bundle as it is drawn, or null when too thin at the deepest zoom a rebuild serves (w.cullFrom). */
function complexOf(w: Work, ci: number): Complex | null {
  const { scene, visible, cam, p } = w, items = scene.items, vc = visible.connections[ci];
  let kTop = vc.ends.length > 0 ? -Infinity : 0;
  for (const e of vc.ends) if (items[e.item].k > kTop) kTop = items[e.item].k;
  // Bundles mostly share their largest step: its threshold is computed again only when it changes.
  if (kTop !== w.cullK) { w.cullK = kTop; w.cullFrom = visibleFrom(kTop, p); }
  if (cam.zoom < w.cullFrom) return null;
  const o = w.origin, layout = w.layouts?.get(vc.part);
  const open = bundleFor(scene, vc, p, o, layout, w.hulls);
  // The two endpoints nearest the camera carry the off-screen fade (spec 8.5); a far part: its node and its centre. The
  // first two of a stable sort by distance, in one scan.
  const cx = cam.x - o.x, cy = cam.y - o.y, n = vc.ends.length + (vc.center !== undefined ? 1 : 0);
  let i0 = -1, i1 = -1, d0 = Infinity, d1 = Infinity;
  for (let q = 0; q < n; q++) {
    const i = q < vc.ends.length ? vc.ends[q].item : vc.center!, d = Math.hypot(items[i].x - o.x - cx, items[i].y - o.y - cy);
    if (i0 < 0 || d < d0) { i1 = i0; d1 = d0; i0 = i; d0 = d; } else if (i1 < 0 || d < d1) { i1 = i; d1 = d; }
  }
  const end = (i: number) => ({ x: items[i].x - o.x, y: items[i].y - o.y, e: extentOf(w, i) });
  const e0 = end(i0), e1 = i1 >= 0 ? end(i1) : e0;
  let stubs = 0;
  for (const b of open.branches) if (b.stub) stubs++;
  return { open, e0, e1, curves: (open.trunk ? 1 : 0) + open.branches.length, glyphs: bundleGlyphCount(open), stubs };
}

/**
 * A complex bundle written: appended, or with `row` (its row in `bundles`) in its place, its counts being the same
 * (rewriteBundles checks them).
 */
function writeComplex(inst: Instances, w: Work, ci: number, c: Complex, row = -1): void {
  const vc = w.visible.connections[ci], { open, e0, e1 } = c, b = inst.bundles.storage, r = row * BUNDLE_INTS;
  const foldK = vc.fade >= 0 ? w.scene.items[vc.fade].maxChildK! : 0, mode = vc.fade >= 0 ? 2 : 0;
  let at = row >= 0 ? b[r + 1] * CURVE_FLOATS : inst.curves.extend(c.curves * CURVE_FLOATS);
  const d = inst.curves.storage;
  /** A branch's end among vc's (by its key), −1 for a trunk or a stub's branch. */
  const endOf = (key: Id | null, stub: boolean) => (key === null || stub ? -1 : vc.ends.findIndex((e) => e.key === key));
  const curve = (a: Pick<Branch, 'p0' | 'b1' | 'b2' | 'p3'>, k0: number, k1: number, dashed: boolean, key: Id | null, own: number) => {
    // Written in place, field by field (CURVE_FIELDS): open0, open1, width, end0, end1, fold, masks.
    d[at] = a.p0.x; d[at + 1] = a.p0.y; d[at + 2] = a.b1.x; d[at + 3] = a.b1.y;
    d[at + 4] = a.b2.x; d[at + 5] = a.b2.y; d[at + 6] = a.p3.x; d[at + 7] = a.p3.y;
    d[at + 8] = k0; d[at + 9] = k1; d[at + 10] = dashed ? 1 : 0; d[at + 11] = ci;
    d[at + 12] = e0.x; d[at + 13] = e0.y; d[at + 14] = e0.e; d[at + 15] = e1.x; d[at + 16] = e1.y; d[at + 17] = e1.e;
    d[at + 18] = mode; d[at + 19] = foldK;
    const m = masksOf(vc, own);
    d[at + 20] = m[0]; d[at + 21] = m[1]; d[at + 22] = m[2]; d[at + 23] = m[3];
    at += CURVE_FLOATS;
    if (row < 0) inst.curveKeys.push(key);
  };
  /** A trunk as a cubic: its control points a third of the way along. */
  const straight = (t: [Vec2, Vec2]) => {
    const [A, B] = t, dx = B.x - A.x, dy = B.y - A.y;
    return { p0: A, b1: { x: A.x + dx / 3, y: A.y + dy / 3 }, b2: { x: A.x + (2 * dx) / 3, y: A.y + (2 * dy) / 3 }, p3: B };
  };
  if (open.trunk) curve(straight(open.trunk), open.kMax, open.kMax, false, null, -1);
  for (const a of open.branches) {
    const [k0, k1] = a.nodeEnd === 'p0' ? [a.kNode, a.kMarker] : [a.kMarker, a.kNode];
    curve(a, k0, k1, a.dashed, a.key, endOf(a.key, a.stub));
  }
  const masks = (br: Branch) => masksOf(vc, endOf(br.key, br.stub));
  appendBundleGlyphs(inst.glyphs, open, { end0: [e0.x, e0.y, e0.e], end1: [e1.x, e1.y, e1.e], fade: mode, foldK, conn: ci, masks }, w.p,
    row >= 0 ? b[r + 3] : undefined);
  const markerMasks = [...masksOf(vc, -1)];
  const marker = { conn: ci, pos: open.marker, kMax: open.kMax, multi: open.multi, masks: markerMasks };
  if (row >= 0) inst.markers[b[r + 5]] = marker;
  else inst.markers.push(marker);
  let si = 0;
  for (const br of open.branches) {
    if (!br.stub) continue;
    const stub = { conn: ci, stub: si, pos: br.nodeEnd === 'p0' ? br.p0 : br.p3, title: vc.stubs[si].title };
    if (row >= 0) inst.stubs[b[r + 6] + si] = stub;
    else inst.stubs.push(stub);
    si++;
  }
}

/** A simple connection's two ends as bundle ends, relative to `origin`. */
export function simpleEnds(scene: PlanScene, vc: VisibleConnection, origin: Vec2): [ReturnType<typeof bundleEnd>, ReturnType<typeof bundleEnd>] {
  const [a, b] = vc.ends;
  return [bundleEnd(scene, a.item, a.role, a.dashed, a.key, origin), bundleEnd(scene, b.item, b.role, b.dashed, b.key, origin)];
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
  if (w.font) appendConnectionTitles(inst.texts, scene, visible, inst.titles, p, w.font, inst.titleGlyphs);
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
      const a = cubic(at + CURVE_AT.open0);
      if (inst.curveKeys[entry] === null) pts = [a.p0, a.p3]; // a trunk
      else pts = sampleBranch(a, bezierSegments(a.p0, a.b1, a.b2, a.p3, pxPerUnit, p.curveTolerancePx));
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
