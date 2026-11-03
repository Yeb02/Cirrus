import { expect, test } from 'vitest';
import {
  type Action, addMember, combine, CommandError, connect, createNode, createPlan, deleteConnection, deleteEverywhere, editConnection, editNode, exclude,
  include, joinArm, moveNodes, movePhantom, placeAbsent, placeNode, removeFromPlan, removeMember, restoreNode, setBranches, setLayout, setRole, splitArm,
  transact,
} from '../src/commands.ts';
import { UndoConflictError, UndoStack } from '../src/history.ts';
import type { Id, PlanType } from '../src/model.ts';
import type { Op } from '../src/ops.ts';
import { toSnapshot } from '../src/snapshot.ts';
import { applyOp, applyOps, canonical, dataOf, emptyState, placementOf, type State } from '../src/state.ts';

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const created = (a: Action, t: 'node' | 'connection' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();

/**
 * The content of a state, its indices and the references held to each row, in identifier terms and sorted: equal for
 * two states that hold the same thing, whatever rows and list orders they use.
 */
function image(s: State): string {
  const x = toSnapshot(s), T = dataOf(s).tables, I = dataOf(s).index;
  const nid = (r: number) => T.nodes.rows.ids[r], pid = (r: number) => T.plans.rows.ids[r], cid = (r: number) => T.conns.rows.ids[r];
  const index: string[] = [];
  for (const [id, r] of T.nodes.rows.row) {
    index.push(`memberOf ${id} ${Array.from(I.memberOf.view(r), cid).sort()}`, `placedIn ${id} ${Array.from(I.placedIn.view(r), pid).sort()}`);
  }
  I.groupOf.forEach((pg, p) => { pg?.group.forEach((g, n) => { if (g >= 0) index.push(`groupOf ${pid(p)} ${nid(n)} ${nid(g)} ${pg.multi.get(n)?.map(nid) ?? ''}`); }); });
  I.groupMembers.forEach((gm, p) => { for (const [g, ms] of gm ?? []) index.push(`groupMembers ${pid(p)} ${nid(g)} ${ms.map(nid).sort()}`); });
  for (const [c, ids] of I.phantomsOf) index.push(`phantomsOf ${c} ${[...ids].sort()}`);
  for (const [g, ids] of I.phantomsIn) index.push(`phantomsIn ${g} ${[...ids].sort()}`);
  const refs = [T.nodes.rows, T.plans.rows, T.conns.rows].map((rows) => [...rows.row].map(([id, r]) => `${id} ${rows.refs[r]}`).sort());
  return canonical({
    nodes: sorted(x.nodes), connections: sorted(x.connections), plans: sorted(x.plans), tagKeys: sorted(x.tagKeys), placements: sorted(x.placements),
    branches: x.branches.map((b) => b.join('|')).sort(), connLayouts: sorted(x.connLayouts), phantoms: sorted(x.phantoms), index: index.sort(), refs,
    counts: [T.nodes.count, T.plans.count, T.conns.count, T.plans.placementCount, T.conns.branchCount],
  });
}

/**
 * Three plans; M in G in H in P, A in G in Q; A–B (its arm B split in P, a phantom of it sitting in G) and A–B–C (shown
 * in P and in Q, where C is absent and its stub has a place of its own); a layout.
 */
function world() {
  const s = emptyState();
  const plan = (name: string, type: PlanType = 'plan') => created(run(s, createPlan(s, name, type)), 'plan');
  const P = plan('P'), Q = plan('Q'), D = plan('D', 'document');
  const mk = (title: string) => created(run(s, createNode(s, { plan: P, title, x: title.charCodeAt(0), y: 0, k: 0 })), 'node');
  const [A, B, C, G, H, M] = ['A', 'B', 'C', 'G', 'H', 'M'].map(mk);
  for (const n of [A, B, G]) run(s, placeNode(s, Q, n, 1, 1, 0));
  run(s, include(s, P, G, H));
  run(s, include(s, P, M, G));
  run(s, include(s, Q, A, G));
  const ab = created(run(s, connect(s, { plan: P, members: [{ node: A, role: 'source' }, { node: B, role: 'target' }] })), 'connection');
  const abc = created(run(s, connect(s, { plan: P, members: [{ node: A, role: 'source' }, { node: B, role: 'target' }, { node: C, role: 'target' }] })), 'connection');
  run(s, setBranches(s, abc, [{ plan: Q, node: A }, { plan: Q, node: B }, { plan: Q, node: C }], true));
  run(s, placeAbsent(s, Q, abc, C, 40, 40, 0));
  run(s, splitArm(s, P, ab, B, { x: 10, y: 0, k: 0 }, { x: 90, y: 0, k: 0 }));
  const phantom = [...s.phantoms.values()].find((p) => p.connection === ab && p.of.kind === 'node')!.id;
  run(s, movePhantom(s, phantom, 11, 1, G));
  run(s, setLayout(s, P, abc, { marker: { x: 1, y: 2 }, handles: {} }));
  return { s, P, Q, D, A, B, C, G, H, M, ab, abc, phantom };
}

test('une commande qui lève une erreur au milieu laisse l’état identique, à instantané canonique égal', () => {
  const { s, P, Q, A, B, C, G, H, M, abc } = world();
  const before = image(s);
  // Refused after some of its operations: the second node is not in this plan, the second node is not a member.
  expect(() => moveNodes(s, P, [{ node: A, x: 5 }, { node: 'inconnu', x: 1 }])).toThrow(CommandError);
  expect(image(s)).toBe(before);
  expect(() => setBranches(s, abc, [{ plan: Q, node: A }, { plan: P, node: H }], false)).toThrow(/membre/);
  expect(image(s)).toBe(before);
  // Any exception, after a deletion everywhere, an inclusion and a new connection.
  expect(() => combine(s, 'x', [
    (x) => deleteEverywhere(x, A),
    (x) => include(x, P, B, G),
    (x) => connect(x, { plan: P, members: [{ node: B, role: 'source' }, { node: C, role: 'target' }] }),
    () => { throw new Error('panne'); },
  ])).toThrow('panne');
  expect(image(s)).toBe(before);
  // A rule broken by the whole: refused at the end, when the rules are checked.
  expect(() => combine(s, 'Boucle', [(x) => moveNodes(x, P, [{ node: M, x: 3 }]), (x) => include(x, P, H, M)])).toThrow(/descendants/);
  expect(image(s)).toBe(before);
});

test('une étape qui rattrape l’erreur d’une commande imbriquée : seules les opérations de cette commande sont défaites', () => {
  const { s, P, A, B } = world();
  const before = image(s), pb = placementOf(s, P, B)!;
  const a = combine(s, 'Repli', [
    (x) => {
      try { return moveNodes(x, P, [{ node: A, x: 7 }, { node: 'inconnu' }]); } catch { return moveNodes(x, P, [{ node: B, x: 9 }]); }
    },
  ]);
  expect(a.ops).toEqual([{ t: 'placement', before: pb, after: { ...pb, x: 9 } }]);
  expect(image(s)).toBe(before);
});

test('une commande réussie laisse l’état identique et rend l’action attendue', () => {
  const w = world(), { s, P, Q, D, A, B, C, G, H, M, ab, abc, phantom } = w;
  const before = image(s);
  const pa = placementOf(s, P, A)!, na = s.nodes.get(A)!;
  expect(moveNodes(s, P, [{ node: A, x: 5 }]).ops).toEqual([{ t: 'placement', before: pa, after: { ...pa, x: 5 } }]);
  expect(editNode(s, A, { title: 'Ä' }).ops).toEqual([{ t: 'node', before: na, after: { ...na, title: 'Ä' } }]);
  expect(setBranches(s, ab, [{ plan: Q, node: A }, { plan: Q, node: B }], true).ops).toEqual([
    { t: 'branch', key: { plan: Q, connection: ab, node: A }, before: false, after: true },
    { t: 'branch', key: { plan: Q, connection: ab, node: B }, before: false, after: true },
  ]);
  // M leaves G for H: its link to G is hidden here, a new one to H is shown.
  const moved = include(s, P, M, H);
  const link = created(moved, 'connection'), old = s.connections.get(link);
  expect(old).toBeUndefined();
  expect(moved.ops.map((o) => (o.t === 'branch' ? `branch ${o.key.node === M ? 'M' : o.key.node === G ? 'G' : 'H'} ${o.after}` : o.t))).toEqual([
    'branch M false', 'branch G false', 'connection', 'branch M true', 'branch H true',
  ]);
  expect(image(s)).toBe(before);
  // Every other command leaves the state as it found it, and its action applies as it was computed.
  const actions: (() => Action)[] = [
    () => createNode(s, { plan: Q, title: 'N', x: 0, y: 0, k: 1 }),
    () => connect(s, { plan: Q, members: [{ node: A, role: 'source' }, { node: G, role: 'target' }] }),
    () => exclude(s, Q, A),
    () => removeFromPlan(s, P, G),
    () => removeFromPlan(s, P, C),
    () => deleteEverywhere(s, A),
    () => deleteEverywhere(s, G),
    () => placeNode(s, Q, C, 5, 5, 0),
    () => placeNode(s, D, A, 0, 0, 0),
    () => addMember(s, P, ab, { node: M, role: 'associate' }),
    () => removeMember(s, ab, B),
    () => removeMember(s, abc, C),
    () => editConnection(s, abc, { title: 'T', relation: 'R' }),
    () => setBranches(s, abc, [{ plan: Q, node: C }], false),
    () => deleteConnection(s, abc),
    () => setRole(s, abc, C, 'associate'),
    () => joinArm(s, P, ab, B),
    () => movePhantom(s, phantom, 3, 4, null, 2),
    () => setLayout(s, P, abc, null),
    () => combine(s, 'Tout', [(x) => removeFromPlan(x, P, G), (x) => include(x, P, M, H), (x) => deleteEverywhere(x, B)]),
  ];
  for (const make of actions) {
    const a = make();
    expect(image(s)).toBe(before);
    run(s, a);
    expect(image(s)).not.toBe(before);
    for (const op of [...a.ops].reverse()) applyOp(s, { ...op, before: op.after, after: op.before } as Op);
    expect(image(s)).toBe(before);
  }
  const trashed = run(s, removeFromPlan(s, P, H));
  const back = image(s);
  restoreNode(s, H, Q, 0, 0, 0);
  expect(image(s)).toBe(back);
  for (const op of [...trashed.ops].reverse()) applyOp(s, { ...op, before: op.after, after: op.before } as Op);
  expect(image(s)).toBe(before);
});

test('transact : le brouillon écrit sur l’état même, une commande imbriquée s’y joint, tout est défait à la sortie', () => {
  const { s, P, A } = world();
  const before = image(s), title = s.nodes.get(A)!.title;
  const seen = transact(s, (d) => {
    d.node(A, { ...s.nodes.get(A)!, title: 'brouillon' });
    const inner = editNode(s, A, { summary: 'imbriquée' });
    // The nested command sees the draft and leaves its own operation applied until the outer transaction ends.
    expect(inner.ops[0]).toMatchObject({ before: { title: 'brouillon' }, after: { title: 'brouillon', summary: 'imbriquée' } });
    return { ...s.nodes.get(A)! };
  });
  expect(seen).toMatchObject({ title: 'brouillon', summary: 'imbriquée' });
  expect(s.nodes.get(A)!.title).toBe(title);
  expect(image(s)).toBe(before);
  // A nested transaction ended without an action (a dry run) is undone at once.
  transact(s, () => {
    transact(s, (d) => { d.placement(P, A, { ...placementOf(s, P, A)!, x: 123 }); });
    expect(placementOf(s, P, A)!.x).not.toBe(123);
  });
  expect(image(s)).toBe(before);
});

test('une violation déjà là ne refuse pas une action ; une violation ajoutée la refuse, état intact', () => {
  const { s, P, A, B } = world();
  // A knowledge connection with a single member, written without a command.
  applyOp(s, { t: 'connection', before: null, after: { id: 'seule', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: A, role: 'source' }] } });
  applyOp(s, { t: 'branch', key: { plan: P, connection: 'seule', node: A }, before: false, after: true });
  const before = image(s);
  expect(editConnection(s, 'seule', { title: 'toujours seule' }).ops).toHaveLength(1);
  expect(image(s)).toBe(before);
  expect(() => removeMember(s, 'seule', A)).not.toThrow(); // to the trash: no rule applies there
  // Two members of which one is the same node twice: added by this action, refused.
  expect(() => addMember(s, P, 'seule', { node: B, role: 'target' })).not.toThrow();
  expect(() => combine(s, 'Doublon', [(x) => addMember(x, P, 'seule', { node: B, role: 'target' }), () => ({
    id: 'brut', label: 'brut', ops: [{ t: 'connection', before: { ...s.connections.get('seule')! }, after: { ...s.connections.get('seule')!, members: [...s.connections.get('seule')!.members, { node: B, role: 'associate' }] } }],
  })])).toThrow(/qu’une fois/);
  expect(image(s)).toBe(before);
});

test('l’essai à blanc d’une annulation applique puis annule : état identique, refusé ou non', () => {
  const { s, P, A, G } = world();
  const stack = new UndoStack();
  stack.record(run(s, deleteEverywhere(s, G)));
  const before = image(s);
  expect(stack.prepareUndo(s)!.ops.length).toBeGreaterThan(3);
  expect(image(s)).toBe(before);
  // Moved elsewhere since: the inverse's first operation (the title) applies, its second (the place) no longer does.
  stack.record(run(s, combine(s, 'Deux', [(x) => moveNodes(x, P, [{ node: A, x: 2 }]), (x) => editNode(x, A, { title: 'ici' })])));
  run(s, moveNodes(s, P, [{ node: A, x: 3 }]));
  const changed = image(s);
  expect(() => stack.prepareUndo(s)).toThrow(UndoConflictError);
  expect(image(s)).toBe(changed);
});
