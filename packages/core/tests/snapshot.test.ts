import { expect, test } from 'vitest';
import { connect, createNode, createPlan, include, splitArm, type Action } from '../src/commands.ts';
import { fromSnapshot, toSnapshot } from '../src/snapshot.ts';
import { applyOp, canonical, emptyState, type State } from '../src/state.ts';
import { created } from './helpers.ts';

const run = (s: State, a: Action): Action => { for (const op of a.ops) applyOp(s, op); return a; };
const parts = (s: State) => ({
  nodes: [...s.nodes], connections: [...s.connections], plans: [...s.plans], tagKeys: [...s.tagKeys],
  placements: [...s.placements], branches: [...s.branches].map((b) => canonical(b)).sort(), connLayouts: [...s.connLayouts], phantoms: [...s.phantoms],
});

test('instantané aller-retour, sans Map ni Set', () => {
  const s = emptyState();
  const plan = created(run(s, createPlan(s, 'Lobby', 'lobby')), 'plan');
  const node = (t: string) => created(run(s, createNode(s, { plan, title: t, x: 0, y: 0, k: 0 })), 'node');
  const a = node('A'), b = node('B'), g = node('G');
  run(s, include(s, plan, a, g));
  const c = created(run(s, connect(s, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, splitArm(s, plan, c, b, { x: 1, y: 1, k: 0 }, { x: 2, y: 2, k: 0 }));
  applyOp(s, { t: 'tagKey', before: null, after: { key: 'x', type: 'word', scope: 'node', multi: false, required: false } });

  const snap = toSnapshot(s);
  expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  expect(canonical(parts(fromSnapshot(snap)))).toBe(canonical(parts(s)));
});
