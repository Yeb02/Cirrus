import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { connectTarget, fold, nodeSuggestions, otherPlans } from '../src/connect.ts';
import { sampleBranch } from '../src/geometry/ribbon.ts';
import { simpleMarker } from '../src/geometry/simple.ts';
import { CURVE_AT, CURVE_FLOATS, SIMPLE_INTS } from '../src/instances.ts';
import { menuFor } from '../src/menus.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { emptySelection } from '../src/selection.ts';
import { fixture, frameAt, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
});

const at = (id: string) => sc.byId.get(id)!;
const mainOf = (id: string) => sc.connections.findIndex((c) => c.id === id && c.part === 'main');
/** The complex curves of visible connection `vi`: each with the member it leads to, and its open cubic's points (relative to the origin). */
const curvesOf = (inst: ReturnType<typeof frameAt>['inst'], vi: number) => {
  const c = inst.curves.view(), out: { key: string | null; points: { x: number; y: number }[] }[] = [];
  for (let j = 0, o = 0; o < c.length; j++, o += CURVE_FLOATS) {
    if (c[o + CURVE_AT.width + 3] !== vi) continue;
    const q = o + CURVE_AT.open0;
    out.push({ key: inst.curveKeys[j], points: sampleBranch({ p0: { x: c[q], y: c[q + 1] }, b1: { x: c[q + 2], y: c[q + 3] }, b2: { x: c[q + 4], y: c[q + 5] }, p3: { x: c[q + 6], y: c[q + 7] } }, 32) });
  }
  return out;
};

test('chaque tronçon de ligne nomme son membre ; le tronc n’en nomme aucun', () => {
  const { inst, visible } = frameAt(sc, 0, 16);
  const vi = visible.connections.findIndex((vc) => sc.connections[vc.part].title === 'Déduction jointe');
  const lines = curvesOf(inst, vi);
  expect(lines.filter((c) => c.key === null)).toHaveLength(1);
  const n = ids.nodes;
  expect(new Set(lines.flatMap((c) => (c.key === null ? [] : [c.key])))).toEqual(new Set([n.kolmogorov, n.solomonoff, n.mdl, n.occam]));
});

test('le survol d’une branche dit de quel membre elle part ; le menu propose alors de la scinder (spec 8.5)', () => {
  const { inst, visible, origin, hits, cam } = frameAt(sc, 0, 16);
  const vi = visible.connections.findIndex((vc) => sc.connections[vc.part].title === 'Déduction jointe');
  const line = curvesOf(inst, vi).find((c) => c.key === ids.nodes.occam)!;
  const q = line.points[Math.floor(line.points.length / 2)];
  const h = hits.hit(q.x + origin.x, q.y + origin.y, cam.zoom);
  // Stable ids: the line is known by its connection, not by indices that change at the next rebuild (I9 of the review).
  const deduction = sc.connections[visible.connections[vi].part].id;
  expect(h).toEqual({ kind: 'connection', conn: vi, key: ids.nodes.occam, id: deduction, part: 'main' });
  const actions = (hit: typeof h) => menuFor(s, sc, hit, emptySelection(), false).map((m) => m.action);
  expect(actions(h)).toEqual(['splitArm', 'layout', 'deleteConnection']);
  expect(actions({ kind: 'connection', conn: -1, key: null, id: deduction, part: 'main' })).toEqual(['layout', 'deleteConnection']);
  // The far side of a split arm: join it back.
  expect(actions({ kind: 'connection', conn: -1, key: ids.nodes.universalite, id: ids.connections.split, part: 'far' })).toEqual(['joinArm', 'deleteConnection']);
});

test('le cœur d’une connexion se touche, celui d’une connexion 1 vers 1 aussi (spec 11.1)', () => {
  const { inst, hits, cam, origin } = frameAt(sc, 0, 16);
  for (const m of inst.markers) expect(hits.markerAt(m.pos.x + origin.x, m.pos.y + origin.y, cam.zoom)).not.toBeNull();
  // A simple connection's core: midway between its boxes.
  const sv = inst.simple.view();
  expect(sv.length).toBeGreaterThan(0);
  for (let o = 0; o < sv.length; o += SIMPLE_INTS) {
    const m = simpleMarker(sc.items[sv[o]], sc.items[sv[o + 1]]);
    expect(hits.markerAt(m.x, m.y, cam.zoom)).not.toBeNull();
  }
  const one = simpleMarker(sc.items[sv[0]], sc.items[sv[1]]);
  expect(hits.markerAt(one.x, one.y, cam.zoom)).toBe(sv[3]);
  expect(hits.markerAt(1e7, 1e7, cam.zoom)).toBeNull();
});

