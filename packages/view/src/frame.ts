import type { ConnectionLayout, Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import type { Camera } from './camera.ts';
import { groupPalette } from './color.ts';
import type { FloatList, IntList } from './geometry/arrays.ts';
import { type BundleEnd, type BundleGeometry, bundleGeometry } from './geometry/bundle.ts';
import { NO_PARENT } from './geometry/envelope.ts';
import { offsetPolygon } from './geometry/hull.ts';
import { foldT, stepScale } from './lod.ts';
import type { RenderParams, Rgb } from './params.ts';
import type { PlanScene, SceneItem } from './scene.ts';
import { appendTitle, type FontData, GLYPH_FLOATS, TITLE_CONNECTION, TITLE_GROUP_CLOSED, TITLE_GROUP_OPEN, TITLE_NODE } from './text.ts';
import { placeTitle, type Rect, type TitleSide } from './titles.ts';
import type { VisibleConnection, VisibleSet } from './visibility.ts';

/**
 * A group's colours (spec 8.4): top-level groups take groupHues in their order of creation (the scene's hue ranks),
 * their subgroups the same hue with a lightness offset per level.
 */
export function groupColors(scene: PlanScene, g: number, p: RenderParams): { open: Rgb; closed: Rgb } {
  let root = g;
  while (scene.items[root].parent >= 0) root = scene.items[root].parent;
  const hue = p.groupHues[(scene.hues.get(root) ?? 0) % p.groupHues.length];
  return groupPalette({ depth: scene.items[g].depth, hue }, p);
}

/**
 * An item as a bundle's end, relative to `origin`: its box, or a closed group's padded envelope. `hulls`: the groups'
 * hulls relative to `origin`, made once for the bundles of one pass (never changed).
 */
export function bundleEnd(
  scene: PlanScene, i: number, role: BundleEnd['role'], hollow: boolean, dashed: boolean, key: Id, origin: Vec2, hulls?: Map<number, Vec2[]>,
): BundleEnd {
  const it = scene.items[i];
  const e: BundleEnd = { pos: { x: it.x - origin.x, y: it.y - origin.y }, halfW: it.halfW, halfH: it.halfH, role, k: it.k, hollow, dashed, key };
  if (it.kind === 'group') {
    let poly = hulls?.get(i);
    if (!poly) { poly = it.hull!.map((q) => ({ x: q.x - origin.x, y: q.y - origin.y })); hulls?.set(i, poly); }
    e.hull = { poly, centre: e.pos, pad: it.pad! };
  }
  return e;
}

/**
 * The bundle of a visible connection (spec 8.5), relative to `origin`. `layout` stands in for the plan's own (a handle
 * being dragged, spec 8.5); `closed` draws it with its fading level closed; `hulls`: as for bundleEnd.
 */
export function bundleFor(
  scene: PlanScene, vc: VisibleConnection, p: RenderParams, origin: Vec2 = { x: 0, y: 0 },
  layout?: Omit<ConnectionLayout, 'plan' | 'connection'>, closed = false, hulls?: Map<number, Vec2[]>,
): BundleGeometry {
  const rel = (q: Vec2): Vec2 => ({ x: q.x - origin.x, y: q.y - origin.y });
  const own = layout ?? (vc.conns.length === 1 ? scene.layout[vc.conns[0]] : undefined);
  return bundleGeometry({
    ends: vc.ends.map((e) => bundleEnd(scene, closed ? e.item2 : e.item, e.role, closed ? e.hollow2 : e.hollow, e.dashed, e.key, origin, hulls)),
    stubs: vc.stubs.map((s) => ({ role: s.role, key: s.node })),
    ...(vc.center !== undefined ? { centre: rel(scene.items[vc.center]) } : {}),
    ...(own ? { layout: { ...own, marker: own.marker ? rel(own.marker) : undefined } } : {}),
  }, p);
}

/**
 * The zoom from which an element of step k, its text `scale` times a box title's, is readable at the deepest zoom a
 * rebuild serves (cam.zoom × curveZoomHeadroom): below it, its title is not built (spec 8.2).
 */
export const readableFrom = (k: number, scale: number, p: RenderParams): number =>
  p.textFade[0] / (p.baseFontPx * stepScale(k, p) * scale * p.curveZoomHeadroom);

/**
 * The glyphs of the items' titles (spec 8.2 to 8.4), in the order they are drawn: boxes, then each group's two titles
 * (open, at the top of its envelope; closed, at its centre), each from its item's centre (the item texture gives it). A
 * title still unreadable at the deepest zoom a rebuild serves is not built: the smallest zoom that would build one is
 * returned (Infinity for none), and reaching it rebuilds. The others fade in the shader, by the formulas BitmapText's
 * alphas followed. `paddedOf`: a group's padded envelope (world). `groupTitles`: for each visible group, the first glyph
 * of its open title and their count (0: not built), what a preview moves (its height above the centre).
 */
export function appendItemTitles(
  out: FloatList, scene: PlanScene, visible: VisibleSet, cam: Camera, p: RenderParams, font: FontData, paddedOf: (g: number) => Vec2[], groupTitles?: IntList,
): number {
  const items = scene.items;
  let reveal = Infinity, lastK = Number.NaN, lastScale = Number.NaN, lastFrom = 0;
  const readable = (k: number, scale: number) => {
    // Neighbours mostly share their step: the threshold is computed again only when it changes.
    if (k !== lastK || scale !== lastScale) { lastK = k; lastScale = scale; lastFrom = readableFrom(k, scale, p); }
    const from = lastFrom;
    if (cam.zoom >= from) return true;
    if (from < reveal) reveal = from;
    return false;
  };
  const parentK = (it: SceneItem) => (it.parent >= 0 ? items[it.parent].maxChildK! : NO_PARENT);
  visible.items.forEach((i, j) => {
    const it = items[i];
    if ((it.kind === 'phantom' && it.phantom !== 'node') || !readable(it.k, 1)) return;
    const s = stepScale(it.k, p), size = p.baseFontPx * s;
    appendTitle(out, font, it.title, size, (p.boxWidth - 2 * p.boxPadX) * s, size * p.lineHeight, 0, 0,
      TITLE_NODE, j, it.kind === 'phantom' ? p.phantomTitleDim : 1, NO_PARENT, parentK(it), i);
  });
  visible.groups.forEach((g, j) => {
    const it = items[g], start = out.length / GLYPH_FLOATS;
    if (!readable(it.k, Math.max(p.groupTitleOpenScale, p.groupTitleClosedScale))) { groupTitles?.push2(start, 0); return; }
    const s = stepScale(it.k, p), open = p.baseFontPx * s * p.groupTitleOpenScale, closed = p.baseFontPx * s * p.groupTitleClosedScale;
    appendTitle(out, font, it.title, open, 0, open * p.lineHeight, 0, openTitleY(scene, g, paddedOf(g), p), TITLE_GROUP_OPEN, j, 1, it.maxChildK!, parentK(it), g);
    groupTitles?.push2(start, out.length / GLYPH_FLOATS - start);
    appendTitle(out, font, it.title, closed, p.boxWidth * s, closed * p.lineHeight, 0, 0, TITLE_GROUP_CLOSED, j, 1, it.maxChildK!, parentK(it), g);
  });
  return reveal;
}

/** The height of a group's open title above its centre: at the top of its padded envelope `padded` (world). */
export function openTitleY(scene: PlanScene, g: number, padded: Vec2[], p: RenderParams): number {
  const it = scene.items[g], open = p.baseFontPx * stepScale(it.k, p) * p.groupTitleOpenScale;
  return Math.min(...padded.map((q) => q.y)) - it.y - open * p.groupTitleOffset;
}

/** The zoom from which a connection's title, its largest step kMax, is readable at the deepest zoom a rebuild serves. */
export const titleReadableFrom = (kMax: number, p: RenderParams): number => p.titleFade[0] / (p.titleFontPx * stepScale(kMax, p) * p.curveZoomHeadroom);

/** A connection title placed: by its visible connection, its id (the parts' ids joined), its box relative to the origin. */
export interface PlacedTitle { conn: number; id: Id; text: string; box: Rect; kMax: number; side: TitleSide }

/** A connection title's box size and its gap to the core, at its largest step kMax. */
export function titleSize(text: string, kMax: number, p: RenderParams): { w: number; h: number; gap: number } {
  const size = p.titleFontPx * stepScale(kMax, p);
  return { w: p.titleCharWidth * size * text.length, h: size * p.titleBoxHeight, gap: p.titleGap * stepScale(kMax, p) };
}

/** Where a visible connection's core is, relative to the origin, with its largest step. */
export interface CoreAt { conn: number; pos: Vec2; kMax: number }

/**
 * The connection titles (spec 8.5): near each core, given in the visible order, covering neither the curves (the
 * samples `samplesIn` gives in a rectangle, relative to the origin) nor the visible boxes, groups more than half
 * closed and titles placed before; `prevSides` keeps a title on the side it had. A title still unreadable at the
 * deepest zoom a rebuild serves is left out: the smallest zoom that would place one is returned (Infinity for none).
 */
export function placeConnectionTitles(
  scene: PlanScene, visible: VisibleSet, cores: CoreAt[], cam: Camera, origin: Vec2, p: RenderParams,
  samplesIn: (x0: number, y0: number, x1: number, y1: number) => Vec2[], prevSides: Map<Id, TitleSide> | undefined, out: PlacedTitle[],
): number {
  const items = scene.items;
  let reveal = Infinity;
  let obTree: Flatbush | null | undefined, obstacles: Rect[] = [];
  /** Obstacles: visible boxes, and groups more than half closed (made at the first title read). */
  const obstaclesIn = (x0: number, y0: number, x1: number, y1: number): Rect[] => {
    if (obTree === undefined) {
      obstacles = [];
      for (const i of visible.items) {
        const it = items[i];
        obstacles.push({ x: it.x - origin.x - it.halfW, y: it.y - origin.y - it.halfH, w: 2 * it.halfW, h: 2 * it.halfH });
      }
      for (const g of visible.groups) {
        const it = items[g];
        if (foldT(it.maxChildK!, cam.zoom, p) < p.foldClickable) continue;
        const poly = offsetPolygon(it.hull!, it.pad!).map((q) => ({ x: q.x - origin.x, y: q.y - origin.y }));
        const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
        obstacles.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      }
      obTree = obstacles.length > 0 ? new Flatbush(obstacles.length) : null;
      if (obTree) { for (const o of obstacles) obTree.add(o.x, o.y, o.x + o.w, o.y + o.h); obTree.finish(); }
    }
    return obTree ? obTree.search(x0, y0, x1, y1).map((i) => obstacles[i]) : [];
  };
  const placed: Rect[] = [];
  for (const m of cores) {
    const vc = visible.connections[m.conn];
    const text = vc.conns.length > 1 ? `${vc.conns.length} connexions` : scene.titles[vc.conns[0]];
    if (!text) continue;
    // Unreadable even at the deepest zoom a rebuild serves: left out until that zoom (spec 8.2).
    const from = titleReadableFrom(m.kMax, p);
    if (cam.zoom < from) { if (from < reveal) reveal = from; continue; }
    const { w, h, gap } = titleSize(text, m.kMax, p);
    const reach = w + gap * 4 + h;
    const [qx0, qy0, qx1, qy1] = [m.pos.x - reach, m.pos.y - reach, m.pos.x + reach, m.pos.y + reach];
    const id = vc.conns.map((i) => scene.ids[i]).join('+');
    const { side, rect } = placeTitle(m.pos, w, h, gap, samplesIn(qx0, qy0, qx1, qy1), [...obstaclesIn(qx0, qy0, qx1, qy1), ...placed], prevSides?.get(id));
    placed.push(rect);
    out.push({ conn: m.conn, id, text, box: rect, kMax: m.kMax, side });
  }
  return reveal;
}

/**
 * The glyphs of the connection titles placed, after the items' (TITLE_CONNECTION, anchored relative to the origin);
 * `spans`: for each title, its first glyph and their count (a title that follows its core moves its anchor).
 */
export function appendConnectionTitles(out: FloatList, visible: VisibleSet, titles: PlacedTitle[], p: RenderParams, font: FontData, spans?: IntList): void {
  for (const t of titles) {
    const size = p.titleFontPx * stepScale(t.kMax, p), vc = visible.connections[t.conn], start = out.length / GLYPH_FLOATS;
    appendTitle(out, font, t.text, size, 0, size * p.lineHeight, t.box.x + t.box.w / 2, t.box.y + t.box.h / 2,
      TITLE_CONNECTION, t.conn, 1, vc.fade === 'out' ? vc.foldK : NO_PARENT, NO_PARENT, -1);
    spans?.push2(start, out.length / GLYPH_FLOATS - start);
  }
}
