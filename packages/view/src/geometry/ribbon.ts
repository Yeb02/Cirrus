import type { Id, Vec2 } from '@cirrus/core';
import type { RenderParams } from '../params.ts';
import { FloatList, IndexList } from './arrays.ts';
import type { Branch, BundleGeometry } from './bundle.ts';
import { len, mul, norm, perp, sub } from './vec.ts';

/**
 * Segments needed to flatten a cubic Bézier within tolPx on screen (port of the bench). Wang's formula on the second
 * differences, keeping only their component across the chord: aligned control points always give one segment.
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

function sample(b: Branch, segments: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t;
    const a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    pts.push({ x: a * b.p0.x + c * b.b1.x + d * b.b2.x + e * b.p3.x, y: a * b.p0.y + c * b.b1.y + d * b.b2.y + e * b.p3.y });
  }
  return pts;
}

/** Unit normal at each point of a polyline, from its neighbours. */
function normals(pts: Vec2[]): Vec2[] {
  const n = pts.length;
  return pts.map((_, i) => perp(norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]))));
}

type Lists<K extends string> = Record<K, FloatList> & { index: IndexList };
type RibbonKey = 'position' | 'position2' | 'normal' | 'normal2' | 'scale' | 'side' | 'dist' | 'end0' | 'end1' | 'fold' | 'conn';
type GlyphKey = 'position' | 'position2' | 'offset' | 'offset2' | 'scale' | 'fill' | 'end0' | 'end1' | 'fold' | 'conn';

/**
 * Per-vertex attributes of the connection meshes. position2/normal2/offset2 hold the same vertex once the fading group
 * level is closed: the shader slides from one to the other (spec 8.5, "glisse en continu du membre vers le bord").
 * fold = (mode, foldK), mode 0 none, 1 slide, 2 out. Glyph fill: 1 connection colour, 2 absent colour, 0 sky (hollow
 * inside), 3 sky only once the level is more than half folded.
 */
export interface ConnectionMeshes {
  ribbons: Lists<RibbonKey>;
  glyphs: Lists<GlyphKey>;
}

const lists = <K extends string>(keys: readonly K[]): Lists<K> =>
  Object.assign(Object.fromEntries(keys.map((k) => [k, new FloatList()])) as Record<K, FloatList>, { index: new IndexList() });

export function newConnectionMeshes(): ConnectionMeshes {
  return {
    ribbons: lists(['position', 'position2', 'normal', 'normal2', 'scale', 'side', 'dist', 'end0', 'end1', 'fold', 'conn'] as const),
    glyphs: lists(['position', 'position2', 'offset', 'offset2', 'scale', 'fill', 'end0', 'end1', 'fold', 'conn'] as const),
  };
}

export function clearConnectionMeshes(m: ConnectionMeshes): void {
  for (const l of [...Object.values(m.ribbons), ...Object.values(m.glyphs)]) l.clear();
}

export interface AppendOptions {
  /** zoom × curveZoomHeadroom: the flattening stays within tolerance until then. */
  pxPerUnit: number;
  /** Two endpoints (x, y, half extent) for the off-screen fade (spec 8.5). */
  end0: [number, number, number];
  end1: [number, number, number];
  fade: 'none' | 'slide' | 'out';
  foldK: number;
  /** Visible connection index (hover). */
  conn: number;
}

const MODE = { none: 0, slide: 1, out: 2 } as const;

/**
 * Appends one bundle: ribbons (trunk + branches) and glyphs (arrows, dots, hollow insides). Returns each line's
 * centerline in the open state with the member it leads to (null: the trunk), for hit testing and title placement. `closed` is the same bundle with the fading level
 * closed: same branches in the same order, sampled with the same counts, so vertex i of one matches vertex i of the other.
 */
