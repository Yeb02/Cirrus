import type { RenderParams } from '../scene/params';
import { mulberry32 } from '../scene/rng';
import type { Rect, Vec2 } from '../scene/types';

const STAR_PRESENCE = 0.7;

function cellSeed(i: number, j: number, layerK: number, seed: number): number {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(layerK + 1024, 83492791) ^ Math.imul(seed, 2654435761);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** At most one star per cell of the layer's grid, placed by a hash of the cell: fixed in the world, no storage. */
export function starsInRect(rect: Rect, layerK: number, seed: number, p: RenderParams): Vec2[] {
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

/** 1 in the middle of starSpacingPx, linear fades over its first and last quarter, 0 outside. */
export function starLayerAlpha(layerK: number, zoom: number, p: RenderParams): number {
  const spacing = p.starCellWorld * p.factor ** layerK * zoom;
  const [lo, hi] = p.starSpacingPx;
  if (spacing <= lo || spacing >= hi) return 0;
  const q = (hi - lo) / 4;
  if (spacing < lo + q) return (spacing - lo) / q;
  if (spacing > hi - q) return (hi - spacing) / q;
  return 1;
}
