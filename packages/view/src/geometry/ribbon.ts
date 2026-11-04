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
type GlyphKey = 'position' | 'position2' | 'offset' | 'offset2' | 'scale' | 'fill' | 'end0' | 'end1' | 'fold' | 'conn';

/**
 * Per-vertex attributes of the glyphs of complex bundles (arrows, dots, hollow insides), built on the CPU: their
 * curves are GPU instances (instances.ts). position2/offset2 hold the same vertex once the fading group level is
 * closed: the shader slides from one to the other (spec 8.5, "glisse en continu du membre vers le bord"). fold =
 * (mode, foldK), mode 0 none, 1 slide, 2 out. Fill: 1 connection colour, 2 absent colour, 0 sky (hollow inside), 3 sky
 * only once the level is more than half folded.
 */
export type GlyphMeshes = Lists<GlyphKey>;

export function newGlyphMeshes(): GlyphMeshes {
  const keys = ['position', 'position2', 'offset', 'offset2', 'scale', 'fill', 'end0', 'end1', 'fold', 'conn'] as const;
  return Object.assign(Object.fromEntries(keys.map((k) => [k, new FloatList()])) as Record<GlyphKey, FloatList>, { index: new IndexList() });
}

export function clearGlyphMeshes(m: GlyphMeshes): void {
  for (const l of Object.values(m)) l.clear();
}

export interface GlyphOptions {
  /** Two endpoints (x, y, half extent) for the off-screen fade (spec 8.5). */
  end0: [number, number, number];
  end1: [number, number, number];
  fade: 'none' | 'slide' | 'out';
  foldK: number;
  /** Visible connection index (hover). */
  conn: number;
}

export const FADE_MODE = { none: 0, slide: 1, out: 2 } as const;

/**
 * Appends one bundle's glyphs at its branches' node ends, with the local width there: an arrow or a dot, a hollow
 * inside, an absent member's dot. `closed` is the same bundle with the fading level closed: same branches in the same
 * order, so glyph i of one matches glyph i of the other.
 */
export function appendBundleGlyphs(g: GlyphMeshes, open: BundleGeometry, closed: BundleGeometry | null, o: GlyphOptions, p: RenderParams): void {
  const mode = FADE_MODE[o.fade], foldK = Number.isFinite(o.foldK) ? o.foldK : 0;
  /** A fan of glyph vertices around the node end: vertex 0 first, triangles given as offsets into the list. */
  const glyph = (at: Vec2, at2: Vec2, offs: Vec2[], offs2: Vec2[], tris: number[], scale: number, fill: number) => {
    const base = g.scale.length;
    for (let i = 0; i < offs.length; i++) {
      g.position.push2(at.x, at.y);
      g.position2.push2(at2.x, at2.y);
      g.offset.push2(offs[i].x, offs[i].y);
      g.offset2.push2(offs2[i].x, offs2[i].y);
      g.scale.push1(scale);
      g.fill.push1(fill);
      g.end0.push3(o.end0[0], o.end0[1], o.end0[2]);
      g.end1.push3(o.end1[0], o.end1[1], o.end1[2]);
      g.fold.push2(mode, foldK);
      g.conn.push1(o.conn);
    }
    for (const t of tris) g.index.push(base + t);
  };
  const dot = (radius: number): Vec2[] => [{ x: 0, y: 0 }, ...Array.from({ length: DOT_SIDES }, (_, i) => {
    const a = (i * 2 * Math.PI) / DOT_SIDES;
    return { x: radius * Math.cos(a), y: radius * Math.sin(a) };
  })];
  /** Notched arrow in line-width units, around the node end; points away from the node for a source. */
  const arrow = (b: Branch): Vec2[] => {
    const L = p.arrowLength, H = p.arrowHalfWidth;
    if (b.nodeEnd === 'p0') {
      const d = norm(sub(b.b1, b.p0), norm(sub(b.p3, b.p0))), n = perp(d);
      return [mul(d, L), mul(n, H), mul(d, L * (1 - p.arrowNotch)), mul(n, -H)];
    }
    const d = norm(sub(b.p3, b.b2), norm(sub(b.p3, b.p0))), n = perp(d);
    return [{ x: 0, y: 0 }, sub(mul(n, H), mul(d, L)), mul(d, -L * p.arrowNotch), sub(mul(n, -H), mul(d, L))];
  };
  const inset = (offs: Vec2[]): Vec2[] => {
    const c = { x: offs.reduce((s, q) => s + q.x, 0) / offs.length, y: offs.reduce((s, q) => s + q.y, 0) / offs.length };
    return offs.map((q) => ({ x: c.x + (q.x - c.x) * p.hollowInset, y: c.y + (q.y - c.y) * p.hollowInset }));
  };
  const nodePoint = (b: Branch) => (b.nodeEnd === 'p0' ? b.p0 : b.p3);

  open.branches.forEach((a, i) => {
    const b = closed?.branches[i] ?? a;
    const sNode = p.factor ** a.kNode;
    const fill = a.dashed ? 2 : 1;
    const shape = a.role === 'associate' ? dot(p.dotRadius) : arrow(a);
    const shape2 = a.role === 'associate' ? shape : arrow(b);
    const tris = a.role === 'associate' ? DOT_TRIS : ARROW_TRIS;
    glyph(nodePoint(a), nodePoint(b), shape, shape2, tris, sNode, fill);
    if (a.hollow || b.hollow) glyph(nodePoint(a), nodePoint(b), inset(shape), inset(shape2), tris, sNode, a.hollow ? 0 : 3);
    if (a.stub && a.role !== 'associate') glyph(nodePoint(a), nodePoint(b), dot(p.dotRadius), dot(p.dotRadius), DOT_TRIS, sNode, 2);
  });
}

/** The sides of a dot (an associate's end, an absent member's): the shaders draw the same (render/shaders.ts). */
export const DOT_SIDES = 12;
const DOT_TRIS = Array.from({ length: DOT_SIDES }, (_, i) => [0, 1 + i, 1 + ((i + 1) % DOT_SIDES)]).flat();
const ARROW_TRIS = [0, 1, 2, 0, 2, 3];
