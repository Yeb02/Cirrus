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
