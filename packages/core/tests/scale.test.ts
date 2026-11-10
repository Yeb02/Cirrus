import { buildLargeState, forceGc } from '@cirrus/fixtures';
import { expect, test } from 'vitest';
import {
  type Action, combine, CommandError, connect, createNode, createPlan, deleteEverywhere, editNode, exclude, include, moveNodes, placeNode, transact, trashedItems,
} from '../src/commands.ts';
import { decodeState, encodeState } from '../src/codec.ts';
import { UndoStack } from '../src/history.ts';
import { groupOf } from '../src/invariants.ts';
import type { TagKeyDef } from '../src/model.ts';
import {
  applyOp, applyOps, connId, dataOf, directGroup, emptyState, groupMembers, nodeId, placementOf, planId, planRow, reindex, type State,
} from '../src/state.ts';
import { KNOWLEDGE } from '../src/tables.ts';

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
  // An enumeration tag carried by a thousand nodes, for an edit of its key.
  const def: TagKeyDef = { key: 'pertinence', type: 'enum', scope: 'both', multi: false, required: false, enumValues: [{ name: 'faible', rank: 1 }, { name: 'forte', rank: 2 }] };
  applyOp(s, { t: 'tagKey', before: null, after: def });
  for (let n = 0; n < 1000; n++) {
    const r = s.nodes.get(nodeId(s, 50 * n))!;
    applyOp(s, { t: 'node', before: r, after: { ...r, tags: [{ key: 'pertinence', value: 'forte' }] } });
  }
  const books = () => [T.nodes.count, T.conns.count, T.conns.branchCount, T.plans.placementCount, s.phantoms.size, I.memberOf.len[hub], groupOf(s, lobby, node)];
  const before = books(), rec = s.nodes.get(node), at = placementOf(s, lobby, node);
  const costs: Record<string, { ms: number; out: Action }> = {
    moveNodes: cost(() => moveNodes(s, lobby, [{ node, x: 1, y: 2 }])),
    editNode: cost(() => editNode(s, node, { title: 'renommé' })),
    createNode: cost(() => createNode(s, { plan: lobby, title: 'nouveau', x: 0, y: 0, k: 0 })),
    connect: cost(() => connect(s, { plan: lobby, members: [{ node, role: 'source' }, { node: other, role: 'target' }] })),
    include: cost(() => include(s, lobby, node, group)),
    exclude: cost(() => exclude(s, lobby, node)),
    createPlan: cost(() => createPlan(s, 'Nouveau', 'plan')),
    tagKey: cost(() => transact(s, (d) => {
      d.push({ t: 'tagKey', before: def, after: { ...def, enumValues: [...def.enumValues!, { name: 'centrale', rank: 3 }] } });
      return d.finish('Modifier le tag « pertinence »');
    })),
  };
  for (const [name, c] of Object.entries(costs)) expect(c.ms, name).toBeLessThanOrEqual(2);
  // The plan aims at 10 ms (met at ≈ 5 ms on a quiet machine); the gate is three times that measure (R12, registry).
  const removal = cost(() => deleteEverywhere(s, nodeId(s, hub)));
  expect(removal.ms).toBeLessThanOrEqual(15);
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

/**
 * The plan aims at 300 ms to encode and 250 ms to decode; measured on a machine shared with a CPU-heavy program, 230–265
 * and 292–361 ms. The gates are three times the best measure (global constraints, as R12): see the registry, task 4.
 */
const ENCODE_CEILING_MS = 700, DECODE_CEILING_MS = 900;
/** The first lookup by identifier after decoding builds the three identifier maps: 237–336 ms measured, gate three times the best. */
const FIRST_LOOKUP_CEILING_MS = 750;

test('base de référence : l’instantané binaire s’encode et se décode d’un trait (cibles 300 et 250 ms, plafonds à trois fois la mesure)', () => {
  const { state } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
  const encode = cost(() => encodeState(state));
  // Each decode makes a whole state: the best of five after one to warm up, the others collected in between. Then the
  // first lookup by identifier in each table, which builds its identifier map (Rows.restored): the cost decoding leaves.
  let best = Infinity, firstLookup = Infinity, decoded: State | null = null;
  for (let i = 0; i < 6; i++) {
    const buf = encode.out.slice(0);
    decoded = null;
    forceGc();
    const t = performance.now();
    const d = (decoded = decodeState(buf));
    const t1 = performance.now();
    const found = [d.nodes.has(nodeId(d, 7)), d.plans.has(planId(d, 0)), d.connections.has(connId(d, 11))];
    const t2 = performance.now();
    expect(found).toEqual([true, true, true]);
    if (i > 0) { best = Math.min(best, t1 - t); firstLookup = Math.min(firstLookup, t2 - t1); }
  }
  if (process.env.CIRRUS_COSTS) {
    console.log(`encodeState ${encode.ms.toFixed(1)} ms, decodeState ${best.toFixed(1)} ms, première recherche par identifiant ${firstLookup.toFixed(1)} ms, ${(encode.out.byteLength / 1e6).toFixed(1)} Mo`);
  }
  expect(encode.ms).toBeLessThanOrEqual(ENCODE_CEILING_MS);
  expect(best).toBeLessThanOrEqual(DECODE_CEILING_MS);
  expect(firstLookup).toBeLessThanOrEqual(FIRST_LOOKUP_CEILING_MS);
  expect([decoded!.nodes.size, decoded!.connections.size, decoded!.branches.size]).toEqual([state.nodes.size, state.connections.size, state.branches.size]);
}, 180_000);

/** trashedItems on the reference base: 3.5 ms measured, 2 000 objects in the trash (registry, task 4 of plan 6a); the gate three times that. */
const TRASH_CEILING_MS = 10.5;

test('base de référence : trashedItems lit la corbeille en un passage sur les nœuds et les colonnes des connexions (plan 6a, D5)', () => {
  const { state: s } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
  const C = dataOf(s).tables.conns;
  // A thousand nodes and a thousand knowledge connections in the trash, written as raw operations.
  for (let n = 0; n < 1000; n++) {
    const r = s.nodes.get(nodeId(s, 50 * n))!;
    applyOp(s, { t: 'node', before: r, after: { ...r, trashedAt: 1000 + n } });
  }
  let thrown = 0;
  for (let c = 0; c < C.rows.end && thrown < 1000; c += 400) {
    if (C.kind[c] !== KNOWLEDGE) continue;
    const rec = s.connections.get(connId(s, c))!;
    applyOp(s, { t: 'connection', before: rec, after: { ...rec, trashedAt: 3000 + thrown++ } });
  }
  const listed = cost(() => trashedItems(s));
  expect(listed.out).toHaveLength(2000);
  expect([listed.out[0].kind, listed.out[0].at, listed.out[1999].kind]).toEqual(['connection', 3999, 'node']);
  // The value measured, for the registry: CIRRUS_COSTS=1 npx vitest run tests/scale.test.ts --silent=false
  if (process.env.CIRRUS_COSTS) console.log(`trashedItems ${listed.ms.toFixed(2)} ms (${listed.out.length} objets, ${s.nodes.size} nœuds, ${s.connections.size} connexions)`);
  expect(listed.ms).toBeLessThanOrEqual(TRASH_CEILING_MS);
}, 120_000);
