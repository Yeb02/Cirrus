import type { Vec2 } from '@cirrus/core';
import { foldT } from '../lod.ts';
import type { RenderParams } from '../params.ts';
import type { PlanScene } from '../scene.ts';
import type { VisibleConnection } from '../visibility.ts';
import { offsetPolygon } from './hull.ts';

/**
 * The mask of a connection by the groups folding over it (spec 8.5, point 7 of 2026-11-12): the fill of a group that
 * folds or is closed is laid over the connections with an end inside it, at the opacity its fold gives — and since an
 * envelope is opaque, that is the connection's own opacity times 1 − s · coverage, s the group's strength, coverage its
 * envelope's (padded hull, then a ring of featherOpenPx to featherClosedPx). The shaders compute it per vertex
 * (render/shaders.ts, MASK); this is their TypeScript twin, for the tests and for the envelope texture's contents.
 */

/** Floats per envelope edge in the envelope texture: its outward unit normal, its offset, a zero. */
export const EDGE_FLOATS = 4;
/** Texels per row of the envelope textures: an index of one texel per item slot, a pool of one texel per edge. */
export const ENVELOPE_TEXTURE_WIDTH = 1024;

/**
 * The edges of a group's padded envelope `poly` (convex: a hull padded along its bisectors), relative to (ox, oy), as
 * (nx, ny, c, 0) each: n its outward unit normal, c = n · a for a point a of the edge, so that max(n · p − c) over the
 * edges is p's signed distance to the envelope (negative inside; outside, the distance to the farthest edge line).
 * Degenerate edges are left out. Appended to `out`; returns the count.
 */
export function envelopeEdges(poly: readonly Vec2[], ox: number, oy: number, out: number[]): number {
  const m = poly.length;
  if (m === 0) return 0;
  let cx = 0, cy = 0;
  for (const q of poly) { cx += q.x - ox; cy += q.y - oy; }
  cx /= m; cy /= m;
  let n = 0;
  for (let i = 0; i < m; i++) {
    const a = poly[i], b = poly[(i + 1) % m], ax = a.x - ox, ay = a.y - oy, ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey);
    if (l < 1e-9) continue;
    let nx = ey / l, ny = -ex / l;
    // Outward: the centre is behind the edge.
    if (nx * (cx - ax) + ny * (cy - ay) > 0) { nx = -nx; ny = -ny; }
    out.push(nx, ny, nx * ax + ny * ay, 0);
    n++;
  }
  return n;
}

/** The padded envelope of group g as edges, relative to `origin` (envelopeEdges). */
export function groupEdges(scene: PlanScene, g: number, origin: Vec2, out: number[]): number {
  const it = scene.items[g];
  return envelopeEdges(offsetPolygon(it.hull!, it.pad!), origin.x, origin.y, out);
}

/** The signed distance from (x, y) to the envelope of `count` edges from edge `from` of `edges`; +∞ without an edge. */
export function envelopeDistance(edges: ArrayLike<number>, from: number, count: number, x: number, y: number): number {
  if (count === 0) return Infinity;
  let d = -Infinity;
  for (let i = from; i < from + count; i++) {
    const o = i * EDGE_FLOATS, v = edges[o] * x + edges[o + 1] * y - edges[o + 2];
    if (v > d) d = v;
  }
  return d;
}

/** How much group g's fill covers what is under it: its fold, times its own opacity (1 − its parent's fold, spec 8.4). */
export function maskStrength(scene: PlanScene, g: number, zoom: number, p: RenderParams): number {
  const it = scene.items[g], t = foldT(it.maxChildK!, zoom, p);
  return it.parent >= 0 ? t * (1 - foldT(scene.items[it.parent].maxChildK!, zoom, p)) : t;
}

/**
 * The opacity left to a connection at world point (x, y) under the groups `masks` (slots, −1 for none): the product of
 * 1 − s · coverage, coverage 1 inside the padded envelope, falling to 0 across the feather of its fold.
 */
export function maskAlpha(scene: PlanScene, masks: ArrayLike<number>, x: number, y: number, zoom: number, p: RenderParams): number {
  let a = 1;
  for (let k = 0; k < masks.length; k++) {
    const g = masks[k];
    if (g < 0) continue;
    const edges: number[] = [], n = groupEdges(scene, g, { x: 0, y: 0 }, edges);
    const t = foldT(scene.items[g].maxChildK!, zoom, p), feather = p.featherOpenPx + (p.featherClosedPx - p.featherOpenPx) * t;
    const reach = (envelopeDistance(edges, 0, n, x, y) * zoom) / Math.max(feather, 1e-6);
    a *= 1 - maskStrength(scene, g, zoom, p) * Math.min(1, Math.max(0, 1 - reach));
  }
  return a;
}

/** The groups a curve can be masked by (spec 8.5, point 7): the size of an ivec4 in the shaders. */
export const MASKS = 4;

/** masksOf's answer: one array, filled again at each call. */
const OUT = new Int32Array(4);

/**
 * The groups whose fill is laid over a curve of `vc` (spec 8.5, point 7), MASKS at most, −1 past them: an Int32Array of
 * MASKS, the same one at each call (valid until the next; callers copy it). For the branch of end `own`: that end's two
 * (VisibleEnd.mask, mask2) first, then the other ends' highest and the centre phantom's (VisibleConnection.centerMask),
 * then their second ones; for a trunk, a stub's branch, a simple connection, a marker or a title (`own` −1): every end's
 * highest and the centre's, then their second ones. A simple connection has two ends: all of its masks fit. Past MASKS
 * (a bundle whose members sit in more than four folding groups), the ones left out are other ends': a branch crossing
 * such a group is drawn over its fill there, as a connection that only passes over it — its own end is always hidden.
 * Written into one typed array of its own (ronde 1 of the review, I1): written straight into the callers' Int32Array,
 * Float32Array and arrays, its stores went megamorphic and doubled buildInstances on a flat plan.
 */
export function masksOf(vc: VisibleConnection, own: number): Int32Array {
  const out = OUT, ends = vc.ends, ne = ends.length, centre = vc.centerMask;
  // No group over any end nor the centre (most connections): four −1.
  let any = centre >= 0;
  for (let k = 0; k < ne && !any; k++) if (ends[k].mask >= 0) any = true;
  if (!any) { out[0] = -1; out[1] = -1; out[2] = -1; out[3] = -1; return out; }
  let n = 0;
  // Candidates in order (own end's two, every end's highest and the centre's, every end's second), each written once.
  for (let pass = 0; pass < 3 && n < MASKS; pass++) {
    const count = pass === 0 ? (own >= 0 ? 2 : 0) : pass === 1 ? ne + 1 : ne;
    for (let k = 0; k < count && n < MASKS; k++) {
      const g = pass === 0 ? (k === 0 ? ends[own].mask : ends[own].mask2) : pass === 1 ? (k < ne ? ends[k].mask : centre) : ends[k].mask2;
      if (g < 0) continue;
      let seen = false;
      for (let q = 0; q < n; q++) if (out[q] === g) { seen = true; break; }
      if (!seen) out[n++] = g;
    }
  }
  for (; n < MASKS; n++) out[n] = -1;
  return out;
}
