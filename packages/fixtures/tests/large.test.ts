import { canonical, checkState, groupIndex, ancestors, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { buildLargeState } from '../src/large.ts';

const parts = (s: State) => ({
  nodes: [...s.nodes], connections: [...s.connections], placements: [...s.placements], branches: [...s.branches].sort(), phantoms: [...s.phantoms],
});

test('grande base synthétique : cohérente, peu profonde, avec des bras scindés, déterministe', () => {
  const { state, lobby } = buildLargeState({ seed: 1, nodes: 2000, connections: 20_000 });
  expect(state.plans.get(lobby)!.type).toBe('lobby');
  expect(state.nodes.size).toBe(2000);
  expect(checkState(state)).toEqual([]);
  const index = groupIndex(state);
  const depth = Math.max(...[...state.nodes.keys()].map((n) => ancestors(state, lobby, n, index).length));
  expect(depth).toBeGreaterThan(0);
  expect(depth).toBeLessThanOrEqual(5);
  const kinds = new Set([...state.phantoms.values()].map((p) => p.of.kind));
  expect(kinds).toEqual(new Set(['node', 'center']));
  const again = buildLargeState({ seed: 1, nodes: 2000, connections: 20_000 });
  expect(canonical(parts(again.state))).toBe(canonical(parts(state)));
}, 60_000);
