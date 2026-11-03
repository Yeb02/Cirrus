import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { dropEffects, dropTarget, intruders, visibleIntruders } from '../src/edit.ts';
import { insidePolygon, offsetPolygon } from '../src/geometry/hull.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { buildIndex, computeVisible, type VisibleSet } from '../src/visibility.ts';
import { camAtTextPx, fixture, measure, P, randomCameras, rng } from './helpers.ts';

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

/** Every drawn item against every drawn envelope: each covered item with the deepest such group, the first by slot among equals. */
function bruteIntruders(scene: PlanScene, v: VisibleSet): Map<number, number> {
  const out = new Map<number, number>(), items = scene.items;
  const above = (i: number, g: number) => { for (let a = items[i].parent; a >= 0; a = items[a].parent) if (a === g) return true; return false; };
  for (const i of [...v.items, ...v.groups]) {
    for (const g of [...v.groups].sort((a, b) => a - b)) {
      if (g === i || above(i, g) || above(g, i) || !insidePolygon(offsetPolygon(items[g].hull!, items[g].pad!), items[i].x, items[i].y)) continue;
      const known = out.get(i);
      if (known === undefined || items[known].depth < items[g].depth) out.set(i, g);
    }
  }
  return out;
}

test('intrus du visible : ceux d’intruders parmi ce qui est dessiné, avec le groupe dessiné le plus profond qui les recouvre', () => {
  const all = intruders(sc), index = buildIndex(sc, P);
  let found = 0;
  for (const cam of [camAtTextPx(sc, 0, 16), camAtTextPx(sc, 0, 5.5), ...randomCameras(sc, 60, rng(5), 0.05, 4)]) {
    const v = computeVisible(sc, index, cam, P), got = visibleIntruders(sc, v);
    expect(got).toEqual(bruteIntruders(sc, v));
    for (const [i, g] of got) {
      expect(all.has(i)).toBe(true);
      // The deepest group of all, when it is drawn, is the one named.
      if (v.groups.includes(all.get(i)!)) expect(g).toBe(all.get(i));
    }
    found += got.size;
  }
  expect(visibleIntruders(sc, computeVisible(sc, index, camAtTextPx(sc, 0, 16), P)).has(sc.items.findIndex((i) => i.title === 'Théorème d’invariance'))).toBe(true);
  expect(found).toBeGreaterThan(10);
  expect(visibleIntruders(sc, { items: [], groups: [], connections: [], signature: '' }).size).toBe(0);
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

test('Alt ou « exclure » puis reposé dans son propre groupe : il ne fait que bouger (spec 10, I3 de la relecture 3b)', () => {
  const cx = at(ids.nodes.groupeComplexite);
  expect(dropEffects(sc, [at(ids.nodes.mdl)], cx, true)).toEqual([{ item: at(ids.nodes.mdl), leave: false, enter: null }]);
});
