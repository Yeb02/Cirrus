import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, applyOps, canonical, createNode, createPlan, decodeState, editNode, emptyState, encodeState, type Id, include, type State, toSnapshot,
} from '@cirrus/core';
import { type ChangeRow, LocalStore } from '@cirrus/store';
import { MAX_JOURNAL_PAGE, MAX_SEED_BYTES } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Tokens } from '../src/tokens.ts';
import { Client, EventReader, newCode, pair, T0 } from './support.ts';

// The first sync (plan 5a, task 5, D7, R16): a PC sends its base to an empty server — its snapshot, streamed to a
// temporary file, then its journal by pages, then « done », which makes the server not empty —; the last PC to start
// a seed owns it; a partial seed stays invisible. And a PC revokes its own token (R15).

let dir: string;
const running: RunningServer[] = [];
const stores: LocalStore[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-semis-')); });
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<RunningServer> {
  const s = await startServer({ dataDir: join(dir, 'serveur'), port: 0, now: () => T0 });
  running.push(s);
  return s;
}

async function paired(url: string, pc: string, data = 'serveur'): Promise<Client> {
  const res = await pair(url, { code: newCode(join(dir, data), pc, T0), pc, name: `Machine ${pc}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

const image = (s: State) => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));
const created = (a: Action, t: 'node' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

/**
 * A PC's base, as the app keeps it: a lobby, a plan, nodes and their edits, written action by action; its snapshot
 * stored at `snapshotAt` lines (the interface saves one now and then: the lines after it are the journal's tail).
 */
function pcBase(pc: string, snapshotAt?: number): { store: LocalStore; s: State; X: Id } {
  const store = LocalStore.open(join(dir, pc), { pc }), s = emptyState();
  stores.push(store);
  const run = (a: Action) => { store.commit(a); applyOps(s, a.ops); return a; };
  run(createPlan(s, 'Lobby', 'lobby'));
  const P = created(run(createPlan(s, 'Thèse', 'plan')), 'plan');
  const X = created(run(createNode(s, { plan: P, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  const G = created(run(createNode(s, { plan: P, title: 'G', x: 100, y: 0, k: 0 })), 'node');
  if (snapshotAt !== undefined) store.writeSnapshot(encodeState(replay(store.changesSince(0).slice(0, snapshotAt))), snapshotAt);
  run(include(s, P, X, G));
  run(editNode(s, X, { title: 'X2' }));
  run(editNode(s, X, { summary: 'résumé' }));
  return { store, s, X };
}

const replay = (rows: ChangeRow[]): State => { const t = emptyState(); applyOps(t, rows.map((r) => r.op)); return t; };

const seedBody = (state: State) => new Uint8Array(encodeState(state));
const send = (c: Client, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(c.url + path, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const sendSnapshot = (c: Client, bytes: Uint8Array, seq: number) =>
  fetch(`${c.url}/seed`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/octet-stream', 'Cirrus-Seq': String(seq) }, body: bytes });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

async function journal(c: Client): Promise<ChangeRow[]> {
  const rows: ChangeRow[] = [];
  for (;;) {
    const page = ((await (await c.get(`/journal?after=${rows.at(-1)?.localSeq ?? 0}`)).json()) as { rows: ChangeRow[] }).rows;
    if (page.length === 0) return rows;
    rows.push(...page);
  }
}

test('seed : l’instantané, le journal par pages, puis done ; le serveur tient l’état et l’historique du PC, numérotés, et le dit (hello)', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  expect(await a.hello()).toEqual({ serverTime: T0, lastSeq: 0, empty: true, nodes: 0, baseId: expect.any(String) });
  // The snapshot covers the first four lines; the tail (5 to 7) is replayed by the server on it.
  const { store, s, X } = pcBase('pc-a', 4);
  const rows = store.changesSince(0), snap = store.readSnapshot()!;
  expect((await sendSnapshot(a, new Uint8Array(snap.data), snap.seq)).status).toBe(204);
  for (const page of [rows.slice(0, 5), rows.slice(5)]) expect((await send(a, '/seed/journal', { rows: page })).status).toBe(200);
  // Not done: the server is still empty, its journal too (a partial seed is invisible).
  expect(await a.hello()).toMatchObject({ lastSeq: 0, empty: true });
  expect(await journal(a)).toEqual([]);
  const done = await send(a, '/seed/done', { last: rows.length });
  expect(done.status).toBe(200);
  expect(await done.json()).toEqual({ lastSeq: rows.length, baseId: expect.any(String) });
  expect(await a.hello()).toEqual({ serverTime: T0, lastSeq: rows.length, empty: false, nodes: 2, baseId: expect.any(String) });
  const served = decodeState(await (await a.get('/snapshot')).arrayBuffer());
  expect(image(served)).toBe(image(s));
  // The history of every line, as the PC wrote it, numbered (server_seq = its local_seq).
  const got = await journal(a);
  expect(got.map((r) => [r.localSeq, r.serverSeq, r.unit, r.pc, r.kind])).toEqual(rows.map((r) => [r.localSeq, r.localSeq, r.unit, 'pc-a', 'local']));
  expect(got.filter((r) => r.subject === X)).toHaveLength(4);
  // The staging is gone; the server then numbers the next writes after the seed's, and survives a restart.
  expect(existsSync(join(dir, 'serveur', 'seed')) ? readdirSync(join(dir, 'serveur', 'seed')) : []).toEqual([]);
  const next = a.unit(editNode(s, X, { title: 'X3' }));
  expect(await a.units([next])).toEqual([{ accepted: rows.length + 1 }]);
  const inMemory = image(decodeState(await (await a.get('/snapshot')).arrayBuffer()));
  await running.pop()!.close();
  const again = await start();
  const b = new Client(again.url, a.token, 'pc-a');
  expect(await b.hello()).toMatchObject({ lastSeq: rows.length + 1, empty: false });
  // Review of task 5, Minor 7: started again, the state loaded from the disk is the one it held in memory.
  expect(image(decodeState(await (await b.get('/snapshot')).arrayBuffer()))).toBe(inMemory);
});

test('R19 : une base qui porte déjà une violation des règles du graphe s’envoie quand même ; done la compte et la signale, sans la refuser', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const { store, s } = pcBase('pc-a');
  // A connection of one member, written as an older version of the app could have (commit checks records, not rules).
  const one = { id: 'c-seule', kind: 'knowledge' as const, title: '', relation: '', tags: [], members: [{ node: [...s.nodes.keys()][0], role: 'source' as const }] };
  const odd: Action = { id: 'a-seule', label: 'Connexion d’un seul membre', ops: [{ t: 'connection', before: null, after: one }] };
  store.commit(odd);
  applyOps(s, odd.ops);
  const rows = store.changesSince(0);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await sendSnapshot(a, seedBody(s), rows.length)).status).toBe(204);
  expect((await send(a, '/seed/journal', { rows })).status).toBe(200);
  const done = await send(a, '/seed/done', { last: rows.length });
  expect(done.status).toBe(200);
  expect(image(decodeState(await (await a.get('/snapshot')).arrayBuffer()))).toBe(image(s));
  expect(warn.mock.calls.some((c) => /1 violation/.test(String(c[0])))).toBe(true);
  warn.mockRestore();
});

test('revue, Minors 5 et 7 : une écriture acceptée entre /seed et /seed/done rend le serveur non vide : done reçoit 409, et l’envoi partiel est effacé', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), c = await paired(url, 'pc-c');
  const { store, s } = pcBase('pc-a');
  const rows = store.changesSince(0);
  expect((await sendSnapshot(a, seedBody(s), rows.length)).status).toBe(204);
  expect((await send(a, '/seed/journal', { rows })).status).toBe(200);
  const t = emptyState(), lobby = createPlan(t, 'Lobby', 'lobby');
  expect(await c.units([c.unit(lobby)])).toEqual([{ accepted: 1 }]);
  const late = await send(a, '/seed/done', { last: rows.length });
  expect(late.status).toBe(409);
  expect(await errorOf(late)).toBe('Le serveur tient déjà une base : il ne reçoit celle d’un PC que vide.');
  expect(readdirSync(join(dir, 'serveur', 'seed'))).toEqual([]);
  expect((await a.hello()).lastSeq).toBe(1);
});

test('seed : refusé à un serveur qui n’est plus vide, sans rien écrire ; une base jamais écrite au journal (le banc) le rend non vide aussi', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  // A base built in bulk (the bench's): an empty journal, its snapshot at 0.
  const { s } = pcBase('pc-a');
  expect((await sendSnapshot(a, seedBody(s), 0)).status).toBe(204);
  expect((await send(a, '/seed/done', { last: 0 })).status).toBe(200);
  expect(await a.hello()).toMatchObject({ lastSeq: 0, empty: false, nodes: 2 });
  // No longer empty: another seed is refused, with its reason.
  const refused = await sendSnapshot(b, seedBody(s), 0);
  expect(refused.status).toBe(409);
  expect(await errorOf(refused)).toBe('Le serveur tient déjà une base : il ne reçoit celle d’un PC que vide.');
  // A server with a write (another PC's lobby) likewise.
  const other = await startServer({ dataDir: join(dir, 'serveur2'), port: 0, now: () => T0 });
  running.push(other);
  const c = await paired(other.url, 'pc-c', 'serveur2'), d = await paired(other.url, 'pc-d', 'serveur2');
  const t = emptyState(), lobby = createPlan(t, 'Lobby', 'lobby');
  applyOps(t, lobby.ops);
  expect(await c.units([c.unit(lobby)])).toEqual([{ accepted: 1 }]);
  expect((await sendSnapshot(d, seedBody(s), 0)).status).toBe(409);
  expect((await send(d, '/seed/journal', { rows: [] })).status).toBe(409);
  expect((await send(d, '/seed/done', { last: 0 })).status).toBe(409);
  expect((await d.hello()).lastSeq).toBe(1);
});

test('seed, R16 : le dernier PC qui commence en est le maître ; les pages et done d’un autre reçoivent 409 ; une page qui ne suit pas, ou une ligne mal formée, 400', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const { store, s } = pcBase('pc-a');
  const rows = store.changesSince(0);
  expect((await sendSnapshot(a, seedBody(s), rows.length)).status).toBe(204);
  expect((await send(a, '/seed/journal', { rows: rows.slice(0, 3) })).status).toBe(200);
  // B starts a seed: A's is dropped, B owns it.
  expect((await sendSnapshot(b, seedBody(s), rows.length)).status).toBe(204);
  const late = await send(a, '/seed/journal', { rows: rows.slice(3) });
  expect(late.status).toBe(409);
  expect(await errorOf(late)).toMatch(/autre PC/);
  expect((await send(a, '/seed/done', { last: rows.length })).status).toBe(409);
  // B's pages: from line 1, each following the last; well formed.
  expect((await send(b, '/seed/journal', { rows: rows.slice(1, 3) })).status).toBe(400);
  const bad = [{ ...rows[0], op: { t: 'node', before: null } }];
  const malformed = await send(b, '/seed/journal', { rows: bad });
  expect(malformed.status).toBe(400);
  expect(await errorOf(malformed)).toMatch(/^Ligne 1 du journal de ce PC : Opération mal formée/);
  expect((await send(b, '/seed/journal', { rows: Array.from({ length: MAX_JOURNAL_PAGE + 1 }, () => rows[0]) })).status).toBe(400);
  expect((await send(b, '/seed/journal', { lignes: [] })).status).toBe(400);
  expect((await send(b, '/seed/journal', { rows: rows.slice(0, 3) })).status).toBe(200);
  // done before every line came: refused, the seed kept.
  expect((await send(b, '/seed/done', { last: rows.length })).status).toBe(400);
  expect((await send(b, '/seed/journal', { rows: rows.slice(3) })).status).toBe(200);
  expect((await send(b, '/seed/done', { last: rows.length })).status).toBe(200);
  expect((await b.hello()).lastSeq).toBe(rows.length);
});

test('seed : un instantané illisible, ou un journal qui ne s’applique pas sur lui, est refusé à done ; le serveur reste vide', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const { store, s } = pcBase('pc-a');
  const rows = store.changesSince(0);
  const broken = seedBody(s);
  broken[100] ^= 0xff;
  expect((await sendSnapshot(a, broken, rows.length)).status).toBe(204);
  expect((await send(a, '/seed/journal', { rows })).status).toBe(200);
  const unreadable = await send(a, '/seed/done', { last: rows.length });
  expect(unreadable.status).toBe(400);
  expect(await errorOf(unreadable)).toMatch(/^Instantané de ce PC illisible/);
  expect(await a.hello()).toMatchObject({ lastSeq: 0, empty: true });
  // A snapshot of the whole state, said to cover only the first line: the tail does not apply on it.
  expect((await sendSnapshot(a, seedBody(s), 1)).status).toBe(204);
  expect((await send(a, '/seed/journal', { rows })).status).toBe(200);
  const stale = await send(a, '/seed/done', { last: rows.length });
  expect(stale.status).toBe(400);
  expect(await errorOf(stale)).toMatch(/^Le journal de ce PC ne suit pas son instantané/);
  expect(await a.hello()).toMatchObject({ lastSeq: 0, empty: true });
  expect(await journal(a)).toEqual([]);
});

test('seed : l’instantané est borné (MAX_SEED_BYTES annoncés : 413 sans rien lire) ; sans jeton, 401 ; un autre type de corps, 415', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/seed`, {
      method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(MAX_SEED_BYTES + 1), 'Cirrus-Seq': '0' },
    }, (res) => { res.resume(); resolve(res.statusCode!); req.destroy(); });
    req.on('error', reject);
    req.write(new Uint8Array(1024));
  });
  expect(status).toBe(413);
  const anonymous = await fetch(`${url}/seed`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Cirrus-Seq': '0' }, body: new Uint8Array(64) });
  expect(anonymous.status).toBe(401);
  expect((await fetch(`${url}/seed`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'text/plain', 'Cirrus-Seq': '0' }, body: 'x' })).status).toBe(415);
  expect((await fetch(`${url}/seed`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(64) })).status).toBe(400);
  expect(await a.hello()).toMatchObject({ lastSeq: 0, empty: true });
});

