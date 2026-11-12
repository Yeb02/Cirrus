import type { Vec2 } from '@cirrus/core';
import type { RenderParams } from '../params.ts';
import { FloatList, IndexList } from './arrays.ts';
import type { Branch, BundleGeometry } from './bundle.ts';
import { mul, norm, perp, sub } from './vec.ts';

/**
 * Segments needed to flatten a cubic Bézier within tolPx on screen (port of the bench). Wang's formula on the second
 * differences, keeping only their component across the chord: aligned control points always give one segment. The
 * GPU draws every cubic in curveSegments (plan 3c task 8); this sampling serves the connection titles' placement,
 * which keeps the samples it always counted.
 */
export function bezierSegments(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2, pxPerUnit: number, tolPx: number): number {
  let ux = p3.x - p0.x, uy = p3.y - p0.y;
  const l = Math.hypot(ux, uy);
  if (l < 1e-12) { ux = 1; uy = 0; } else { ux /= l; uy /= l; }
  const across = (dx: number, dy: number) => Math.abs(dx * uy - dy * ux);
  const d1 = across(p0.x - 2 * c0.x + c1.x, p0.y - 2 * c0.y + c1.y);
  const d2 = across(c0.x - 2 * c1.x + p3.x, c0.y - 2 * c1.y + p3.y);
  const n = Math.ceil(Math.sqrt((0.75 * Math.max(d1, d2) * pxPerUnit) / tolPx));
  return Math.min(64, Math.max(1, Number.isFinite(n) ? n : 64));
}

/** The cubic at `segments + 1` evenly spaced parameters, as the shaders evaluate it. */
export function sampleBranch(b: Pick<Branch, 'p0' | 'b1' | 'b2' | 'p3'>, segments: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t;
    const a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    pts.push({ x: a * b.p0.x + c * b.b1.x + d * b.b2.x + e * b.p3.x, y: a * b.p0.y + c * b.b1.y + d * b.b2.y + e * b.p3.y });
  }
  return pts;
}

/**
 * A connection's opacity from its width alone (spec 8.5), its largest step `kTop` at `pxPerUnit` screen pixels per
 * world unit: under ribbonCullAlpha it is not drawn.
 */
export function ribbonAlpha(kTop: number, pxPerUnit: number, p: RenderParams): number {
  return Math.min(1, (p.widthBasePx * p.factor ** kTop * pxPerUnit) / p.widthMinPx);
}

type Lists<K extends string> = Record<K, FloatList> & { index: IndexList };
type GlyphKey = 'position' | 'offset' | 'scale' | 'fill' | 'end0' | 'end1' | 'fold' | 'conn' | 'masks';

/**
 * Per-vertex attributes of the glyphs of complex bundles (arrows, dots), built on the CPU: their curves are GPU
 * instances (instances.ts). fold = (mode, foldK), mode 2 when the bundle fades out with a folding group, 0 otherwise.
 * Fill: 1 connection colour, 2 absent colour. masks: the groups whose fill is laid over the glyph (masksOf, −1 for none).
 */
export type GlyphMeshes = Lists<GlyphKey>;

const GLYPH_KEYS = ['position', 'offset', 'scale', 'fill', 'end0', 'end1', 'fold', 'conn', 'masks'] as const;

export function newGlyphMeshes(): GlyphMeshes {
  return Object.assign(Object.fromEntries(GLYPH_KEYS.map((k) => [k, new FloatList()])) as Record<GlyphKey, FloatList>, { index: new IndexList() });
}

export function clearGlyphMeshes(m: GlyphMeshes): void {
  for (const l of Object.values(m)) l.clear();
}

interface GlyphOptions {
  /** Two endpoints (x, y, half extent) for the off-screen fade (spec 8.5). */
  end0: [number, number, number];
  end1: [number, number, number];
  /** 2: fades out with the folding group of step foldK; 0: does not. */
  fade: number;
  foldK: number;
  /** Visible connection index (hover). */
  conn: number;
  /** Writes into out[0..4) the groups masking a branch's glyphs (masksOf); none without it. */
  masks?: (b: Branch, out: number[]) => void;
}

/** The glyph vertices of one bundle, in the order appendBundleGlyphs writes them (what an in-place rewrite checks). */
export function bundleGlyphCount(g: BundleGeometry): number {
  let n = 0;
  for (const a of g.branches) {
    n += a.role === 'associate' ? 1 + DOT_SIDES : 4;
    if (a.stub && a.role !== 'associate') n += 1 + DOT_SIDES;
  }
  return n;
}

/** The glyph mesh's vertex attributes, with their floats per vertex. */
const glyphLists = (g: GlyphMeshes): [FloatList, number][] =>
  [[g.position, 2], [g.offset, 2], [g.scale, 1], [g.fill, 1], [g.end0, 3], [g.end1, 3], [g.fold, 2], [g.conn, 1], [g.masks, 4]];

