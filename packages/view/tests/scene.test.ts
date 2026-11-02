import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOp, cloneState, connect, createNode, createPlan, emptyState, type Id, placeNode, removeFromPlan, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { beforeAll, expect, test } from 'vitest';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';
import { buildScene, type Measure, type PlanScene } from '../src/scene.ts';

const P = DEFAULT_PARAMS;
const measure: Measure = (t) => Math.max(1, Math.ceil(t.length / 23));
let s: State;
let ids: FixtureIds;
let sc: PlanScene;
const it = (scene: PlanScene, id: Id) => scene.items[scene.byId.get(id)!];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-view-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  s = store.state;
  sc = buildScene(s, ids.plans.lobby, measure, P);
});

const run = (st: State, a: Action): Action => { for (const op of a.ops) applyOp(st, op); return a; };
const created = (a: Action, t: 'node' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

test('lobby de la base de test : hiérarchie à trois niveaux', () => {
  expect(it(sc, ids.nodes.groupeTheorie).kind).toBe('group');
  expect(sc.items[it(sc, ids.nodes.groupeInduction).parent].id).toBe(ids.nodes.groupeComplexite);
  expect(sc.items[it(sc, ids.nodes.groupeComplexite).parent].id).toBe(ids.nodes.groupeTheorie);
  expect(it(sc, ids.nodes.groupeTheorie).depth).toBe(0);
  expect(it(sc, ids.nodes.groupeInduction).depth).toBe(2);
  expect(it(sc, ids.nodes.monde).kind).toBe('node');
  expect(it(sc, ids.nodes.monde).parent).toBe(-1);
  expect(sc.byId.has(ids.nodes.trashed)).toBe(false);
  expect(sc.roots).toContain(sc.byId.get(ids.nodes.groupeTheorie));
  for (const r of sc.roots) expect(sc.items[r].parent).toBe(-1);
});

test('un groupe déduit sa position et son enveloppe de ses membres (spec 10)', () => {
  const g = it(sc, ids.nodes.groupeInduction);
  const kids = g.children.map((i) => sc.items[i]);
  expect(kids.map((k) => k.title).sort()).toEqual(['Induction de Solomonoff', 'Priore universelle']);
  expect(g.x).toBeCloseTo(kids.reduce((a, c) => a + c.x, 0) / kids.length, 9);
  expect(g.y).toBeCloseTo(kids.reduce((a, c) => a + c.y, 0) / kids.length, 9);
  expect(g.maxChildK).toBe(0);
  expect(g.pad).toBe(P.envelopePad);
  // The parent's hull covers the child group's padded envelope.
  const parent = it(sc, ids.nodes.groupeComplexite);
  expect(parent.maxChildK).toBe(1);
  const minX = Math.min(...parent.hull!.map((q) => q.x));
  expect(minX).toBeLessThan(Math.min(...offsetPolygon(g.hull!, g.pad!).map((q) => q.x)) + 1e-6);
});

test('boîte : largeur fixe à l’échelle du cran, hauteur selon les lignes', () => {
  const m = it(sc, ids.nodes.mdl);
  expect(m.lines).toBe(measure(m.title));
  expect(m.halfW).toBe(P.boxWidth / 2);
  expect(m.halfH).toBeCloseTo((m.lines * P.lineHeight * P.baseFontPx + 2 * P.boxPadY) / 2, 9);
});

test('un long titre agrandit la boîte en hauteur sans tronquer', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const long = 'Un titre vraiment très long qui ne tient pas sur une seule ligne de boîte, loin de là';
  const a = created(run(st, createNode(st, { plan, title: long, x: 0, y: 0, k: 0 })), 'node');
  const b = created(run(st, createNode(st, { plan, title: 'Court', x: 400, y: 0, k: 0 })), 'node');
  const one = buildScene(st, plan, measure, P);
  expect(it(one, a).lines).toBe(measure(long));
  expect(it(one, a).halfH).toBeGreaterThan(it(one, b).halfH);
  expect(it(one, a).title).toBe(long);
});

