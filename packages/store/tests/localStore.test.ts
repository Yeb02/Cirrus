import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Action, createNode, createPlan, editNode, type Id, type NodeRec, removeFromPlan } from '@cirrus/core';
import { LocalStore, SCHEMA_VERSION } from '../src/localStore.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const afterId = (a: Action, t: string): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

function withPlan(store: LocalStore): Id {
  const a = createPlan(store.state, 'Thèse', 'plan');
  store.commit(a);
  return afterId(a, 'plan');
}

test('ouvrir crée la base au schéma courant', () => {
  LocalStore.open(dir, { pc: 'pc1' }).close();
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  db.close();
  expect(SCHEMA_VERSION).toBe(1);
});

test('une action validée persiste et se recharge à la réouverture', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' });
  const plan = withPlan(store);
  const a = createNode(store.state, { plan, title: 'Minimum Description Length Principle (MDL)', x: 1, y: 2, k: 0 });
  store.commit(a);
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  expect(again.state.nodes.get(afterId(a, 'node'))!.title).toBe('Minimum Description Length Principle (MDL)');
  expect(again.state.placements.size).toBe(1);
  again.close();
});

test('le journal reçoit une ligne par opération, numéros locaux croissants, numéro serveur vide', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' });
  const plan = withPlan(store);
  const a = createNode(store.state, { plan, title: 'A', x: 0, y: 0, k: 0 });
  const rows = store.commit(a);
  expect(rows).toHaveLength(2);
  const all = store.changesSince(0);
  expect(all).toHaveLength(3);
  expect(all.map((r) => r.localSeq)).toEqual([1, 2, 3]);
  expect(all.every((r) => r.serverSeq === null && r.pc === 'pc1')).toBe(true);
  expect(rows.every((r) => r.actionId === a.id)).toBe(true);
  expect(all.map((r) => r.flow)).toEqual(['content', 'content', 'layout']);
  store.close();
});

test('action invalide : rien écrit, ni tables ni journal, état intact (Review Focus 2)', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' });
  const plan = withPlan(store);
  const ok = createNode(store.state, { plan, title: 'A', x: 0, y: 0, k: 0 });
  store.commit(ok);
  const n = store.state.nodes.get(afterId(ok, 'node'))!;
  const fresh: NodeRec = { id: 'n-new', title: 'B', summary: '', tags: [], files: [] };
  const bad: Action = { id: 'bad', label: 'bad', ops: [
    { t: 'node', before: null, after: fresh },
    { t: 'node', before: { ...n, title: 'périmé' }, after: { ...n, title: 'C' } },
  ] };
  const seqBefore = store.changesSince(0).length;
  expect(() => store.commit(bad)).toThrow();
  expect(store.state.nodes.has('n-new')).toBe(false);
  expect(store.changesSince(0)).toHaveLength(seqBefore);
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  expect(again.state.nodes.has('n-new')).toBe(false);
  expect(again.state.nodes.get(n.id)!.title).toBe('A');
  again.close();
});

test('historique par objet', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' });
  const plan = withPlan(store);
  const a = createNode(store.state, { plan, title: 'A', x: 0, y: 0, k: 0 });
  store.commit(a);
  const id = afterId(a, 'node');
  store.commit(editNode(store.state, id, { title: 'A2' }));
  store.commit(editNode(store.state, id, { title: 'A3' }));
  expect(store.historyOf(id).filter((r) => r.op.t === 'node')).toHaveLength(3);
  store.close();
});

test('corbeille', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' });
  const plan = withPlan(store);
  const a = createNode(store.state, { plan, title: 'A', x: 0, y: 0, k: 0 });
  store.commit(a);
  store.commit(removeFromPlan(store.state, plan, afterId(a, 'node')));
  expect(store.trash().map((n) => n.title)).toEqual(['A']);
  store.close();
});
