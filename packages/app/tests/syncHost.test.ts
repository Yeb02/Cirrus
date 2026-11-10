import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNode, createPlan, decodeState, editNode, encodeState, type Id, MAX_BODY_BYTES, MAX_ID_CHARS, MAX_OPS_PER_UNIT, type NodeRec, type Op, type Reconciliation, reconcile, type State, SyncDivergedError } from '@cirrus/core';
import { afterEach, expect, test, vi } from 'vitest';
import { SERVER_FILE } from '../src/main/sync/config.ts';
import { DOWNLOADS_FILE } from '../src/main/sync/downloads.ts';
import { watchWindow } from '../src/main/sync/host.ts';
import { insecureServer } from '../src/main/sync/pairing.ts';
import { EventEmitter } from 'node:events';
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

test('jumeler : refusé sans chiffrement de Windows, pour un http hors de cette machine, sans code ni nom, sans rien demander au serveur ; un code faux : le message du serveur', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const code = l.code('Portable');
  a.canEncrypt = false;
  expect(await a.sync.pair(l.url, code, 'Portable')).toEqual({ ok: false, message: expect.stringMatching(/chiffrer/) });
  a.canEncrypt = true;
  expect(await a.sync.pair('http://192.168.1.20:7310', code, 'Portable')).toEqual({ ok: false, message: expect.stringMatching(/^Adresse refusée : sans HTTPS/) });
  expect(await a.sync.pair('ftp://127.0.0.1', code, 'Portable')).toEqual({
    ok: false, message: 'Adresse du serveur invalide : https://domaine (ou http://127.0.0.1:port pour un serveur de cette machine) attendu.',
  });
  expect(await a.sync.pair(l.url, ' ', 'Portable')).toEqual({ ok: false, message: 'Donne le code de jumelage affiché par le serveur.' });
  expect(await a.sync.pair(l.url, code, '  ')).toEqual({ ok: false, message: 'Donne un nom à ce PC.' });
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

/**
 * An app PC whose base is empty but was used (a node created, then undone): not vierge, so that a server holding a base
 * asks it D7's question (a vierge one takes the server's base at once: after the short review of plan 5a).
 */
async function used(l: Lab, name: string): Promise<AppPc> {
  const a = await app(l, name);
  const lobby = [...a.session.state.plans.values()][0].id;
  expect((await a.session.run((s) => createNode(s, { plan: lobby, title: 'Essai', x: 0, y: 0, k: 0 }))).ok).toBe(true);
  expect((await a.session.undo()).ok).toBe(true);
  expect(a.store.isEmpty()).toBe(true);
  return a;
}

test('un serveur dont le journal n’est pas vide, même d’un lobby seul : un PC vide se voit proposer de prendre sa base (R7) ; rien de gardé ni de démarré avant sa réponse ; vierge, il la prend aussitôt', async () => {
  const l = (lab = await Lab.start());
  // A first PC paired: its lobby is the server's first write.
  const first = await app(l, 'pc-0');
  expect(await first.sync.pair(l.url, l.code('Premier'), 'Premier')).toEqual({ ok: true });
  await until(async () => (await l.lastSeq()) === 1);
  const a = await used(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'adopt', nodes: 0 } });
  // The question held by the main process, for the block to show again (a panel closed and opened).
  expect(a.host.info()).toMatchObject({ paired: false, url: l.url, name: 'Portable', offer: { offer: { kind: 'adopt' } } });
  expect(await a.sync.first('cancel')).toMatchObject({ ok: false });
  expect(a.host.info()).toEqual({ paired: false, url: '', name: 'PORTABLE' });
  // A plan besides the lobby, from a virtual PC: the same offer.
  const b = await l.pc('pc-b');
  b.act((s) => createPlan(s, 'Thèse', 'plan'));
  await l.settle([b]);
  expect(await a.sync.pair(l.url, l.code('Portable 2'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'adopt', nodes: 0 } });
  expect(existsSync(join(a.dir, SERVER_FILE))).toBe(false);
  expect(a.host.paired()).toBe(false);
  expect(a.net.count('GET', '/events')).toBe(0);
  expect(a.statuses.every((s) => s.state === 'off')).toBe(true);
  expect((await l.journal()).filter((r) => r.op.t === 'plan' && (r.op.after as { type?: string } | null)?.type === 'lobby')).toHaveLength(1);
  // A vierge PC is not asked: it takes the server's base at once (R7 all the same: never a second lobby).
  const v = await app(l, 'pc-v');
  expect(await v.sync.pair(l.url, l.code('Vierge'), 'Vierge')).toEqual({ ok: true, restarting: true });
  expect([v.relaunched, v.serversTold.some((i) => i.offer !== undefined)]).toEqual([1, false]);
  expect((await l.journal()).filter((r) => r.op.t === 'plan' && (r.op.after as { type?: string } | null)?.type === 'lobby')).toHaveLength(1);
});

