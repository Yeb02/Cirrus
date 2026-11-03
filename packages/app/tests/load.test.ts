import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Action, canonical, createNode, decodeState, editNode, encodeState, moveNodes, SNAPSHOT_VERSION, type State, toSnapshot } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { keepSnapshot, loadPayload, saveSnapshot } from '../src/main/base.ts';
import { EditSession, openState } from '../src/renderer/session.ts';

let dir: string;
let ids: FixtureIds;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-load-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  store.close();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sorted = (s: State) => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, (v as unknown[]).map((x) => canonical(x)).sort()])));
const open = () => LocalStore.open(dir, { pc: 'test' });
/** cirrus:load as the main process answers it (index.ts): the payload copied across, a rebuilt snapshot kept once sent. */
function bridge(store: LocalStore, calls: boolean[] = []) {
  return async (fromTables: boolean) => {
    calls.push(fromTables);
    const { payload, rebuilt } = loadPayload(store, fromTables);
    const sent = structuredClone(payload);
    if (rebuilt) keepSnapshot(store, payload.data, payload.seq);
    return sent;
  };
}
/** The interface's session over the store, as App wires it: each commit's journal number kept. */
const sessionOn = (store: LocalStore, s: State, seq: number) => new EditSession(s, async (a: Action) => store.commit(a), () => {}, seq);

test('sans instantané : l’état des tables, encodé par le principal, gardé ensuite comme instantané', async () => {
  const store = open(), calls: boolean[] = [];
  expect(store.readSnapshot()).toBeNull();
  const o = await openState(bridge(store, calls));
  expect(sorted(o.state)).toBe(sorted(store.loadState()));
  expect([o.seq, o.stale, o.fallback, calls]).toEqual([store.lastSeq(), false, undefined, [false]]);
  expect(store.readSnapshot()).toMatchObject({ seq: store.lastSeq(), version: SNAPSHOT_VERSION });
  // The next start reads that snapshot, with an empty tail.
  const again = loadPayload(store, false);
  expect([again.rebuilt, again.payload.tail, again.payload.seq]).toEqual([false, '[]', store.lastSeq()]);
  store.close();
});

test('instantané plus fin du journal égalent l’état complet, y compris après une fermeture brutale (actions écrites, pas d’instantané)', async () => {
  let store = open();
  const first = await openState(bridge(store));
  const snapSeq = store.readSnapshot()!.seq;
  const session = sessionOn(store, first.state, first.seq);
  for (const build of [
    (s: State) => editNode(s, ids.nodes.mdl, { title: 'MDL renommé' }),
    (s: State) => moveNodes(s, ids.plans.lobby, [{ node: ids.nodes.monde, x: 12, y: -40 }]),
    (s: State) => createNode(s, { plan: ids.plans.these, title: 'Écrit avant la panne', x: 1, y: 2, k: 0 }),
  ]) expect((await session.run(build)).ok).toBe(true);
  expect(session.seq).toBe(store.lastSeq());
  // Brutal close: the journal has the three actions, the snapshot does not.
  store.close();
  store = open();
  expect(store.readSnapshot()!.seq).toBe(snapSeq);
  const { payload } = loadPayload(store, false);
  expect((JSON.parse(payload.tail) as unknown[]).length).toBe(store.lastSeq() - snapSeq);
  const calls: boolean[] = [];
  const o = await openState(bridge(store, calls));
  expect(calls).toEqual([false]);
  expect(sorted(o.state)).toBe(sorted(store.loadState()));
  expect(sorted(o.state)).toBe(sorted(session.state));
  expect([o.seq, o.stale]).toEqual([store.lastSeq(), true]);
  store.close();
});

test('un instantané endommagé retombe sur les tables, sans rien perdre, et un bon le remplace', async () => {
  const store = open(), full = sorted(store.loadState());
  const bad = encodeState(store.loadState());
  new Uint8Array(bad)[Math.floor(bad.byteLength / 2)] ^= 0xff;
  store.writeSnapshot(bad, store.lastSeq());
  const calls: boolean[] = [];
  const o = await openState(bridge(store, calls));
  expect(calls).toEqual([false, true]);
  expect(o.fallback).toMatch(/endommagé/);
  expect(sorted(o.state)).toBe(full);
  expect(sorted(decodeState(store.readSnapshot()!.data))).toBe(full);
  store.close();
});

