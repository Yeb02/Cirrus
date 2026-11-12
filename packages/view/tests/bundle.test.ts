import type { Role } from '@cirrus/core';
import { expect, test } from 'vitest';
import { type BundleEnd, type BundleInput, bundleGeometry } from '../src/geometry/bundle.ts';
import { appendBundleGlyphs, newGlyphMeshes, sampleBranch } from '../src/geometry/ribbon.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const P = DEFAULT_PARAMS;
let key = 0;
const end = (x: number, y: number, role: Role, k = 0, extra: Partial<BundleEnd> = {}): BundleEnd =>
  ({ pos: { x, y }, halfW: 105, halfH: 23, role, k, dashed: false, key: `n${key++}`, ...extra });
const src = (x: number, y: number, k = 0) => end(x, y, 'source', k);
const tgt = (x: number, y: number, k = 0) => end(x, y, 'target', k);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const opts = { end0: [0, 0, 100] as [number, number, number], end1: [1000, 0, 100] as [number, number, number], fade: 0, foldK: Number.NaN, conn: 0 };

test('1 vers 1 : pas de tronc, les deux branches se rejoignent en M, tangentes à u', () => {
  const g = bundleGeometry({ ends: [src(0, 0), tgt(1000, 0)], stubs: [] }, P);
  expect(g.trunk).toBeNull();
  expect(g.multi).toBe(false);
  expect(g.marker).toEqual({ x: 500, y: 0 });
  expect(g.branches[0].p3).toEqual(g.branches[1].p0);
  expect(g.branches[0].b2.y).toBeCloseTo(0, 9);
  expect(g.branches[1].b1.y).toBeCloseTo(0, 9);
});

test('faisceau 3 → 1 : tronc de trunkLength à l’échelle du plus grand cran', () => {
  const g = bundleGeometry({ ends: [src(0, 0, 0), src(0, 200, 1), src(0, 400, 0), tgt(1000, 200, 0)], stubs: [] }, P);
  expect(g.multi).toBe(true);
  expect(g.kMax).toBe(1);
  expect(dist(g.trunk![0], g.trunk![1])).toBeCloseTo(P.trunkLength * 2, 9);
  // Sources reach the trunk's start, the target leaves from its end.
  expect(g.branches.filter((b) => b.nodeEnd === 'p0').every((b) => dist(b.p3, g.trunk![0]) < 1e-9)).toBe(true);
  expect(dist(g.branches.find((b) => b.role === 'target')!.p0, g.trunk![1])).toBeLessThan(1e-9);
});

test('les ancrages sont sur le bord des boîtes, écart compris', () => {
  const g = bundleGeometry({ ends: [src(0, 0), tgt(1000, 0)], stubs: [] }, P);
  expect(g.branches[0].p0.x).toBeCloseTo(105 + P.anchorGap, 9);
  expect(g.branches[1].p3.x).toBeCloseTo(1000 - 105 - P.anchorGap, 9);
});

test('un groupe replié s’ancre sur son enveloppe élargie', () => {
  const poly = [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }];
  const g = bundleGeometry({ ends: [end(0, 0, 'source', 0, { hull: { poly, centre: { x: 0, y: 0 }, pad: 44 } }), tgt(1000, 0)], stubs: [] }, P);
  expect(g.branches[0].p0.x).toBeCloseTo(144, 9);
});

test('associés seuls : traités comme une paire, un point à chaque bout', () => {
  const g = bundleGeometry({ ends: [end(0, 0, 'associate'), end(0, 600, 'associate')], stubs: [] }, P);
  expect(g.branches.map((b) => b.role)).toEqual(['associate', 'associate']);
  expect(g.marker).toEqual({ x: 0, y: 300 });
});

test('associé dans un faisceau : rejoint le marqueur par le côté', () => {
  const g = bundleGeometry({ ends: [src(0, 0), tgt(1000, 0), end(500, 400, 'associate')], stubs: [] }, P);
  const a = g.branches.find((b) => b.role === 'associate')!;
  expect(a.p3).toEqual(g.marker);
  expect(a.b2.y).toBeGreaterThan(g.marker.y); // from the associate's side
});

test('réglages du plan : marqueur épinglé, angle imposé, poignées décalées', () => {
  const k = 'm';
  const g = bundleGeometry({
    ends: [{ ...src(0, 0), key: k }, tgt(1000, 0)], stubs: [],
    layout: { marker: { x: 300, y: 50 }, angle: Math.PI / 2, handles: { [k]: { b1: { x: 7, y: 0 }, b2: { x: 0, y: 0 } } } },
  }, P);
  expect(g.marker).toEqual({ x: 300, y: 50 });
  expect(g.u.x).toBeCloseTo(0, 9);
  expect(g.u.y).toBeCloseTo(1, 9);
  const free = bundleGeometry({ ends: [{ ...src(0, 0), key: k }, tgt(1000, 0)], stubs: [], layout: { marker: { x: 300, y: 50 }, angle: Math.PI / 2, handles: {} } }, P);
  expect(g.branches[0].b1.x - free.branches[0].b1.x).toBeCloseTo(7, 9);
});

test('partie lointaine : une branche du nœud au centre fixe', () => {
  const g = bundleGeometry({ ends: [tgt(1000, 0)], stubs: [], centre: { x: 600, y: 0 } }, P);
  expect(g.marker).toEqual({ x: 600, y: 0 });
  expect(g.branches).toHaveLength(1);
  expect(g.branches[0].p0).toEqual({ x: 600, y: 0 });
  expect(g.branches[0].p3.x).toBeCloseTo(1000 - 105 - P.anchorGap, 9);
});

test('amorce en pointillés depuis le début du tronc', () => {
  const g = bundleGeometry({ ends: [src(0, 0), tgt(1000, 0)], stubs: [{ role: 'source' }] }, P);
  const stub = g.branches.find((b) => b.stub)!;
  expect(stub.dashed).toBe(true);
  expect(g.multi).toBe(true);
  expect(dist(stub.p0, stub.p3)).toBeCloseTo(P.stubLength, 6);
});

const degenerate: [string, BundleInput][] = [
  ['même point', { ends: [src(5, 5), tgt(5, 5)], stubs: [] }],
  ['mêmes centres', { ends: [src(0, 0), src(100, 0), tgt(50, 0), tgt(50, 0)], stubs: [] }],
  ['crans très éloignés', { ends: [src(0, 0, -3), tgt(1e5, 3e4, 5)], stubs: [] }],
  ['un membre et une amorce', { ends: [src(0, 0)], stubs: [{ role: 'target' }] }],
  ['associés seuls au même point', { ends: [end(1, 1, 'associate'), end(1, 1, 'associate')], stubs: [] }],
  ['deux sources sans cible', { ends: [src(0, 0), src(0, 0)], stubs: [{ role: 'associate' }] }],
];

test.each(degenerate)('géométrie dégénérée sans NaN : %s (Review Focus 4)', (_name, input) => {
  const m = newGlyphMeshes(), g = bundleGeometry(input, P);
  appendBundleGlyphs(m, g, opts, P);
  for (const list of Object.values(m)) expect([...list.view()].every(Number.isFinite)).toBe(true);
  // The curves the GPU evaluates from the same control points.
  for (const b of g.branches) for (const q of sampleBranch(b, P.curveSegments)) expect([q.x, q.y].every(Number.isFinite)).toBe(true);
});
