import { buildLargeState, forceGc } from '@cirrus/fixtures';
import { expect, test } from 'vitest';
import {
  type Action, combine, CommandError, connect, createNode, createPlan, deleteEverywhere, editNode, exclude, include, moveNodes, placeNode,
} from '../src/commands.ts';
import { UndoStack } from '../src/history.ts';
import { groupOf } from '../src/invariants.ts';
import { applyOp, applyOps, dataOf, directGroup, emptyState, groupMembers, nodeId, placementOf, planRow, reindex, type State } from '../src/state.ts';

// Timed tests run one after the other in this file, not against each other.
/** 20 000 placed nodes and 20 000 connections, written by raw operations (commands would take minutes). */
function flat(): State {
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'P', type: 'plan' } });
  for (let i = 0; i < 20_000; i++) {
    const id = `n${i}`;
    applyOp(s, { t: 'node', before: null, after: { id, title: id, summary: '', tags: [], files: [] } });
    applyOp(s, { t: 'placement', before: null, after: { plan: 'p', node: id, x: i, y: 0, k: 0 } });
  }
  for (let i = 0; i < 20_000; i++) {
    const id = `c${i}`, a = `n${i}`, b = `n${(i + 1) % 20_000}`;
    applyOp(s, { t: 'connection', before: null, after: { id, kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] } });
    for (const node of [a, b]) applyOp(s, { t: 'branch', key: { plan: 'p', connection: id, node }, before: false, after: true });
  }
  return s;
}

test('une action composée de 300 étapes sur 20 000 nœuds ne copie pas l’état à chaque étape (C2 de la relecture 3b)', () => {
  const s = flat();
  const t0 = performance.now();
  const a = combine(s, 'Coller', Array.from({ length: 300 }, (_, i) => (x: State) => moveNodes(x, 'p', [{ node: `n${i}`, x: -i }])));
  expect(performance.now() - t0).toBeLessThan(600);
  expect(a.ops).toHaveLength(300);
  expect(placementOf(s, 'p', 'n5')!.x).toBe(5); // the state received is untouched
  for (const op of a.ops) applyOp(s, op);
  expect(placementOf(s, 'p', 'n5')!.x).toBe(-5);
});

test('une règle violée par l’ensemble des étapes est refusée, avec le message du socle', () => {
  const s = flat();
  // Each inclusion is fine alone; together they make a loop.
  expect(() => combine(s, 'Boucle', [(x) => include(x, 'p', 'n1', 'n2'), (x) => include(x, 'p', 'n2', 'n1')])).toThrow(CommandError);
  expect(groupOf(s, 'p', 'n1')).toBeUndefined();
});

/**
 * Step 0 of plan 3c (registry): the object model's state for the reference base, its identifiers flat and shared by
 * every reference — the smallest of the three measures (939.5 MB as built then, 573.6 MB after a JSON round trip).
 */
const STEP0_BYTES = 492.0e6;
/** The JS heap and the typed arrays' buffers, after two full collections. */
const memory = () => { forceGc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };

test('base de référence : l’état en colonnes tient en 45 % du Step 0, et reindex en 300 ms au plus', () => {
  const before = memory();
  const { state } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
  expect(memory() - before).toBeLessThan(0.45 * STEP0_BYTES);
  const t = performance.now();
  reindex(state);
  expect(performance.now() - t).toBeLessThan(300);
  expect(state.connections.size).toBe(549_189);
}, 120_000);

/**
 * The best of seven runs, after two to warm up: a command leaves the state as it found it, so each run does the same
 * work, and whatever else the machine does only adds to it (a cost that grew with the base would show in every run).
 */
function cost<T>(fn: () => T): { ms: number; out: T } {
  let out = fn();
  out = fn();
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    out = fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, out };
}

test('base de référence : une commande coûte ce qu’elle touche, appliquée sur place puis défaite, pas la taille de la base', () => {
  const { state: s, lobby } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
  const T = dataOf(s).tables, I = dataOf(s).index, p = planRow(s, lobby);
  // Two leaves in different groups, and the node whose number of connections is nearest 500.
  let leaf = -1, far = -1, hub = -1;
  for (let n = 0; n < T.nodes.rows.end; n++) {
    const g = directGroup(s, p, n);
    if (g >= 0 && groupMembers(s, p, n).length === 0) {
      if (leaf < 0) leaf = n;
      else if (far < 0 && g !== directGroup(s, p, leaf)) far = n;
    }
    if (hub < 0 || Math.abs(I.memberOf.len[n] - 500) < Math.abs(I.memberOf.len[hub] - 500)) hub = n;
  }
  expect(Math.abs(I.memberOf.len[hub] - 500)).toBeLessThan(10);
  const node = nodeId(s, leaf), other = nodeId(s, far), group = nodeId(s, directGroup(s, p, far));
  const books = () => [T.nodes.count, T.conns.count, T.conns.branchCount, T.plans.placementCount, s.phantoms.size, I.memberOf.len[hub], groupOf(s, lobby, node)];
  const before = books(), rec = s.nodes.get(node), at = placementOf(s, lobby, node);
  const costs: Record<string, { ms: number; out: Action }> = {
    moveNodes: cost(() => moveNodes(s, lobby, [{ node, x: 1, y: 2 }])),
    editNode: cost(() => editNode(s, node, { title: 'renommé' })),
    createNode: cost(() => createNode(s, { plan: lobby, title: 'nouveau', x: 0, y: 0, k: 0 })),
    connect: cost(() => connect(s, { plan: lobby, members: [{ node, role: 'source' }, { node: other, role: 'target' }] })),
    include: cost(() => include(s, lobby, node, group)),
    exclude: cost(() => exclude(s, lobby, node)),
  };
  for (const [name, c] of Object.entries(costs)) expect(c.ms, name).toBeLessThanOrEqual(2);
  const removal = cost(() => deleteEverywhere(s, nodeId(s, hub)));
  expect(removal.ms).toBeLessThanOrEqual(10);
  expect(removal.out.ops.length).toBeGreaterThan(1000);
  expect(books()).toEqual(before);
  expect([s.nodes.get(node), placementOf(s, lobby, node)]).toEqual([rec, at]);
  // Fifty nodes pasted into a second plan, as one action.
  const second = createPlan(s, 'Second', 'plan');
  applyOps(s, second.ops);
  const plan = (second.ops[0] as { after: { id: string } }).after.id, fifty = Array.from({ length: 50 }, (_, i) => nodeId(s, 997 * i));
  const paste = cost(() => combine(s, 'Coller', fifty.map((n, i) => (x: State) => placeNode(x, plan, n, i, 0, 0))));
  expect(paste.ms).toBeLessThanOrEqual(10);
  expect(paste.out.ops).toHaveLength(50);
  // The undo of an inclusion, tried before it is written.
  const stack = new UndoStack();
  applyOps(s, costs.include.out.ops);
  stack.record(costs.include.out);
  const undo = cost(() => stack.prepareUndo(s));
  expect(undo.ms).toBeLessThanOrEqual(2);
  expect(groupOf(s, lobby, node)).toBe(group);
  // The values measured, for the registry: CIRRUS_COSTS=1 npx vitest run tests/scale.test.ts --silent=false
  if (process.env.CIRRUS_COSTS) {
    const ms = (x: number) => x.toFixed(3);
    console.log(Object.entries({ ...costs, deleteEverywhere: removal, combine50: paste, undoDryRun: undo }).map(([k, c]) => `${k} ${ms(c.ms)} ms (${c.out!.ops.length} op.)`).join('\n'));
  }
}, 120_000);