test('seed : les flux ouverts avant sont fermés à done, et reprennent par le journal', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const events = await EventReader.open(b, { after: 0 });
  try {
    const { store, s } = pcBase('pc-a');
    const rows = store.changesSince(0);
    expect((await sendSnapshot(a, seedBody(s), rows.length)).status).toBe(204);
    expect((await send(a, '/seed/journal', { rows })).status).toBe(200);
    expect((await send(a, '/seed/done', { last: rows.length })).status).toBe(200);
    const deadline = Date.now() + 2000;
    while (!events.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(events.closed).toBe(true);
  } finally {
    events.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Final review of plan 5a.

test('R31 : la base du serveur a une identité, rendue par /hello, gardée quand serveur.db est remis à zéro ; une base neuve en a une autre, et un envoi de base la remplace (done la rend)', async () => {
  const first = await start();
  const a = await paired(first.url, 'pc-a');
  const fresh = (await a.hello()).baseId;
  expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
  expect((await a.hello()).baseId).toBe(fresh);
  // serveur.db reset (its PCs, codes and settings lost), the base kept: the same identity.
  await running.pop()!.close();
  for (const f of ['serveur.db', 'serveur.db-wal', 'serveur.db-shm']) rmSync(join(dir, 'serveur', f), { force: true });
  const again = await start();
  const b = await paired(again.url, 'pc-b');
  expect((await b.hello()).baseId).toBe(fresh);
  // A seed brings another base: another identity, which done gives the seeding PC.
  const { store } = pcBase('pc-b');
  const rows = store.changesSince(0);
  expect((await sendSnapshot(b, seedBody(replay(rows)), rows.length)).status).toBe(204);
  expect((await send(b, '/seed/journal', { rows })).status).toBe(200);
  const done = (await (await send(b, '/seed/done', { last: rows.length })).json()) as { lastSeq: number; baseId: string };
  expect(done).toEqual({ lastSeq: rows.length, baseId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(done.baseId).not.toBe(fresh);
  expect((await b.hello()).baseId).toBe(done.baseId);
  // The base folder replaced by a new one: another identity again.
  await running.pop()!.close();
  rmSync(join(dir, 'serveur', 'base'), { recursive: true, force: true });
  const third = await start();
  const c = new Client(third.url, b.token, 'pc-b');
  expect((await c.hello()).baseId).not.toBe(done.baseId);
});

test('R32 : une ligne d’historique qu’un PC a écrite avant les bornes d’aujourd’hui (une clé de tag trop longue) s’envoie, numérotée comme chez lui ; la même ligne dans la fin du journal, rejouée sur l’instantané, est refusée', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const { store, s, X } = pcBase('pc-a');
  // As an older app wrote it: a word tag of 200 characters, then removed (the node editable again).
  const long = 'mot'.repeat(70);
  for (const tags of [[{ key: long }], []]) {
    const n = s.nodes.get(X)!, op = { t: 'node' as const, before: n, after: { ...n, tags } };
    store.commit({ id: `a-${tags.length}`, label: 'Tag', ops: [op] });
    applyOps(s, [op]);
  }
  const rows = store.changesSince(0), line = rows.findIndex((r) => r.op.t === 'node' && (r.op.after?.tags.length ?? 0) > 0) + 1;
  // Its snapshot before that line: the line is in the tail, replayed as a write — refused, named.
  expect((await sendSnapshot(a, seedBody(replay(rows.slice(0, line - 1))), line - 1)).status).toBe(204);
  const tail = await send(a, '/seed/journal', { rows });
  expect(tail.status).toBe(400);
  expect(await errorOf(tail)).toMatch(new RegExp(`^Ligne ${line} du journal de ce PC : Opération mal formée : node\\.after\\.tags\\[0\\]\\.key`));
  // Its snapshot after it: history, taken; the server numbers every line as the PC's journal does.
  expect((await sendSnapshot(a, seedBody(s), rows.length)).status).toBe(204);
  expect((await send(a, '/seed/journal', { rows })).status).toBe(200);
  expect((await send(a, '/seed/done', { last: rows.length })).status).toBe(200);
  const got = await journal(a);
  expect(got.map((r) => [r.localSeq, r.serverSeq, r.unit])).toEqual(rows.map((r) => [r.localSeq, r.localSeq, r.unit]));
  expect(got[line - 1].op).toEqual(rows[line - 1].op);
  // A write adding such a key is still refused; one editing the node, which no longer holds it, passes.
  const n = s.nodes.get(X)!;
  expect(await a.units([a.unit({ id: 'a-x', label: 'Tag', ops: [{ t: 'node', before: n, after: { ...n, tags: [{ key: long }] } }] })])).toEqual([{ refused: expect.stringMatching(/tags\[0\]\.key/) }]);
  expect(await a.units([a.unit(editNode(s, X, { title: 'X3' }))])).toEqual([{ accepted: rows.length + 1 }]);
});

test('R15 : POST /unpair révoque le jeton qui le demande, et lui seul', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const res = await send(a, '/unpair', {});
  expect(res.status).toBe(204);
  expect((await a.get('/hello')).status).toBe(401);
  expect((await send(a, '/unpair', {})).status).toBe(401);
  expect(await b.hello()).toMatchObject({ lastSeq: 0 });
  const tokens = Tokens.open(join(dir, 'serveur'));
  try {
    expect(tokens.pcs().map((p) => p.id)).toEqual(['pc-b']);
  } finally {
    tokens.close();
  }
});
