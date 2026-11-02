import type { Role } from '@cirrus/core';
import { expect, test } from 'vitest';
import { type BundleEnd, bundleGeometry } from '../src/geometry/bundle.ts';
import { appendBundle, bezierSegments, newConnectionMeshes } from '../src/geometry/ribbon.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const P = DEFAULT_PARAMS;
const end = (x: number, y: number, role: Role, extra: Partial<BundleEnd> = {}): BundleEnd =>
  ({ pos: { x, y }, halfW: 105, halfH: 23, role, k: 0, hollow: false, dashed: false, key: `${x},${y}`, ...extra });
const opts = (o: Partial<Parameters<typeof appendBundle>[3]> = {}) => ({
  pxPerUnit: 2, end0: [0, 0, 100] as [number, number, number], end1: [1000, 0, 100] as [number, number, number],
  fade: 'none' as const, foldK: Number.NaN, conn: 3, ...o,
});

test('aplatissement : une droite tient en un segment, une courbe en plusieurs', () => {
  expect(bezierSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 }, 1, 0.2)).toBe(1);
  expect(bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 1, 0.2)).toBeGreaterThan(4);
  expect(bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 1e6, 0.2)).toBe(64);
});

test('ruban : deux sommets par point, côtés opposés, indices valides', () => {
  const m = newConnectionMeshes();
  const lines = appendBundle(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P), null, opts(), P);
  const n = m.ribbons.position.length / 2;
  expect(m.ribbons.side.length).toBe(n);
  const side = [...m.ribbons.side.view()];
  for (let i = 0; i < n; i += 2) expect(side[i] + side[i + 1]).toBe(0);
  expect([...m.ribbons.index.view()].every((i) => i < n)).toBe(true);
  expect([...m.ribbons.conn.view()].every((c) => c === 3)).toBe(true);
  expect(lines).toHaveLength(2);
  expect([...m.ribbons.dist.view()].every((d) => d === -1)).toBe(true); // solid
});

test('sans version repliée, position2 = position', () => {
  const m = newConnectionMeshes();
  appendBundle(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P), null, opts(), P);
  expect([...m.ribbons.position2.view()]).toEqual([...m.ribbons.position.view()]);
  expect([...m.glyphs.position2.view()]).toEqual([...m.glyphs.position.view()]);
});

test('glissement : mêmes sommets dans les deux versions, positions repliées différentes', () => {
  const open = bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P);
  const poly = [{ x: -300, y: -300 }, { x: 300, y: -300 }, { x: 300, y: 300 }, { x: -300, y: 300 }];
  const closed = bundleGeometry({ ends: [end(0, 0, 'source', { hull: { poly, centre: { x: 0, y: 0 }, pad: 44 }, hollow: true }), end(1000, 300, 'target')], stubs: [] }, P);
  const m = newConnectionMeshes();
  appendBundle(m, open, closed, opts({ fade: 'slide', foldK: 0 }), P);
  expect(m.ribbons.position2.length).toBe(m.ribbons.position.length);
  expect([...m.ribbons.position2.view()]).not.toEqual([...m.ribbons.position.view()]);
  // fold = (mode, foldK): slide = 1
  expect(m.ribbons.fold.view()[0]).toBe(1);
  expect(m.ribbons.fold.view()[1]).toBe(0);
  // The hollow inner arrow appears only once folded past halfway: fill code 3.
  expect([...m.glyphs.fill.view()]).toContain(3);
});

test('amorce : pointillés (distance cumulée croissante) et couleur des absents', () => {
  const m = newConnectionMeshes();
  appendBundle(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 0, 'target')], stubs: [{ role: 'source' }] }, P), null, opts(), P);
  const dist = [...m.ribbons.dist.view()].filter((d) => d >= 0);
  expect(dist.length).toBeGreaterThan(0);
  for (let i = 2; i < dist.length; i += 2) expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 2]);
  expect([...m.glyphs.fill.view()]).toContain(2);
});

test('flèches évidées : un intérieur couleur du ciel', () => {
  const m = newConnectionMeshes();
  appendBundle(m, bundleGeometry({ ends: [end(0, 0, 'source', { hollow: true }), end(1000, 0, 'target')], stubs: [] }, P), null, opts(), P);
  expect([...m.glyphs.fill.view()]).toContain(0);
});

test('connexion trop fine au zoom de validité : rien n’est construit', () => {
  const m = newConnectionMeshes();
  const g = bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 0, 'target')], stubs: [] }, P);
  expect(appendBundle(m, g, null, opts({ pxPerUnit: 1e-4 }), P)).toEqual([]);
  expect(m.ribbons.position.length).toBe(0);
});

test('l’échelle varie du cran du nœud à celui du marqueur', () => {
  const m = newConnectionMeshes();
  appendBundle(m, bundleGeometry({ ends: [end(0, 0, 'source', { k: -2 }), end(1000, 0, 'target', { k: 2 })], stubs: [] }, P), null, opts(), P);
  const scale = [...m.ribbons.scale.view()];
  expect(Math.min(...scale)).toBeCloseTo(0.25, 9);
  expect(Math.max(...scale)).toBeCloseTo(4, 9);
});
