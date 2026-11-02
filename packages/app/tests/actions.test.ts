import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOp, branchKey, groupOf, layoutKey, placementKey, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { buildScene, copyClip, DEFAULT_PARAMS as P, offsetPolygon, type PlanScene } from '@cirrus/view';
import { beforeEach, expect, test } from 'vitest';
import {
  absentBuild, addMemberBuild, connectBuild, createBuild, deleteBuild, deleteConnectionBuild, hideBuild, importBuild, joinBuild, lobbyConnectionBuild,
  dropBuild, dropMemberships, layoutBuild, pasteBuild, placeInPlanBuild, removeMemberBuild, renameBuild, roleBuild, scaleBuild, splitBuild,
  withRepercussion,
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

test('cacher un groupe avec son contenu, ou seul : ses membres restent alors, dans l’ancêtre présent (spec 7)', () => {
  const { nodes, plans } = ids;
  run(hideBuild(sc, [nodes.groupeInduction], false));
  expect(s.placements.has(placementKey(plans.lobby, nodes.groupeInduction))).toBe(false);
  expect(s.placements.has(placementKey(plans.lobby, nodes.solomonoff))).toBe(true);
  const sc2 = buildScene(s, plans.lobby, measure, P);
  expect(sc2.items[sc2.items[sc2.byId.get(nodes.solomonoff)!].parent].id).toBe(nodes.groupeComplexite);
  run(hideBuild(sc2, [nodes.groupeML], true));
  for (const n of [nodes.groupeML, nodes.biais, nodes.generalisation]) expect(s.placements.has(placementKey(plans.lobby, n))).toBe(false);
});

test('supprimer : ici seulement retire du plan, partout met à la corbeille ; une connexion de même', () => {
  const { nodes, plans, connections } = ids;
  run(deleteBuild(sc, [nodes.mdl], false));
  expect(s.placements.has(placementKey(plans.lobby, nodes.mdl))).toBe(false);
  expect(s.placements.has(placementKey(plans.these, nodes.mdl))).toBe(true);
  run(deleteBuild(sc, [nodes.monde, nodes.occam], true));
  expect(s.nodes.get(nodes.occam)!.trashedAt).toBeDefined();
  run(deleteConnectionBuild(plans.lobby, connections.twoToTwo, false));
  expect(shown(plans.lobby, connections.twoToTwo, nodes.biais)).toBe(false);
  expect(s.connections.get(connections.twoToTwo)!.trashedAt).toBeUndefined();
  run(deleteConnectionBuild(plans.these, connections.twoToOne, true));
  expect(s.connections.get(connections.twoToOne)!.trashedAt).toBeDefined();
});

test('une connexion ajoutée au lobby y montre tous ses membres, en amorces s’ils n’y sont pas (spec 7)', () => {
  const { nodes, plans, connections } = ids;
  run(lobbyConnectionBuild(plans.lobby, connections.twoToOne));
  for (const n of [nodes.kolmogorov, nodes.entropie, nodes.compression]) expect(shown(plans.lobby, connections.twoToOne, n)).toBe(true);
});

test('coller : une seule action, qui dit les nœuds déjà présents', () => {
  const { nodes, plans } = ids;
  const clip = copyClip(s, sc, [sc.byId.get(nodes.mdl)!, sc.byId.get(nodes.monde)!], 1)!;
  const these = buildScene(s, plans.these, measure, P);
  const r = pasteBuild(s, clip, these, { x: 0, y: 900 }, 1, P);
  expect(r.present).toEqual([nodes.mdl]);
  const a = run(r.build);
  expect(a.label).toBe('Coller 2 nœuds');
  expect(s.placements.has(placementKey(plans.these, nodes.monde))).toBe(true);
});

test('disposer une connexion à la main, puis rétablir la disposition automatique (spec 8.5)', () => {
  const { plans, connections } = ids;
  run(layoutBuild(plans.lobby, connections.twoToTwo, { marker: { x: 1, y: 2 }, handles: {} }));
  expect(s.connLayouts.get(layoutKey(plans.lobby, connections.twoToTwo))).toMatchObject({ marker: { x: 1, y: 2 } });
  run(layoutBuild(plans.lobby, connections.twoToTwo, null));
  expect(s.connLayouts.has(layoutKey(plans.lobby, connections.twoToTwo))).toBe(false);
});

test('un dépôt dit quels nœuds changent de groupe, d’où et vers où ; les fantômes n’en sont pas (spec 10)', () => {
  const { nodes } = ids;
  const g = sc.items[sc.byId.get(nodes.groupeML)!];
  const poly = offsetPolygon(g.hull!, g.pad! * 0.4);
  const at = poly.reduce((b, q) => (q.y > b.y ? q : b), poly[0]);
  const monde = sc.byId.get(nodes.monde)!;
  expect(dropMemberships(s, sc, [monde], at, false, 1, P)).toEqual([{ node: nodes.monde, from: null, to: nodes.groupeML }]);
  const mdl = sc.byId.get(nodes.mdl)!;
  expect(dropMemberships(s, sc, [mdl], { x: 5000, y: 5000 }, true, 1, P)).toEqual([{ node: nodes.mdl, from: nodes.groupeComplexite, to: null }]);
  expect(dropMemberships(s, sc, [sc.byId.get(ids.phantoms.node)!], { x: 5000, y: 5000 }, true, 1, P)).toEqual([]);
});

test('répercussion : le dépôt et les plans automatiques en une action ; un plan à corriger se pose d’un bloc avec son appartenance', () => {
  const { nodes, plans } = ids;
  const mdl = sc.byId.get(nodes.mdl)!;
  const drop = dropBuild(sc, [mdl], 4000, 0, { x: 4175, y: 140 }, true, 1, P);
  const a = run(withRepercussion(drop, [{ plan: plans.these, node: nodes.mdl, to: null }]));
  expect(groupOf(s, plans.lobby, nodes.mdl)).toBeUndefined();
  expect(groupOf(s, plans.these, nodes.mdl)).toBeUndefined();
  expect(a.label).toBe('Sortir du groupe'); // one action, named after the drop
  const these = buildScene(s, plans.these, measure, P);
  run(placeInPlanBuild(these, nodes.compression, { x: 900, y: 900 }, null));
  expect(s.placements.get(placementKey(plans.these, nodes.compression))).toMatchObject({ x: 900, y: 900 });
  expect(groupOf(s, plans.these, nodes.compression)).toBeUndefined();
  // A group moves as a block: its members follow.
  const lobby = buildScene(s, plans.lobby, measure, P);
  const before = s.placements.get(placementKey(plans.lobby, nodes.solomonoff))!;
  const gi = lobby.items[lobby.byId.get(nodes.groupeInduction)!];
  run(placeInPlanBuild(lobby, nodes.groupeInduction, { x: gi.x + 100, y: gi.y }, nodes.groupeTheorie));
  expect(s.placements.get(placementKey(plans.lobby, nodes.solomonoff))!.x).toBeCloseTo(before.x + 100, 9);
  expect(groupOf(s, plans.lobby, nodes.groupeInduction)).toBe(nodes.groupeTheorie);
});
