import { createNode, createPlan, emptyState, include, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { buildScene, type PlanScene, previewBase, withMoves, withOffsets } from '../src/scene.ts';
import { created, fixture, measure, P, run } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
});
const at = (scene: PlanScene, id: string) => scene.items[scene.byId.get(id)!];

test('déplacer un membre : son groupe et ses ancêtres suivent, le reste ne bouge pas', () => {
  const sol = sc.byId.get(ids.nodes.solomonoff)!;
  const moved = withOffsets(sc, new Map([[sol, { x: 300, y: 0 }]]), P);
  expect(at(moved, ids.nodes.solomonoff).x).toBe(at(sc, ids.nodes.solomonoff).x + 300);
  const g = at(moved, ids.nodes.groupeInduction), g0 = at(sc, ids.nodes.groupeInduction);
  expect(g.x).toBeCloseTo(g0.x + 150, 9); // barycentre of two members, one moved by 300
  expect(Math.max(...g.hull!.map((q) => q.x))).toBeGreaterThan(Math.max(...g0.hull!.map((q) => q.x)));
  expect(at(moved, ids.nodes.groupeComplexite).x).not.toBe(at(sc, ids.nodes.groupeComplexite).x);
  expect(at(moved, ids.nodes.monde)).toBe(at(sc, ids.nodes.monde)); // untouched items are shared, not copied
  expect(at(sc, ids.nodes.solomonoff).x).toBe(sc.items[sol].x); // the original scene is unchanged
});

test('déplacer un groupe déplace tous ses descendants, fantômes compris', () => {
  const g = sc.byId.get(ids.nodes.groupeComplexite)!;
  const moved = withOffsets(sc, new Map([[g, { x: -50, y: 20 }]]), P);
  for (const id of [ids.nodes.mdl, ids.nodes.solomonoff, ids.phantoms.node]) {
    expect(at(moved, id).x).toBeCloseTo(at(sc, id).x - 50, 9);
    expect(at(moved, id).y).toBeCloseTo(at(sc, id).y + 20, 9);
  }
  expect(at(moved, ids.nodes.groupeComplexite).x).toBeCloseTo(at(sc, ids.nodes.groupeComplexite).x - 50, 9);
  expect(moved.bounds!.minX).toBeLessThanOrEqual(sc.bounds!.minX);
});

test('aperçu suivant : il reprend le stockage du précédent, ne réécrit que ce qui bouge, et égale un aperçu neuf ; la scène de base ne change pas', () => {
  const g = sc.byId.get(ids.nodes.groupeComplexite)!, sol = sc.byId.get(ids.nodes.solomonoff)!, base = [...sc.items];
  const first = withOffsets(sc, new Map([[g, { x: 10, y: 5 }]]), P);
  expect(previewBase(first)).toBe(sc);
  expect(first.items).not.toBe(sc.items);
  const second = withOffsets(sc, new Map([[sol, { x: -40, y: 12 }]]), P, first);
  // The same storage, set back where the first preview wrote and written where this one moves.
  expect(second.items).toBe(first.items);
  const fresh = withOffsets(sc, new Map([[sol, { x: -40, y: 12 }]]), P);
  expect(second.items).toEqual(fresh.items);
  second.items.forEach((it, i) => { if (it !== fresh.items[i]) expect(it).toEqual(fresh.items[i]); });
  expect(at(second, ids.nodes.mdl)).toBe(at(sc, ids.nodes.mdl)); // set back: shared again
  expect(sc.items).toEqual(base);
  // A spent preview, or one of another scene, is not taken again: a copy is made.
  expect(withOffsets(sc, new Map([[sol, { x: 1, y: 1 }]]), P, first).items).not.toBe(first.items);
  expect(withMoves(sc, { nodes: [{ node: ids.nodes.mdl, k: 1 }], phantoms: [] }, P, second).items).toBe(second.items);
  expect(previewBase(sc)).toBe(sc);
});

const maxX = (hull: { x: number }[]) => Math.max(...hull.map((q) => q.x));

test('Alt : un membre qui sort de son groupe ne l’emporte pas ; son groupe et ses ancêtres se dérivent sans lui', () => {
  const sol = sc.byId.get(ids.nodes.solomonoff)!;
  const moved = withOffsets(sc, new Map([[sol, { x: 3000, y: 0 }]]), P, undefined, [sol]);
  expect(at(moved, ids.nodes.solomonoff).x).toBe(at(sc, ids.nodes.solomonoff).x + 3000);
  const g = at(moved, ids.nodes.groupeInduction), priore = at(sc, at(sc, ids.nodes.groupeInduction).children.map((c) => sc.items[c].id).find((id) => id !== ids.nodes.solomonoff)!);
  // Derived from its other member alone: its centre is that member's, its hull holds nothing of the moved one.
  expect(g.x).toBeCloseTo(priore.x, 9);
  expect(maxX(g.hull!)).toBeCloseTo(priore.x + priore.halfW, 9);
  expect(maxX(at(moved, ids.nodes.groupeComplexite).hull!)).toBeLessThanOrEqual(maxX(at(sc, ids.nodes.groupeComplexite).hull!));
  // Without Alt, the same move stretches them to it.
  expect(maxX(at(withOffsets(sc, new Map([[sol, { x: 3000, y: 0 }]]), P), ids.nodes.groupeInduction).hull!)).toBeGreaterThan(at(sc, ids.nodes.solomonoff).x + 3000);
});

test('Alt : le seul membre d’un groupe le laisse tel qu’il était dessiné', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const g = created(run(st, createNode(st, { plan, title: 'B', x: 0, y: 0, k: 0 })), 'node');
  const a = created(run(st, createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 })), 'node');
  run(st, include(st, plan, a, g));
  const scene = buildScene(st, plan, measure, P), ai = scene.byId.get(a)!;
  const moved = withOffsets(scene, new Map([[ai, { x: 500, y: 200 }]]), P, undefined, [ai]);
  expect(at(moved, a).x).toBe(500);
  expect(at(moved, g)).toBe(at(scene, g));
});
