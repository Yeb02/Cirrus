import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { groupPalette } from '../src/color.ts';
import { buildFrame, groupColors } from '../src/frame.ts';
import { buildHitIndex } from '../src/hit.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { placeTitle } from '../src/titles.ts';
import { buildIndex, computeVisible } from '../src/visibility.ts';
import { camAtTextPx, fixture, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
});

const frameAt = (scene: PlanScene, k: number, px: number) => {
  const cam = camAtTextPx(scene, k, px);
  const visible = computeVisible(scene, buildIndex(scene, P), cam, P);
  const origin = { x: cam.x, y: cam.y };
  const frame = buildFrame(scene, visible, cam, origin, P);
  return { cam, visible, origin, frame, hits: buildHitIndex(scene, visible, frame, origin, P) };
};

test('cadre complet sans NaN sur les trois plans de la base de test, à cinq zooms (Review Focus 4, 5)', () => {
  for (const plan of Object.values(ids.plans)) {
    const scene = buildScene(s, plan, measure, P);
    for (const px of [0.5, 3, 5.5, 16, 200]) {
      const { frame } = frameAt(scene, 0, px);
      const all = [
        ...Object.values(frame.connections.ribbons), ...Object.values(frame.connections.glyphs), ...Object.values(frame.envelopes),
      ];
      for (const list of all) expect([...list.view()].every(Number.isFinite)).toBe(true);
    }
  }
});

test('le cadre contient les enveloppes, les rubans, les marqueurs et les titres', () => {
  const { frame, visible } = frameAt(sc, 0, 16);
  expect(frame.envelopes.alpha.length).toBeGreaterThan(0);
  expect(frame.connections.ribbons.position.length).toBeGreaterThan(0);
  expect(frame.markers.some((m) => m.multi)).toBe(true);
  expect(frame.titles.map((t) => t.text)).toContain('Déduction jointe');
  expect(new Set(frame.centerlines.map((c) => c.conn)).size).toBe(visible.connections.length);
});

test('les groupes de premier niveau prennent les teintes dans leur ordre de création, leurs sous-groupes la même', () => {
  const at = (id: string) => sc.byId.get(id)!;
  const hueOf = (g: number) => groupColors(sc, g, P).closed;
  const expected = (depth: number, i: number) => groupPalette({ depth, hue: P.groupHues[i] }, P).closed;
  expect(hueOf(at(ids.nodes.groupeTheorie))).toEqual(expected(0, 0));
  expect(hueOf(at(ids.nodes.groupeML))).toEqual(expected(0, 1));
  expect(hueOf(at(ids.nodes.groupeInduction))).toEqual(expected(2, 0));
});

test('« n connexions » pour une agrégation', () => {
  // Universalité receives MDL (split, far part) and Solomonoff → Universalité; with Complexité et induction closed only
  // the second one reaches it from the group. Aggregation is covered in visibility tests; here: the label text.
  const { frame, visible } = frameAt(sc, 1, 3);
  for (const t of frame.titles) {
    const vc = visible.connections[t.conn];
    if (vc.conns.length > 1) expect(t.text).toBe(`${vc.conns.length} connexions`);
  }
});

test('survol : nœud, connexion, groupe replié, fond d’un groupe ouvert', () => {
  const { frame, origin, hits, cam } = frameAt(sc, 0, 16);
  const mdl = sc.items[sc.byId.get(ids.nodes.mdl)!];
  expect(hits.hit(mdl.x, mdl.y, cam.zoom)).toEqual({ kind: 'item', item: sc.byId.get(ids.nodes.mdl), id: ids.nodes.mdl });
  // A point on a connection's centerline, away from boxes.
  const line = frame.centerlines.find((c) => c.points.length > 6)!;
  const q = line.points[Math.floor(line.points.length / 2)];
  const h = hits.hit(q.x + origin.x, q.y + origin.y, cam.zoom);
  expect(['connection', 'item']).toContain(h.kind);
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
  const { frame, visible } = frameAt(sc, 0, 16);
  const parentK = [...frame.envelopes.parentK.view()];
  const kOfComplexite = sc.items[sc.byId.get(ids.nodes.groupeComplexite)!].maxChildK!;
  expect(parentK).toContain(kOfComplexite); // Induction universelle, inside Complexité et induction
  expect(parentK.some((k) => k > 1e8)).toBe(true); // a top-level group: no parent
  expect(parentK).toHaveLength(frame.envelopes.alpha.length);
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