const NO_MASKS = [-1, -1, -1, -1];

/**
 * Appends one bundle's glyphs at its branches' node ends, with the local width there: an arrow or a dot, an absent
 * member's dot. `at`: written again from vertex `at` in place instead (plan 3c task 9: the same count,
 * bundleGlyphCount, and the same indices as before).
 */
export function appendBundleGlyphs(g: GlyphMeshes, open: BundleGeometry, o: GlyphOptions, p: RenderParams, at?: number): void {
  const mode = o.fade, foldK = Number.isFinite(o.foldK) ? o.foldK : 0;
  let v = at ?? g.scale.length;
  if (at === undefined) {
    const n = bundleGlyphCount(open);
    for (const [l, size] of glyphLists(g)) l.extend(n * size);
  }
  // Each attribute written in place, vertex by vertex, in the storage once extended.
  const pos = g.position.storage, off = g.offset.storage, sc = g.scale.storage, fi = g.fill.storage;
  const e0 = g.end0.storage, e1 = g.end1.storage, fo = g.fold.storage, cn = g.conn.storage, ms = g.masks.storage;
  let masks = NO_MASKS;
  /** A fan of glyph vertices around the node end: vertex 0 first, triangles given as offsets into the list. */
  const glyph = (p0: Vec2, offs: Vec2[], tris: number[], scale: number, fill: number) => {
    if (at === undefined) for (const t of tris) g.index.push(v + t);
    for (let i = 0; i < offs.length; i++, v++) {
      pos[2 * v] = p0.x; pos[2 * v + 1] = p0.y;
      off[2 * v] = offs[i].x; off[2 * v + 1] = offs[i].y;
      sc[v] = scale;
      fi[v] = fill;
      e0[3 * v] = o.end0[0]; e0[3 * v + 1] = o.end0[1]; e0[3 * v + 2] = o.end0[2];
      e1[3 * v] = o.end1[0]; e1[3 * v + 1] = o.end1[1]; e1[3 * v + 2] = o.end1[2];
      fo[2 * v] = mode; fo[2 * v + 1] = foldK;
      cn[v] = o.conn;
      ms[4 * v] = masks[0]; ms[4 * v + 1] = masks[1]; ms[4 * v + 2] = masks[2]; ms[4 * v + 3] = masks[3];
    }
  };
  /** Notched arrow in line-width units, around the node end; points away from the node for a source. */
  const arrow = (b: Branch): Vec2[] => {
    const L = p.arrowLength, H = p.arrowHalfWidth;
    // The tangent at the node end; along the chord when it is degenerate (norm's fallback, made only then).
    const tangent = (a: Vec2, z: Vec2) => {
      const x = a.x - z.x, y = a.y - z.y, l = Math.hypot(x, y);
      return l < 1e-9 ? norm(sub(b.p3, b.p0)) : { x: x / l, y: y / l };
    };
    if (b.nodeEnd === 'p0') {
      const d = tangent(b.b1, b.p0), n = perp(d);
      return [mul(d, L), mul(n, H), mul(d, L * (1 - p.arrowNotch)), mul(n, -H)];
    }
    const d = tangent(b.p3, b.b2), n = perp(d);
    return [{ x: 0, y: 0 }, sub(mul(n, H), mul(d, L)), mul(d, -L * p.arrowNotch), sub(mul(n, -H), mul(d, L))];
  };
  const own: number[] = [];
  for (const a of open.branches) {
    if (o.masks) { o.masks(a, own); masks = own; }
    const sNode = p.factor ** a.kNode, node = a.nodeEnd === 'p0' ? a.p0 : a.p3;
    glyph(node, a.role === 'associate' ? dot(p.dotRadius) : arrow(a), a.role === 'associate' ? DOT_TRIS : ARROW_TRIS, sNode, a.dashed ? 2 : 1);
    if (a.stub && a.role !== 'associate') glyph(node, dot(p.dotRadius), DOT_TRIS, sNode, 2);
  }
}

/** The sides of a dot (an associate's end, an absent member's): the shaders draw the same (render/shaders.ts). */
export const DOT_SIDES = 12;
const dots = new Map<number, Vec2[]>();
/** A dot's vertices around its centre, made once per radius (read only). */
function dot(radius: number): Vec2[] {
  let d = dots.get(radius);
  if (!d) {
    d = [{ x: 0, y: 0 }, ...Array.from({ length: DOT_SIDES }, (_, i) => {
      const a = (i * 2 * Math.PI) / DOT_SIDES;
      return { x: radius * Math.cos(a), y: radius * Math.sin(a) };
    })];
    dots.set(radius, d);
  }
  return d;
}
const DOT_TRIS = Array.from({ length: DOT_SIDES }, (_, i) => [0, 1 + i, 1 + ((i + 1) % DOT_SIDES)]).flat();
const ARROW_TRIS = [0, 1, 2, 0, 2, 3];
