import { applyOp, emptyState, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { buildFrame } from '../src/frame.ts';
import { buildHitIndex } from '../src/hit.ts';
import { buildScene } from '../src/scene.ts';
import { buildIndex, computeVisible } from '../src/visibility.ts';
import { measure, P } from './helpers.ts';

/** One plan, 10 000 nodes in 100 groups laid out on a grid, 50 000 local knowledge connections. */
function large(): State {
  const N = 10_000, G = 100, C = 50_000;
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'Lobby', type: 'lobby' } });
  const node = (id: string, x: number, y: number, k: number) => {
    applyOp(s, { t: 'node', before: null, after: { id, title: `Nœud ${id}`, summary: '', tags: [], files: [] } });
    applyOp(s, { t: 'placement', before: null, after: { plan: 'p', node: id, x, y, k } });
  };
  const link = (id: string, kind: 'inclusion' | 'knowledge', a: string, b: string) => {
    applyOp(s, { t: 'connection', before: null, after: { id, kind, title: '', relation: '', tags: [], members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] } });
    for (const n of [a, b]) applyOp(s, { t: 'branch', key: { plan: 'p', connection: id, node: n }, before: false, after: true });
  };
  // Group g sits in a 10×10 grid of cells 4000 wide; its 99 members on a 10×10 grid inside the cell.
  for (let g = 0; g < G; g++) node(`n${g}`, (g % 10) * 4000, Math.floor(g / 10) * 4000, 2);
  for (let i = G; i < N; i++) {
    const g = i % G, j = Math.floor(i / G);
    node(`n${i}`, (g % 10) * 4000 + (j % 10) * 300, Math.floor(g / 10) * 4000 + Math.floor(j / 10) * 300, 0);
    link(`inc${i}`, 'inclusion', `n${i}`, `n${g}`);
  }
  for (let i = 0; i < C; i++) {
    const a = G + (i * 7919) % (N - G);
    const b = (i % 5 === 0) ? G + (i * 104729 + 1) % (N - G) : G + ((a - G + G * (1 + (i % 3))) % (N - G));
    if (a !== b) link(`c${i}`, 'knowledge', `n${a}`, `n${b}`);
  }
  return s;
}

test('grande base : scène, index, visibilité, cadre et survol rapides (10 000 nœuds, 50 000 connexions)', () => {
  const s = large();
  let t = performance.now();
  const scene = buildScene(s, 'p', measure, P);
  const index = buildIndex(scene, P);
  const sceneMs = performance.now() - t;
  expect(scene.items).toHaveLength(10_000);
  for (const [zoom, x, y] of [[0.02, 18000, 18000], [0.3, 18000, 18000], [1, 4000, 4000]] as const) {
    const cam = { x, y, zoom, widthPx: 2560, heightPx: 1600 };
    t = performance.now();
    const visible = computeVisible(scene, index, cam, P);
    const frame = buildFrame(scene, visible, cam, { x, y }, P);
    buildHitIndex(scene, visible, frame, { x, y }, P);
    const frameMs = performance.now() - t;
    expect(frameMs, `zoom ${zoom}: ${visible.connections.length} connexions visibles`).toBeLessThan(400);
  }
  expect(sceneMs).toBeLessThan(1500);
}, 120_000);
