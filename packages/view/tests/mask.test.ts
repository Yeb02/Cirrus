import { connect, createNode, createPlan, emptyState, type Id, include, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { envelopeDistance, envelopeEdges, groupEdges, maskAlpha, maskStrength } from '../src/geometry/mask.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { sampleBranch } from '../src/geometry/ribbon.ts';
import { simpleBranches } from '../src/geometry/simple.ts';
import { CURVE_AT, CURVE_FLOATS, isSimple, MASKS, masksOf, SIMPLE_INTS, simpleEnds } from '../src/instances.ts';
import { foldT } from '../src/lod.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import type { VisibleConnection, VisibleEnd } from '../src/visibility.ts';
import { camAtTextPx, created, frameAt, measure, P, run } from './helpers.ts';

// Point 7 of 2026-11-12: a connection keeps its own path to its own nodes; the fill of a group that folds over one of its
// ends is laid over it (a mask), and nothing else changes.

/** A plan: group G of A and B at the left, C alone far to the right; A → C, B → C, and A → B inside G. */
function plan(): { st: State; scene: PlanScene; g: number; a: number; b: number; c: number } {
  const st = emptyState();
  const p = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan: p, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), a = node('A', 0, 0), b = node('B', 0, 400), c = node('C', 3000, 200);
  run(st, include(st, p, a, g));
  run(st, include(st, p, b, g));
  run(st, connect(st, { plan: p, members: [{ node: a, role: 'source' }, { node: c, role: 'target' }], title: 'sort' }));
  run(st, connect(st, { plan: p, members: [{ node: b, role: 'source' }, { node: c, role: 'target' }] }));
  run(st, connect(st, { plan: p, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] }));
  const scene = buildScene(st, p, measure, P);
  const at = (id: Id) => scene.byId.get(id)!;
  return { st, scene, g: at(g), a: at(a), b: at(b), c: at(c) };
}

test('l’enveloppe en arêtes : distance signée négative dedans, nulle au bord, positive dehors', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  for (const poly of [square, [...square].reverse()]) {
    const e: number[] = [];
    expect(envelopeEdges(poly, 0, 0, e)).toBe(4);
    expect(envelopeDistance(e, 0, 4, 5, 5)).toBeCloseTo(-5, 12);
    expect(envelopeDistance(e, 0, 4, 10, 3)).toBeCloseTo(0, 12);
    expect(envelopeDistance(e, 0, 4, 13, 5)).toBeCloseTo(3, 12);
  }
  // Relative to an origin, as the texture holds them.
  const e: number[] = [];
  envelopeEdges(square, 100, 100, e);
  expect(envelopeDistance(e, 0, 4, -95, -95)).toBeCloseTo(-5, 12);
  expect(envelopeDistance([], 0, 0, 0, 0)).toBe(Infinity);
});

test('le masque : effacé dans un groupe fermé, entier loin de lui, à mi-chemin dans sa plume ; il monte avec le repli', () => {
  const { scene, g } = plan(), it = scene.items[g];
  const closed = camAtTextPx(scene, 0, 3).zoom, fading = camAtTextPx(scene, 0, 7).zoom, open = camAtTextPx(scene, 0, 16).zoom;
  expect(maskStrength(scene, g, closed, P)).toBe(1);
  expect(maskStrength(scene, g, open, P)).toBe(0);
  expect(maskStrength(scene, g, fading, P)).toBeCloseTo(foldT(it.maxChildK!, fading, P), 12);
  expect(maskAlpha(scene, [g, -1, -1, -1], it.x, it.y, closed, P)).toBe(0);
  expect(maskAlpha(scene, [g], it.x, it.y, fading, P)).toBeCloseTo(1 - foldT(it.maxChildK!, fading, P), 12);
  expect(maskAlpha(scene, [g], it.x + 1e6, it.y, closed, P)).toBe(1);
  expect(maskAlpha(scene, [-1, -1], it.x, it.y, closed, P)).toBe(1);
  // Half the closed feather out of the padded envelope's rightmost vertex, straight out: half covered.
  const poly = offsetPolygon(it.hull!, it.pad!), right = poly.reduce((m, q) => (q.x > m.x ? q : m));
  const edges: number[] = [], n = groupEdges(scene, g, { x: 0, y: 0 }, edges);
  let x = right.x;
  while (envelopeDistance(edges, 0, n, x, right.y) * closed < P.featherClosedPx / 2) x += 0.01 / closed;
  expect(maskAlpha(scene, [g], x, right.y, closed, P)).toBeCloseTo(0.5, 1);
});

test('replié : une connexion vers un nœud caché reste simple, tracée jusqu’à lui, masquée par le groupe et lui seul', () => {
  const { scene, g, a, b, c } = plan();
  const { visible, inst } = frameAt(scene, 0, 3);
  expect(visible.items).not.toContain(a);
  expect(visible.groups).toContain(g);
  const s = inst.simple.view(), rows: number[][] = [];
  for (let o = 0; o < s.length; o += SIMPLE_INTS) rows.push([...s.subarray(o, o + SIMPLE_INTS)]);
  // A → C and B → C: two lines (no merging), each from its own node; A → B, internal to the closed group, is not drawn.
  expect(rows.map((r) => r[0]).sort()).toEqual([a, b].sort());
  expect(rows.every((r) => r[1] === c && r[4] === -1)).toBe(true);
  expect(rows.every((r) => r.slice(5, 5 + MASKS).join() === [g, -1, -1, -1].join())).toBe(true);
  expect(visible.connections.every((vc) => isSimple(scene, vc))).toBe(true);
});

