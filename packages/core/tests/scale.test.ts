import { expect, test } from 'vitest';
import { deleteEverywhere, include, moveNodes } from '../src/commands.ts';
import { checkState } from '../src/invariants.ts';
import { applyOp, emptyState, type State } from '../src/state.ts';

/** One plan, 10 000 nodes in 100 groups, 50 000 knowledge connections: the scale the spec aims at. */
function large(): State {
  const N = 10_000, C = 50_000;
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'Lobby', type: 'lobby' } });
  for (let i = 0; i < N; i++) {
    applyOp(s, { t: 'node', before: null, after: { id: `n${i}`, title: `n${i}`, summary: '', tags: [], files: [] } });
    applyOp(s, { t: 'placement', before: null, after: { plan: 'p', node: `n${i}`, x: 0, y: 0, k: 0 } });
  }
  const link = (id: string, kind: 'inclusion' | 'knowledge', a: string, b: string) => {
    applyOp(s, { t: 'connection', before: null, after: { id, kind, title: '', relation: '', tags: [], members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] } });
    for (const node of [a, b]) applyOp(s, { t: 'branch', key: { plan: 'p', connection: id, node }, before: false, after: true });
  };
  for (let i = 100; i < N; i++) link(`inc${i}`, 'inclusion', `n${i}`, `n${i % 100}`);
  for (let i = 0; i < C; i++) {
    const a = `n${(i * 7919) % N}`, b = `n${(i * 104729 + 1) % N}`;
    if (a !== b) link(`c${i}`, 'knowledge', a, b);
  }
  // A hub: one node with 500 connections.
  applyOp(s, { t: 'node', before: null, after: { id: 'hub', title: 'hub', summary: '', tags: [], files: [] } });
  applyOp(s, { t: 'placement', before: null, after: { plan: 'p', node: 'hub', x: 0, y: 0, k: 0 } });
  for (let i = 0; i < 500; i++) link(`h${i}`, 'knowledge', 'hub', `n${i * 7 + 1}`);
  return s;
}

test('une commande reste rapide sur une grande base', () => {
  const s = large();
  expect(checkState(s)).toEqual([]);
  let t = performance.now();
  moveNodes(s, 'p', [{ node: 'n500', x: 1, y: 1 }]);
  expect(performance.now() - t).toBeLessThan(300);
  t = performance.now();
  include(s, 'p', 'n5000', 'n3');
  expect(performance.now() - t).toBeLessThan(300);
  t = performance.now();
  deleteEverywhere(s, 'hub');
  expect(performance.now() - t).toBeLessThan(300);
}, 120_000);
