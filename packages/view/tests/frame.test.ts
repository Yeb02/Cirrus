import { applyOps, setGroupColor, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { chosenPalette, groupPalette, hexToRgb } from '../src/color.ts';
import { groupColors } from '../src/frame.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { sampleBranch } from '../src/geometry/ribbon.ts';
import { simpleBranches } from '../src/geometry/simple.ts';
import { CURVE_AT, CURVE_FLOATS, SIMPLE_INTS, simpleEnds } from '../src/instances.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { placeTitle } from '../src/titles.ts';
import { fixture, frameAt, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
});

test('instances complètes sans NaN sur les trois plans de la base de test, à cinq zooms (Review Focus 4, 5)', () => {
  for (const plan of Object.values(ids.plans)) {
    const scene = buildScene(s, plan, measure, P);
    for (const px of [0.5, 3, 7, 16, 200]) {
      const { inst } = frameAt(scene, 0, px);
      for (const list of [inst.curves, ...Object.values(inst.glyphs), ...Object.values(inst.envelopes)]) expect([...list.view()].every(Number.isFinite)).toBe(true);
    }
  }
});

test('les instances contiennent les enveloppes, les connexions, les marqueurs et les titres', () => {
  const { inst, visible } = frameAt(sc, 0, 16);
  expect(inst.envelopes.alpha.length).toBeGreaterThan(0);
  expect(inst.simple.length).toBeGreaterThan(0);
  expect(inst.curves.length).toBeGreaterThan(0);
  expect(inst.markers.some((m) => m.drawn)).toBe(true);
  expect(inst.titles.map((t) => t.text)).toContain('Déduction jointe');
  const drawn = new Set<number>();
  for (let o = 0; o < inst.simple.length; o += SIMPLE_INTS) drawn.add(inst.simple.view()[o + 3]);
  for (let o = 0; o < inst.curves.length; o += CURVE_FLOATS) drawn.add(inst.curves.view()[o + CURVE_AT.width + 3]);
  expect(drawn.size).toBe(visible.connections.length);
});

test('les groupes de premier niveau prennent les teintes dans leur ordre de création, leurs sous-groupes la même', () => {
  const at = (id: string) => sc.byId.get(id)!;
  const hueOf = (g: number) => groupColors(sc, g, P).closed;
  const expected = (depth: number, i: number) => groupPalette({ depth, hue: P.groupHues[i] }, P).closed;
  expect(hueOf(at(ids.nodes.groupeTheorie))).toEqual(expected(0, 0));
  expect(hueOf(at(ids.nodes.groupeML))).toEqual(expected(0, 1));
  expect(hueOf(at(ids.nodes.groupeInduction))).toEqual(expected(2, 0));
});

test('repliés, les titres restent ceux de chaque connexion : plus de « n connexions » (point 7)', () => {
  const { inst, visible } = frameAt(sc, 1, 3);
  for (const t of inst.titles) expect(t.text).toBe(sc.titles[visible.connections[t.conn].part]);
  expect(inst.titles.some((t) => /connexions$/.test(t.text))).toBe(false);
});

test('survol : nœud, connexion, groupe replié, fond d’un groupe ouvert', () => {
  const { inst, visible, hits, cam } = frameAt(sc, 0, 16);
  const mdl = sc.items[sc.byId.get(ids.nodes.mdl)!];
  expect(hits.hit(mdl.x, mdl.y, cam.zoom)).toEqual({ kind: 'item', item: sc.byId.get(ids.nodes.mdl), id: ids.nodes.mdl });
  // A point on a simple connection's curve, as the GPU draws it (simpleBranches): that connection, by its branch.
  const conn = inst.simple.view()[3], [a, b] = simpleEnds(sc, visible.connections[conn], { x: 0, y: 0 });
  const branch = simpleBranches(a, b, P)[1], q = sampleBranch(branch, 32)[16];
  expect(hits.hit(q.x, q.y, cam.zoom)).toMatchObject({ kind: 'connection', conn, key: branch.key });
  // Inside the padded ring of an open group: background, and the group is listed.
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!];
  const outer = offsetPolygon(g.hull!, g.pad!);
  const i = outer.reduce((best, v, j) => (v.x > outer[best].x ? j : best), 0);
  const inner = offsetPolygon(g.hull!, g.pad! * 0.4)[i];
  expect(hits.hit(inner.x, inner.y, cam.zoom)).toEqual({ kind: 'background' });
  expect(hits.openGroupsAt(inner.x, inner.y, cam.zoom)).toEqual([sc.byId.get(ids.nodes.groupeML)]);
});

test('un groupe replié se touche comme un élément', () => {
  const { hits, cam } = frameAt(sc, 0, 3);
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!];
  expect(hits.hit(g.x, g.y, cam.zoom)).toEqual({ kind: 'item', item: sc.byId.get(ids.nodes.groupeML), id: ids.nodes.groupeML });
});

test('rappel de hiérarchie : du plus profond au plus haut', () => {
  const { hits, cam } = frameAt(sc, 0, 16);
  const sol = sc.items[sc.byId.get(ids.nodes.solomonoff)!];
  const chain = hits.openGroupsAt(sol.x, sol.y, cam.zoom).map((i) => sc.items[i].id);
  expect(chain).toEqual([ids.nodes.groupeInduction, ids.nodes.groupeComplexite, ids.nodes.groupeTheorie]);
});

