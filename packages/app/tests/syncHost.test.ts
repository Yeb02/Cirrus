import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNode, createPlan, decodeState, editNode, encodeState, type Id, type Reconciliation, reconcile, SyncDivergedError } from '@cirrus/core';
import { afterEach, expect, test, vi } from 'vitest';
import { SERVER_FILE } from '../src/main/sync/config.ts';
import { DOWNLOADS_FILE } from '../src/main/sync/downloads.ts';
import { FIRST_SYNC_LATER, insecureServer, SERVER_NOT_EMPTY } from '../src/main/sync/host.ts';
import { AppPc } from './support/appPc.ts';
import { created, Lab, sleep, until } from './support/virtualPc.ts';

// The main process's side of the synchronisation in the app (plan 5a, task 4): pairing and unpairing, the
// reconciliation's round trip through the interface, sleep and wake. A server in the process (Lab), the app's PC
// without Electron (AppPc), and virtual PCs (task 3).

let lab: Lab | null = null;
const apps: AppPc[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
});

async function app(l: Lab, name: string, params = {}): Promise<AppPc> {
  const a = new AppPc(l, name, params);
  apps.push(a);
  return a.open();
}

test('R10 : sans HTTPS, seul un serveur de cette machine', () => {
  expect(insecureServer('http://127.0.0.1:7310')).toBe(false);
  expect(insecureServer('http://localhost:7310')).toBe(false);
  expect(insecureServer('http://[::1]:7310')).toBe(false);
  expect(insecureServer('https://cirrus.example.org')).toBe(false);
  expect(insecureServer('http://192.168.1.20:7310')).toBe(true);
  expect(insecureServer('http://cirrus.example.org')).toBe(true);
  expect(insecureServer('http://127.0.0.2:7310')).toBe(true);
});

test('jumeler : refusé sans chiffrement de Windows, pour un http hors de cette machine, pour une base pas vide, sans rien demander au serveur ; un code faux : le message du serveur', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const code = l.code('Portable');
  a.canEncrypt = false;
  expect(await a.sync.pair(l.url, code, 'Portable')).toEqual({ ok: false, message: expect.stringMatching(/chiffrer/) });
  a.canEncrypt = true;
  expect(await a.sync.pair('http://192.168.1.20:7310', code, 'Portable')).toEqual({ ok: false, message: expect.stringMatching(/^Adresse refusée : sans HTTPS/) });
  expect(await a.sync.pair('ftp://127.0.0.1', code, 'Portable')).toEqual({ ok: false, message: 'Adresse du serveur invalide : http://hôte:port attendu.' });
  expect(await a.sync.pair(l.url, ' ', 'Portable')).toEqual({ ok: false, message: 'Donne le code de jumelage affiché par le serveur.' });
  expect(await a.sync.pair(l.url, code, '  ')).toEqual({ ok: false, message: 'Donne un nom à ce PC.' });
  // A base with a plan besides its lobby is not empty (D7): its first sync comes with the next step (R8).
  await a.session.run((s) => createPlan(s, 'Thèse', 'plan'));
  expect(await a.sync.pair(l.url, code, 'Portable')).toEqual({ ok: false, message: FIRST_SYNC_LATER });
  expect(a.net.requests).toEqual([]);
  expect(existsSync(join(a.dir, SERVER_FILE))).toBe(false);
  // The code was not spent: an empty PC takes it; a wrong one gets the server's word.
  const b = await app(l, 'pc-b');
  expect(await b.sync.pair(l.url, 'AAAA-AAAA-AAAA-AAAA', 'Fixe')).toEqual({ ok: false, message: expect.stringMatching(/code/i) });
  expect(await b.sync.pair(l.url, code, 'Portable')).toEqual({ ok: true });
});

