import { expect, test } from 'vitest';
import { combine, CommandError, deleteEverywhere, include, moveNodes } from '../src/commands.ts';
import { checkState, groupOf } from '../src/invariants.ts';
import { applyOp, branchKey, emptyState, placementKey, type State } from '../src/state.ts';

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

// Kept in this file: timed tests run one after the other, not against each other.
/** 20 000 placed nodes and 20 000 connections, written straight into the maps (commands would take minutes). */
function flat(): State {
  const s = emptyState();
  s.plans.set('p', { id: 'p', name: 'P', type: 'plan' });
  for (let i = 0; i < 20_000; i++) {
    const id = `n${i}`;
    s.nodes.set(id, { id, title: id, summary: '', tags: [], files: [] });
    s.placements.set(placementKey('p', id), { plan: 'p', node: id, x: i, y: 0, k: 0 });
  }
  for (let i = 0; i < 20_000; i++) {
    const id = `c${i}`, a = `n${i}`, b = `n${(i + 1) % 20_000}`;
    s.connections.set(id, { id, kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] });
    s.branches.add(branchKey({ plan: 'p', connection: id, node: a }));
    s.branches.add(branchKey({ plan: 'p', connection: id, node: b }));
  }
  return s;
}

test('une action composée de 300 étapes sur 20 000 nœuds ne copie pas l’état à chaque étape (C2 de la relecture 3b)', () => {
  const s = flat();
  const t0 = performance.now();
  const a = combine(s, 'Coller', Array.from({ length: 300 }, (_, i) => (x: State) => moveNodes(x, 'p', [{ node: `n${i}`, x: -i }])));
  expect(performance.now() - t0).toBeLessThan(600);
  expect(a.ops).toHaveLength(300);
  expect(s.placements.get(placementKey('p', 'n5'))!.x).toBe(5); // the state received is untouched
  for (const op of a.ops) applyOp(s, op);
  expect(s.placements.get(placementKey('p', 'n5'))!.x).toBe(-5);
});

test('une règle violée par l’ensemble des étapes est refusée, avec le message du socle', () => {
  const s = flat();
  // Each inclusion is fine alone; together they make a loop.
  expect(() => combine(s, 'Boucle', [(x) => include(x, 'p', 'n1', 'n2'), (x) => include(x, 'p', 'n2', 'n1')])).toThrow(CommandError);
  expect(groupOf(s, 'p', 'n1')).toBeUndefined();
});
