import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { bundleFor } from '../src/frame.ts';
import { applyHandle, handleAt, layoutHandles, withLayout } from '../src/layout.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { buildIndex, computeVisible, type VisibleConnection } from '../src/visibility.ts';
import { camAtTextPx, fixture, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene, vc: VisibleConnection;
const zoom = 2;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
  const visible = computeVisible(sc, buildIndex(sc, P), camAtTextPx(sc, 0, 16), P);
  vc = visible.connections.find((c) => sc.connections[c.part].id === ids.connections.twoToTwo)!;
});

test('poignées d’une connexion sélectionnée : le marqueur, la rotation au-delà du tronc, deux poignées de Bézier par branche', () => {
  const g = bundleFor(sc, vc, P);
  const h = layoutHandles(g, zoom, P);
  expect(h.find((x) => x.handle.kind === 'marker')!.at).toEqual(g.marker);
  const rot = h.find((x) => x.handle.kind === 'rotation')!;
  const B = g.trunk![1];
  expect(rot.at.x).toBeCloseTo(B.x + (g.u.x * P.rotationHandlePx) / zoom, 9);
  const beziers = h.filter((x) => x.handle.kind === 'bezier');
  expect(beziers).toHaveLength(2 * g.branches.filter((b) => !b.stub).length);
  const b = g.branches[0];
  expect(beziers.find((x) => x.handle.kind === 'bezier' && x.handle.key === b.key && x.handle.which === 'b1')!.at).toEqual(b.b1);
  expect(beziers.find((x) => x.handle.kind === 'bezier' && x.handle.key === b.key && x.handle.which === 'b1')!.from).toEqual(b.p0);
});

test('tirer une poignée de Bézier la met sous le curseur, sans toucher aux autres', () => {
  const g = bundleFor(sc, vc, P);
  const b = g.branches[1];
  const to = { x: b.b2.x + 40, y: b.b2.y - 25 };
  const layout = applyHandle(undefined, g, { kind: 'bezier', key: b.key!, which: 'b2' }, to);
  const g2 = bundleFor(sc, vc, P, { x: 0, y: 0 }, layout);
  const b2 = g2.branches.find((x) => x.key === b.key)!;
  expect(b2.b2.x).toBeCloseTo(to.x, 9);
  expect(b2.b2.y).toBeCloseTo(to.y, 9);
  expect(b2.b1).toEqual(b.b1);
  expect(g2.branches[0]).toEqual(g.branches[0]);
  // A second drag of the same handle starts from the adjusted one.
  const again = applyHandle(layout, g2, { kind: 'bezier', key: b.key!, which: 'b2' }, b.b2);
  expect(bundleFor(sc, vc, P, { x: 0, y: 0 }, again).branches.find((x) => x.key === b.key)!.b2.x).toBeCloseTo(b.b2.x, 9);
});

test('le marqueur suit le curseur ; la poignée de rotation oriente le tronc', () => {
  const g = bundleFor(sc, vc, P);
  const at = { x: g.marker.x + 100, y: g.marker.y + 50 };
  const moved = applyHandle(undefined, g, { kind: 'marker' }, at);
  expect(moved.marker).toEqual(at);
  expect(bundleFor(sc, vc, P, { x: 0, y: 0 }, moved).marker).toEqual(at);
  const turned = applyHandle(moved, g, { kind: 'rotation' }, { x: g.marker.x, y: g.marker.y + 10 });
  expect(turned.angle).toBeCloseTo(Math.PI / 2, 9);
  expect(turned.marker).toEqual(at); // what was set stays
});

test('une poignée se touche à sa taille à l’écran', () => {
  const g = bundleFor(sc, vc, P);
  const h = layoutHandles(g, zoom, P);
  const m = h.find((x) => x.handle.kind === 'marker')!;
  expect(handleAt(h, m.at.x + 2 / zoom, m.at.y, zoom, P)).toEqual({ kind: 'marker' });
  expect(handleAt(h, m.at.x + 1e5, m.at.y, zoom, P)).toBeNull();
});

test('aperçu : la scène avec la disposition d’une connexion remplacée, le reste partagé', () => {
  const i = vc.part;
  const next = withLayout(sc, i, { angle: 0.5, handles: {} });
  expect(next.connections[i].layout).toEqual({ plan: ids.plans.lobby, connection: ids.connections.twoToTwo, angle: 0.5, handles: {} });
  expect(next.items).toBe(sc.items);
  expect(sc.connections[i].layout).toBeUndefined();
});
