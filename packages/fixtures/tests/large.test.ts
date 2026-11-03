import { canonical, checkState, groupIndex, ancestors, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { benchId, buildLargeState } from '../src/large.ts';

const parts = (s: State) => ({
  nodes: [...s.nodes], connections: [...s.connections], placements: [...s.placements], branches: [...s.branches].sort(), phantoms: [...s.phantoms],
});
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

test('grande base synthétique : des identifiants de 36 caractères partout, tous distincts', () => {
  const { state, lobby } = buildLargeState({ seed: 1, nodes: 500, connections: 3000 });
  const ids = [lobby, ...state.nodes.keys(), ...state.connections.keys(), ...state.phantoms.keys()];
  expect(ids.every((id) => UUIDV7.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

test('benchId : forme UUIDv7 de 36 caractères, unique sur 600 000 valeurs, déterministe, croissant', () => {
  const n = 600_000;
  const ids = Array.from({ length: n }, (_, i) => benchId('node', i));
  expect(ids.every((id) => id.length === 36 && UUIDV7.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(n);
  let increasing = true;
  for (let i = 1; i < n; i++) if (!(ids[i - 1] < ids[i])) increasing = false;
  expect(increasing).toBe(true);
  expect(benchId('node', 123_456)).toBe(ids[123_456]);
  // Two kinds never share an identifier: nodes and connections live in different maps, connections of two kinds in one.
  expect(benchId('inclusion', 7)).not.toBe(benchId('connection', 7));
  expect(benchId('node', 7)).not.toBe(benchId('connection', 7));
}, 60_000);
