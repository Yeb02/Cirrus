import type { Id, Vec2 } from '@cirrus/core';
import type { Bounds, Camera } from './camera.ts';
import { openTitleY, type PlacedTitle, titleSize } from './frame.ts';
import type { EnvelopeMeshes } from './geometry/envelope.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { simpleMarker } from './geometry/simple.ts';
import { appendEnvelopes, BUNDLE_AT, BUNDLE_INTS, type Instances, isSimple, type LayoutOverrides, placeTitlesAnew, type Ranges, rewriteBundles } from './instances.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import { GONE_ITEM, type PlanScene, type SceneItem } from './scene.ts';
import type { SceneChanges } from './sceneUpdate.ts';
import { type FontData, GLYPH_AT, GLYPH_FLOATS } from './text.ts';
import { titleRect, type TitleSide } from './titles.ts';
import type { VisibleConnection, VisibleSet } from './visibility.ts';

/**
 * What a preview changes of what is drawn (plan 3c task 9), found once per gesture and visible set: the texels of
 * `items` and `groups`, the complex bundles `complex`, the envelopes of `groups`; the rest follows by the item texture.
 */
export interface PreviewSplit {
  /** The visible set it is for: `complex`, `simple`, `drawnGroups` are its indices. */
  visible: VisibleSet;
  /** The items moved and their descendants. */
  items: number[];
  /** Their ancestors, and the groups moved. */
  groups: number[];
  /** The visible complex bundles that touch items ∪ groups. */
  complex: number[];
  /** The visible simple connections that touch them: they follow by the texture, their titles with their core. */
  simple: number[];
  /** Of items ∪ groups, those not drawn though their parent is (out of the view): a preview that brings one in is built whole. */
  hidden: number[];
  /** The visible indices of the groups among them that are drawn, in visible order. */
  drawnGroups: number[];
}

/** Whether a visible connection ends on (or is centred on) an item of `set`, its fading level open or closed. */
function touches(vc: VisibleConnection, set: ReadonlySet<number>): boolean {
  if (vc.center !== undefined && set.has(vc.center)) return true;
  for (const e of vc.ends) if (set.has(e.item) || set.has(e.item2)) return true;
  return false;
}

/**
 * The split of a preview that moves `moving` (their descendants with them, spec 9.1), for the visible set drawn: one
 * pass over it, made once per drag (and again when the visible set is rebuilt).
 */
export function previewSplit(scene: PlanScene, visible: VisibleSet, moving: readonly number[]): PreviewSplit {
  const items = scene.items, list: number[] = [], all = new Set<number>(), groups = new Set<number>();
  const take = (i: number) => {
    if (all.has(i)) return;
    all.add(i);
    list.push(i);
    if (items[i].kind === 'group') groups.add(i);
    for (const c of items[i].children) take(c);
  };
  for (const i of moving) take(i);
  for (const i of moving) for (let a = items[i].parent; a >= 0; a = items[a].parent) { groups.add(a); all.add(a); }
  const drawn = new Set<number>(), drawnGroups: number[] = [];
  visible.groups.forEach((g, j) => { if (all.has(g)) { drawn.add(g); drawnGroups.push(j); } });
  for (const i of visible.items) if (all.has(i)) drawn.add(i);
  const hidden = [...all].filter((i) => !drawn.has(i) && (items[i].parent < 0 || drawn.has(items[i].parent)));
  const complex: number[] = [], simple: number[] = [];
  visible.connections.forEach((vc, ci) => { if (touches(vc, all)) (isSimple(scene, vc) ? simple : complex).push(ci); });
  return { visible, items: list, groups: [...groups], complex, simple, hidden, drawnGroups };
}

/** The split of a handle dragged on part `part` (spec 8.5): its visible connections, given another layout; nothing moves. */
export function layoutSplit(visible: VisibleSet, part: number): PreviewSplit {
  const complex: number[] = [];
  visible.connections.forEach((vc, ci) => { if (vc.conns.includes(part)) complex.push(ci); });
  return { visible, items: [], groups: [], complex, simple: [], hidden: [], drawnGroups: [] };
}

