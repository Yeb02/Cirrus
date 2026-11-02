import type { RenderParams } from '../params.ts';

/**
 * The fractal grid (spec 8.6): one level per power of the factor whose on-screen spacing lies in gridSpacingPx; the
 * finest fades in over its first factor octave, so levels appear and leave smoothly.
 */
export function gridLevels(zoom: number, p: RenderParams): { spacingWorld: number; alpha: number }[] {
  const [lo, hi] = p.gridSpacingPx;
  const lf = Math.log(p.factor);
  const jLo = Math.ceil(Math.log(lo / zoom) / lf), jHi = Math.floor(Math.log(hi / zoom) / lf);
  // Parameters outside their cards (factor 1, zero spacing): no grid rather than an endless loop (C1 of the review).
  if (!Number.isFinite(jLo) || !Number.isFinite(jHi) || jHi - jLo > 64) return [];
  const out: { spacingWorld: number; alpha: number }[] = [];
  for (let j = jLo; j <= jHi; j++) {
    const spacingWorld = p.factor ** j;
    out.push({ spacingWorld, alpha: p.gridAlpha * Math.min(1, Math.log((spacingWorld * zoom) / lo) / lf) });
  }
  return out;
}
