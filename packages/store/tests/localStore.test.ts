import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Action, applyOps, canonical, type ConnectionLayout, connect, createNode, createPlan, editNode, emptyState, encodeState, type Id, type NodeRec,
  OpConflictError, type PhantomRec, removeFromPlan, SNAPSHOT_VERSION, type State, type TagKeyDef, toSnapshot,
} from '@cirrus/core';
import { LocalStore, SCHEMA_VERSION } from '../src/localStore.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const afterId = (a: Action, t: string): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
/** The store keeps no state: the interface's copy, here, moves only once an action is written (EditSession). */
const write = (store: LocalStore, s: State, a: Action): number => { const seq = store.commit(a); applyOps(s, a.ops); return seq; };
const same = (a: State, b: State) => expect(canonical(sorted(a))).toBe(canonical(sorted(b)));
const sorted = (s: State) => Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, (v as unknown[]).map((x) => canonical(x)).sort()]));

function withPlan(store: LocalStore, s: State): Id {
  const a = createPlan(s, 'Thèse', 'plan');
  write(store, s, a);
  return afterId(a, 'plan');
}

test('ouvrir crée la base au schéma courant, avec la table de l’instantané', () => {
  LocalStore.open(dir, { pc: 'pc1' }).close();
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshot'").get()).toBeDefined();
  db.close();
  expect(SCHEMA_VERSION).toBe(2);
});

test('une action validée persiste et se recharge depuis les tables à la réouverture', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'Minimum Description Length Principle (MDL)', x: 1, y: 2, k: 0 });
  write(store, s, a);
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' }), loaded = again.loadState();
  expect(loaded.nodes.get(afterId(a, 'node'))!.title).toBe('Minimum Description Length Principle (MDL)');
  expect(loaded.placements.size).toBe(1);
  same(loaded, s);
  again.close();
});

test('le journal reçoit une ligne par opération, numéros locaux croissants ; commit rend celui de la dernière', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.lastSeq()).toBe(0);
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  expect(write(store, s, a)).toBe(3);
  expect(store.lastSeq()).toBe(3);
  const all = store.changesSince(0);
  expect(all.map((r) => r.localSeq)).toEqual([1, 2, 3]);
  expect(all.every((r) => r.serverSeq === null && r.pc === 'pc1')).toBe(true);
  expect(all.slice(1).every((r) => r.actionId === a.id)).toBe(true);
  expect(all.map((r) => r.flow)).toEqual(['content', 'content', 'layout']);
  expect(store.changesSince(2).map((r) => r.op)).toEqual([a.ops[1]]);
  store.close();
});

test('commit refuse un « avant » périmé, relu dans la base : ni ligne, ni journal, même après des opérations déjà écrites (ROLLBACK)', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const ok = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, ok);
  const other = createNode(s, { plan, title: 'B', x: 5, y: 0, k: 0 });
  write(store, s, other);
  const link = connect(s, { plan, members: [{ node: afterId(ok, 'node'), role: 'source' }, { node: afterId(other, 'node'), role: 'target' }] });
  write(store, s, link);
  const n = s.nodes.get(afterId(ok, 'node'))!, c = s.connections.get(afterId(link, 'connection'))!;
  // A tag key, a layout and a phantom in the base, for their stale "befores" too.
  const key: TagKeyDef = { key: 'mot', type: 'word', scope: 'both', multi: false, required: false };
  const layout: ConnectionLayout = { plan, connection: c.id, marker: { x: 1, y: 2 }, handles: {} };
  const phantom: PhantomRec = { id: 'f-1', plan, connection: c.id, of: { kind: 'node', node: n.id }, x: 3, y: 4, k: 0 };
  write(store, s, { id: 'extra', label: 'extra', ops: [
    { t: 'tagKey', before: null, after: key }, { t: 'connLayout', before: null, after: layout }, { t: 'phantom', before: null, after: phantom },
  ] });
  const fresh: NodeRec = { id: 'n-new', title: 'Nouveau', summary: '', tags: [], files: [] };
  const stale: Op[][] = [
    [{ t: 'node', before: { ...n, title: 'périmé' }, after: { ...n, title: 'C' } }],
    [{ t: 'node', before: null, after: { ...n, title: 'déjà là' } }],
    [{ t: 'connection', before: { ...c, title: 'autre' }, after: { ...c, title: 'D' } }],
    [{ t: 'branch', key: { plan, connection: c.id, node: 'personne' }, before: true, after: false }],
    [{ t: 'placement', before: { plan, node: n.id, x: 9, y: 9, k: 0 }, after: null }],
    [{ t: 'plan', before: null, after: { id: plan, name: 'Double', type: 'plan' } }],
    [{ t: 'tagKey', before: { ...key, multi: true }, after: null }],
    [{ t: 'tagKey', before: null, after: { ...key, required: true } }],
    [{ t: 'connLayout', before: { ...layout, angle: 1 }, after: null }],
    [{ t: 'phantom', before: { ...phantom, x: 9 }, after: { ...phantom, x: 10 } }],
    [{ t: 'phantom', before: null, after: { ...phantom, y: 0 } }],
  ];
  const tables = () => canonical(sorted(store.loadState()));
  const before = tables(), seq = store.lastSeq();
  for (const ops of stale) {
    const bad: Action = { id: 'bad', label: 'bad', ops: [{ t: 'node', before: null, after: fresh }, ...ops] };
    expect(() => store.commit(bad), JSON.stringify(ops[0])).toThrow(OpConflictError);
    expect(store.lastSeq()).toBe(seq);
    expect(tables()).toBe(before);
  }
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  expect(again.loadState().nodes.has('n-new')).toBe(false);
  expect(again.changesSince(seq)).toEqual([]);
  again.close();
});

