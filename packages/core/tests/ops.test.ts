import { expect, test } from 'vitest';
import type { NodeRec } from '../src/model.ts';
import { flowOf, invertOp, type Op } from '../src/ops.ts';
import { applyOp, emptyState, OpConflictError } from '../src/state.ts';

test('créer puis modifier un nœud', () => {
  const s = emptyState();
  const n: NodeRec = { id: 'n1', title: 'MDL', summary: '', tags: [], files: [] };
  applyOp(s, { t: 'node', before: null, after: n });
  applyOp(s, { t: 'node', before: n, after: { ...n, title: 'Minimum Description Length Principle (MDL)' } });
  expect(s.nodes.get('n1')!.title).toBe('Minimum Description Length Principle (MDL)');
});

test("l'opération inverse rétablit l'état", () => {
  const s = emptyState();
  const op: Op = { t: 'placement', before: null, after: { plan: 'p', node: 'n', x: 1, y: 2, k: 0 } };
  applyOp(s, op);
  applyOp(s, invertOp(op));
  expect(s.placements.size).toBe(0);
});

test('avant périmé : conflit, état intact', () => {
  const s = emptyState();
  const n: NodeRec = { id: 'n1', title: 'A', summary: '', tags: [], files: [] };
  applyOp(s, { t: 'node', before: null, after: n });
  expect(() => applyOp(s, { t: 'node', before: { ...n, title: 'autre' }, after: { ...n, title: 'B' } })).toThrow(OpConflictError);
  expect(s.nodes.get('n1')!.title).toBe('A');
});

test('flux de chaque opération', () => {
  expect(flowOf({ t: 'connection', before: null, after: null })).toBe('content');
  expect(flowOf({ t: 'branch', key: { plan: 'p', connection: 'c', node: 'n' }, before: false, after: true })).toBe('layout');
});