test('cibles d’une connexion tirée : un autre nœud ou un groupe qui ne le contient pas, jamais lui-même, ses groupes, un fantôme ni le fond', () => {
  const from = at(ids.nodes.mdl);
  const item = (i: number) => ({ kind: 'item' as const, item: i, id: sc.items[i].id });
  expect(connectTarget(s, sc, from, item(at(ids.nodes.occam)), null)).toEqual({ kind: 'node', item: at(ids.nodes.occam) });
  expect(connectTarget(s, sc, from, item(at(ids.nodes.groupeML)), null)).toEqual({ kind: 'node', item: at(ids.nodes.groupeML) });
  for (const no of [from, at(ids.nodes.groupeComplexite), at(ids.nodes.groupeTheorie), at(ids.phantoms.node)]) {
    expect(connectTarget(s, sc, from, item(no), null)).toBeNull();
  }
  expect(connectTarget(s, sc, from, { kind: 'background' }, null)).toBeNull();
});

test('le cœur d’une connexion est une cible, sauf si le nœud en est déjà membre', () => {
  const from = at(ids.nodes.mdl);
  const two = mainOf(ids.connections.twoToTwo);
  expect(connectTarget(s, sc, from, { kind: 'background' }, two)).toEqual({ kind: 'connection', conn: two });
  expect(connectTarget(s, sc, from, { kind: 'background' }, mainOf(ids.connections.mdlSolomonoff))).toBeNull();
  // A box under the cursor decides alone.
  expect(connectTarget(s, sc, from, { kind: 'item', item: from, id: ids.nodes.mdl }, two)).toBeNull();
});

test('« partout » : les autres plans (hors documents) où les nœuds sont tous présents, et la connexion si elle existe déjà', () => {
  const { plans, nodes, connections } = ids;
  expect(otherPlans(s, plans.lobby, [nodes.mdl, nodes.compression])).toEqual([plans.these]);
  expect(otherPlans(s, plans.lobby, [nodes.mdl, nodes.occam])).toEqual([]);
  expect(otherPlans(s, plans.lobby, [nodes.mdl, nodes.solomonoff])).toEqual([]); // both in the document plan only
  expect(otherPlans(s, plans.lobby, [nodes.mdl], connections.twoToOne)).toEqual([plans.these]);
  expect(otherPlans(s, plans.these, [nodes.mdl], connections.twoToOne)).toEqual([]);
});

test('suggestions d’un nœud à ajouter : sans accents ni casse, débuts de titre d’abord, ni membres ni corbeille', () => {
  const titles = (typed: string, exclude: string[] = []) => nodeSuggestions(s, typed, new Set(exclude), 8).map((n) => n.title);
  expect(titles('complex')[0]).toBe('Complexité et induction'); // starts with it, shorter than « Complexité de Kolmogorov »
  expect(titles('COMPLEXITE')).toContain('Complexité de Kolmogorov');
  expect(titles('induction')[0]).toBe('Induction universelle');
  expect(titles('complex', [ids.nodes.groupeComplexite])).not.toContain('Complexité et induction');
  expect(titles('brouillon')).toEqual([]); // in the trash
  expect(titles('   ')).toEqual([]);
});

test('un appui sur une amorce dit son nœud, sa connexion et son titre ; sur un élément, son id (I9 de la relecture 3b)', () => {
  const these = buildScene(s, ids.plans.these, measure, P);
  const { inst, hits, cam, origin } = frameAt(these, 0, 16);
  const st = inst.stubs[0];
  const h = hits.hit(st.pos.x + origin.x, st.pos.y + origin.y, cam.zoom);
  expect(h).toMatchObject({ kind: 'stub', connection: ids.connections.twoToOne, node: ids.nodes.entropie, title: 'Entropie de Shannon' });
  const mdl = these.items[these.byId.get(ids.nodes.mdl)!];
  expect(hits.hit(mdl.x, mdl.y, cam.zoom)).toEqual({ kind: 'item', item: these.byId.get(ids.nodes.mdl), id: ids.nodes.mdl });
});

test('fold : sans casse ni accents, les ligatures en deux lettres (plan 6a, D1 : « noeud » trouve « Nœud »)', () => {
  expect(fold('Énoncé de la Complexité')).toBe('enonce de la complexite');
  expect(fold('Nœud, ŒUVRE et Æther')).toBe('noeud, oeuvre et aether');
  // A decomposed accent (NFD typed or pasted) folds as a composed one.
  expect(fold('été')).toBe(fold('été'));
});