test('revue courte du plan 5a, B2 : le principal dit à la fenêtre chaque changement du jumelage (cirrus:sync:server) — une offre, un jumelage fait, une dissociation', async () => {
  const l = (lab = await Lab.start());
  const first = await app(l, 'pc-0');
  // A call of the host itself, not the interface's: what the window is told comes from the main process.
  expect(await first.host.pair(l.url, l.code('Premier'), 'Premier')).toEqual({ ok: true });
  expect(first.serversTold.at(-1)).toEqual({ paired: true, url: l.url, name: 'Premier' });
  await until(async () => (await l.lastSeq()) === 1);
  // An offer (the server holds a lobby, this PC's base was used), then given up: each told.
  const a = await used(l, 'pc-a');
  expect(await a.host.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'adopt' } });
  expect(a.serversTold.at(-1)).toMatchObject({ paired: false, url: l.url, name: 'Portable', offer: { offer: { kind: 'adopt' } } });
  await a.host.first('cancel');
  expect(a.serversTold.at(-1)).toEqual({ paired: false, url: '', name: 'PORTABLE' });
  await first.host.unpair();
  expect(first.serversTold.at(-1)).toEqual({ paired: false, url: '', name: 'PORTABLE' });
});

test('dissocier : le client arrêté, downloads.json et serveur.json effacés ; ensuite, rien ne part', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  writeFileSync(join(a.dir, DOWNLOADS_FILE), JSON.stringify({ hashes: ['a'.repeat(64)] }));
  await a.sync.unpair();
  expect([existsSync(join(a.dir, SERVER_FILE)), existsSync(join(a.dir, DOWNLOADS_FILE)), a.status?.state, a.host.paired()]).toEqual([false, false, 'off', false]);
  // R15: its token revoked by the PC itself, at best.
  expect(a.net.count('POST', '/unpair')).toBe(1);
  expect(await l.pairedNames()).not.toContain('Portable');
  await until(() => a.view?.chip === null && a.view.veil === false);
  const before = a.net.requests.length;
  const lobby = [...a.session.state.plans.values()][0].id;
  expect((await a.session.run((s) => createNode(s, { plan: lobby, title: 'Seul', x: 0, y: 0, k: 0 }))).ok).toBe(true);
  await sleep(100);
  expect(a.net.requests.length).toBe(before);
  expect(a.session.pending).toEqual([]);
  expect(a.store.pendingCount()).toBe(1);
});

test('relecture des corrections du plan 5a, N2 : la page rechargée (Ctrl+R) pendant une dissociation s’ouvre jumelée ; le principal dit ensuite la dissociation faite, et un jumelage refait dans la même session démarre la synchro', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  // « Dissocier ce PC », asked by the page about to go: its answer reaches no one, so the call is the host's own. The new
  // page asks the main process before the unpairing clears the server: paired, it follows and asks to start — a start
  // that runs after the unpairing, and finds no server.
  const seen = a.views.length;
  const unpairing = a.host.unpair();
  await a.reload();
  await unpairing;
  expect(a.views.slice(seen).some((v) => v.veil)).toBe(true);
  await until(() => a.servers.at(-1)?.paired === false);
  expect(a.host.paired()).toBe(false);
  // Paired again (R31) without a relaunch: the synchronisation starts, and a write reaches the server.
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  const lobby = [...a.session.state.plans.values()][0].id;
  expect((await a.session.run((s) => createNode(s, { plan: lobby, title: 'Après', x: 0, y: 0, k: 0 }))).ok).toBe(true);
  await until(() => a.status?.state === 'live' && a.status.pending === 0 && a.store.pendingCount() === 0, 3000, () => `état ${JSON.stringify(a.statuses.slice(-3))}, ${a.store.pendingCount()} en attente`);
  expect([...(await l.state()).nodes.values()].map((n) => n.title)).toEqual(['Après']);
});

test('reconcile : la base écrit la réconciliation de l’interface avant de rendre son numéro ; une divergence de l’interface rejette par SyncDivergedError ; une fenêtre fermée rejette', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  a.answers = false;
  // The page holds its state and listens (cirrus:sync:start): reconciliations may be sent to it (R13).
  await a.host.start();
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
  // Until a page asks to start again, nothing is sent (R13); and without a window at all, nothing either.
  await expect(a.host.reconcile([{ ...unit, unit: 'u-5', seq: unit.seq + 2 }], [])).rejects.toThrow(/pas prête/);
  await a.host.start();
  a.windowOpen = false;
  await expect(a.host.reconcile([{ ...unit, unit: 'u-6', seq: unit.seq + 2 }], [])).rejects.toThrow(/Fenêtre/);
});

