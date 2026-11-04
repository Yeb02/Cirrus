import type { Role } from '@cirrus/core';
import { stepScale } from '../lod.ts';
import type { RenderParams } from '../params.ts';
import { type Branch, type BundleEnd, SIDE_TOLERANCE } from './bundle.ts';
import { add, len, mul, norm, perp, sub } from './vec.ts';

/**
 * A simple connection's curves (plan 3c task 8): two ends on boxes (no closed group), no stub, centre nor layout. It is
 * bundleGeometry with two members, step by step as the vertex shaders compute it from the two items' texels
 * (render/shaders.ts, SIMPLE): no trunk, the two branches meeting at the marker M, midway between the boxes. Hit testing
 * computes here the curves the GPU draws. Branches come as bundleGeometry gives them: sources, then targets, then
 * associates (two associates alone are a source and a target drawn with dots).
 */
export function simpleBranches(a: BundleEnd, b: BundleEnd, p: RenderParams): Branch[] {
  const pairNeu = a.role === 'associate' && b.role === 'associate';
  // Each end's class: 0 converges on the marker (a source), 1 leaves it (a target), 2 joins it from the side.
  const ca = pairNeu ? 0 : CLASS[a.role], cb = pairNeu ? 1 : CLASS[b.role];
  const of = (c: number) => (ca === c && cb === c ? [a, b] : ca === c ? [a] : cb === c ? [b] : []);
  const S = of(0), T = of(1), N = of(2);
  const centre = (es: BundleEnd[]) => (es.length === 2 ? { x: (es[0].pos.x + es[1].pos.x) / 2, y: (es[0].pos.y + es[1].pos.y) / 2 } : es[0].pos);
  const fallback = N.length > 0 ? centre(N) : centre([a, b]);
  const cs = S.length > 0 ? centre(S) : fallback, ct = T.length > 0 ? centre(T) : fallback;
  const kMax = Math.max(a.k, b.k);
  const M = mul(add(cs, ct), 0.5), u = norm(sub(ct, cs));
  const branch = (e: BundleEnd, c: number): Branch => {
    const gap = p.anchorGap * stepScale(e.k, p), d = sub(M, e.pos);
    const sx = Math.abs(d.x) > 1e-9 ? (e.halfW + gap) / Math.abs(d.x) : Infinity;
    const sy = Math.abs(d.y) > 1e-9 ? (e.halfH + gap) / Math.abs(d.y) : Infinity;
    const at = add(e.pos, mul(d, Math.min(sx, sy, 1)));
    const t = p.trunkTension * len(sub(M, at));
    const role: Role = pairNeu ? 'associate' : e.role;
    const extra = { role, kNode: e.k, kMarker: kMax, hollow: e.hollow, dashed: e.dashed, stub: false, key: e.key };
    if (c === 0) return { p0: at, b1: add(at, mul(norm(sub(M, at), u), t * 0.6)), b2: sub(M, mul(u, t)), p3: M, nodeEnd: 'p0', ...extra };
    if (c === 1) return { p0: M, b1: add(M, mul(u, t)), b2: add(at, mul(norm(sub(M, at), mul(u, -1)), t * 0.6)), p3: at, nodeEnd: 'p3', ...extra };
    let n = perp(u);
    const v = sub(e.pos, M);
    // On the axis (always, with two members): from +n, as bundleGeometry decides it.
    if (n.x * v.x + n.y * v.y < -SIDE_TOLERANCE * len(v)) n = mul(n, -1);
    return { p0: at, b1: add(at, mul(norm(sub(M, at), mul(n, -1)), t * 0.6)), b2: add(M, mul(n, t)), p3: M, nodeEnd: 'p0', ...extra };
  };
  return [...S.map((e) => branch(e, 0)), ...T.map((e) => branch(e, 1)), ...N.map((e) => branch(e, 2))];
}

const CLASS: Record<Role, number> = { source: 0, target: 1, associate: 2 };

/** The marker of a simple connection: midway between its two boxes (bundleGeometry's M for two members, whatever their roles). */
export function simpleMarker(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}