test('un instantané d’une autre version n’est pas envoyé : le principal lit les tables', async () => {
  const store = open(), full = sorted(store.loadState());
  const other = encodeState(store.loadState());
  new Uint32Array(other, 0, 2)[1] = SNAPSHOT_VERSION + 1;
  store.writeSnapshot(other, store.lastSeq());
  expect(store.readSnapshot()!.version).toBe(SNAPSHOT_VERSION + 1);
  expect(loadPayload(store, false).rebuilt).toBe(true);
  const calls: boolean[] = [];
  const o = await openState(bridge(store, calls));
  expect(calls).toEqual([false]);
  expect(sorted(o.state)).toBe(full);
  expect(store.readSnapshot()!.version).toBe(SNAPSHOT_VERSION);
  store.close();
});

test('des tables qui ne se relisent pas au chemin de secours : l’erreur remonte, l’instantané gardé reste en place', async () => {
  const store = open();
  await openState(bridge(store));
  const kept = store.readSnapshot()!;
  store.loadState = () => { throw new Error('ligne illisible'); };
  expect(() => loadPayload(store, true)).toThrow(/ligne illisible.*instantané est gardé/);
  expect(store.readSnapshot()).toMatchObject({ seq: kept.seq, version: kept.version });
  // A snapshot of another version, which would send the load to the tables: kept as well.
  const other = encodeState(decodeState(kept.data));
  new Uint32Array(other, 0, 2)[1] = SNAPSHOT_VERSION + 1;
  store.dropSnapshot();
  store.writeSnapshot(other, kept.seq);
  expect(() => loadPayload(store, false)).toThrow(/ligne illisible/);
  expect(store.readSnapshot()).toMatchObject({ seq: kept.seq, version: SNAPSHOT_VERSION + 1 });
  // The interface, refused twice, reports it rather than opening an empty base.
  await expect(openState(bridge(store))).rejects.toThrow(/ligne illisible/);
  store.close();
});

test('un instantané qui ne couvre pas le numéro qu’il annonce : la fin du journal ne s’applique pas, retour aux tables', async () => {
  const store = open(), s = store.loadState(), stale = encodeState(s);
  const session = sessionOn(store, s, store.lastSeq());
  expect((await session.run((st) => editNode(st, ids.nodes.mdl, { title: 'Un' }))).ok).toBe(true);
  const claimed = store.lastSeq();
  expect((await session.run((st) => editNode(st, ids.nodes.mdl, { title: 'Deux' }))).ok).toBe(true);
  // Written as if it covered the first edit, which it does not: the second's "before" no longer matches.
  store.writeSnapshot(stale, claimed);
  const calls: boolean[] = [];
  const o = await openState(bridge(store, calls));
  expect(calls).toEqual([false, true]);
  expect(o.fallback).toBeDefined();
  expect(o.state.nodes.get(ids.nodes.mdl)!.title).toBe('Deux');
  expect(sorted(o.state)).toBe(sorted(store.loadState()));
  store.close();
});

test('l’instantané envoyé par l’interface : arguments vérifiés, un plus ancien ne remplace pas un plus récent', async () => {
  const store = open(), s = store.loadState(), older = encodeState(s), olderSeq = store.lastSeq();
  const session = sessionOn(store, s, olderSeq);
  expect((await session.run((st) => editNode(st, ids.nodes.mdl, { title: 'Plus récent' }))).ok).toBe(true);
  const newer = encodeState(session.state);
  saveSnapshot(store, newer, session.seq);
  saveSnapshot(store, older, olderSeq);
  expect(store.readSnapshot()!.seq).toBe(session.seq);
  expect(decodeState(store.readSnapshot()!.data).nodes.get(ids.nodes.mdl)!.title).toBe('Plus récent');
  for (const [data, seq] of [['pas un tampon', 1], [newer, 1.5], [newer, -1], [newer, Number.NaN], [newer, '3'], [new ArrayBuffer(16), 1]] as const) {
    expect(() => saveSnapshot(store, data, seq), `${typeof data} ${String(seq)}`).toThrow();
  }
  expect(store.readSnapshot()!.seq).toBe(session.seq);
  // The base, read straight from the file, holds one snapshot row.
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  expect(db.prepare('SELECT count(*) AS n FROM snapshot').get()).toEqual({ n: 1 });
  db.close();
  store.close();
});
