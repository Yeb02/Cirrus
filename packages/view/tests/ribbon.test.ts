import type { Role } from '@cirrus/core';
import { expect, test } from 'vitest';
import { type BundleEnd, bundleGeometry } from '../src/geometry/bundle.ts';
import { appendBundleGlyphs, bezierSegments, newGlyphMeshes, ribbonAlpha, sampleBranch } from '../src/geometry/ribbon.ts';
import { visibleFrom } from '../src/instances.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const P = DEFAULT_PARAMS;
const end = (x: number, y: number, role: Role, extra: Partial<BundleEnd> = {}): BundleEnd =>
  ({ pos: { x, y }, halfW: 105, halfH: 23, role, k: 0, hollow: false, dashed: false, key: `${x},${y}`, ...extra });
const opts = (o: Partial<Parameters<typeof appendBundleGlyphs>[3]> = {}) => ({
  end0: [0, 0, 100] as [number, number, number], end1: [1000, 0, 100] as [number, number, number], fade: 'none' as const, foldK: Number.NaN, conn: 3, ...o,
});

test('aplatissement : une droite tient en un segment, une courbe en plusieurs', () => {
  expect(bezierSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 }, 1, 0.2)).toBe(1);
  expect(bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 1, 0.2)).toBeGreaterThan(4);
  expect(bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 1e6, 0.2)).toBe(64);
});

test('échantillons d’une cubique : ses deux bouts, segments + 1 points', () => {
  const b = { p0: { x: 0, y: 0 }, b1: { x: 0, y: 100 }, b2: { x: 100, y: 100 }, p3: { x: 100, y: 0 } };
  const pts = sampleBranch(b, 32);
  expect(pts).toHaveLength(33);
  expect(pts[0]).toEqual(b.p0);
  expect(pts[32]).toEqual(b.p3);
  expect(pts[16]).toEqual({ x: 50, y: 75 });
});

test('pointes : une flèche par bout de branche, à la couleur des connexions, numéro de la connexion', () => {
  const m = newGlyphMeshes();
  appendBundleGlyphs(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P), null, opts(), P);
  expect(m.scale.length).toBe(8);
  expect(m.index.length).toBe(12);
  expect([...m.index.view()].every((i) => i < 8)).toBe(true);
  expect([...m.fill.view()].every((f) => f === 1)).toBe(true);
  expect([...m.conn.view()].every((c) => c === 3)).toBe(true);
  // Without a closed version, position2 = position.
  expect([...m.position2.view()]).toEqual([...m.position.view()]);
});

test('glissement : mêmes sommets dans les deux versions, positions repliées différentes, intérieur creux à mi-repli', () => {
  const open = bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P);
  const poly = [{ x: -300, y: -300 }, { x: 300, y: -300 }, { x: 300, y: 300 }, { x: -300, y: 300 }];
  const closed = bundleGeometry({ ends: [end(0, 0, 'source', { hull: { poly, centre: { x: 0, y: 0 }, pad: 44 }, hollow: true }), end(1000, 300, 'target')], stubs: [] }, P);
  const m = newGlyphMeshes();
  appendBundleGlyphs(m, open, closed, opts({ fade: 'slide', foldK: 0 }), P);
  expect(m.position2.length).toBe(m.position.length);
  expect([...m.position2.view()]).not.toEqual([...m.position.view()]);
  expect([...m.fold.view()].slice(0, 2)).toEqual([1, 0]);
  // The hollow inner arrow appears only once folded past halfway: fill code 3.
  expect([...m.fill.view()]).toContain(3);
});

test('amorce : la couleur des absents et son point ; flèche évidée : un intérieur couleur du ciel', () => {
  const m = newGlyphMeshes();
  appendBundleGlyphs(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 0, 'target')], stubs: [{ role: 'source' }] }, P), null, opts(), P);
  expect([...m.fill.view()]).toContain(2);
  const h = newGlyphMeshes();
  appendBundleGlyphs(h, bundleGeometry({ ends: [end(0, 0, 'source', { hollow: true }), end(1000, 0, 'target')], stubs: [] }, P), null, opts(), P);
  expect([...h.fill.view()]).toContain(0);
});

test('connexion trop fine : sous ribbonCullAlpha au zoom servi, visible à partir de visibleFrom', () => {
  for (const k of [-2, 0, 3]) {
    const from = visibleFrom(k, P);
    expect(ribbonAlpha(k, from * 1.001 * P.curveZoomHeadroom, P)).toBeGreaterThanOrEqual(P.ribbonCullAlpha);
    expect(ribbonAlpha(k, from * 0.999 * P.curveZoomHeadroom, P)).toBeLessThan(P.ribbonCullAlpha);
  }
});

test('la pointe prend la largeur du cran de son nœud', () => {
  const m = newGlyphMeshes();
  appendBundleGlyphs(m, bundleGeometry({ ends: [end(0, 0, 'source', { k: -2 }), end(1000, 0, 'target', { k: 2 })], stubs: [] }, P), null, opts(), P);
  const scale = [...m.scale.view()];
  expect(Math.min(...scale)).toBeCloseTo(0.25, 9);
  expect(Math.max(...scale)).toBeCloseTo(4, 9);
});
