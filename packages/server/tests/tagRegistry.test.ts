import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, applyOps, canonical, connect, createNode, createPlan, decodeState, defineTagKey, deleteTagKey, editConnection, editNode, emptyState, invertAction,
  renameEnumValue, renameTagKey, type State, type TagKeyDef, toSnapshot, UndoStack,
} from '@cirrus/core';
import { LocalStore } from '@cirrus/store';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, created, newCode, pair, T0 } from './support.ts';

// The tag registry's actions (plan 6a, task 3) as the server takes them (POST /units: parseUnit, the "befores", the
// rules), and as its base keeps them: the scenario of the task — an enumeration created, two nodes tagged, a value
// renamed, the key renamed, Ctrl+Z —, then a definition changed and removed.

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-registre-')); });
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0 });
  running.push(s);
  return s;
}

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const image = (s: State) => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));

test('registre des tags : créer une énumération, taguer deux nœuds et une connexion, renommer une valeur, renommer la clé, Ctrl+Z, changer puis retirer la définition — tout est accepté, et la base du serveur tient l’état du PC', async () => {
  let srv = await start();
  const res = await pair(srv.url, { code: newCode(dir, 'pc-a', T0), pc: 'pc-a', name: 'Machine pc-a' });
  expect(res.status).toBe(200);
  const a = new Client(srv.url, ((await res.json()) as { token: string }).token, 'pc-a');
  const s = emptyState();
  const actions: Action[] = [];
  const go = (x: Action) => { actions.push(run(s, x)); return x; };
  const P = created(go(createPlan(s, 'P', 'plan')), 'plan');
  const X = created(go(createNode(s, { plan: P, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  const G = created(go(createNode(s, { plan: P, title: 'G', x: 100, y: 0, k: 0 })), 'node');
  const XG = go(connect(s, { plan: P, members: [{ node: X, role: 'source' }, { node: G, role: 'target' }] })).ops.find((o) => o.t === 'connection')!.after!;
  const niveau: TagKeyDef = {
    key: 'niveau', type: 'enum', scope: 'both', multi: false, required: true, defaultValue: 'bas',
    enumValues: [{ name: 'bas', rank: 1 }, { name: 'moyen', rank: 2 }, { name: 'haut', rank: 3 }],
  };
  go(defineTagKey(s, niveau));
  go(editNode(s, X, { tags: [{ key: 'niveau', value: 'bas' }] }));
  go(editNode(s, G, { tags: [{ key: 'niveau', value: 3 }] }));
  go(editConnection(s, XG.id, { tags: [{ key: 'niveau', value: 'bas' }] }));
  go(renameEnumValue(s, 'niveau', 'bas', 'faible'));
  const stack = new UndoStack();
  stack.record(go(renameTagKey(s, 'niveau', 'grade')));
  expect(s.nodes.get(X)!.tags).toEqual([{ key: 'grade', value: 'faible' }]);
  go(stack.undo(s)!);
  expect([s.tagKeys.has('grade'), s.nodes.get(X)!.tags]).toEqual([false, [{ key: 'niveau', value: 'faible' }]]);
  go(stack.redo(s)!);
  go(defineTagKey(s, { ...s.tagKeys.get('grade')!, multi: true, required: false, defaultValue: undefined }));
  go(deleteTagKey(s, 'grade'));
  // Undeclared now, only carried: renamed without a definition.
  go(renameTagKey(s, 'grade', 'note'));
  const results = await a.units(actions.map((x) => a.unit(x)));
  expect(results.every((r) => 'accepted' in r), JSON.stringify(results)).toBe(true);
  expect(s.tagKeys.size).toBe(0);
  expect([s.nodes.get(X)!.tags, s.nodes.get(G)!.tags, s.connections.get(XG.id)!.tags]).toEqual([
    [{ key: 'note', value: 'faible' }], [{ key: 'note', value: 'haut' }], [{ key: 'note', value: 'faible' }],
  ]);
  const snap = await a.get('/snapshot');
  expect(snap.status).toBe(200);
  expect(image(decodeState(await snap.arrayBuffer()))).toBe(image(s));
  // Its base: from its tables, without the snapshot, the same state.
  await srv.close();
  running.splice(0);
  const base = LocalStore.open(join(dir, 'base'), { pc: 'test' });
  try {
    base.dropSnapshot();
    expect(image(base.loadState())).toBe(image(s));
  } finally {
    base.close();
  }
  // And the undo of all of it, the last first, accepted too.
  srv = await start();
  const again = new Client(srv.url, a.token, 'pc-a');
  const undo = actions.slice(4).reverse().map((x) => run(s, invertAction(x)));
  const back = await again.units(undo.map((x) => again.unit(x)));
  expect(back.every((r) => 'accepted' in r), JSON.stringify(back)).toBe(true);
  expect([s.tagKeys.size, s.nodes.get(X)!.tags, s.connections.get(XG.id)!.tags]).toEqual([0, [], []]);
});