/**
 * The slots whose texels a preview `scene` of `base` changes: its items and groups, and the children of a group whose
 * largest step changed (their texels carry it as their parent's, texelSlots).
 */
export function previewSlots(base: PlanScene, scene: PlanScene, split: PreviewSplit): number[] {
  const out = [...split.items, ...split.groups];
  for (const g of split.groups) if (scene.items[g].maxChildK !== base.items[g].maxChildK) out.push(...scene.items[g].children);
  return out;
}

/**
 * What is drawn, as the renderer keeps it: the instances and their visible set, built at `cam` for `base` — itself the
 * state's scene `state`, or a preview of it —, and showing `scene` (a preview patched in, or `base`); `layouts`: the
 * layouts they were built with in place of the plan's.
 */
export interface Shown { scene: PlanScene; base: PlanScene; state: PlanScene; visible: VisibleSet; inst: Instances; cam: Camera; layouts?: LayoutOverrides }

/** What a patch rewrote in place, to send again: curve instances, glyph vertices, title glyphs; the envelopes all anew (an edit). */
export interface Patched { curves: Ranges; glyphs: Ranges; texts: Ranges; envelopes: boolean }

/** The rectangle the visible set was computed for: the camera's view widened by viewMarginPx (computeVisible). */
function preparedRect(cam: Camera, p: RenderParams): Bounds {
  const hw = (cam.widthPx / 2 + p.viewMarginPx) / cam.zoom, hh = (cam.heightPx / 2 + p.viewMarginPx) / cam.zoom;
  return { minX: cam.x - hw, maxX: cam.x + hw, minY: cam.y - hh, maxY: cam.y + hh };
}

/** An item's box as the visibility index has it: its own, a group's padded envelope. */
function boxOf(it: SceneItem): Bounds {
  if (it.kind !== 'group') return { minX: it.x - it.halfW, maxX: it.x + it.halfW, minY: it.y - it.halfH, maxY: it.y + it.halfH };
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const q of offsetPolygon(it.hull!, it.pad!)) {
    b.minX = Math.min(b.minX, q.x); b.maxX = Math.max(b.maxX, q.x);
    b.minY = Math.min(b.minY, q.y); b.maxY = Math.max(b.maxY, q.y);
  }
  return b;
}

/** Whether item i, not drawn, would be at `cam` in `scene`: in the prepared view, its parent (if any) not closed. */
function wouldShow(scene: PlanScene, i: number, cam: Camera, rect: Bounds, p: RenderParams): boolean {
  const it = scene.items[i];
  if (it === GONE_ITEM || (it.parent >= 0 && foldT(scene.items[it.parent].maxChildK!, cam.zoom, p) >= 1)) return false;
  const b = boxOf(it);
  return b.maxX >= rect.minX && b.minX <= rect.maxX && b.maxY >= rect.minY && b.minY <= rect.maxY;
}

/** The open titles of the drawn groups at visible indices `groups`, at the top of their envelope in `scene`. */
function rewriteGroupTitles(inst: Instances, scene: PlanScene, visible: VisibleSet, groups: readonly number[], p: RenderParams): Ranges {
  const out: Ranges = [], t = inst.texts.storage, spans = inst.groupTitles.storage, y0 = GLYPH_AT.anchor + 1;
  for (const j of groups) {
    if (2 * j + 1 >= inst.groupTitles.length) continue;
    const start = spans[2 * j], count = spans[2 * j + 1];
    if (count === 0) continue;
    const g = visible.groups[j], it = scene.items[g], y = openTitleY(scene, g, offsetPolygon(it.hull!, it.pad!), p);
    for (let q = start; q < start + count; q++) t[q * GLYPH_FLOATS + y0] = y;
    out.push([start, start + count]);
  }
  return out;
}

