import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { buildScene, type PlanScene, withOffsets } from '../src/scene.ts';
import { fixture, measure, P } from './helpers.ts';

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
