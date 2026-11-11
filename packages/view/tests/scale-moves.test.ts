import { combine, moveNodes, movePhantom, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { scaleMoves } from '../src/edit.ts';
import { buildScene, withMoves } from '../src/scene.ts';
import { copyOf, fixture, measure, P, run } from './helpers.ts';

let s: State, ids: FixtureIds;
beforeAll(() => { ({ s, ids } = fixture()); });

const apply = (st: State, plan: string, m: ReturnType<typeof scaleMoves>) =>
  run(st, combine(st, 'Échelle', [
    (x) => moveNodes(x, plan, m.nodes),
    ...m.phantoms.map((ph) => (x: State) => movePhantom(x, ph.id, ph.x, ph.y, undefined, ph.k)),
  ]));
/** Where each item is drawn, and its step (a group's own stored position is not drawn: it follows its centre). */
const positions = (st: State, plan: string) => JSON.stringify(buildScene(st, plan, measure, P).items.map((it) => [it.id, it.x, it.y, it.k]));

test('nœud seul : son cran change, sa position non', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const m = scaleMoves(sc, [sc.byId.get(ids.nodes.monde)!], 1, P);
  expect(m.nodes).toHaveLength(1);
  const pl = s.placements.get(`${ids.plans.lobby}|${ids.nodes.monde}`)!;
  expect(m.nodes[0]).toEqual({ node: ids.nodes.monde, x: pl.x, y: pl.y, k: pl.k + 1 });
});

test('groupe : lui et tous ses descendants +1 cran, membres dilatés autour du centre ; − puis + rend tout (Review Focus 5)', () => {
  const st = copyOf(s);
  const plan = ids.plans.lobby;
  const before = positions(st, plan);
  const phantomBefore = st.phantoms.get(ids.phantoms.node)!;
  const sc = buildScene(st, plan, measure, P);
  const g = sc.byId.get(ids.nodes.groupeComplexite)!;
  const center = { x: sc.items[g].x, y: sc.items[g].y };
  const m = scaleMoves(sc, [g], 1, P);
  const mdl = m.nodes.find((n) => n.node === ids.nodes.mdl)!;
  const mdlBefore = st.placements.get(`${plan}|${ids.nodes.mdl}`)!;
  expect(mdl.x! - center.x).toBeCloseTo((mdlBefore.x - center.x) * P.factor, 9);
  expect(mdl.k).toBe(mdlBefore.k + 1); // every descendant changes by the same steps (2026-11-11)
  const induction = m.nodes.find((n) => n.node === ids.nodes.groupeInduction)!, solomonoff = m.nodes.find((n) => n.node === ids.nodes.solomonoff)!;
  expect(induction.k).toBe(st.placements.get(`${plan}|${ids.nodes.groupeInduction}`)!.k + 1); // a subgroup
  expect(solomonoff.k).toBe(st.placements.get(`${plan}|${ids.nodes.solomonoff}`)!.k + 1); // and its members
  expect(m.phantoms.find((ph) => ph.id === ids.phantoms.node)!.k).toBe(phantomBefore.k + 1);
  expect(m.nodes.find((n) => n.node === ids.nodes.groupeComplexite)!.k).toBe(st.placements.get(`${plan}|${ids.nodes.groupeComplexite}`)!.k + 1);
  expect(m.nodes.some((n) => n.node === ids.nodes.monde)).toBe(false); // outside the group: untouched
  expect(m.phantoms.map((ph) => ph.id)).toContain(ids.phantoms.node); // the split arm's phantom sits in the group
  apply(st, plan, m);
  const sc2 = buildScene(st, plan, measure, P);
  apply(st, plan, scaleMoves(sc2, [sc2.byId.get(ids.nodes.groupeComplexite)!], -1, P));
  const after = JSON.parse(positions(st, plan)) as [string, number, number, number][];
  (JSON.parse(before) as [string, number, number, number][]).forEach(([n, x, y, k], i) => {
    expect(after[i][0]).toBe(n);
    expect(after[i][1]).toBeCloseTo(x, 9);
    expect(after[i][2]).toBeCloseTo(y, 9);
    expect(after[i][3]).toBe(k);
  });
  expect(st.phantoms.get(ids.phantoms.node)!.x).toBeCloseTo(phantomBefore.x, 9);
});