test('une réconciliation dont les écritures reçues ne sont pas celles du serveur est refusée, rien d’écrit', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  a.answers = false;
  // The page holds its state and listens (cirrus:sync:start): reconciliations may be sent to it (R13).
  await a.host.start();
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

// ---------------------------------------------------------------------------------------------------------------------
// Final review of plan 5a, Important 2 (R32): a base never holds a write the server's gate would refuse.

test('R32 : une action que le serveur refuserait (trop d’opérations, trop grosse, mal formée) est refusée avant d’être écrite, en français, jumelé ou non ; rien n’est écrit ni envoyé', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const lobby = [...a.session.state.plans.values()][0].id;
  const X = (await a.session.run((s) => createNode(s, { plan: lobby, title: 'X', x: 0, y: 0, k: 0 }))).ok ? [...a.session.state.nodes.keys()][0] : '';
  const x = () => a.session.state.nodes.get(X)!;
  const refusals = async () => {
    const lines = a.store.lastSeq(), before = JSON.stringify(x());
    const out: string[] = [];
    // Deleting more than MAX_OPS_PER_UNIT records at once, say (the same operation, as many times: never applied).
    const op: Op = { t: 'node', before: x(), after: { ...x(), title: 'X' } };
    for (const build of [
      () => ({ id: 'a-n', label: 'Beaucoup', ops: Array.from({ length: MAX_OPS_PER_UNIT + 1 }, () => op) }),
      (s: State) => editNode(s, X, { summary: 's'.repeat(MAX_BODY_BYTES) }),
      (s: State) => editNode(s, X, { tags: [{ key: 'k'.repeat(MAX_ID_CHARS + 1) }] }),
    ]) {
      const r = await a.session.run(build);
      out.push(r.ok ? 'acceptée' : r.message);
    }
    expect([a.store.lastSeq(), JSON.stringify(x())]).toEqual([lines, before]);
    return out;
  };
  const expected = [
    `Action refusée : elle compte ${(MAX_OPS_PER_UNIT + 1).toLocaleString('fr-FR')} opérations, et le serveur en prend ${MAX_OPS_PER_UNIT.toLocaleString('fr-FR')} au plus. Fais-la en plusieurs fois.`,
    `Action refusée : elle fait plus de ${MAX_BODY_BYTES / 2 ** 20} Mio, ce que le serveur ne prend pas.`,
    expect.stringMatching(/^Action refusée : Opération mal formée : node\.after\.tags\[0\]\.key n’est pas un identifiant de 1 à 128 caractères/),
  ];
  // Without a server: refused all the same (nothing visible changes but the refusal itself).
  expect(await refusals()).toEqual(expected);
  // Paired: refused before anything is sent.
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'seed' } });
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  const sent = a.net.count('POST', '/units');
  expect(await refusals()).toEqual(expected);
  // A normal action passes, and goes.
  expect((await a.session.run((s) => editNode(s, X, { title: 'X2' }))).ok).toBe(true);
  await until(() => a.store.pendingCount() === 0 && a.net.count('POST', '/units') === sent + 1);
});

test('R32 : un nœud qu’une version plus ancienne a laissé avec une clé de tag trop longue reste modifiable (renommé, son tag retiré), jumelé ou non', async () => {
  const l = (lab = await Lab.start());
  const a = new AppPc(l, 'pc-a');
  apps.push(a);
  // As an older app wrote it, before the bound: a node with a word tag of 200 characters.
  const s = a.store.loadState(), lobby = [...s.plans.values()][0].id, long = 'mot'.repeat(70);
  const made = createNode(s, { plan: lobby, title: 'Ancien', x: 0, y: 0, k: 0 });
  a.store.commit(made);
  const N = (made.ops[0].after as { id: Id }).id, n = { ...(made.ops[0].after as NodeRec), tags: [{ key: long }, { key: 'lu' }] };
  a.store.commit({ id: 'a-tag', label: 'Tag', ops: [{ t: 'node', before: made.ops[0].after as NodeRec, after: n }] });
  await a.open();
  expect((await a.session.run((t) => editNode(t, N, { title: 'Renommé' }))).ok).toBe(true);
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'seed' } });
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  expect((await a.session.run((t) => editNode(t, N, { tags: [{ key: 'lu' }] }))).ok).toBe(true);
  await until(async () => a.store.pendingCount() === 0 && (await l.state()).nodes.get(N)?.tags.length === 1, 5000, () => JSON.stringify(a.statuses.slice(-2)));
  expect(a.store.loadState().nodes.get(N)).toMatchObject({ title: 'Renommé', tags: [{ key: 'lu' }] });
});

