import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { dropEffects, dropTarget, intruders } from '../src/edit.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { fixture, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
});
const at = (id: string) => sc.byId.get(id)!;
/** A point inside a group's padded envelope but on none of its boxes: halfway into the padding ring. */
const inPadding = (id: string) => {
  const g = sc.items[at(id)];
  const outer = offsetPolygon(g.hull!, g.pad!), inner = offsetPolygon(g.hull!, g.pad! * 0.4);
  const i = outer.reduce((best, v, j) => (v.y > outer[best].y ? j : best), 0);
  return inner[i];
};

test('déposer un nœud libre dans l’enveloppe d’un groupe : ce groupe', () => {
  expect(dropTarget(sc, inPadding(ids.nodes.groupeML), [at(ids.nodes.monde)], 1, P)).toBe(at(ids.nodes.groupeML));
});

test('déposer sur la boîte d’un nœud simple : ce nœud (il deviendra un groupe)', () => {
  const b = sc.items[at(ids.nodes.biais)];
  expect(dropTarget(sc, { x: b.x, y: b.y }, [at(ids.nodes.monde)], 1, P)).toBe(at(ids.nodes.biais));
});

test('jamais dans soi-même ni dans un de ses descendants (Review Focus 3)', () => {
  const sol = sc.items[at(ids.nodes.solomonoff)];
  const t = dropTarget(sc, { x: sol.x, y: sol.y }, [at(ids.nodes.groupeComplexite)], 1, P);
  expect(t).not.toBe(at(ids.nodes.solomonoff));
  expect(t).not.toBe(at(ids.nodes.groupeInduction));
  expect(t).not.toBe(at(ids.nodes.groupeComplexite));
  expect(t === null || t === at(ids.nodes.groupeTheorie)).toBe(true);
});

test('sur le fond : aucune cible', () => {
  expect(dropTarget(sc, { x: 1e6, y: 1e6 }, [at(ids.nodes.monde)], 1, P)).toBeNull();
});

test('intrus : nœud étranger recouvert par une enveloppe, jamais un membre', () => {
  const found = intruders(sc);
  const invariance = sc.items.findIndex((i) => i.title === 'Théorème d’invariance');
  expect(found.has(invariance)).toBe(true);
  expect([at(ids.nodes.groupeTheorie), at(ids.nodes.groupeComplexite)]).toContain(found.get(invariance));
  expect(found.has(at(ids.nodes.mdl))).toBe(false);
  expect(found.has(at(ids.nodes.groupeInduction))).toBe(false);
  expect(found.has(at(ids.nodes.monde))).toBe(false);
});

test('effets d’un dépôt (spec 10) : un nœud libre entre, un membre ne descend que dans un sous-groupe, Alt fait sortir', () => {
  const ml = at(ids.nodes.groupeML), ind = at(ids.nodes.groupeInduction), cx = at(ids.nodes.groupeComplexite);
  expect(dropEffects(sc, [at(ids.nodes.monde)], ml, false)).toEqual([{ item: at(ids.nodes.monde), leave: false, enter: ml }]);
  // MDL (in Complexité) dropped into Induction (a subgroup of Complexité): it goes down.
  expect(dropEffects(sc, [at(ids.nodes.mdl)], ind, false)).toEqual([{ item: at(ids.nodes.mdl), leave: false, enter: ind }]);
  // MDL dropped into Généralisation (a neighbour): it only moves; changing groups needs « exclure ».
  expect(dropEffects(sc, [at(ids.nodes.mdl)], ml, false)).toEqual([{ item: at(ids.nodes.mdl), leave: false, enter: null }]);
  // Dropped back in its own group: it only moves.
  expect(dropEffects(sc, [at(ids.nodes.mdl)], cx, false)).toEqual([{ item: at(ids.nodes.mdl), leave: false, enter: null }]);
  // Alt: it leaves, and enters the group under the cursor if it is another one.
  expect(dropEffects(sc, [at(ids.nodes.mdl)], null, true)).toEqual([{ item: at(ids.nodes.mdl), leave: true, enter: null }]);
  expect(dropEffects(sc, [at(ids.nodes.mdl)], ml, true)).toEqual([{ item: at(ids.nodes.mdl), leave: true, enter: ml }]);
});