/**
 * The placed titles of a split's connections, found at its first patch, per list of titles placed (a rebuild or an
 * edit places them in a new list: the entry then is simply not found).
 */
const titlesOfSplit = new WeakMap<PreviewSplit, WeakMap<PlacedTitle[], number[]>>();

/**
 * The titles of the connections a preview moves follow their core, on the side they had (Ruling of plan 3c task 9):
 * placed by the same arithmetic as placeTitle, so that the base's core gives back the base's rectangle to the bit.
 */
function followTitles(inst: Instances, scene: PlanScene, split: PreviewSplit, p: RenderParams): Ranges {
  let byTitles = titlesOfSplit.get(split);
  if (!byTitles) titlesOfSplit.set(split, (byTitles = new WeakMap()));
  let list = byTitles.get(inst.titles);
  if (!list) {
    const conns = new Set([...split.complex, ...split.simple]);
    list = inst.titles.flatMap((t, k) => (conns.has(t.conn) ? [k] : []));
    byTitles.set(inst.titles, list);
  }
  const out: Ranges = [], t = inst.texts.storage, spans = inst.titleGlyphs.storage, o = inst.origin, items = scene.items, a0 = GLYPH_AT.anchor;
  for (const k of list) {
    const title = inst.titles[k], row = inst.bundleOf.storage[title.conn];
    let core: Vec2;
    if (row >= 0) {
      const m = inst.bundles.storage[row * BUNDLE_INTS + BUNDLE_AT.marker];
      if (m < 0) continue;
      core = inst.markers[m].pos;
    } else {
      const vc = split.visible.connections[title.conn], a = items[vc.ends[0].item], b = items[vc.ends[1].item];
      core = simpleMarker({ x: a.x - o.x, y: a.y - o.y }, { x: b.x - o.x, y: b.y - o.y });
    }
    const { w, h, gap } = titleSize(title.text, title.kMax, p);
    const box = (title.box = titleRect(core, w, h, gap, title.side));
    const x = box.x + box.w / 2, y = box.y + box.h / 2, start = spans[2 * k], count = spans[2 * k + 1];
    for (let q = start; q < start + count; q++) { t[q * GLYPH_FLOATS + a0] = x; t[q * GLYPH_FLOATS + a0 + 1] = y; }
    if (count > 0) out.push([start, start + count]);
  }
  return out;
}

/**
 * The instances shown, patched in place for `scene`, a preview of their state's scene by `split` — or that scene
 * itself, which brings them back to the bit (Review Focus 5) — with `layouts` for parts drawn with another layout: the
 * complex bundles of the split, the open titles of its groups, the titles of its connections. The items, boxes, simple
 * connections and their titles' glyphs follow by the item texture; the envelopes are previewEnvelopes'. Null when it
 * cannot be done in place, the instances unchanged: the preview is then built whole (a step changed, a scale gesture;
 * an item it moves comes into view; a bundle not built as a complex one, or that would not keep its counts).
 */
export function patchPreview(shown: Shown, scene: PlanScene, split: PreviewSplit, p: RenderParams, layouts?: LayoutOverrides): Patched | null {
  const { inst, visible, cam } = shown;
  if (split.visible !== visible) return null;
  const now = scene.items, was = shown.state.items;
  for (const list of [split.items, split.groups]) for (const i of list) if (now[i].k !== was[i].k || now[i].maxChildK !== was[i].maxChildK) return null;
  if (split.hidden.length > 0) {
    const rect = preparedRect(cam, p);
    for (const i of split.hidden) if (wouldShow(scene, i, cam, rect, p)) return null;
  }
  const rewritten = rewriteBundles(inst, scene, visible, cam, p, split.complex, layouts);
  if (!rewritten) return null;
  const texts = rewriteGroupTitles(inst, scene, visible, split.drawnGroups, p);
  for (const r of followTitles(inst, scene, split, p)) texts.push(r);
  return { curves: rewritten.curves, glyphs: rewritten.glyphs, texts, envelopes: false };
}

