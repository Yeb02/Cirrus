import { connect, createNode, createPlan, emptyState, moveNodes, placeNode, type Role, setLayout, type State, type Vec2 } from '@cirrus/core';
import { expect, test } from 'vitest';
import { copyClip } from '../src/clip.ts';
import { bundleFor } from '../src/frame.ts';
import { bundleGlyphCount, DOT_SIDES } from '../src/geometry/ribbon.ts';
import { isSimple, markerCores } from '../src/instances.ts';
import { layoutHandles } from '../src/layout.ts';
import { stepScale } from '../src/lod.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { created, frameAt, measure, P, run } from './helpers.ts';

// Plan 6b, D2: a knowledge connection of one member is drawn by the complex path — one arm from the node's edge to its
// marker, the marker always drawn — wherever its node has a branch.

/** A plan with node A (step 1) and its connection of one member, `role`; plan Q, where A is placed without a branch. */
function world(role: Role = 'source'): { s: State; plan: string; other: string; a: string; c: string } {
  const s = emptyState();
  const plan = created(run(s, createPlan(s, 'P', 'plan')), 'plan');
  const other = created(run(s, createPlan(s, 'Q', 'plan')), 'plan');
  const a = created(run(s, createNode(s, { plan, title: 'A', x: 100, y: 50, k: 1 })), 'node');
  run(s, placeNode(s, other, a, 0, 0, 1));
  const c = created(run(s, connect(s, { plan, members: [{ node: a, role }] })), 'connection');
  return { s, plan, other, a, c };
}
const geometry = (sc: PlanScene) => {
  const { visible } = frameAt(sc, 1, 16);
  return bundleFor(sc, visible.connections[0], P);
};
const close = (a: Vec2, b: Vec2) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };

test('une connexion d’un membre se montre là où son nœud est placé, avec un marqueur toujours dessiné', () => {
  const { s, plan, other, a } = world();
  const sc = buildScene(s, plan, measure, P);
  expect(sc.connections).toHaveLength(1);
  const { visible, inst, cam } = frameAt(sc, 1, 16);
  expect(visible.connections).toHaveLength(1);
  expect(isSimple(sc, visible.connections[0])).toBe(false);
  expect(inst.markers).toHaveLength(1);
  expect(markerCores(sc, inst, cam.zoom, P, false)).toHaveLength(1);
  expect(sc.items[sc.byId.get(a)!].badge).toBe(false);
  // Placed in Q without a branch there: not drawn, A badged (spec 11.3).
  const q = buildScene(s, other, measure, P);
  expect(q.connections).toHaveLength(0);
  expect(q.items[q.byId.get(a)!].badge).toBe(true);
});

test('son marqueur par défaut est à singleArmLength · f^k du bord du nœud, dans la direction singleArmAngle', () => {
  expect(P.singleArmLength).toBe(80);
  expect(P.singleArmAngle).toBe(-45);
  const { s, plan, a } = world();
  const sc = buildScene(s, plan, measure, P), it = sc.items[sc.byId.get(a)!];
  const g = geometry(sc);
  expect(g.trunk).toBeNull();
  expect(g.branches).toHaveLength(1);
  const b = g.branches[0], L = P.singleArmLength * P.factor ** 1, rad = (P.singleArmAngle * Math.PI) / 180;
  // The arm's node end is on the box's edge, the anchor gap beyond it.
  const gap = P.anchorGap * stepScale(1, P);
  expect(Math.max(Math.abs(b.p0.x - it.x) / (it.halfW + gap), Math.abs(b.p0.y - it.y) / (it.halfH + gap))).toBeCloseTo(1, 9);
  close(g.marker, { x: b.p0.x + L * Math.cos(rad), y: b.p0.y + L * Math.sin(rad) });
  close(b.p3, g.marker);
  // Up and to the right on the screen (the world's y goes down).
  expect(g.marker.x).toBeGreaterThan(it.x);
  expect(g.marker.y).toBeLessThan(it.y);
});

test('un marqueur épinglé est respecté ; sans épingle, il suit son nœud déplacé', () => {
  const { s, plan, a, c } = world();
  const before = geometry(buildScene(s, plan, measure, P)).marker;
  run(s, moveNodes(s, plan, [{ node: a, x: 400, y: 250 }]));
  close(geometry(buildScene(s, plan, measure, P)).marker, { x: before.x + 300, y: before.y + 200 });
  run(s, setLayout(s, plan, c, { marker: { x: 900, y: 700 }, handles: {} }));
  const sc = buildScene(s, plan, measure, P), it = sc.items[sc.byId.get(a)!], g = geometry(sc), b = g.branches[0];
  close(g.marker, { x: 900, y: 700 });
  close(b.p3, g.marker);
  // The arm leaves the box toward the marker: its node end on the line from the node's centre to the marker.
  const ux = 900 - it.x, uy = 700 - it.y, vx = b.p0.x - it.x, vy = b.p0.y - it.y;
  expect(Math.abs(ux * vy - uy * vx) / Math.hypot(ux, uy)).toBeLessThan(1e-6);
  expect(ux * vx + uy * vy).toBeGreaterThan(0);
});

test('le marqueur se touche, le bras aussi ; ses poignées : le marqueur et le bras, pas de rotation', () => {
  const { s, plan, a } = world();
  const sc = buildScene(s, plan, measure, P);
  const { visible, hits, cam } = frameAt(sc, 1, 16);
  const g = bundleFor(sc, visible.connections[0], P), b = g.branches[0];
  expect(hits.markerAt(g.marker.x, g.marker.y, cam.zoom)).toBe(0);
  const mid = { x: (b.p0.x + b.p3.x) / 2, y: (b.p0.y + b.p3.y) / 2 };
  expect(hits.hit(mid.x, mid.y, cam.zoom)).toMatchObject({ kind: 'connection', conn: 0, key: a, part: 'main' });
  const kinds = layoutHandles(g, cam.zoom, P).map((h) => h.handle.kind);
  expect(kinds.sort()).toEqual(['bezier', 'bezier', 'marker']);
});

test('le glyphe dit le rôle, au bout côté nœud : une flèche sortante, entrante, un point', () => {
  const at = (role: Role) => {
    const { s, plan } = world(role);
    return geometry(buildScene(s, plan, measure, P));
  };
  const src = at('source'), tgt = at('target'), neu = at('associate');
  // Source: the node at p0, the arrow pointing away from it (appendBundleGlyphs); target: the node at p3, pointing in.
  expect(src.branches[0]).toMatchObject({ nodeEnd: 'p0', role: 'source', stub: false });
  expect(bundleGlyphCount(src)).toBe(4);
  expect(tgt.branches[0]).toMatchObject({ nodeEnd: 'p3', role: 'target' });
  close(tgt.branches[0].p0, tgt.marker);
  close(tgt.branches[0].p3, src.branches[0].p0);
  expect(bundleGlyphCount(tgt)).toBe(4);
  expect(neu.branches[0]).toMatchObject({ role: 'associate' });
  expect(bundleGlyphCount(neu)).toBe(1 + DOT_SIDES);
  // The same default marker, whatever the role.
  close(tgt.marker, src.marker);
});

test('copier son nœud la copie', () => {
  const { s, plan, a, c } = world();
  const sc = buildScene(s, plan, measure, P);
  expect(copyClip(s, sc, [sc.byId.get(a)!], 1)!.connections).toEqual([{ id: c, nodes: [a] }]);
});
