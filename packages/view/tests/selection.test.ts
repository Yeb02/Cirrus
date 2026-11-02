import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { emptySelection, inRectangle, selectionCenter, toggle } from '../src/selection.ts';
import { fixture, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
});
const box = (id: string, pad = 1) => {
  const it = sc.items[sc.byId.get(id)!];
  if (it.kind === 'group') {
    const poly = offsetPolygon(it.hull!, it.pad!);
    return { minX: Math.min(...poly.map((q) => q.x)) - pad, minY: Math.min(...poly.map((q) => q.y)) - pad, maxX: Math.max(...poly.map((q) => q.x)) + pad, maxY: Math.max(...poly.map((q) => q.y)) + pad };
  }
  return { minX: it.x - pad, minY: it.y - pad, maxX: it.x + pad, maxY: it.y + pad };
};

test('Ctrl+clic ajoute puis retire', () => {
  let sel = toggle(emptySelection(), { kind: 'item', id: 'a' });
  sel = toggle(sel, { kind: 'connection', id: 'c' });
  expect([...sel.items]).toEqual(['a']);
  expect([...sel.connections]).toEqual(['c']);
  sel = toggle(sel, { kind: 'item', id: 'a' });
  expect(sel.items.size).toBe(0);
});

test('un élément est pris si son centre est dans le rectangle (spec 9.3)', () => {
  expect(inRectangle(sc, box(ids.nodes.monde), 1, P)).toEqual([ids.nodes.monde]);
});

test('groupe ouvert : pris si et seulement si tous ses membres le sont', () => {
  const all = inRectangle(sc, box(ids.nodes.groupeML), 1, P);
  expect(all).toContain(ids.nodes.groupeML);
  expect(all).toContain(ids.nodes.biais);
  const one = inRectangle(sc, box(ids.nodes.biais), 1, P);
  expect(one).toEqual([ids.nodes.biais]);
});

test('groupe replié : pris entier ou pas du tout, sans ses membres un à un', () => {
  const zoom = 3 / P.baseFontPx; // members' text at 3 px: Généralisation (members at step 0) is closed
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!];
  const around = { minX: g.x - 1, minY: g.y - 1, maxX: g.x + 1, maxY: g.y + 1 };
  expect(inRectangle(sc, around, zoom, P)).toEqual([ids.nodes.groupeML]);
  expect(inRectangle(sc, box(ids.nodes.biais), zoom, P)).toEqual([]);
});

test('centre de la sélection : le barycentre', () => {
  const a = sc.items[sc.byId.get(ids.nodes.monde)!], b = sc.items[sc.byId.get(ids.nodes.universalite)!];
  const c = selectionCenter(sc, { items: new Set([ids.nodes.monde, ids.nodes.universalite]), connections: new Set() })!;
  expect(c.x).toBeCloseTo((a.x + b.x) / 2, 9);
  expect(selectionCenter(sc, emptySelection())).toBeNull();
});
