import { expect, test } from 'vitest';
import { screenToWorld } from '../src/camera.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { fitItem, navigate } from '../src/navigation.ts';
import { buildScene } from '../src/scene.ts';
import { fixture, measure, P } from './helpers.ts';

const cam = { x: 100, y: 50, zoom: 2, widthPx: 800, heightPx: 600 };

test('molette : zoom autour du curseur ; Ctrl+molette ne bouge pas la vue (réservé au cran d’échelle)', () => {
  const before = screenToWorld(cam, 200, 100);
  const c = navigate(cam, { t: 'wheel', sx: 200, sy: 100, deltaY: -120, ctrl: false }, P);
  expect(c.zoom).toBeCloseTo(2 * Math.exp(120 * P.wheelZoomSpeed), 9);
  const after = screenToWorld(c, 200, 100);
  expect(after.x).toBeCloseTo(before.x, 9);
  expect(after.y).toBeCloseTo(before.y, 9);
  expect(navigate(cam, { t: 'wheel', sx: 200, sy: 100, deltaY: -120, ctrl: true }, P)).toEqual(cam);
});

test('+ et − sont inverses, au centre de l’écran', () => {
  const plus = navigate(cam, { t: 'key', key: '+' }, P);
  expect(plus.zoom).toBeCloseTo(2 * P.keyZoomStep, 9);
  expect(plus).toMatchObject({ x: 100, y: 50 });
  expect(navigate(cam, { t: 'key', key: '=' }, P).zoom).toBeCloseTo(plus.zoom, 9);
  const back = navigate(plus, { t: 'key', key: '-' }, P);
  expect(back.zoom).toBeCloseTo(2, 9);
});

test('les flèches déplacent la vue de keyPanPx à l’écran', () => {
  expect(navigate(cam, { t: 'key', key: 'ArrowRight' }, P).x).toBeCloseTo(100 + P.keyPanPx / 2, 9);
  expect(navigate(cam, { t: 'key', key: 'ArrowUp' }, P).y).toBeCloseTo(50 - P.keyPanPx / 2, 9);
  expect(navigate(cam, { t: 'key', key: 'a' }, P)).toEqual(cam);
});

test('glisser déplace la vue avec la souris ; redimensionner garde le centre', () => {
  expect(navigate(cam, { t: 'drag', dxPx: 40, dyPx: -20 }, P)).toMatchObject({ x: 80, y: 60 });
  expect(navigate(cam, { t: 'resize', widthPx: 1000, heightPx: 300 }, P)).toEqual({ ...cam, widthPx: 1000, heightPx: 300 });
});

test('cadrer un groupe contient son enveloppe élargie', () => {
  const { s, ids } = fixture();
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const g = sc.byId.get(ids.nodes.groupeInduction)!;
  const c = fitItem(sc, g, cam, P);
  for (const q of offsetPolygon(sc.items[g].hull!, sc.items[g].pad!)) {
    const sx = (q.x - c.x) * c.zoom + c.widthPx / 2, sy = (q.y - c.y) * c.zoom + c.heightPx / 2;
    expect(sx).toBeGreaterThanOrEqual(-1e-6);
    expect(sx).toBeLessThanOrEqual(c.widthPx + 1e-6);
    expect(sy).toBeGreaterThanOrEqual(-1e-6);
    expect(sy).toBeLessThanOrEqual(c.heightPx + 1e-6);
  }
  const n = sc.byId.get(ids.nodes.monde)!;
  expect(fitItem(sc, n, cam, P)).toMatchObject({ x: sc.items[n].x, y: sc.items[n].y });
});