test('sélection : dilatée autour de son barycentre comme un seul élément ; un membre d’un groupe sélectionné n’est pas compté deux fois', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const a = sc.byId.get(ids.nodes.monde)!, b = sc.byId.get(ids.nodes.universalite)!, g = sc.byId.get(ids.nodes.groupeML)!;
  const inside = sc.byId.get(ids.nodes.biais)!;
  const m = scaleMoves(sc, [a, b, g, inside], -1, P);
  const center = { x: (sc.items[a].x + sc.items[b].x + sc.items[g].x) / 3, y: (sc.items[a].y + sc.items[b].y + sc.items[g].y) / 3 };
  const monde = m.nodes.find((n) => n.node === ids.nodes.monde)!;
  expect(monde.x! - center.x).toBeCloseTo((sc.items[a].x - center.x) / P.factor, 9);
  expect(monde.k).toBe(sc.items[a].k - 1);
  const biais = m.nodes.filter((n) => n.node === ids.nodes.biais);
  expect(biais).toHaveLength(1);
  expect(biais[0].k).toBe(sc.items[inside].k - 1); // a selected group's member: once, with its group's steps
});

test('échelle : un sous-groupe dilaté écrit aussi sa position propre, celle où il est dessiné (I2 de la relecture 3b)', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const g = sc.byId.get(ids.nodes.groupeComplexite)!, sub = sc.items[sc.byId.get(ids.nodes.groupeInduction)!];
  const m = scaleMoves(sc, [g], 1, P);
  const c = { x: sc.items[g].x, y: sc.items[g].y };
  const written = m.nodes.find((n) => n.node === ids.nodes.groupeInduction)!;
  expect(written.x).toBeCloseTo(c.x + (sub.x - c.x) * P.factor, 9);
  expect(written.y).toBeCloseTo(c.y + (sub.y - c.y) * P.factor, 9);
});

test('un fantôme change de cran comme un nœud (I14 de la relecture 3b)', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const i = sc.byId.get(ids.phantoms.node)!;
  const m = scaleMoves(sc, [i], 1, P);
  expect(m.phantoms).toEqual([{ id: ids.phantoms.node, x: sc.items[i].x, y: sc.items[i].y, k: sc.items[i].k + 1 }]);
});

test('aperçu d’un changement de cran sans reconstruire la scène : comme si l’action était écrite (I15 de la relecture 3b)', () => {
  const st = copyOf(s);
  const plan = ids.plans.lobby;
  const sc = buildScene(st, plan, measure, P);
  const m = scaleMoves(sc, [sc.byId.get(ids.nodes.groupeComplexite)!, sc.byId.get(ids.phantoms.center)!], 1, P);
  const mdlBefore = sc.items[sc.byId.get(ids.nodes.mdl)!].x;
  const preview = withMoves(sc, m, P);
  apply(st, plan, m);
  const real = buildScene(st, plan, measure, P);
  real.items.forEach((it, i) => {
    const q = preview.items[i];
    expect(q.id).toBe(it.id);
    for (const key of ['x', 'y', 'k', 'halfW', 'halfH'] as const) expect(q[key]).toBeCloseTo(it[key], 9);
    if (it.pad !== undefined) expect(q.pad).toBeCloseTo(it.pad, 9);
  });
  expect(sc.items[sc.byId.get(ids.nodes.mdl)!].x).toBe(mdlBefore); // the scene received is untouched
  expect(preview.items[sc.byId.get(ids.nodes.mdl)!].x).not.toBe(mdlBefore);
});
