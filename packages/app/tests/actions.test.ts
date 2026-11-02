import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOp, branchKey, groupOf, placementKey, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { buildScene, DEFAULT_PARAMS as P, offsetPolygon, type PlanScene } from '@cirrus/view';
import { beforeEach, expect, test } from 'vitest';
import {
  absentBuild, addMemberBuild, connectBuild, createBuild, hideBuild, importBuild, joinBuild, removeMemberBuild, renameBuild, roleBuild, scaleBuild,
  splitBuild,
} from '../src/renderer/actions.ts';

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

const shown = (plan: string, conn: string, node: string) => s.branches.has(branchKey({ plan, connection: conn, node }));
const newConnection = (a: import('@cirrus/core').Action) => (a.ops.find((o) => o.t === 'connection' && o.before === null) as { after: { id: string } }).after.id;

test('tracer vers un nœud crée la connexion, montrée « partout » où ses deux nœuds sont ; vers un cœur, le nœud s’y ajoute en source', () => {
  const { nodes, plans, connections } = ids;
  const from = sc.byId.get(nodes.mdl)!;
  const c = newConnection(run(connectBuild(sc, from, { kind: 'node', item: sc.byId.get(nodes.compression)! }, [plans.these])));
  expect(s.connections.get(c)!.members).toEqual([{ node: nodes.mdl, role: 'source' }, { node: nodes.compression, role: 'target' }]);
  for (const plan of [plans.lobby, plans.these]) for (const n of [nodes.mdl, nodes.compression]) expect(shown(plan, c, n)).toBe(true);
  const core = sc.connections.findIndex((x) => x.id === connections.twoToTwo && x.part === 'main');
  run(connectBuild(sc, from, { kind: 'connection', conn: core }, []));
  expect(s.connections.get(connections.twoToTwo)!.members).toContainEqual({ node: nodes.mdl, role: 'source' });
  expect(shown(plans.lobby, connections.twoToTwo, nodes.mdl)).toBe(true);
});

test('scinder un bras pose deux fantômes au cran du nœud lointain ; réunir les retire', () => {
  const { nodes, plans, connections } = ids;
  const before = s.phantoms.size;
  run(splitBuild(sc, connections.twoToTwo, nodes.occam, { x: 500, y: 300 }, { x: 760, y: 60 }));
  const mine = [...s.phantoms.values()].filter((ph) => ph.connection === connections.twoToTwo);
  expect(mine.map((ph) => ph.of.kind).sort()).toEqual(['center', 'node']);
  expect(mine.every((ph) => ph.k === s.placements.get(placementKey(plans.lobby, nodes.occam))!.k)).toBe(true);
  run(joinBuild(plans.lobby, connections.twoToTwo, nodes.occam));
  expect(s.phantoms.size).toBe(before);
});

test('une amorce : posée à la main elle devient un fantôme ; importée dans une enveloppe, son nœud entre dans le groupe', () => {
  const { nodes, plans, connections } = ids;
  const these = buildScene(s, plans.these, measure, P);
  run(absentBuild(these, connections.twoToOne, nodes.entropie, { x: 0, y: 500 }));
  expect([...s.phantoms.values()].some((ph) => ph.plan === plans.these && ph.of.kind === 'absent' && ph.of.node === nodes.entropie)).toBe(true);
  const g = these.items[these.byId.get(nodes.theseOnly)!];
  const poly = offsetPolygon(g.hull!, g.pad! * 0.4);
  const at = poly.reduce((b, q) => (q.y > b.y ? q : b), poly[0]);
  run(importBuild(buildScene(s, plans.these, measure, P), nodes.entropie, at, 1, P));
  expect(s.placements.get(placementKey(plans.these, nodes.entropie))).toMatchObject({ x: at.x, y: at.y, k: 0 });
  expect(groupOf(s, plans.these, nodes.entropie)).toBe(nodes.theseOnly);
  expect([...s.phantoms.values()].some((ph) => ph.plan === plans.these && ph.of.node === nodes.entropie)).toBe(false);
});

test('membres d’une connexion : ajouter partout, changer le rôle, ôter ici seulement puis partout (spec 11.2)', () => {
  const { nodes, plans } = ids;
  const c = newConnection(run(connectBuild(sc, sc.byId.get(nodes.mdl)!, { kind: 'node', item: sc.byId.get(nodes.compression)! }, [plans.these])));
  run(addMemberBuild(plans.lobby, c, nodes.kolmogorov, [plans.these]));
  expect(shown(plans.these, c, nodes.kolmogorov)).toBe(true);
  run(roleBuild(c, nodes.kolmogorov, 'associate'));
  expect(s.connections.get(c)!.members).toContainEqual({ node: nodes.kolmogorov, role: 'associate' });
  run(removeMemberBuild(plans.lobby, c, nodes.kolmogorov, false));
  expect(shown(plans.lobby, c, nodes.kolmogorov)).toBe(false);
  expect(shown(plans.these, c, nodes.kolmogorov)).toBe(true);
  run(removeMemberBuild(plans.lobby, c, nodes.kolmogorov, true));
  expect(s.connections.get(c)!.members.map((m) => m.node)).toEqual([nodes.mdl, nodes.compression]);
});
