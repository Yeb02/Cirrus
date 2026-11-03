import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Action, canonical, type Op, parseBranchKey, type State, toSnapshot } from '@cirrus/core';
import { LocalStore, writeBenchBase } from '@cirrus/store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildLargeState } from '../src/large.ts';

let dirs: string[] = [];
const newDir = () => { const d = mkdtempSync(join(tmpdir(), 'cirrus-bench-base-')); dirs.push(d); return d; };
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The snapshot with every list sorted: the tables come back in their own order. */
const sorted = (s: State) => Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, (v as unknown[]).map((x) => canonical(x)).sort()]));

/** Every row of the state tables, sorted, read straight from the file. */
function rows(dir: string): Record<string, string[]> {
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  const out: Record<string, string[]> = {};
  for (const t of ['nodes', 'connections', 'plans', 'tag_keys', 'placements', 'branches', 'conn_layouts', 'phantoms']) {
    out[t] = (db.prepare(`SELECT * FROM ${t}`).all() as unknown[]).map((r) => canonical(r)).sort();
  }
  db.close();
  return out;
}

test('base du banc : écrite d’un coup, LocalStore.open rend le même état, journal vide', () => {
  const { state } = buildLargeState({ seed: 1, nodes: 1000, connections: 10_000 });
  const dir = newDir();
  writeBenchBase(dir, state);
  const store = LocalStore.open(dir, { pc: 'banc' });
  expect(canonical(sorted(store.state))).toBe(canonical(sorted(state)));
  expect(store.changesSince(0)).toEqual([]);
  store.close();
  expect(() => writeBenchBase(dir, state)).toThrow();
}, 60_000);

test('base du banc : les mêmes lignes que le magasin écrit action par action', () => {
  const { state } = buildLargeState({ seed: 2, nodes: 200, connections: 1000 });
  const bulk = newDir(), byCommit = newDir();
  writeBenchBase(bulk, state);
  const ops: Op[] = [
    ...[...state.plans.values()].map((after): Op => ({ t: 'plan', before: null, after })),
    ...[...state.nodes.values()].map((after): Op => ({ t: 'node', before: null, after })),
    ...[...state.placements.values()].map((after): Op => ({ t: 'placement', before: null, after })),
    ...[...state.connections.values()].map((after): Op => ({ t: 'connection', before: null, after })),
    ...[...state.branches].map((key): Op => ({ t: 'branch', key: parseBranchKey(key), before: false, after: true })),
    ...[...state.phantoms.values()].map((after): Op => ({ t: 'phantom', before: null, after })),
  ];
  const store = LocalStore.open(byCommit, { pc: 'banc' });
  store.commit({ id: 'tout', label: 'Tout', ops } satisfies Action);
  store.close();
  expect(rows(bulk)).toEqual(rows(byCommit));
}, 60_000);
