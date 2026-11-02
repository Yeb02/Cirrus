import { expect, test } from 'vitest';
import { centroid, convexHull, offsetPolygon } from '../src/geometry/hull.ts';

test('enveloppe convexe d’un carré et de son centre : les quatre coins, sens trigonométrique', () => {
  const h = convexHull([{ x: 0, y: 0 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }]);
  expect(h).toEqual([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]);
});

test('élargir un polygone pousse chaque sommet de la distance le long de sa normale moyenne', () => {
  const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  const out = offsetPolygon(sq, 10);
  expect(out).toHaveLength(4);
  expect(out[2].x).toBeCloseTo(1 + 10 / Math.SQRT2, 9);
  expect(out[2].y).toBeCloseTo(1 + 10 / Math.SQRT2, 9);
  for (let i = 0; i < 4; i++) expect(Math.hypot(out[i].x - sq[i].x, out[i].y - sq[i].y)).toBeCloseTo(10, 9);
});

test('un ou deux points donnent un octogone', () => {
  const one = offsetPolygon([{ x: 3, y: 4 }], 10);
  expect(one).toHaveLength(8);
  for (const q of one) expect(Math.hypot(q.x - 3, q.y - 4)).toBeCloseTo(10, 4);
  const two = offsetPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5);
  expect(two).toHaveLength(8);
  expect(centroid(two).x).toBeCloseTo(5, 9);
});

test('points confondus : jamais de NaN', () => {
  const h = convexHull([{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 2 }]);
  const out = offsetPolygon(h, 4);
  for (const q of out) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
});
