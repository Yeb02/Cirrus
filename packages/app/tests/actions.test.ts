import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOp, groupOf, placementKey, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { buildScene, DEFAULT_PARAMS as P, offsetPolygon, type PlanScene } from '@cirrus/view';
import { beforeEach, expect, test } from 'vitest';
import { createBuild, hideBuild, renameBuild, scaleBuild } from '../src/renderer/actions.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-actions-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  s = store.state;
  sc = buildScene(s, ids.plans.lobby, measure, P);
});
const run = (build: ((st: State) => import('@cirrus/core').Action) | null) => { const a = build!(s); for (const op of a.ops) applyOp(s, op); return a; };

test('créer un nœud dans l’enveloppe d’un groupe : il y entre, au cran lisible à ce zoom', () => {
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!];
  const poly = offsetPolygon(g.hull!, g.pad! * 0.4);
  const at = poly.reduce((b, q) => (q.y > b.y ? q : b), poly[0]);
  const a = run(createBuild(sc, '  Nouveau  ', at, 0.25, P));
  const id = (a.ops[0] as { after: { id: string; title: string } }).after.id;
  expect(s.nodes.get(id)!.title).toBe('Nouveau');
  expect(s.placements.get(placementKey(ids.plans.lobby, id))!.k).toBe(2); // 16 px text at zoom 0.25 needs f^2
  expect(groupOf(s, ids.plans.lobby, id)).toBe(ids.nodes.groupeML);
  expect(createBuild(sc, '   ', at, 1, P)).toBeNull();
});

test('cacher, renommer, échelle : une action chacun, rien quand il n’y a rien à faire', () => {
  run(hideBuild(sc, [ids.nodes.monde]));
  expect(s.placements.has(placementKey(ids.plans.lobby, ids.nodes.monde))).toBe(false);
  expect(hideBuild(sc, [ids.phantoms.node])).toBeNull();
  run(renameBuild(ids.nodes.mdl, ' MDL '));
  expect(s.nodes.get(ids.nodes.mdl)!.title).toBe('MDL');
  expect(renameBuild(ids.nodes.mdl, '')).toBeNull();
  const k0 = s.placements.get(placementKey(ids.plans.lobby, ids.nodes.occam))!.k;
  run(scaleBuild(sc, [sc.byId.get(ids.nodes.occam)!], 1, P));
  expect(s.placements.get(placementKey(ids.plans.lobby, ids.nodes.occam))!.k).toBe(k0 + 1);
  expect(scaleBuild(sc, [], 1, P)).toBeNull();
});
