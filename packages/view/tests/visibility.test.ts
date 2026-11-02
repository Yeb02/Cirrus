import { connect, createNode, createPlan, emptyState, type Id, include, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { buildIndex, computeVisible, foldSignature, type SceneIndex, type VisibleConnection } from '../src/visibility.ts';
import { camAtTextPx, created, fixture, measure, P, run } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene, idx: SceneIndex;
const at = (id: Id) => sc.byId.get(id)!;
const conn = (vs: VisibleConnection[], from: Id, to: Id) =>
  vs.find((c) => c.conns.some((i) => {
    const members = s.connections.get(sc.connections[i].id)!.members.map((m) => m.node);
    return members.includes(from) && members.includes(to) && members.length === 2;
  }));

beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
  idx = buildIndex(sc, P);
});

test('zoom lisible : tout est ouvert, chaque connexion est statique', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 16), P);
  expect(v.items).toContain(at(ids.nodes.solomonoff));
  expect(v.groups).toContain(at(ids.nodes.groupeInduction));
  expect(v.connections.every((c) => c.fade === 'none')).toBe(true);
  expect(v.connections.length).toBeGreaterThan(10);
  // Parents before children.
  expect(v.groups.indexOf(at(ids.nodes.groupeTheorie))).toBeLessThan(v.groups.indexOf(at(ids.nodes.groupeInduction)));
});

test('dézoom : le groupe Induction se replie et ses connexions sortantes partent de son bord (évidées)', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 4), P);
  expect(v.items).not.toContain(at(ids.nodes.solomonoff));
  expect(v.groups).toContain(at(ids.nodes.groupeInduction));
  const c = conn(v.connections, ids.nodes.solomonoff, ids.nodes.universalite)!;
  expect(c.fade).toBe('none');
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: at(ids.nodes.groupeInduction), hollow: true });
  expect(c.ends.find((e) => e.role === 'target')).toMatchObject({ item: at(ids.nodes.universalite), hollow: false });
});

test('en transition, les bouts glissent vers le bord, et un seul cran est en transition', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 5.5), P);
  const c = conn(v.connections, ids.nodes.solomonoff, ids.nodes.universalite)!;
  expect(c.fade).toBe('slide');
  expect(c.foldK).toBe(0);
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: at(ids.nodes.solomonoff), item2: at(ids.nodes.groupeInduction), hollow: false, hollow2: true });
  expect(new Set(v.connections.filter((x) => x.fade !== 'none').map((x) => x.foldK)).size).toBe(1);
  expect(v.items).toContain(at(ids.nodes.solomonoff)); // members still drawn while they fade
});

test('connexion interne à un groupe qui se replie : en place, puis effacée', () => {
  const priore = sc.items.find((i) => i.title === 'Priore universelle')!.id;
  const fading = conn(computeVisible(sc, idx, camAtTextPx(sc, 0, 5.5), P).connections, priore, ids.nodes.solomonoff)!;
  expect(fading.fade).toBe('out');
  expect(fading.ends.map((e) => e.item).sort()).toEqual([at(priore), at(ids.nodes.solomonoff)].sort());
  expect(new Set(fading.ends.map((e) => e.item2))).toEqual(new Set([at(ids.nodes.groupeInduction)]));
  const closed = computeVisible(sc, idx, camAtTextPx(sc, 0, 4), P);
  expect(conn(closed.connections, priore, ids.nodes.solomonoff)).toBeUndefined();
});

test('plusieurs membres d’une même connexion fusionnent en une branche une fois repliés', () => {
  // « Déduction jointe » : Kolmogorov, Solomonoff, MDL → Occam. With Complexité et induction closed, the three sources
  // become one hollow branch from the group.
  const v = computeVisible(sc, idx, camAtTextPx(sc, 1, 4), P);
  const c = v.connections.find((x) => x.conns.some((i) => sc.connections[i].title === 'Déduction jointe'))!;
  expect(c.fade).toBe('none');
  expect(c.ends).toHaveLength(2);
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: at(ids.nodes.groupeTheorie), hollow: true });
});

test('deux connexions entre les mêmes extrémités repliées fusionnent en « 2 connexions »', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), a = node('A', 0, 0), b = node('B', 0, 200), c = node('C', 2000, 100);
  run(st, include(st, plan, a, g));
  run(st, include(st, plan, b, g));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: c, role: 'target' }] }));
  run(st, connect(st, { plan, members: [{ node: b, role: 'source' }, { node: c, role: 'target' }] }));
  const scene = buildScene(st, plan, measure, P);
  const v = computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 3), P);
  expect(v.connections).toHaveLength(1);
  expect(v.connections[0].conns).toHaveLength(2);
  const open = computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 16), P);
  expect(open.connections).toHaveLength(2);
});

test('hors écran : rien n’est visible loin du plan', () => {
  const cam = { ...camAtTextPx(sc, 0, 16), x: 1e7, y: -1e7 };
  const v = computeVisible(sc, idx, cam, P);
  expect(v.items).toEqual([]);
  expect(v.connections).toEqual([]);
});

test('une connexion reste visible si un seul de ses nœuds est à l’écran (spec 8.5)', () => {
  // Camera centred on Monde, narrow screen: Universalité → Monde must stay, Kraft → Code préfixe must not.
  const m = sc.items[at(ids.nodes.monde)];
  const cam = { x: m.x, y: m.y + 150, zoom: 1, widthPx: 600, heightPx: 400 };
  const v = computeVisible(sc, idx, cam, { ...P, viewMarginPx: 0 });
  expect(conn(v.connections, ids.nodes.universalite, ids.nodes.monde)).toBeDefined();
  expect(v.connections.some((c) => c.conns.some((i) => sc.connections[i].ends.some((e) => sc.items[e.item].title === 'Inégalité de Kraft')))).toBe(false);
});

test('la partie lointaine d’un bras scindé est visible près d’Universalité', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 16), P);
  const far = v.connections.find((c) => c.center !== undefined)!;
  expect(sc.items[far.center!].id).toBe(ids.phantoms.center);
  expect(sc.items[far.ends[0].item].id).toBe(ids.nodes.universalite);
});

test('signature de repli : change seulement quand un niveau change d’état', () => {
  const a = foldSignature(idx, camAtTextPx(sc, 0, 16).zoom, P);
  expect(foldSignature(idx, camAtTextPx(sc, 0, 15).zoom, P)).toBe(a);
  expect(foldSignature(idx, camAtTextPx(sc, 0, 5.5).zoom, P)).not.toBe(a);
  expect(computeVisible(sc, idx, camAtTextPx(sc, 0, 16), P).signature).toBe(a);
});

test('deux connexions parallèles ouvertes restent distinctes ; elles ne fusionnent que repliées (I5 de la relecture)', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), a = node('A', 0, 0), b = node('B', 2000, 0);
  run(st, include(st, plan, a, g));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], title: 'cite' }));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], title: 'contredit' }));
  const scene = buildScene(st, plan, measure, P);
  expect(computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 16), P).connections).toHaveLength(2);
  const folded = computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 3), P);
  expect(folded.connections).toHaveLength(1);
  expect(folded.connections[0].conns).toHaveLength(2);
});