test('le fantôme du bras scindé est dans le groupe de MDL, et la partie lointaine relie Universalité au centre', () => {
  const ph = it(sc, ids.phantoms.node);
  expect(ph.kind).toBe('phantom');
  expect(ph.phantom).toBe('node');
  expect(ph.title).toBe('Universalité algorithmique');
  expect(sc.items[ph.parent].id).toBe(ids.nodes.groupeComplexite);
  const parts = sc.connections.filter((c) => c.id === ids.connections.split);
  expect(parts.map((c) => c.part).sort()).toEqual(['far', 'main']);
  const main = parts.find((c) => c.part === 'main')!;
  expect(main.ends.map((e) => sc.items[e.item].id).sort()).toEqual([ids.nodes.mdl, ids.phantoms.node].sort());
  expect(main.ends.find((e) => e.item === sc.byId.get(ids.phantoms.node))!.role).toBe('target');
  const far = parts.find((c) => c.part === 'far')!;
  expect(sc.items[far.ends[0].item].id).toBe(ids.nodes.universalite);
  expect(far.ends[0].role).toBe('target');
  expect(sc.items[far.center!].id).toBe(ids.phantoms.center);
  // A split arm is not "absent": Universality carries no badge for it.
  expect(it(sc, ids.nodes.universalite).badge).toBe(false);
});

test('Thèse : Entropie absente devient une amorce, et le badge signale les connexions absentes', () => {
  const th = buildScene(s, ids.plans.these, measure, P);
  const c = th.connections.find((x) => x.id === ids.connections.twoToOne)!;
  expect(c.stubs).toEqual([{ role: 'source', node: ids.nodes.entropie, title: 'Entropie de Shannon' }]);
  expect(c.ends).toHaveLength(2);
  expect(it(th, ids.nodes.mdl).badge).toBe(true); // MDL has lobby connections absent here
  expect(sc.items.every((i) => i.kind !== 'node' || i.id !== ids.nodes.monde || i.badge === false)).toBe(true);
});

test('document : structure dessinée, connaissance masquée ; inclusion jamais dessinée', () => {
  const doc = buildScene(s, ids.plans.article, measure, P);
  expect(doc.connections.length).toBeGreaterThan(0);
  expect(doc.connections.every((c) => s.connections.get(c.id)!.kind === 'structure')).toBe(true);
  expect(sc.connections.some((c) => s.connections.get(c.id)!.kind !== 'knowledge')).toBe(false);
});

test('groupe retiré du plan : ses membres se dessinent dans le plus proche ancêtre placé (spec 7)', () => {
  const s2 = cloneState(s);
  run(s2, removeFromPlan(s2, ids.plans.lobby, ids.nodes.groupeInduction));
  const sc2 = buildScene(s2, ids.plans.lobby, measure, P);
  expect(sc2.byId.has(ids.nodes.groupeInduction)).toBe(false);
  expect(sc2.items[it(sc2, ids.nodes.solomonoff).parent].id).toBe(ids.nodes.groupeComplexite);
});

test('plan vide : aucun élément, bornes nulles', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'Lobby', 'lobby')), 'plan');
  const empty = buildScene(st, plan, measure, P);
  expect(empty.items).toEqual([]);
  expect(empty.connections).toEqual([]);
  expect(empty.bounds).toBeNull();
});

test('les bornes couvrent les boîtes et les enveloppes élargies', () => {
  const b = sc.bounds!;
  for (const i of sc.items) {
    if (i.kind === 'group') continue;
    expect(i.x - i.halfW).toBeGreaterThanOrEqual(b.minX);
    expect(i.y + i.halfH).toBeLessThanOrEqual(b.maxY);
  }
  const g = it(sc, ids.nodes.groupeTheorie);
  expect(Math.min(...offsetPolygon(g.hull!, g.pad!).map((q) => q.x))).toBeGreaterThanOrEqual(b.minX - 1e-6);
});

test('une connexion masquée dans ce plan (un seul nœud présent) laisse un badge à ce nœud (spec 11.3, M2 de la relecture)', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const a = created(run(st, createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 })), 'node');
  const b = created(run(st, createNode(st, { plan, title: 'B', x: 400, y: 0, k: 0 })), 'node');
  const other = created(run(st, createPlan(st, 'Q', 'plan')), 'plan');
  run(st, placeNode(st, other, b, 0, 0, 0)); // B lives on elsewhere: hiding it here keeps it out of the trash
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] }));
  expect(it(buildScene(st, plan, measure, P), a).badge).toBe(false);
  run(st, removeFromPlan(st, plan, b));
  const sc2 = buildScene(st, plan, measure, P);
  expect(sc2.connections).toHaveLength(0); // masked: fewer than two nodes shown (spec 11.2)
  expect(it(sc2, a).badge).toBe(true);
});