test('jumeler un PC vide à un serveur vide : le jeton chiffré dans serveur.json, la synchro démarre, le lobby devient la première écriture du serveur ; les actions vont et viennent', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(a.host.info()).toEqual({ paired: false, url: '', name: 'PORTABLE' });
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  expect(a.host.info()).toEqual({ paired: true, url: l.url, name: 'Portable' });
  const stored = readFileSync(join(a.dir, SERVER_FILE), 'utf8');
  expect(JSON.parse(stored)).toMatchObject({ url: l.url, name: 'Portable' });
  await until(() => a.status?.state === 'live' && a.status.pending === 0, 5000, () => JSON.stringify(a.statuses));
  const journal = await l.journal();
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({ serverSeq: 1, op: { t: 'plan', after: { type: 'lobby' } } });
  expect(a.store.lastServerSeq()).toBe(1);
  expect(a.session.pending).toEqual([]);
  expect(a.view).toMatchObject({ veil: false, chip: { text: 'À jour' } });
  // A virtual PC receives the lobby, and puts a node there: the interface has it within a second, as one action.
  const b = await l.pc('pc-b');
  await until(() => b.store.lastServerSeq() === 1);
  const lobby = [...b.s.plans.values()][0].id;
  const t0 = Date.now();
  const X = created(b.act((s) => createNode(s, { plan: lobby, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  await until(() => a.session.state.nodes.has(X), 1000);
  expect(Date.now() - t0).toBeLessThan(1000);
  // The interface's action reaches B.
  expect((await a.session.run((s) => editNode(s, X, { title: 'X par A' }))).ok).toBe(true);
  await until(() => b.s.nodes.get(X)?.title === 'X par A');
  await l.settle([b]);
  await until(() => a.store.pendingCount() === 0 && a.session.pending.length === 0);
  expect(a.store.loadState().nodes.get(X)?.title).toBe('X par A');
});

test('un serveur dont le journal n’est pas vide, même d’un lobby seul : jumelage refusé après l’échange du code, rien de gardé ni de démarré (R11 : la première synchro arrive avec l’étape suivante)', async () => {
  const l = (lab = await Lab.start());
  // A first PC paired: its lobby is the server's first write.
  const first = await app(l, 'pc-0');
  expect(await first.sync.pair(l.url, l.code('Premier'), 'Premier')).toEqual({ ok: true });
  await until(async () => (await l.lastSeq()) === 1);
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: false, message: SERVER_NOT_EMPTY });
  // A plan besides the lobby, from a virtual PC: refused the same.
  const b = await l.pc('pc-b');
  b.act((s) => createPlan(s, 'Thèse', 'plan'));
  await l.settle([b]);
  expect(await a.sync.pair(l.url, l.code('Portable 2'), 'Portable')).toEqual({ ok: false, message: SERVER_NOT_EMPTY });
  expect(existsSync(join(a.dir, SERVER_FILE))).toBe(false);
  expect(a.host.paired()).toBe(false);
  expect(a.net.count('GET', '/events')).toBe(0);
  expect(a.statuses.every((s) => s.state === 'off')).toBe(true);
  expect((await l.journal()).filter((r) => r.op.t === 'plan' && (r.op.after as { type?: string } | null)?.type === 'lobby')).toHaveLength(1);
});

test('dissocier : le client arrêté, downloads.json et serveur.json effacés ; ensuite, rien ne part', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  writeFileSync(join(a.dir, DOWNLOADS_FILE), JSON.stringify({ hashes: ['a'.repeat(64)] }));
  await a.sync.unpair();
  expect([existsSync(join(a.dir, SERVER_FILE)), existsSync(join(a.dir, DOWNLOADS_FILE)), a.status?.state, a.host.paired()]).toEqual([false, false, 'off', false]);
  await until(() => a.view?.chip === null && a.view.veil === false);
  const before = a.net.requests.length;
  const lobby = [...a.session.state.plans.values()][0].id;
  expect((await a.session.run((s) => createNode(s, { plan: lobby, title: 'Seul', x: 0, y: 0, k: 0 }))).ok).toBe(true);
  await sleep(100);
  expect(a.net.requests.length).toBe(before);
  expect(a.session.pending).toEqual([]);
  expect(a.store.pendingCount()).toBe(1);
});

