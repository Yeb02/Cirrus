import type { Role } from '@cirrus/core';
import { expect, test } from 'vitest';
import { type BundleEnd, bundleGeometry } from '../src/geometry/bundle.ts';
import { appendBundleGlyphs, bezierSegments, newGlyphMeshes, ribbonAlpha, sampleBranch } from '../src/geometry/ribbon.ts';
import { visibleFrom } from '../src/instances.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const P = DEFAULT_PARAMS;
const end = (x: number, y: number, role: Role, extra: Partial<BundleEnd> = {}): BundleEnd =>
  ({ pos: { x, y }, halfW: 105, halfH: 23, role, k: 0, dashed: false, key: `${x},${y}`, ...extra });
const opts = (o: Partial<Parameters<typeof appendBundleGlyphs>[2]> = {}) => ({
  end0: [0, 0, 100] as [number, number, number], end1: [1000, 0, 100] as [number, number, number], fade: 0, foldK: Number.NaN, conn: 3, ...o,
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
  appendBundleGlyphs(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P), opts(), P);
  expect(m.scale.length).toBe(8);
  expect(m.index.length).toBe(12);
  expect([...m.index.view()].every((i) => i < 8)).toBe(true);
  expect([...m.fill.view()].every((f) => f === 1)).toBe(true);
  expect([...m.conn.view()].every((c) => c === 3)).toBe(true);
  // No mask given: none (point 7).
  expect([...m.masks.view()].every((g) => g === -1)).toBe(true);
});

test('pointes masquées : chaque branche porte les groupes repliés de son bout ; l’effacement avec un groupe passe en mode 2', () => {
  const g = bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 300, 'target')], stubs: [] }, P);
  const m = newGlyphMeshes();
  appendBundleGlyphs(m, g, opts({ fade: 2, foldK: 1, masks: (b) => [b.nodeEnd === 'p0' ? 7 : 9, -1, -1, -1] }), P);
  const masks = [...m.masks.view()];
  expect(masks.slice(0, 4)).toEqual([7, -1, -1, -1]);
  expect(masks.slice(16, 20)).toEqual([9, -1, -1, -1]);
  expect([...m.fold.view()].slice(0, 2)).toEqual([2, 1]);
});

test('amorce : la couleur des absents et son point', () => {
  const m = newGlyphMeshes();
  appendBundleGlyphs(m, bundleGeometry({ ends: [end(0, 0, 'source'), end(1000, 0, 'target')], stubs: [{ role: 'source' }] }, P), opts(), P);
  expect([...m.fill.view()]).toContain(2);
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
  appendBundleGlyphs(m, bundleGeometry({ ends: [end(0, 0, 'source', { k: -2 }), end(1000, 0, 'target', { k: 2 })], stubs: [] }, P), opts(), P);
  const scale = [...m.scale.view()];
  expect(Math.min(...scale)).toBeCloseTo(0.25, 9);
  expect(Math.max(...scale)).toBeCloseTo(4, 9);
});