test('en repli : rien ne glisse, la connexion interne s’efface avec son groupe et n’est masquée par rien', () => {
  const { scene, g, a, b } = plan();
  const { visible, inst } = frameAt(scene, 0, 7);
  const s = inst.simple.view();
  let internal = 0;
  for (let o = 0; o < s.length; o += SIMPLE_INTS) {
    const vc = visible.connections[s[o + 3]];
    if (s[o] === a && s[o + 1] === b) {
      internal++;
      expect(s[o + 4]).toBe(g);
      expect([...s.subarray(o + 5, o + 9)]).toEqual([-1, -1, -1, -1]);
    } else expect(vc.ends[0].mask).toBe(g);
  }
  expect(internal).toBe(1);
});

/** A visible connection made by hand: its ends' masks. */
const vcOf = (masks: [number, number][]): VisibleConnection => ({
  part: 0, stubs: [], fade: -1,
  ends: masks.map(([mask, mask2], i): VisibleEnd => ({ item: 100 + i, role: i === 0 ? 'target' : 'source', key: `n${i}`, dashed: false, mask, mask2 })),
});
const masks = (vc: VisibleConnection, own: number) => { const out: number[] = []; masksOf(vc, own, out, 0); return out; };

test('au plus quatre masques par courbe : ceux de son bout d’abord, puis le plus haut groupe des autres, puis leurs seconds', () => {
  // Three members, each in a closed group within a folding one: six groups for four places.
  const vc = vcOf([[10, 11], [20, 21], [30, 31]]);
  expect(masks(vc, 0)).toEqual([10, 11, 20, 30]);
  expect(masks(vc, 1)).toEqual([20, 21, 10, 30]);
  expect(masks(vc, 2)).toEqual([30, 31, 10, 20]);
  // A trunk (or a marker): every end's highest group first.
  expect(masks(vc, -1)).toEqual([10, 20, 30, 11]);
  // Five members in five groups: each branch keeps its own end's group.
  const five = vcOf([[1, -1], [2, -1], [3, -1], [4, -1], [5, -1]]);
  for (let i = 0; i < 5; i++) expect(masks(five, i)[0]).toBe(i + 1);
  // Shared groups count once; none: −1.
  expect(masks(vcOf([[7, -1], [7, -1]]), -1)).toEqual([7, -1, -1, -1]);
  expect(masks(vcOf([[-1, -1], [-1, -1]]), 0)).toEqual([-1, -1, -1, -1]);
});

test('faisceau complexe replié : chaque branche porte le groupe de son bout, le tronc ceux de tous', () => {
  const st = emptyState();
  const p = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan: p, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), h = node('H', 0, 3000), a = node('A', 0, 0), b = node('B', 0, 3000), c = node('C', 3000, 1500);
  run(st, include(st, p, a, g));
  run(st, include(st, p, b, h));
  run(st, connect(st, { plan: p, members: [{ node: a, role: 'source' }, { node: b, role: 'source' }, { node: c, role: 'target' }] }));
  const scene = buildScene(st, p, measure, P), G = scene.byId.get(g)!, H = scene.byId.get(h)!;
  const { inst } = frameAt(scene, 0, 3);
  const cv = inst.curves.view(), byKey = new Map<string | null, number[]>();
  for (let j = 0; j < cv.length / CURVE_FLOATS; j++) byKey.set(inst.curveKeys[j], [...cv.subarray(j * CURVE_FLOATS + CURVE_AT.masks, j * CURVE_FLOATS + CURVE_AT.masks + MASKS)]);
  expect(byKey.get(a)).toEqual([G, H, -1, -1]);
  expect(byKey.get(b)).toEqual([H, G, -1, -1]);
  expect(byKey.get(c)).toEqual([G, H, -1, -1]);
  expect(byKey.get(null)).toEqual([G, H, -1, -1]);
  // Its glyphs: an arrow per branch, masked as its branch.
  const gm = [...inst.glyphs.masks.view()];
  expect(gm.length).toBe(4 * inst.glyphs.scale.length);
  expect(new Set(gm.filter((x) => x >= 0))).toEqual(new Set([G, H]));
});

test('clics (point 7) : sur la partie masquée par un fond opaque, le groupe ; sur la partie visible, la connexion', () => {
  const { scene, g, a, c } = plan();
  const { visible, hits, cam } = frameAt(scene, 0, 3);
  const ci = visible.connections.findIndex((vc) => vc.ends[0].item === a && vc.ends[1].item === c);
  const [ea, eb] = simpleEnds(scene, visible.connections[ci], { x: 0, y: 0 });
  const branch = simpleBranches(ea, eb, P).find((x) => x.key === scene.items[a].node)!;
  const pts = sampleBranch(branch, 64), edges: number[] = [], n = groupEdges(scene, g, { x: 0, y: 0 }, edges);
  const inside = pts.find((q) => envelopeDistance(edges, 0, n, q.x, q.y) < -1 / cam.zoom)!;
  const outside = pts.find((q) => envelopeDistance(edges, 0, n, q.x, q.y) > 20 / cam.zoom)!;
  expect(maskAlpha(scene, [g], inside.x, inside.y, cam.zoom, P)).toBe(0);
  expect(hits.hit(inside.x, inside.y, cam.zoom)).toMatchObject({ kind: 'item', item: g });
  expect(maskAlpha(scene, [g], outside.x, outside.y, cam.zoom, P)).toBe(1);
  expect(hits.hit(outside.x, outside.y, cam.zoom)).toMatchObject({ kind: 'connection', conn: ci, id: scene.ids[visible.connections[ci].part] });
});
