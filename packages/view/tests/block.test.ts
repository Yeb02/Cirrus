import { expect, test } from 'vitest';
import { bibBlock, blockHalves } from '../src/block.ts';
import { stepScale } from '../src/lod.ts';
import { DEFAULT_PARAMS as P } from '../src/params.ts';
import { boxHalves } from '../src/scene.ts';

/** The boxes of the block at `step`: centre and half sizes, `lines` each title's lines. */
const boxes = (n: number, step: number, lines?: number[]) => bibBlock(n, step, P, lines).map((o, i) => ({ ...o, ...boxHalves(lines?.[i] ?? 1, step, P) }));
/** The smallest gap between two boxes of the block, along the axis that separates them. */
function smallestGap(b: ReturnType<typeof boxes>): number {
  let gap = Infinity;
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const gx = Math.abs(b[i].x - b[j].x) - b[i].halfW - b[j].halfW, gy = Math.abs(b[i].y - b[j].y) - b[i].halfH - b[j].halfH;
      gap = Math.min(gap, Math.max(gx, gy));
    }
  }
  return gap;
}
/** The block's bounding box. */
const extent = (b: ReturnType<typeof boxes>) => ({
  minX: Math.min(...b.map((x) => x.x - x.halfW)), maxX: Math.max(...b.map((x) => x.x + x.halfW)),
  minY: Math.min(...b.map((x) => x.y - x.halfH)), maxY: Math.max(...b.map((x) => x.y + x.halfH)),
});

test('bibBlock : une entrée, au centre', () => {
  expect(bibBlock(1, 0, P)).toEqual([{ x: 0, y: 0 }]);
  expect(bibBlock(0, 0, P)).toEqual([]);
});

test('bibBlock : 7 entrées, ceil(√7) = 3 colonnes, rangée par rangée ; les boîtes à bibBlockGapPx l’une de l’autre ; le bloc centré', () => {
  const b = boxes(7, 0, undefined);
  const s = stepScale(0, P), pitch = (P.boxWidth + P.bibBlockGapPx) * s;
  // Three columns, three rows (3, 3, 1), the last row from the left like the others.
  expect(new Set(b.map((x) => x.x.toFixed(6))).size).toBe(3);
  expect(new Set(b.map((x) => x.y.toFixed(6))).size).toBe(3);
  expect(b[1].x - b[0].x).toBeCloseTo(pitch, 9);
  expect(b[3].x).toBeCloseTo(b[0].x, 9);
  expect(b[6].x).toBeCloseTo(b[0].x, 9);
  expect(b[3].y - b[0].y).toBeCloseTo(2 * b[0].halfH + P.bibBlockGapPx * s, 9);
  expect(smallestGap(b)).toBeCloseTo(P.bibBlockGapPx * s, 9);
  const e = extent(b);
  expect(e.minX + e.maxX).toBeCloseTo(0, 9);
  expect(e.minY + e.maxY).toBeCloseTo(0, 9);
  const h7 = blockHalves(bibBlock(7, 0, P), 0, P);
  expect(h7.halfW).toBeCloseTo((e.maxX - e.minX) / 2, 9);
  expect(h7.halfH).toBeCloseTo((e.maxY - e.minY) / 2, 9);
});

test('bibBlock : 100 entrées, 10 × 10 ; une rangée a la hauteur de sa plus haute boîte ; tout grandit avec le cran', () => {
  const lines = Array.from({ length: 100 }, (_, i) => (i === 42 ? 5 : 1 + (i % 3)));
  const b = boxes(100, 0, lines);
  expect(new Set(b.map((x) => x.x.toFixed(6))).size).toBe(10);
  expect(new Set(b.map((x) => x.y.toFixed(6))).size).toBe(10);
  // Never closer than the gap, whatever the titles' lines: the row of the five-line title is as high as it.
  expect(smallestGap(b)).toBeCloseTo(P.bibBlockGapPx * stepScale(0, P), 9);
  const row4 = b.slice(40, 50), row3 = b.slice(30, 40), row5 = b.slice(50, 60);
  expect(row4[0].y - row3[0].y).toBeCloseTo(boxHalves(3, 0, P).halfH + P.bibBlockGapPx + boxHalves(5, 0, P).halfH, 9);
  expect(row5[0].y - row4[0].y).toBeCloseTo(boxHalves(5, 0, P).halfH + P.bibBlockGapPx + boxHalves(3, 0, P).halfH, 9);
  const e = extent(b);
  expect(e.minY + e.maxY).toBeCloseTo(0, 9);
  const h100 = blockHalves(bibBlock(100, 0, P, lines), 0, P, lines);
  expect(h100.halfW).toBeCloseTo((e.maxX - e.minX) / 2, 9);
  expect(h100.halfH).toBeCloseTo((e.maxY - e.minY) / 2, 9);
  // Two steps up, every distance by factor²: the boxes at the readable step of a zoom four times smaller.
  const up = bibBlock(100, 2, P, lines), base = bibBlock(100, 0, P, lines);
  for (let i = 0; i < 100; i++) {
    expect(up[i].x).toBeCloseTo(base[i].x * P.factor ** 2, 6);
    expect(up[i].y).toBeCloseTo(base[i].y * P.factor ** 2, 6);
  }
  // The gap is a setting.
  const wide = bibBlock(100, 0, { ...P, bibBlockGapPx: 100 }, lines);
  expect(wide[1].x - wide[0].x).toBeCloseTo((P.boxWidth + 100) * stepScale(0, P), 9);
});

test('bibBlock : 2 000 entrées, 45 colonnes, vite', () => {
  const t0 = performance.now();
  const b = bibBlock(2000, 0, P, Array.from({ length: 2000 }, (_, i) => 1 + (i % 4)));
  expect(performance.now() - t0).toBeLessThan(50);
  expect(new Set(b.map((x) => x.x.toFixed(6))).size).toBe(45);
  expect(new Set(b.map((x) => x.y.toFixed(6))).size).toBe(45);
});