export function appendBundle(m: ConnectionMeshes, open: BundleGeometry, closed: BundleGeometry | null, o: AppendOptions, p: RenderParams): { points: Vec2[]; key: Id | null }[] {
  const kTop = Math.max(open.kMax, closed?.kMax ?? -Infinity);
  if (Math.min(1, (p.widthBasePx * p.factor ** kTop * o.pxPerUnit) / p.widthMinPx) < p.ribbonCullAlpha) return [];
  const mode = MODE[o.fade], foldK = Number.isFinite(o.foldK) ? o.foldK : 0;
  const lines: { points: Vec2[]; key: Id | null }[] = [];
  const r = m.ribbons, g = m.glyphs;

  const ribbon = (P: Vec2[], Q: Vec2[], scales: number[], dists: number[]) => {
    const nP = normals(P), nQ = normals(Q);
    const base = r.side.length;
    for (let i = 0; i < P.length; i++) {
      for (const side of [1, -1]) {
        r.position.push2(P[i].x, P[i].y);
        r.position2.push2(Q[i].x, Q[i].y);
        r.normal.push2(nP[i].x, nP[i].y);
        r.normal2.push2(nQ[i].x, nQ[i].y);
        r.scale.push1(scales[i]);
        r.side.push1(side);
        r.dist.push1(dists[i]);
        r.end0.push3(...o.end0);
        r.end1.push3(...o.end1);
        r.fold.push2(mode, foldK);
        r.conn.push1(o.conn);
      }
    }
    for (let i = 0; i < P.length - 1; i++) {
      const a = base + i * 2;
      r.index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };

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
      g.end0.push3(...o.end0);
      g.end1.push3(...o.end1);
      g.fold.push2(mode, foldK);
      g.conn.push1(o.conn);
    }
    for (const t of tris) g.index.push(base + t);
  };

  const DOT_SIDES = 12;
  const dotTris = Array.from({ length: DOT_SIDES }, (_, i) => [0, 1 + i, 1 + ((i + 1) % DOT_SIDES)]).flat();
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
  const arrowTris = [0, 1, 2, 0, 2, 3];
  const inset = (offs: Vec2[]): Vec2[] => {
    const c = { x: offs.reduce((s, q) => s + q.x, 0) / offs.length, y: offs.reduce((s, q) => s + q.y, 0) / offs.length };
    return offs.map((q) => ({ x: c.x + (q.x - c.x) * p.hollowInset, y: c.y + (q.y - c.y) * p.hollowInset }));
  };
  const nodePoint = (b: Branch) => (b.nodeEnd === 'p0' ? b.p0 : b.p3);

  if (open.trunk) {
    const t2 = closed?.trunk ?? open.trunk, s = p.factor ** open.kMax;
    ribbon([open.trunk[0], open.trunk[1]], [t2[0], t2[1]], [s, s], [-1, -1]);
    lines.push({ points: [open.trunk[0], open.trunk[1]], key: null });
  }
  open.branches.forEach((a, i) => {
    const b = closed?.branches[i] ?? a;
    const segs = Math.max(
      bezierSegments(a.p0, a.b1, a.b2, a.p3, o.pxPerUnit, p.curveTolerancePx),
      closed ? bezierSegments(b.p0, b.b1, b.b2, b.p3, o.pxPerUnit, p.curveTolerancePx) : 0,
    );
    const P = sample(a, segs), Q = closed ? sample(b, segs) : P;
    const scales = P.map((_, j) => {
      const t = j / segs;
      return a.nodeEnd === 'p0' ? p.factor ** (a.kNode + (a.kMarker - a.kNode) * t) : p.factor ** (a.kMarker + (a.kNode - a.kMarker) * t);
    });
    let acc = 0;
    const dists = P.map((q, j) => {
      if (!a.dashed) return -1;
      if (j > 0) acc += len(sub(q, P[j - 1]));
      return acc;
    });
    ribbon(P, Q, scales, dists);
    lines.push({ points: P, key: a.key });

    // Glyph at the node end, with the local width there.
    const sNode = p.factor ** a.kNode;
    const fill = a.dashed ? 2 : 1;
    const shape = a.role === 'associate' ? dot(p.dotRadius) : arrow(a);
    const shape2 = a.role === 'associate' ? shape : arrow(b);
    const tris = a.role === 'associate' ? dotTris : arrowTris;
    glyph(nodePoint(a), nodePoint(b), shape, shape2, tris, sNode, fill);
    if (a.hollow || b.hollow) glyph(nodePoint(a), nodePoint(b), inset(shape), inset(shape2), tris, sNode, a.hollow ? 0 : 3);
    if (a.stub && a.role !== 'associate') glyph(nodePoint(a), nodePoint(b), dot(p.dotRadius), dot(p.dotRadius), dotTris, sNode, 2);
  });
  return lines;
}
