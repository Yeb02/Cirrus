import type { Vec2 } from '@cirrus/core';
import type { RenderParams } from '../params.ts';

const STAR_PRESENCE = 0.7;

/** Deterministic PRNG (mulberry32): the same cell always gets the same star. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cellSeed(i: number, j: number, layerK: number, seed: number): number {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(layerK + 1024, 83492791) ^ Math.imul(seed, 2654435761);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** At most one star per cell of the layer's grid, placed by a hash of the cell: fixed in the plan, no storage (spec 8.6). */
export function starsInRect(rect: { x: number; y: number; w: number; h: number }, layerK: number, seed: number, p: RenderParams): Vec2[] {
  const cell = p.starCellWorld * p.factor ** layerK;
  const i0 = Math.floor(rect.x / cell), i1 = Math.floor((rect.x + rect.w) / cell);
  const j0 = Math.floor(rect.y / cell), j1 = Math.floor((rect.y + rect.h) / cell);
  const stars: Vec2[] = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const rand = mulberry32(cellSeed(i, j, layerK, seed));
      if (rand() > STAR_PRESENCE) continue;
      const s = { x: (i + rand()) * cell, y: (j + rand()) * cell };
      if (s.x >= rect.x && s.x < rect.x + rect.w && s.y >= rect.y && s.y < rect.y + rect.h) stars.push(s);
    }
  }
  return stars;
}

/** 1 in the middle of starSpacingPx, linear fades over its first and last quarter, 0 outside: no carpet, no void. */
export function starLayerAlpha(layerK: number, zoom: number, p: RenderParams): number {
  const spacing = p.starCellWorld * p.factor ** layerK * zoom;
  const [lo, hi] = p.starSpacingPx;
  if (spacing <= lo || spacing >= hi) return 0;
  const q = (hi - lo) / 4;
  if (spacing < lo + q) return (spacing - lo) / q;
  if (spacing > hi - q) return (hi - spacing) / q;
  return 1;
}

/** The layer steps visible at this zoom (at most three). */
export function starLayers(zoom: number, p: RenderParams): number[] {
  const kLo = Math.ceil(Math.log(p.starSpacingPx[0] / (p.starCellWorld * zoom)) / Math.log(p.factor));
  const ks: number[] = [];
  for (let k = kLo; k <= kLo + 2; k++) if (starLayerAlpha(k, zoom, p) > 0) ks.push(k);
  return ks;
}
