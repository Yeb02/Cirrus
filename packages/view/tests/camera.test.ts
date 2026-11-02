import { expect, test } from 'vitest';
import { fitBounds, panBy, screenToWorld, worldToScreen, zoomAt } from '../src/camera.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const P = DEFAULT_PARAMS;

test('écran et monde sont inverses', () => {
  const c = { x: 10, y: -5, zoom: 2, widthPx: 800, heightPx: 600 };
  const w = screenToWorld(c, 123, 456);
  const s = worldToScreen(c, w.x, w.y);
  expect(s.x).toBeCloseTo(123, 9);
  expect(s.y).toBeCloseTo(456, 9);
  expect(screenToWorld(c, 400, 300)).toEqual({ x: 10, y: -5 });
});

test('zoomAt garde fixe le point sous le curseur', () => {
  const c = { x: 10, y: -5, zoom: 2, widthPx: 800, heightPx: 600 };
  const before = screenToWorld(c, 100, 50);
  const after = screenToWorld(zoomAt(c, 100, 50, 3.7, P), 100, 50);
  expect(after.x).toBeCloseTo(before.x, 9);
  expect(after.y).toBeCloseTo(before.y, 9);
});

test('zoom borné et cadrage d’un plan vide', () => {
  const c = { x: 0, y: 0, zoom: 900, widthPx: 800, heightPx: 600 };
  expect(zoomAt(c, 0, 0, 10, P).zoom).toBe(P.zoomMax);
  expect(zoomAt({ ...c, zoom: 0.002 }, 0, 0, 0.1, P).zoom).toBe(P.zoomMin);
  expect(fitBounds(null, 800, 600, P)).toMatchObject({ x: 0, y: 0, zoom: 1, widthPx: 800, heightPx: 600 });
  const f = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, 800, 600, P);
  expect(f.x).toBe(500);
  expect(f.y).toBe(50);
  expect(f.zoom).toBeCloseTo((800 - 2 * P.fitMarginPx) / 1000, 9);
});

test('un plan d’un seul point se cadre au zoom 1 sur ce point', () => {
  expect(fitBounds({ minX: 5, minY: 7, maxX: 5, maxY: 7 }, 800, 600, P)).toMatchObject({ x: 5, y: 7, zoom: 1 });
});

test('déplacer la vue suit la souris', () => {
  const c = { x: 0, y: 0, zoom: 4, widthPx: 800, heightPx: 600 };
  expect(panBy(c, 40, -20)).toMatchObject({ x: -10, y: 5 });
});