test('reconcile : la base écrit la réconciliation de l’interface avant de rendre son numéro ; une divergence de l’interface rejette par SyncDivergedError ; une fenêtre fermée rejette', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  a.answers = false;
  // The lobby, pending, acknowledged by the server (line 1), and B's node Y after it.
  const lobby = a.session.state.plans.values().next().value!;
  const ops = createNode(a.session.state, { plan: lobby.id, title: 'Y', x: 0, y: 0, k: 0 }).ops;
  const unit = { unit: 'u-1', action: 'a-1', label: 'Créer « Y »', at: 1, pc: 'pc-b', seq: 1 + ops.length, ops };
  const first = { ...a.store.pendingUnits()[0], seq: 1 };
  let done = false;
  const p = a.host.reconcile([first, unit], []).then(() => { done = true; });
  await until(() => a.incoming.length === 1);
  await sleep(20);
  expect(done).toBe(false);
  const m = a.incoming[0];
  const r: Reconciliation = reconcile(decodeState(encodeState(a.session.state)), a.store.pendingUnits(), m.units, m.refused);
  const seq = a.host.reconciled(m.id, { reconciliation: r });
  await p;
  expect([done, seq, a.store.lastServerSeq(), a.store.pendingCount()]).toEqual([true, a.store.lastSeq(), unit.seq, 0]);
  // An unknown or settled identifier: refused, nothing written.
  expect(() => a.host.reconciled(m.id, { reconciliation: r })).toThrow(/inconnue/);
  // The interface's reconcile diverged: a real SyncDivergedError in the main process.
  const q = a.host.reconcile([{ ...unit, unit: 'u-2', seq: unit.seq + 2 }], []);
  await until(() => a.incoming.length === 2);
  expect(a.host.reconciled(a.incoming[1].id, { diverged: 'La base de ce PC ne suit plus celle du serveur : …' })).toBeNull();
  await expect(q).rejects.toBeInstanceOf(SyncDivergedError);
  // Any other failure of the interface: a plain Error (a broken connection for the client).
  const e = a.host.reconcile([{ ...unit, unit: 'u-3', seq: unit.seq + 2 }], []);
  await until(() => a.incoming.length === 3);
  a.host.reconciled(a.incoming[2].id, { error: 'panne' });
  await expect(e).rejects.not.toBeInstanceOf(SyncDivergedError);
  // A window gone: rejected, so that stop() never hangs.
  const w = a.host.reconcile([{ ...unit, unit: 'u-4', seq: unit.seq + 2 }], []);
  await until(() => a.incoming.length === 4);
  a.host.detach();
  await expect(w).rejects.toThrow(/Fenêtre/);
  a.windowOpen = false;
  await expect(a.host.reconcile([{ ...unit, unit: 'u-5', seq: unit.seq + 2 }], [])).rejects.toThrow(/Fenêtre/);
});

test('une réconciliation dont les écritures reçues ne sont pas celles du serveur est refusée, rien d’écrit', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  a.answers = false;
  const first = { ...a.store.pendingUnits()[0], seq: 1 };
  const p = a.host.reconcile([first], []);
  await until(() => a.incoming.length === 1);
  const forged: Reconciliation = { rewind: [], remote: [{ ...first, unit: 'autre' }], rebased: [], dropped: [], acked: ['autre'], notices: [] };
  expect(() => a.host.reconciled(a.incoming[0].id, { reconciliation: forged })).toThrow(/Réconciliation incohérente/);
  await expect(p).rejects.toThrow(/Réconciliation incohérente/);
  expect([a.store.lastServerSeq(), a.store.pendingCount()]).toEqual([0, 1]);
});

test('veille : flush(syncSuspendFlushMs) ; réveil : le voile, puis stop et start, jamais start pendant un stop ; un clic « Réessayer » pendant un stop attend sa fin', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a', { syncSuspendFlushMs: 1234 });
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live');
  const client = a.host.client;
  const flush = vi.spyOn(client, 'flush');
  await a.host.suspend();
  expect(flush).toHaveBeenCalledWith(1234);
  const events: string[] = [];
  const stop = client.stop.bind(client), start = client.start.bind(client);
  let stopping = false;
  vi.spyOn(client, 'stop').mockImplementation(async () => {
    events.push('stop');
    stopping = true;
    await sleep(50);
    await stop();
    stopping = false;
    events.push('stopped');
  });
  vi.spyOn(client, 'start').mockImplementation(() => {
    events.push(stopping ? 'start pendant un stop' : 'start');
    start();
  });
  const woke = a.host.resume();
  await sleep(10);
  a.host.retry();
  await woke;
  await until(() => events.length >= 4);
  expect(a.veils).toBe(1);
  expect(events).toEqual(['stop', 'stopped', 'start', 'start']);
  await until(() => a.status?.state === 'live');
  await until(() => a.view?.veil === false);
});

test('commit : l’heure du principal corrigée de l’écart du serveur, rendue à l’interface et gardée dans l’écriture en attente ; un identifiant invalide est refusé', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live');
  const offset = a.host.client.clockOffset();
  const lobby = [...a.session.state.plans.values()][0].id;
  const r = await a.session.run((s) => createNode(s, { plan: lobby, title: 'Z', x: 0, y: 0, k: 0 }));
  expect(r.ok).toBe(true);
  const row = a.store.changesSince(0).at(-1)!;
  expect(row.at).toBe(l.clock + offset);
  const sent = a.session.pending.find((u) => u.unit === row.unit) ?? (await l.journal()).find((x) => x.unit === row.unit);
  expect(sent?.at).toBe(row.at);
  expect(() => a.host.commit(createNode(a.session.state, { plan: lobby, title: 'W', x: 0, y: 0, k: 0 }), '' as Id)).toThrow(/identifiant/);
});
