import type { Role } from '@cirrus/core';
import { expect, test } from 'vitest';
import { type BundleEnd, bundleGeometry } from '../src/geometry/bundle.ts';
import { simpleBranches, simpleMarker } from '../src/geometry/simple.ts';
import { P, rng } from './helpers.ts';

const ROLES: Role[] = ['source', 'target', 'associate'];

test('simpleBranches égale bundleGeometry à deux membres, à 1e-9 près, sur 1 000 paires tirées au hasard', () => {
  const r = rng(2026);
  const end = (key: string): BundleEnd => ({
    pos: { x: (r() - 0.5) * 2e5, y: (r() - 0.5) * 2e5 }, halfW: 1 + r() * 400, halfH: 1 + r() * 120, role: ROLES[Math.floor(r() * 3)],
    k: Math.floor(r() * 9) - 3, dashed: r() < 0.2, key,
  });
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  let pairs = 0;
  for (let i = 0; i < 1000; i++) {
    const a = end(`a${i}`), b = i % 10 === 0 ? { ...end(`b${i}`), pos: { ...a.pos } } : end(`b${i}`);
    // A few with the same centre, or aligned on an axis (the anchor's sx or sy infinite).
    if (i % 10 === 1) b.pos.y = a.pos.y;
    if (i % 10 === 2) b.pos.x = a.pos.x;
    const want = bundleGeometry({ ends: [a, b], stubs: [] }, P), got = simpleBranches(a, b, P);
    expect(got).toHaveLength(want.branches.length);
    got.forEach((g, j) => {
      const w = want.branches[j];
      for (const q of ['p0', 'b1', 'b2', 'p3'] as const) {
        expect(close(g[q].x, w[q].x) && close(g[q].y, w[q].y), `paire ${i}, branche ${j}, ${q}`).toBe(true);
      }
      expect({ ...g, p0: 0, b1: 0, b2: 0, p3: 0 }).toEqual({ ...w, p0: 0, b1: 0, b2: 0, p3: 0 });
    });
    const m = simpleMarker(a.pos, b.pos);
    expect(close(m.x, want.marker.x) && close(m.y, want.marker.y)).toBe(true);
    pairs++;
  }
  expect(pairs).toBe(1000);
});

test('un associé face à une source ou une cible est sur l’axe : il la rejoint du côté +n, quel que soit l’arrondi (float32 du GPU, double ici)', () => {
  const r = rng(7);
  for (let i = 0; i < 500; i++) {
    const far = 10 ** (2 + r() * 6), x = (r() - 0.5) * far, y = (r() - 0.5) * far, d = 50 + r() * 5000, ang = r() * 2 * Math.PI;
    const end = (px: number, py: number, role: Role): BundleEnd => ({ pos: { x: px, y: py }, halfW: 20, halfH: 10, role, k: 0, dashed: false, key: role });
    const other: Role = r() < 0.5 ? 'source' : 'target';
    const side = (round: (v: number) => number) => {
      const a = end(round(x), round(y), other), b = end(round(x + d * Math.cos(ang)), round(y + d * Math.sin(ang)), 'associate');
      const br = simpleBranches(a, b, P).find((q) => q.role === 'associate')!, m = simpleMarker(a.pos, b.pos);
      const ux = b.pos.x - a.pos.x, uy = b.pos.y - a.pos.y;
      // b2 = M + n·t: the side of the associate's curve, by the sign of u × (b2 − M) (+n: positive for a source, the
      // axis pointing to the associate; negative for a target, the axis pointing away from it).
      return Math.sign(ux * (br.b2.y - m.y) - uy * (br.b2.x - m.x)) * (other === 'source' ? 1 : -1);
    };
    expect(side((v) => v)).toBe(1);
    expect(side(Math.fround)).toBe(1);
  }
});
