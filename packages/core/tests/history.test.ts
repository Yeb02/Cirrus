import { expect, test } from 'vitest';
import { type Action, connect, createNode, createPlan, deleteEverywhere, editNode } from '../src/commands.ts';
import { UndoConflictError, UndoStack } from '../src/history.ts';
import type { Id } from '../src/model.ts';
import { applyOp, canonical, emptyState, type State } from '../src/state.ts';

const run = (s: State, a: Action): Action => { for (const op of a.ops) applyOp(s, op); return a; };
const createdId = (a: Action): Id => (a.ops.find((o) => o.t === 'node' && o.before === null) as { after: { id: Id } }).after.id;
// Sorted: removing then re-adding an entry changes Map/Set iteration order, not the content.
const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();
const snapshot = (s: State) => canonical({ n: sorted(s.nodes), c: sorted(s.connections), p: sorted(s.placements), b: sorted(s.branches) });

function setup() {
  const s = emptyState();
  const planAction = run(s, createPlan(s, 'Thèse', 'plan'));
  const plan = (planAction.ops[0] as { after: { id: Id } }).after.id;
  return { s, plan, stack: new UndoStack() };
}

test('annuler puis rétablir', () => {
  const { s, plan, stack } = setup();
  const a = run(s, createNode(s, { plan, title: 'MDL', x: 0, y: 0, k: 0 }));
  stack.record(a);
  run(s, stack.undo(s)!);
  expect(s.nodes.has(createdId(a))).toBe(false);
  run(s, stack.redo(s)!);
  expect(s.nodes.get(createdId(a))!.title).toBe('MDL');
});

test('une nouvelle action vide la pile de rétablissement', () => {
  const { s, plan, stack } = setup();
  stack.record(run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 })));
  run(s, stack.undo(s)!);
  expect(stack.canRedo).toBe(true);
  stack.record(run(s, createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 })));
  expect(stack.canRedo).toBe(false);
});

test('objet modifié depuis : annulation refusée, état et pile intacts (Review Focus 1)', () => {
  const { s, plan, stack } = setup();
  const a = run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  stack.record(a);
  run(s, editNode(s, createdId(a), { title: 'A modifié ailleurs' })); // e.g. arrived by sync, not recorded here
  const before = snapshot(s);
  expect(() => stack.undo(s)).toThrow(UndoConflictError);
  expect(() => stack.undo(s)).toThrow(/modifié depuis/);
  expect(snapshot(s)).toBe(before);
  expect(stack.canUndo).toBe(true);
});

test('annuler une action multi-opérations la défait entièrement', () => {
  const { s, plan, stack } = setup();
  const a = createdId(run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 })));
  const b = createdId(run(s, createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 })));
  run(s, connect(s, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] }));
  const before = snapshot(s);
  stack.record(run(s, deleteEverywhere(s, a)));
  run(s, stack.undo(s)!);
  expect(snapshot(s)).toBe(before);
});

test('préparer une annulation ne déplace la pile qu’une fois confirmée (écriture réussie)', () => {
  const { s, plan, stack } = setup();
  stack.record(run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 })));
  const inverse = stack.prepareUndo(s)!;
  expect(stack.canUndo).toBe(true); // not moved yet: the write may still fail
  expect(stack.prepareUndo(s)!.ops).toEqual(inverse.ops);
  run(s, inverse);
  stack.confirmUndo();
  expect(stack.canUndo).toBe(false);
  expect(stack.canRedo).toBe(true);
  const again = stack.prepareRedo(s)!;
  expect(stack.canRedo).toBe(true);
  run(s, again);
  stack.confirmRedo();
  expect(stack.canUndo).toBe(true);
  expect(stack.canRedo).toBe(false);
});

test('le pas que la prochaine annulation défera, et celui que le prochain rétablissement refera (plan 4c : le plein écran)', () => {
  const { s, plan, stack } = setup();
  expect([stack.nextUndo, stack.nextRedo]).toEqual([null, null]);
  const a = run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  stack.record(a);
  const b = run(s, createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  stack.record(b);
  expect([stack.nextUndo, stack.nextRedo]).toEqual([b.id, null]);
  run(s, stack.undo(s)!);
  expect([stack.nextUndo, stack.nextRedo]).toEqual([a.id, b.id]);
  // Prepared only, the stack has not moved.
  stack.prepareUndo(s);
  expect([stack.nextUndo, stack.nextRedo]).toEqual([a.id, b.id]);
  run(s, stack.redo(s)!);
  expect([stack.nextUndo, stack.nextRedo]).toEqual([b.id, null]);
});

test('un rétablissement refusé dit « rétablir » (M3 du plan 2)', () => {
  const { s, plan, stack } = setup();
  const a = run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  stack.record(a);
  run(s, stack.undo(s)!);
  // Someone else recreates a conflicting state: redoing would not apply.
  for (const op of a.ops) applyOp(s, op);
  expect(() => stack.redo(s)).toThrow(/rétablir/);
});

test('forget : une action réécrite ou écartée par une réconciliation quitte la pile, d’annulation comme de rétablissement (plan 5a, D5)', () => {
  const { s, plan, stack } = setup();
  const a = run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  stack.record(a);
  const b = run(s, createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  stack.record(b);
  stack.forget(a.id);
  expect(stack.nextUndo).toBe(b.id);
  run(s, stack.undo(s)!);
  expect(stack.canUndo).toBe(false);
  stack.forget(b.id);
  expect(stack.canRedo).toBe(false);
  stack.forget('inconnue');
  // A step another action completed (extend) goes when either is named.
  const c = run(s, createNode(s, { plan, title: 'C', x: 0, y: 0, k: 0 }));
  stack.record(c);
  const d = run(s, editNode(s, createdId(c), { title: 'C2' }));
  expect(stack.extend(c.id, d)).toBe(true);
  stack.forget(d.id);
  expect(stack.canUndo).toBe(false);
});