test('l’« avant » se compare au sens canonique (ordre des clés, propriétés indéfinies), et les opérations d’une action se voient l’une l’autre', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, a);
  const n = s.nodes.get(afterId(a, 'node'))!;
  const reordered = { files: n.files, tags: n.tags, summary: n.summary, title: n.title, id: n.id, trashedAt: undefined } as NodeRec;
  const twice: Action = { id: 'x', label: 'deux fois', ops: [
    { t: 'node', before: reordered, after: { ...n, title: 'A2' } },
    { t: 'node', before: { ...n, title: 'A2' }, after: { ...n, title: 'A3' } },
  ] };
  write(store, s, twice);
  expect(store.loadState().nodes.get(n.id)!.title).toBe('A3');
  store.close();
});

test('un enregistrement que l’état refuserait, sans tags, une connexion comme un nœud, est refusé avant toute écriture : la base se relit toujours', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const node = [...s.nodes.keys()][0], seq = store.lastSeq(), tables = () => canonical(sorted(store.loadState())), before = tables();
  const fresh: NodeRec = { id: 'n-new', title: 'Nouveau', summary: '', tags: [], files: [] };
  const tagless: Op[] = [
    { t: 'connection', before: null, after: { id: 'c-bad', kind: 'knowledge', title: '', relation: '', members: [{ node, role: 'source' }] } as never },
    { t: 'node', before: null, after: { id: 'n-bad', title: 'Sans tags', summary: '', files: [] } as never },
    { t: 'node', before: s.nodes.get(node)!, after: { ...s.nodes.get(node)!, tags: undefined } as never },
  ];
  for (const op of tagless) {
    expect(() => store.commit({ id: 'b', label: 'b', ops: [{ t: 'node', before: null, after: fresh }, op] }), JSON.stringify(op)).toThrow(/invalid/);
    expect(store.lastSeq()).toBe(seq);
    expect(tables()).toBe(before);
  }
  store.close();
});

test('un enregistrement de connexion que l’état refuserait (genre, rôle, corbeille) est refusé avant toute écriture', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const node = [...s.nodes.keys()][0], seq = store.lastSeq();
  const base = { id: 'c-bad', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node, role: 'source' }] };
  for (const after of [{ ...base, kind: 'bogus' }, { ...base, members: [{ node, role: 'bogus' }] }, { ...base, trashedAt: 'hier' }]) {
    expect(() => store.commit({ id: 'b', label: 'b', ops: [{ t: 'connection', before: null, after } as Op] })).toThrow();
    expect(store.lastSeq()).toBe(seq);
  }
  store.close();
});

test('historique par objet', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, a);
  const id = afterId(a, 'node');
  write(store, s, editNode(s, id, { title: 'A2' }));
  write(store, s, editNode(s, id, { title: 'A3' }));
  expect(store.historyOf(id).filter((r) => r.op.t === 'node')).toHaveLength(3);
  store.close();
});

test('corbeille et lobby lus en SQL', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.hasLobby()).toBe(false);
  const plan = withPlan(store, s);
  expect(store.hasLobby()).toBe(false);
  write(store, s, createPlan(s, 'Lobby', 'lobby'));
  expect(store.hasLobby()).toBe(true);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, a);
  write(store, s, createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  expect(store.trash()).toEqual([]);
  write(store, s, removeFromPlan(s, plan, afterId(a, 'node')));
  expect(store.trash()).toEqual([s.nodes.get(afterId(a, 'node'))]);
  store.close();
});

test('instantané : écrit puis relu ; un plus ancien ne remplace pas un plus récent ; au-delà du journal ou pas un instantané, refusé', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.readSnapshot()).toBeNull();
  withPlan(store, s);
  const first = encodeState(s), seq1 = store.lastSeq();
  store.writeSnapshot(first, seq1);
  const read = store.readSnapshot()!;
  expect([read.seq, read.version, read.data.byteLength]).toEqual([seq1, SNAPSHOT_VERSION, first.byteLength]);
  expect(new Uint8Array(read.data)).toEqual(new Uint8Array(first));
  const plan2 = createPlan(s, 'Deux', 'plan');
  write(store, s, plan2);
  const second = encodeState(s), seq2 = store.lastSeq();
  store.writeSnapshot(second, seq2);
  // Older, or the same seq again: ignored.
  store.writeSnapshot(first, seq1);
  store.writeSnapshot(first, seq2);
  expect(new Uint8Array(store.readSnapshot()!.data)).toEqual(new Uint8Array(second));
  expect(() => store.writeSnapshot(second, seq2 + 1)).toThrow();
  expect(() => store.writeSnapshot(new ArrayBuffer(64), seq2)).toThrow();
  expect(store.readSnapshot()!.seq).toBe(seq2);
  store.dropSnapshot();
  expect(store.readSnapshot()).toBeNull();
  store.close();
});

test('migration du schéma 1 au schéma 2 : additive, rien de perdu, sans instantané', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'Ancien', x: 0, y: 0, k: 0 }));
  store.close();
  // The base as plan 3b left it: schema 1, no snapshot table.
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  db.exec('DROP TABLE snapshot; PRAGMA user_version = 1;');
  db.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  same(again.loadState(), s);
  expect(again.changesSince(0)).toHaveLength(3);
  expect(again.readSnapshot()).toBeNull();
  again.close();
});

type Op = Action['ops'][number];
