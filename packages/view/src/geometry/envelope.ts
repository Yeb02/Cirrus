import type { Vec2 } from '@cirrus/core';
import type { Rgb } from '../params.ts';
import { FloatList, IndexList } from './arrays.ts';
import { centroid, offsetPolygon, vertexNormals } from './hull.ts';

/** Group envelopes (spec 8.4): an opaque fan, then a ring the shader pushes out by the feather width in pixels. */
export interface EnvelopeMeshes {
  position: FloatList;
  /** Outward unit normal on the outer ring, (0, 0) inside. */
  normal: FloatList;
  alpha: FloatList;
  open: FloatList;
  closed: FloatList;
  foldK: FloatList;
  /** The parent group's maxChildK (NO_PARENT at top level): the envelope fades as its parent folds (spec 8.4). */
  parentK: FloatList;
  index: IndexList;
}

export function newEnvelopeMeshes(): EnvelopeMeshes {
  return { position: new FloatList(), normal: new FloatList(), alpha: new FloatList(), open: new FloatList(), closed: new FloatList(), foldK: new FloatList(), parentK: new FloatList(), index: new IndexList() };
}

export function clearEnvelopeMeshes(m: EnvelopeMeshes): void {
  for (const l of Object.values(m)) l.clear();
}

/** The parentK of a top-level group: above 1e8, the shaders read it as "never folded". */
export const NO_PARENT = 1e9;

/** Appends the envelope of a hull (world, relative to the local origin) padded by `pad`. */
export function appendEnvelope(m: EnvelopeMeshes, hull: Vec2[], pad: number, colors: { open: Rgb; closed: Rgb }, maxChildK: number, parentK = NO_PARENT): void {
  const poly = offsetPolygon(hull, pad);
  const normals = vertexNormals(poly);
  const c = centroid(poly);
  const n = poly.length;
  const base = m.alpha.length;
  const vertex = (q: Vec2, nx: number, ny: number, alpha: number) => {
    m.position.push2(q.x, q.y);
    m.normal.push2(nx, ny);
    m.alpha.push1(alpha);
    m.open.push3(...colors.open);
    m.closed.push3(...colors.closed);
    m.foldK.push1(maxChildK);
    m.parentK.push1(parentK);
  };
  vertex(c, 0, 0, 1);
  for (const q of poly) vertex(q, 0, 0, 1);
  poly.forEach((q, i) => vertex(q, normals[i].x, normals[i].y, 0));
  for (let i = 0; i < n; i++) {
    const a = base + 1 + i, b = base + 1 + ((i + 1) % n);
    m.index.push(base, a, b, a, a + n, b, b, a + n, b + n);
  }
}
