import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MAX_CONSULTATIONS_BODY_BYTES, MAX_CONSULTATIONS_PER_REQUEST } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Tokens } from '../src/tokens.ts';
import { Client, newCode, pair, T0 } from './support.ts';

// The consultations of every PC (plan 6b, D7): POST /consultations { events: [{ seq, at, kind, subject?, plan?, detail? }] }
// keeps a PC's batch, its rows keyed by (pc, seq) — the PC the token's, never the body's —, and answers the greatest seq
// kept for that PC; GET /consultations/upto answers it alone; GET /consultations/seen, the last consultation of each
// subject, every PC together, of the kinds that say an object was looked at. Every batch checked whole before anything
// is written.

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-consultations-'));
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0 });
  running.push(s);
  return s;
}

async function paired(url: string, pc: string, name: string): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, name, T0), pc, name: `Machine ${name}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

interface Event { seq: number; at: number; kind: string; subject?: string; plan?: string; detail?: string }

/** POST /consultations: its status and its body. */
async function post(c: Client, events: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await c.send('POST', '/consultations', { events });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function upto(c: Client): Promise<number> {
  const res = await c.get('/consultations/upto');
  expect(res.status).toBe(200);
  return ((await res.json()) as { upto: number }).upto;
}

async function seen(c: Client): Promise<[string, number][]> {
  const res = await c.get('/consultations/seen');
  expect(res.status).toBe(200);
  return ((await res.json()) as { seen: [string, number][] }).seen.sort((a, b) => a[0].localeCompare(b[0]));
}

/** serveur.db's consultations, read beside the server. */
function rows(): Record<string, unknown>[] {
  const db = new DatabaseSync(join(dir, 'serveur.db'), { readOnly: true });
  try {
    return db.prepare('SELECT pc, seq, at, kind, subject, plan, detail FROM consultations ORDER BY pc, seq').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const batch = (from: number, n: number, rest: Partial<Event> = {}): Event[] =>
  Array.from({ length: n }, (_, i) => ({ seq: from + i, at: T0 + from + i, kind: 'node_popup', subject: `n${from + i}`, plan: 'p1', ...rest }));

test('un lot s’écrit et rend upto', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  expect(await upto(a)).toBe(0);
  const r = await post(a, [
    { seq: 3, at: T0, kind: 'app_open' },
    { seq: 7, at: T0 + 1, kind: 'search', subject: 'n1', plan: 'p1', detail: 'tenseur' },
  ]);
  expect(r).toEqual({ status: 200, body: { upto: 7 } });
  expect(await upto(a)).toBe(7);
  expect(rows()).toEqual([
    { pc: 'pc-a', seq: 3, at: T0, kind: 'app_open', subject: null, plan: null, detail: null },
    { pc: 'pc-a', seq: 7, at: T0 + 1, kind: 'search', subject: 'n1', plan: 'p1', detail: 'tenseur' },
  ]);
  // An empty batch writes nothing, and says where the PC stands.
  expect(await post(a, [])).toEqual({ status: 200, body: { upto: 7 } });
  // Another PC's upto is its own.
  const b = await paired(url, 'pc-b', 'Bureau');
  expect(await upto(b)).toBe(0);
  expect((await post(b, batch(1, 2))).body).toEqual({ upto: 2 });
  expect(await upto(a)).toBe(7);
  // A restart keeps them.
  await running.pop()!.close();
  const again = await start();
  expect(await upto(new Client(again.url, a.token, 'pc-a'))).toBe(7);
});

test('le même lot deux fois ne double rien', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  const events = batch(1, 50);
  expect((await post(a, events)).body).toEqual({ upto: 50 });
  const before = rows();
  // Its answer lost, the PC sends it again: nothing more, nothing changed, the same upto.
  expect(await post(a, events)).toEqual({ status: 200, body: { upto: 50 } });
  // A batch that overlaps the one kept: only its new rows count.
  expect((await post(a, batch(41, 20))).body).toEqual({ upto: 60 });
  expect(rows()).toHaveLength(60);
  expect(rows().slice(0, 50)).toEqual(before);
  // A batch below the upto changes nothing of it.
  expect((await post(a, batch(1, 3))).body).toEqual({ upto: 60 });
});

test('le pc d’une ligne est celui du jeton, jamais celui du corps', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  // A field pc is no field of an event: the batch is refused.
  expect((await post(a, [{ seq: 1, at: T0, kind: 'app_open', pc: 'pc-b' }])).status).toBe(400);
  expect((await post(a, batch(1, 1))).body).toEqual({ upto: 1 });
  expect(rows().map((r) => r.pc)).toEqual(['pc-a']);
});

const IRREGULAR: [string, unknown][] = [
  ['un genre inconnu', { seq: 3, at: T0, kind: 'peek' }],
  ['un seq absent', { at: T0, kind: 'app_open' }],
  ['un seq nul', { seq: 0, at: T0, kind: 'app_open' }],
  ['un seq non entier', { seq: 3.5, at: T0, kind: 'app_open' }],
  ['un seq en texte', { seq: '3', at: T0, kind: 'app_open' }],
  ['une heure négative', { seq: 3, at: -1, kind: 'app_open' }],
  ['un sujet vide', { seq: 3, at: T0, kind: 'node_popup', subject: '' }],
  ['un sujet trop long', { seq: 3, at: T0, kind: 'node_popup', subject: 'x'.repeat(129) }],
  ['un détail trop long', { seq: 3, at: T0, kind: 'search', detail: 'x'.repeat(2001) }],
  ['un champ inconnu', { seq: 3, at: T0, kind: 'app_open', extra: 1 }],
  ['un seq qui ne croît pas', { seq: 1, at: T0, kind: 'app_open' }],
  ['pas un objet', 'app_open'],
];

test.each(IRREGULAR)('un lot irrégulier est refusé en entier : %s', async (_why, bad) => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  const r = await post(a, [...batch(1, 2), bad]);
  expect(r.status).toBe(400);
  expect(typeof r.body.error).toBe('string');
  expect(rows()).toEqual([]);
  expect(await upto(a)).toBe(0);
});

test('un corps d’une autre forme est refusé : 400, rien d’écrit', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  for (const body of [[], { events: 'x' }, { events: [], more: 1 }, { list: [] }, null]) {
    expect((await a.send('POST', '/consultations', body)).status, JSON.stringify(body)).toBe(400);
  }
  expect((await a.send('POST', '/consultations', 'x', 'text/plain')).status).toBe(415);
  expect(rows()).toEqual([]);
});

test('1 001 événements → 413', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  expect(MAX_CONSULTATIONS_PER_REQUEST).toBe(1000);
  expect(MAX_CONSULTATIONS_BODY_BYTES).toBe(2 ** 20);
  const r = await post(a, batch(1, 1001, { subject: 'n' }));
  expect(r.status).toBe(413);
  expect(rows()).toEqual([]);
  // 1 000 pass.
  expect((await post(a, batch(1, 1000, { subject: 'n' }))).body).toEqual({ upto: 1000 });
  // A body past MAX_CONSULTATIONS_BODY_BYTES: 413 too, nothing written.
  const big = batch(1001, 600, { kind: 'search', detail: 'é'.repeat(2000) });
  expect(Buffer.byteLength(JSON.stringify({ events: big }))).toBeGreaterThan(MAX_CONSULTATIONS_BODY_BYTES);
  expect((await post(a, big)).status).toBe(413);
  expect(await upto(a)).toBe(1000);
});

test('sans jeton → 401', async () => {
  const { url } = await start();
  await paired(url, 'pc-a', 'Portable');
  const anonymous = new Client(url, 'A'.repeat(43), 'pc-x');
  expect((await post(anonymous, batch(1, 1))).status).toBe(401);
  for (const path of ['/consultations/upto', '/consultations/seen']) {
    expect((await fetch(url + path)).status, path).toBe(401);
    expect((await anonymous.get(path)).status, path).toBe(401);
  }
  expect((await fetch(`${url}/consultations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch(1, 1) }) })).status).toBe(401);
  // A revoked PC's token too; its rows stay.
  const b = await paired(url, 'pc-b', 'Bureau');
  expect((await post(b, batch(1, 1))).status).toBe(200);
  const tokens = Tokens.open(dir);
  try {
    tokens.revoke('Bureau');
  } finally {
    tokens.close();
  }
  expect((await post(b, batch(2, 1))).status).toBe(401);
  expect(rows()).toHaveLength(1);
  // The other methods.
  expect((await b.get('/consultations')).status).toBe(405);
  expect((await b.send('POST', '/consultations/seen', {})).status).toBe(405);
});

