import type { RenderParams } from './params.ts';

/** Smoothstep: 0 below a, 1 above b (the maquette's transitions). */
export function smooth(a: number, b: number, v: number): number {
  if (!(b > a)) return v >= a ? 1 : 0; // a degenerate interval is a step, never NaN
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** World size multiplier of an element at scale step k: boxes and text grow with the text scale (spec 8.1). */
export function stepScale(k: number, p: RenderParams): number {
  return p.textScale * p.factor ** k;
}

/** On-screen text size of an element at scale step k (spec 8.1): base × text scale × f^k × zoom. */
export function textPx(k: number, zoom: number, p: RenderParams): number {
  return p.baseFontPx * stepScale(k, p) * zoom;
}

/** 1 when a group is closed, 0 when open; driven by the text size of its largest member (spec 8.2). */
export function foldT(maxChildK: number, zoom: number, p: RenderParams): number {
  if (maxChildK === -Infinity) return 1;
  return 1 - smooth(p.groupFold[0], p.groupFold[1], textPx(maxChildK, zoom, p));
}