/**
 * The envelopes of a preview's drawn groups, made for `scene` into `out`, and where they go among the instances' own,
 * which stay as they are: per group, four numbers — the index range of its envelope in the instances' mesh, which is
 * not drawn, then the one in `out` drawn in its place (the draw order is kept).
 */
export function previewEnvelopes(shown: Shown, scene: PlanScene, split: PreviewSplit, p: RenderParams, out: EnvelopeMeshes): number[] {
  const inst = shown.inst, at = inst.envelopeAt.storage, draws: number[] = [];
  let side = 0;
  appendEnvelopes(inst, scene, shown.visible, p, out, split.drawnGroups, (from, to) => {
    const j = split.drawnGroups[side++];
    draws.push(at[2 * j], at[2 * j] + at[2 * j + 1], from, to);
  });
  return draws;
}

/**
 * The instances shown, patched in place after an action that leads from `prev` (the scene they were built for) to
 * `scene` by `changes` (plan 3c task 9), equal to what a rebuild for the same visible set would give: the complex
 * bundles that touch what changed, the open titles of the groups changed, the envelopes and the connection titles
 * anew (placed again, as after any action: `sides` cleared). `also`: a preview patched in before (a drop, or an action
 * that lands during a gesture), whose split is rewritten too, its complex bundles from the scene's own layouts. Null when the visible set could have changed — the hierarchy, slots come or gone, parts
 * derived again, a step, a title or a fold changed, an item come into view — and then nothing was changed.
 */
export function patchEdit(
  shown: Shown, prev: PlanScene, scene: PlanScene, changes: SceneChanges, p: RenderParams, font?: FontData, sides?: Map<Id, TitleSide>, also?: PreviewSplit,
): Patched | null {
  if (changes.full || changes.hierarchy || changes.parts.length > 0 || scene.items.length !== prev.items.length) return null;
  const { inst, visible, cam } = shown, a = prev.items, b = scene.items;
  for (const i of changes.items) {
    const x = a[i], y = b[i];
    if (x === GONE_ITEM || y === GONE_ITEM || x.kind !== y.kind || x.phantom !== y.phantom || x.k !== y.k || x.maxChildK !== y.maxChildK || x.title !== y.title
      || x.lines !== y.lines || x.parent !== y.parent) return null;
  }
  const touched = new Set(changes.items);
  if (also) for (const list of [also.items, also.groups]) for (const i of list) touched.add(i);
  const drawn = new Set<number>(), drawnGroups: number[] = [];
  visible.groups.forEach((g, j) => { if (touched.has(g)) { drawn.add(g); drawnGroups.push(j); } });
  for (const i of visible.items) if (touched.has(i)) drawn.add(i);
  const rect = preparedRect(cam, p);
  for (const i of changes.items) if (!drawn.has(i) && (b[i].parent < 0 || drawn.has(b[i].parent)) && wouldShow(scene, i, cam, rect, p)) return null;
  // The bundles it touches, and those the preview rewrote (a layout handle's: its override is dropped with it).
  const complex: number[] = also?.visible === visible ? [...also.complex] : [], of = inst.bundleOf.storage;
  visible.connections.forEach((vc, ci) => { if (of[ci] >= 0 && touches(vc, touched)) complex.push(ci); });
  const rewritten = rewriteBundles(inst, scene, visible, cam, p, complex);
  if (!rewritten) return null;
  const texts = rewriteGroupTitles(inst, scene, visible, drawnGroups, p);
  placeTitlesAnew(inst, scene, visible, cam, p, font, sides);
  texts.push([inst.itemTexts / GLYPH_FLOATS, inst.texts.length / GLYPH_FLOATS]);
  appendEnvelopes(inst, scene, visible, p);
  return { curves: rewritten.curves, glyphs: rewritten.glyphs, texts, envelopes: true };
}