test('seen rend la dernière consultation par sujet, tous PC confondus', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable'), b = await paired(url, 'pc-b', 'Bureau');
  expect(await seen(a)).toEqual([]);
  await post(a, [
    { seq: 1, at: 100, kind: 'node_popup', subject: 'n1' },
    { seq: 2, at: 300, kind: 'connection_popup', subject: 'c1' },
    { seq: 3, at: 150, kind: 'file_preview', subject: 'n2', detail: 'a.pdf' },
  ]);
  await post(b, [
    // B saw n1 later: the most recent wins, whichever PC.
    { seq: 1, at: 200, kind: 'jump', subject: 'n1', plan: 'p1' },
    // B saw c1 earlier than A: A's stays.
    { seq: 2, at: 50, kind: 'connection_popup', subject: 'c1' },
    { seq: 3, at: 400, kind: 'file_fullscreen', subject: 'n3', detail: 'b.tex' },
    { seq: 4, at: 500, kind: 'search', subject: 'n4', detail: 'tenseur' },
  ]);
  const expected = [['c1', 300], ['n1', 200], ['n2', 150], ['n3', 400], ['n4', 500]];
  expect(await seen(a)).toEqual(expected);
  expect(await seen(b)).toEqual(expected);
});

test('seen ignore app_open et plan_shown', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  await post(a, [
    { seq: 1, at: 100, kind: 'app_open' },
    { seq: 2, at: 110, kind: 'plan_shown', plan: 'p1' },
    // Kinds that say nothing was looked at, a subject or not.
    { seq: 3, at: 120, kind: 'app_close' },
    { seq: 4, at: 130, kind: 'focus' },
    { seq: 5, at: 140, kind: 'blur' },
    // A search given up: no subject.
    { seq: 6, at: 150, kind: 'search', detail: 'rien' },
    // A jump to a plan, nothing framed.
    { seq: 7, at: 160, kind: 'jump', plan: 'p2' },
    { seq: 8, at: 170, kind: 'node_popup', subject: 'n1' },
  ]);
  expect(await seen(a)).toEqual([['n1', 170]]);
});
