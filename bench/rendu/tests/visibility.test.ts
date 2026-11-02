import { test, expect } from 'vitest';
import { textPx, isGroupOpen } from '../src/scene/lod';
import { buildIndex, computeVisible, lowestCommonGroup } from '../src/scene/visibility';
import { generateScene } from '../src/scene/generate';
import { BENCH_SCENE, DEFAULT_PARAMS } from '../src/scene/params';
import type { Camera, Scene } from '../src/scene/types';

// G (step 2) holds A and B (step 0); C is a free node (step 0).
const G = 0, A = 1, B = 2, C = 3;
const scene: Scene = {
  nodes: [
    { id: G, x: 0, y: 0, k: 2, parent: -1, r: 500, title: 'G' },
    { id: A, x: -200, y: 0, k: 0, parent: G, r: 0, title: 'A' },
    { id: B, x: 200, y: 0, k: 0, parent: G, r: 0, title: 'B' },
    { id: C, x: 1000, y: 0, k: 0, parent: -1, r: 0, title: 'C' },
  ],
  connections: [
    { id: 0, members: [{ node: A, role: 'source' }, { node: B, role: 'target' }] },
    { id: 1, members: [{ node: A, role: 'source' }, { node: C, role: 'target' }] },
    { id: 2, members: [{ node: B, role: 'source' }, { node: C, role: 'target' }] },
  ],
  children: [[A, B], [], [], []],
};

const camAtZoom = (zoom: number): Camera => ({ x: 0, y: 0, zoom, widthPx: 2560, heightPx: 1600 });

function overviewCamera(s: Scene): Camera {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of s.nodes) {
    if (n.parent >= 0) continue;
    const r = Math.max(n.r, 105 * 2 ** n.k);
    minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
    minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
  }
  const zoom = Math.min(2560 / (maxX - minX), 1600 / (maxY - minY));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, widthPx: 2560, heightPx: 1600 };
}

test('textPx suit la formule de la spec', () => {
  expect(textPx(0, 1, DEFAULT_PARAMS)).toBe(16);
  expect(textPx(3, 0.5, DEFAULT_PARAMS)).toBe(64);
});

test('un groupe est fermé quand le texte de ses membres passe sous 4,5 px', () => {
  expect(isGroupOpen(scene, G, 4 / 16, DEFAULT_PARAMS)).toBe(false); // membres à 4 px
  expect(isGroupOpen(scene, G, 5 / 16, DEFAULT_PARAMS)).toBe(true); // membres à 5 px
});

test('groupe fermé : membres non dessinés, connexion interne masquée', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(4 / 16), DEFAULT_PARAMS);
  expect(v.closedGroups).toContain(G);
  expect(v.nodes).not.toContain(A);
  expect(v.connections.flatMap((c) => c.ids)).not.toContain(0);
});

test('extrémité redirigée vers le groupe fermé, branche évidée', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(4 / 16), DEFAULT_PARAMS);
  const c = v.connections.find((c) => c.ids.includes(1))!;
  expect(c.branches.find((b) => b.node === G)!.hollow).toBe(true);
});

test('A→C et B→C agrégées une fois redirigées vers G', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(4 / 16), DEFAULT_PARAMS);
  expect(v.connections.find((c) => c.ids.includes(1))!.ids.sort()).toEqual([1, 2]);
});

test('groupe ouvert : membres dessinés, rien de redirigé', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(1), DEFAULT_PARAMS);
  expect(v.nodes).toEqual(expect.arrayContaining([A, B, C]));
  expect(v.connections.every((c) => c.branches.every((b) => !b.hollow))).toBe(true);
});

test('hors de la vue et de sa marge : non dessiné', () => {
  const v = computeVisible(scene, buildIndex(scene), { ...camAtZoom(1), x: 1e7 }, DEFAULT_PARAMS);
  expect(v.nodes).toHaveLength(0);
});

test('connexion sans aucune extrémité à l\'écran masquée, même si elle traverse l\'écran', () => {
  // Deux nœuds libres de part et d'autre de la vue, hors vue et hors marge ; la connexion traverse l'écran.
  const far: Scene = {
    nodes: [
      { id: 0, x: -5000, y: 0, k: 0, parent: -1, r: 0, title: 'L' },
      { id: 1, x: 5000, y: 0, k: 0, parent: -1, r: 0, title: 'R' },
    ],
    connections: [{ id: 0, members: [{ node: 0, role: 'source' }, { node: 1, role: 'target' }] }],
    children: [[], []],
  };
  const v = computeVisible(far, buildIndex(far), camAtZoom(1), DEFAULT_PARAMS);
  expect(v.connections).toHaveLength(0);
});

test('une extrémité dans la marge suffit à garder la connexion', () => {
  // Bord droit de l'écran à x = 1280 ; marge 200 px ; demi-boîte 105 : le nœud en 1500 touche la marge.
  const near: Scene = {
    nodes: [
      { id: 0, x: -5000, y: 0, k: 0, parent: -1, r: 0, title: 'L' },
      { id: 1, x: 1500, y: 0, k: 0, parent: -1, r: 0, title: 'R' },
    ],
    connections: [{ id: 0, members: [{ node: 0, role: 'source' }, { node: 1, role: 'target' }] }],
    children: [[], []],
  };
  const v = computeVisible(near, buildIndex(near), camAtZoom(1), DEFAULT_PARAMS);
  expect(v.connections).toHaveLength(1);
});

test('connexion en amorces : signalée, et jamais agrégée avec une connexion complète', () => {
  const s: Scene = {
    ...scene,
    connections: [
      { id: 0, members: [{ node: A, role: 'source' }, { node: C, role: 'target' }] },
      { id: 1, members: [{ node: A, role: 'source' }, { node: C, role: 'target' }], display: 'stubs' },
    ],
  };
  const v = computeVisible(s, buildIndex(s), camAtZoom(1), DEFAULT_PARAMS);
  expect(v.connections).toHaveLength(2);
  expect(v.connections.find((c) => c.ids.includes(1))!.stubs).toBe(true);
  expect(v.connections.find((c) => c.ids.includes(0))!.stubs).toBeFalsy();
});

test('plus bas groupe commun', () => {
  expect(lowestCommonGroup(scene, [A, B])).toBe(G);
  expect(lowestCommonGroup(scene, [A, C])).toBe(-1);
});

test("scène du banc : calcul en moins de 50 ms vue d'ensemble", () => {
  const s = generateScene(BENCH_SCENE, DEFAULT_PARAMS);
  const idx = buildIndex(s);
  // Best of three: the criterion is the cost of the computation, not scheduler noise from other processes.
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    computeVisible(s, idx, overviewCamera(s), DEFAULT_PARAMS);
    best = Math.min(best, performance.now() - t0);
  }
  expect(best).toBeLessThan(50);
}, 60_000);
