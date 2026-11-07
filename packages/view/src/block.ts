import type { Vec2 } from '@cirrus/core';
import { stepScale } from './lod.ts';
import type { RenderParams } from './params.ts';
import { boxHalves } from './scene.ts';

/**
 * The compact block a .bib's publications are put down in (plan 4c, D9, task 6): `n` places row by row, ceil(√n)
 * columns, as offsets from the block's centre (it lands under the cursor, as a paste's barycentre does). Its boxes, at
 * step `step` — the readable one at the zoom of the click —, stand bibBlockGapPx apart at that step's scale: a column is
 * a box wide plus the gap; a row as high as its tallest box plus the gap, `lines` being each title's lines (one when not
 * given), so that no title overlaps the next row's. The last row starts on the left, as the others. The pitch is no
 * constant of its own: the boxes' size at that step, plus the gap.
 */
export function bibBlock(n: number, step: number, p: RenderParams, lines?: ArrayLike<number>): Vec2[] {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const s = stepScale(step, p), boxW = p.boxWidth * s, gap = p.bibBlockGapPx * s;
  const width = cols * boxW + (cols - 1) * gap;
  // Each row's height, its tallest box's, then their centres from the top.
  const heights = new Float64Array(rows);
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), h = 2 * boxHalves(lines?.[i] ?? 1, step, p).halfH;
    if (h > heights[r]) heights[r] = h;
  }
  const centres = new Float64Array(rows);
  let y = 0;
  for (let r = 0; r < rows; r++) {
    centres[r] = y + heights[r] / 2;
    y += heights[r] + gap;
  }
  const height = y - gap;
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    out[i] = { x: c * (boxW + gap) + boxW / 2 - width / 2, y: centres[r] - height / 2 };
  }
  return out;
}

/** The half sizes of the block whose boxes stand at `offsets` (bibBlock), at step `step`: what the ghost of the block outlines. */
export function blockHalves(offsets: readonly Vec2[], step: number, p: RenderParams, lines?: ArrayLike<number>): { halfW: number; halfH: number } {
  let halfW = 0, halfH = 0;
  for (let i = 0; i < offsets.length; i++) {
    const b = boxHalves(lines?.[i] ?? 1, step, p);
    halfW = Math.max(halfW, Math.abs(offsets[i].x) + b.halfW);
    halfH = Math.max(halfH, Math.abs(offsets[i].y) + b.halfH);
  }
  return { halfW, halfH };
}
