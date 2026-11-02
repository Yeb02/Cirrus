import { expect, test } from 'vitest';
import type { ConnectionRec, Id, NodeRec, PlanType } from '../src/model.ts';
import { ancestors, checkState, groupOf } from '../src/invariants.ts';
import { applyOp, emptyState, type State } from '../src/state.ts';

const node = (id: Id): NodeRec => ({ id, title: id, summary: '', tags: [], files: [] });

function base(): State {
  const s = emptyState();
  const plans: [Id, PlanType][] = [['p1', 'plan'], ['p2', 'plan'], ['doc', 'document']];
  for (const [id, type] of plans) applyOp(s, { t: 'plan', before: null, after: { id, name: id, type } });
  for (const id of ['A', 'G', 'H']) {
    applyOp(s, { t: 'node', before: null, after: node(id) });
    for (const plan of ['p1', 'p2']) applyOp(s, { t: 'placement', before: null, after: { plan, node: id, x: 0, y: 0, k: 0 } });
  }
  return s;
}

function connection(s: State, c: ConnectionRec, plan: Id): void {
  applyOp(s, { t: 'connection', before: s.connections.get(c.id) ?? null, after: c });
  for (const m of c.members) applyOp(s, { t: 'branch', key: { plan, connection: c.id, node: m.node }, before: false, after: true });
}

function inclusion(s: State, member: Id, group: Id, plan: Id): void {
  const id = `inc-${member}-${group}`;
  const c: ConnectionRec = { id, kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: member, role: 'source' }, { node: group, role: 'target' }] };
  if (s.connections.has(id)) {
    for (const m of c.members) applyOp(s, { t: 'branch', key: { plan, connection: id, node: m.node }, before: false, after: true });
  } else connection(s, c, plan);
}

const codes = (s: State) => checkState(s).map((v) => v.code);

test('connexion à un seul membre refusée', () => {
  const s = base();
  connection(s, { id: 'c', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: 'A', role: 'source' }] }, 'p1');
  expect(codes(s)).toContain('members');
});

test('second groupe direct dans le même plan refusé (Review Focus 4)', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'A', 'H', 'p1');
  expect(codes(s)).toContain('twoGroups');
});

test("boucle d'inclusion refusée (Review Focus 4)", () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'G', 'A', 'p1');
  expect(codes(s)).toContain('cycle');
});

test('deux groupes différents dans deux plans différents acceptés', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'A', 'H', 'p2');
  expect(codes(s)).toEqual([]);
});

test('nœud jeté encore placé refusé', () => {
  const s = base();
  applyOp(s, { t: 'node', before: node('A'), after: { ...node('A'), trashedAt: 1 } });
  expect(codes(s)).toContain('trashedPlaced');
});

test('connexion de structure hors plan document refusée', () => {
  const s = base();
  connection(s, { id: 'st', kind: 'structure', title: '', relation: '', tags: [{ key: 'partie', value: 1 }], members: [{ node: 'G', role: 'source' }, { node: 'A', role: 'target' }] }, 'p1');
  expect(codes(s)).toContain('structureOutsideDocument');
});

test('groupOf et ancestors suivent la hiérarchie du plan', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'G', 'H', 'p1');
  expect(groupOf(s, 'p1', 'A')).toBe('G');
  expect(ancestors(s, 'p1', 'A')).toEqual(['G', 'H']);
  expect(groupOf(s, 'p2', 'A')).toBeUndefined();
});