test('titre : « up » si libre, autre côté si une boîte le recouvre, côté précédent préféré', () => {
  const m = { x: 0, y: 0 };
  expect(placeTitle(m, 100, 20, 10, [], []).side).toBe('up');
  const blocker = { x: -200, y: -100, w: 400, h: 95 };
  const r = placeTitle(m, 100, 20, 10, [], [blocker]);
  expect(r.side.startsWith('up')).toBe(false);
  expect(placeTitle(m, 100, 20, 10, [], [], 'down').side).toBe('down');
  const crossing = Array.from({ length: 20 }, (_, i) => ({ x: -50 + i * 5, y: -20 }));
  expect(placeTitle(m, 100, 20, 10, crossing, []).side).not.toBe('up');
});

test('l’enveloppe d’un sous-groupe porte le repli de son parent, pour s’estomper avec lui (I4 de la relecture)', () => {
  const { inst, visible } = frameAt(sc, 0, 16);
  const parentK = [...inst.envelopes.parentK.view()];
  const kOfComplexite = sc.items[sc.byId.get(ids.nodes.groupeComplexite)!].maxChildK!;
  expect(parentK).toContain(kOfComplexite); // Induction universelle, inside Complexité et induction
  expect(parentK.some((k) => k > 1e8)).toBe(true); // a top-level group: no parent
  expect(parentK).toHaveLength(inst.envelopes.alpha.length);
  expect(visible.groups.length).toBeGreaterThan(0);
});

test('le titre d’un groupe ouvert se touche comme le groupe : on le clique, on le tire, on ouvre son menu (spec 9.1, I11 de la relecture 3b)', () => {
  const { hits, cam } = frameAt(sc, 0, 16);
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!];
  const top = Math.min(...offsetPolygon(g.hull!, g.pad!).map((q) => q.y));
  const size = P.baseFontPx * P.factor ** g.k * P.groupTitleOpenScale;
  const y = top - size * P.groupTitleOffset;
  expect(hits.hit(g.x, y, cam.zoom)).toEqual({ kind: 'item', item: sc.byId.get(ids.nodes.groupeML), id: ids.nodes.groupeML });
});

test('la couleur choisie d’un groupe (plan 6b, D4) : il la montre exacte, ses sous-groupes ses nuances ; un sous-groupe coloré l’emporte et transmet la sienne ; sans couleur, rien ne change', () => {
  const { s: st, ids: id } = fixture();
  const lobby = id.plans.lobby, before = buildScene(st, lobby, measure, P);
  const at = (scene: PlanScene, x: string) => scene.byId.get(x)!;
  const depth = (scene: PlanScene, x: string) => scene.items[at(scene, x)].depth;
  applyOps(st, setGroupColor(st, lobby, id.nodes.groupeTheorie, '#3a7bd5').ops);
  const one = buildScene(st, lobby, measure, P);
  expect(groupColors(one, at(one, id.nodes.groupeTheorie), P).closed).toEqual(hexToRgb('#3a7bd5'));
  const d = depth(one, id.nodes.groupeInduction) - depth(one, id.nodes.groupeTheorie);
  expect(groupColors(one, at(one, id.nodes.groupeInduction), P)).toEqual(chosenPalette('#3a7bd5', d, P));
  // Another top-level group keeps its own.
  expect(groupColors(one, at(one, id.nodes.groupeML), P)).toEqual(groupColors(before, at(before, id.nodes.groupeML), P));
  applyOps(st, setGroupColor(st, lobby, id.nodes.groupeInduction, '#d5503a').ops);
  const two = buildScene(st, lobby, measure, P);
  expect(groupColors(two, at(two, id.nodes.groupeInduction), P).closed).toEqual(hexToRgb('#d5503a'));
  applyOps(st, setGroupColor(st, lobby, id.nodes.groupeTheorie, null).ops);
  applyOps(st, setGroupColor(st, lobby, id.nodes.groupeInduction, null).ops);
  const none = buildScene(st, lobby, measure, P);
  for (const g of [id.nodes.groupeTheorie, id.nodes.groupeInduction, id.nodes.groupeML]) expect(groupColors(none, at(none, g), P)).toEqual(groupColors(before, at(before, g), P));
});

test('la couleur d’un groupe suit l’action dans la scène tenue à jour : l’élément est redessiné (reshaped)', () => {
  const { s: st, ids: id } = fixture();
  const lobby = id.plans.lobby, scene = buildScene(st, lobby, measure, P), g = scene.byId.get(id.nodes.groupeTheorie)!;
  const ops = setGroupColor(st, lobby, id.nodes.groupeTheorie, '#3a7bd5').ops;
  applyOps(st, ops);
  const u = updateScene(scene, st, ops, measure, P);
  expect(u.scene.items[u.scene.byId.get(id.nodes.groupeTheorie)!].color).toBe('#3a7bd5');
  expect(groupColors(u.scene, u.scene.byId.get(id.nodes.groupeTheorie)!, P).closed).toEqual(hexToRgb('#3a7bd5'));
  expect(u.changes.items).toContain(g);
});
