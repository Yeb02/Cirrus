import { applyOps, type State } from '@cirrus/core';
import { buildLargeState, type FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { dropEffects, dropTarget, intruders, visibleIntruders } from '../src/edit.ts';
import { insidePolygon, offsetPolygon } from '../src/geometry/hull.ts';
import { buildScene, isLive, type PlanScene, sceneWith } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { buildIndex, computeVisible, updateIndex, type VisibleSet } from '../src/visibility.ts';
import { camAtTextPx, copyOf, fixture, measure, P, randomActions, randomCameras, rng } from './helpers.ts';

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

/** Points to drop on: every item's centre, its box's corners and edges, its envelope's vertices, and points at random. */
function dropPoints(scene: PlanScene, r: () => number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  scene.items.forEach((it, i) => {
    if (!isLive(scene, i)) return;
    out.push({ x: it.x, y: it.y });
    for (const f of [-1, -0.999, 0.999, 1]) out.push({ x: it.x + f * it.halfW, y: it.y + f * it.halfH }, { x: it.x + f * it.halfW, y: it.y }, { x: it.x, y: it.y - f * it.halfH });
    if (it.kind === 'group') for (const d of [1, 0.999, 0.4]) out.push(...offsetPolygon(it.hull!, it.pad! * d));
  });
  const b = scene.bounds ?? { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  for (let k = 0; k < 300; k++) out.push({ x: b.minX + r() * (b.maxX - b.minX), y: b.minY + r() * (b.maxY - b.minY) });
  return out;
}

test('cible du dépôt par l’index de la vue : la même que le balayage du plan, pour chaque point, zoom et ensemble tiré, actions comprises', () => {
  const st = copyOf(s), r = rng(31);
  let compared = 0, found = 0;
  const check = (scene: PlanScene, index: ReturnType<typeof buildIndex>) => {
    const live = scene.items.flatMap((_it, i) => (isLive(scene, i) ? [i] : []));
    const leaf = live.find((i) => scene.items[i].kind === 'node' && scene.items[i].parent >= 0), group = live.find((i) => scene.items[i].kind === 'group');
    const draggedSets = [[], ...(leaf !== undefined ? [[leaf]] : []), ...(group !== undefined ? [[group]] : []), live.slice(0, 2)];
    const points = dropPoints(scene, r);
    for (const zoom of [0.005, 0.03, 0.1, 0.25, 0.6, 1, 3, P.zoomMin * (2 / P.zoomMin) ** r()]) {
      for (const dragged of draggedSets) {
        for (const pt of points) {
          const t = dropTarget(scene, pt, dragged, zoom, P, index);
          expect(t, `${JSON.stringify(pt)} ${zoom} [${dragged}]`).toBe(dropTarget(scene, pt, dragged, zoom, P));
          compared++;
          if (t !== null) found++;
        }
      }
    }
  };
  for (const plan of Object.values(ids.plans)) { const scene = buildScene(st, plan, measure, P); check(scene, buildIndex(scene, P)); }
  // After actions, the index followed by updateIndex (roots come, go and move: searched one by one until its tree is rebuilt).
  let scene = buildScene(st, ids.plans.lobby, measure, P), index = buildIndex(scene, P);
  const next = randomActions(st, r);
  for (let i = 0; i < 40; i++) {
    const picked = next();
    if (!picked) continue;
    applyOps(st, picked.action.ops);
    const u = updateScene(scene, st, picked.action.ops, measure, P);
    index = u.changes.full ? buildIndex(u.scene, P) : updateIndex(index, u.scene, u.changes, P);
    scene = u.scene;
    if (i % 8 === 0) check(scene, index);
  }
  expect(compared).toBeGreaterThan(50_000);
  expect(found).toBeGreaterThan(5_000);
}, 120_000);

test('cible du dépôt par l’index : seuls les éléments dont la boîte tient le point sont lus, jamais tout le plan', () => {
  const { state, lobby } = buildLargeState({ seed: 2, nodes: 5_000, connections: 2_000 });
  const scene = buildScene(state, lobby, measure, P), index = buildIndex(scene, P);
  let reads = 0;
  const counted = sceneWith(scene, {
    items: new Proxy(scene.items, { get: (t, k, rc) => { if (typeof k === 'string' && k.charCodeAt(0) <= 57) reads++; return Reflect.get(t, k, rc); } }),
  });
  const leaf = scene.items.findIndex((it, i) => isLive(scene, i) && it.kind === 'node' && it.depth >= 2), it = scene.items[leaf];
  for (const zoom of [0.02, 0.3, 1.2]) {
    reads = 0;
    const t = dropTarget(counted, { x: it.x, y: it.y }, [leaf], zoom, P, index);
    expect(t).toBe(dropTarget(scene, { x: it.x, y: it.y }, [leaf], zoom, P));
    expect(reads, `zoom ${zoom}`).toBeLessThan(scene.items.length / 20);
  }
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