test('R13 : la page rechargée (detach), une écriture reçue avant le cirrus:sync:start de la nouvelle est rejetée aussitôt ; stop() rend la main ; après start, le lot est réconcilié', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  const b = await l.pc('pc-b');
  await until(() => b.store.lastServerSeq() === 1);
  // The page reloads: nothing listens until the new one asks to start.
  a.answers = false;
  a.host.detach();
  const sent = a.incoming.length;
  const lobby = [...b.s.plans.values()][0].id;
  const X = created(b.act((s) => createNode(s, { plan: lobby, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  await until(async () => (await l.lastSeq()) === 3);
  await sleep(200);
  expect(a.incoming.length).toBe(sent);
  // Nothing hangs: the client stops.
  let stopped = false;
  await Promise.race([a.host.client.stop().then(() => { stopped = true; }), sleep(3000)]);
  expect(stopped).toBe(true);
  // The new page is ready: the batch comes again, reconciled.
  a.answers = true;
  await a.host.start();
  await until(() => a.session.state.nodes.has(X) && a.store.lastServerSeq() === 3, 5000, () => JSON.stringify(a.statuses.slice(-3)));
});

test('revue, Minor 2 : dissocier efface d’abord serveur.json ; une liste des téléchargements qui ne s’efface pas est seulement signalée', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  // A list that cannot be removed (here, a folder of that name).
  mkdirSync(join(a.dir, DOWNLOADS_FILE, 'bloqué'), { recursive: true });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await a.host.unpair();
  expect([a.host.paired(), existsSync(join(a.dir, SERVER_FILE)), a.status?.state]).toEqual([false, false, 'off']);
  expect(warn.mock.calls.some((c) => String(c[0]).includes(DOWNLOADS_FILE))).toBe(true);
});

test('revue, Minor 11 : dissocier pendant un démarrage, jumeler pendant un arrêt — la file les fait l’un après l’autre', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  // A pairing asked while a stop (waking) runs: it waits for the stop, then refuses (already paired).
  const client = a.host.client, stop = client.stop.bind(client), events: string[] = [];
  vi.spyOn(client, 'stop').mockImplementation(async () => {
    events.push('stop');
    await sleep(50);
    await stop();
    events.push('stopped');
  });
  const woke = a.host.resume();
  const paired = a.host.pair(l.url, l.code('Autre'), 'Autre').then((r) => { events.push('pair'); return r; });
  await woke;
  expect(await paired).toEqual({ ok: false, message: 'Ce PC est déjà jumelé à un serveur : dissocie-le d’abord.' });
  expect(events).toEqual(['stop', 'stopped', 'pair']);
  // Unpairing asked during a start: the start first, then the stop; nothing starts again.
  const started = a.host.start();
  await a.host.unpair();
  await started;
  expect([a.host.paired(), a.status?.state]).toEqual([false, 'off']);
  const hellos = a.net.count('GET', '/hello');
  await sleep(200);
  expect(a.net.count('GET', '/hello')).toBe(hellos);
});

test('revue 2, Minor 1 : une navigation commencée puis refusée ne détache rien ; une navigation faite (did-navigate), un rendu perdu ou la fenêtre fermée détachent', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  a.answers = false;
  await a.host.start();
  const win = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  watchWindow(win, a.host);
  const unit = { ...a.store.pendingUnits()[0], seq: 1 };
  const sent = () => a.incoming.length;
  // Started, then refused by will-navigate (a link dropped on the page): Electron emits no did-navigate.
  win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://exemple.org/' });
  const first = a.host.reconcile([unit], []);
  await until(() => sent() === 1);
  // The page is still the same, its reconciliations still go to it: committed now, they are rejected, and none is sent
  // until a page asks to start (the reload case, R13).
  win.webContents.emit('did-navigate', {}, 'file:///index.html');
  await expect(first).rejects.toThrow(/Fenêtre/);
  await expect(a.host.reconcile([unit], [])).rejects.toThrow(/pas prête/);
  expect(sent()).toBe(1);
  // A same-document navigation (an anchor) detaches nothing; a crash or the window closed does.
  await a.host.start();
  win.webContents.emit('did-navigate-in-page', {}, 'file:///index.html#x');
  const kept = a.host.reconcile([unit], []);
  await until(() => sent() === 2);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await expect(kept).rejects.toThrow(/Fenêtre/);
  await a.host.start();
  const last = a.host.reconcile([unit], []);
  await until(() => sent() === 3);
  win.emit('closed');
  await expect(last).rejects.toThrow(/Fenêtre/);
});
