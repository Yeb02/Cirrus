import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  type Action, applyOps, canonical, createNode, createPlan, decodeState, editNode, emptyState, fromSnapshot, type Id, include, type State, toSnapshot, type Unit,
} from '@cirrus/core';
import { type ChangeRow, filePath, LocalStore } from '@cirrus/store';
import { MAX_BODY_BYTES, MAX_PAIR_BODY_BYTES, MAX_UNITS_PER_REQUEST, PAIRING_TRIES, PAIRING_TTL_MS, SERVER_SNAPSHOT_UNITS } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Tokens } from '../src/tokens.ts';
import { Client, EventReader, FORMAT, newCode, pair, sha256, T0 } from './support.ts';

let dir: string;
/** The server's clock (its `now`). */
let clock: number;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-'));
  clock = T0;
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => clock });
  running.push(s);
  return s;
}

async function stop(s: RunningServer): Promise<void> {
  running.splice(running.indexOf(s), 1);
  await s.close();
}

/** A PC paired under `name`, by a code made as `jumeler` makes it. */
async function paired(url: string, pc: string, name = pc): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, name, clock), pc, name: `Machine ${name}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const created = (a: Action, t: 'node' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
const copy = (s: State): State => fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s))) as ReturnType<typeof toSnapshot>);
const baseDir = () => join(dir, 'base');

/** Plan P, then X, G and H placed in it, sent by `a` and accepted: lines 1 (the plan), 2-3, 4-5 and 6-7 (each node and its placement). */
async function world(a: Client) {
  const s = emptyState();
  const plan = run(s, createPlan(s, 'P', 'plan')), P = created(plan, 'plan');
  const nodes = ['X', 'G', 'H'].map((title, i) => run(s, createNode(s, { plan: P, title, x: i * 100, y: 0, k: 0 })));
  expect(await a.units([plan, ...nodes].map((x) => a.unit(x)))).toEqual([{ accepted: 1 }, { accepted: 3 }, { accepted: 5 }, { accepted: 7 }]);
  const [X, G, H] = nodes.map((n) => created(n, 'node'));
  return { s, P, X, G, H };
}

async function journal(c: Client, after = 0): Promise<ChangeRow[]> {
  const res = await c.get(`/journal?after=${after}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { rows: ChangeRow[] }).rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pairing (D3)

test('jumelage : un code, puis un jeton ; la base du serveur ne garde que son empreinte', async () => {
  const { url } = await start();
  const code = newCode(dir, 'Portable', clock);
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  // Typed in lower case, without its dashes: the same code.
  const res = await pair(url, { code: code.replaceAll('-', '').toLowerCase(), pc: 'pc-a', name: 'DESKTOP-A' });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  // 256 bits.
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const a = new Client(url, token, 'pc-a');
  expect(await a.hello()).toEqual({ serverTime: T0, lastSeq: 0, empty: true });
  // Only the token's hash is kept, and the code's: neither in clear, in the tables nor anywhere in the file.
  const db = new DatabaseSync(join(dir, 'serveur.db'));
  const rows = db.prepare('SELECT * FROM pcs').all() as Record<string, unknown>[];
  db.close();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 'pc-a', name: 'Portable', machine: 'DESKTOP-A', token_hash: createHash('sha256').update(token).digest('hex') });
  for (const file of readdirSync(dir).filter((f) => f.startsWith('serveur.db'))) {
    const bytes = readFileSync(join(dir, file), 'latin1');
    expect(bytes.includes(token), file).toBe(false);
    expect(bytes.includes(code.replaceAll('-', '')), file).toBe(false);
  }
});

test('jumelage : un code faux, expiré, déjà servi ou épuisé par des essais faux est refusé', async () => {
  const { url } = await start();
  const tryCode = async (code: string, pc = 'pc-a') => (await pair(url, { code, pc, name: 'DESKTOP' })).status;
  // Wrong.
  expect(await tryCode('ABCD-EFGH-JKMN-PQRS')).toBe(403);
  // Expired: ten minutes later.
  const old = newCode(dir, 'Ancien', clock);
  clock += PAIRING_TTL_MS + 1;
  expect(await tryCode(old)).toBe(403);
  // Served once only.
  const once = newCode(dir, 'Portable', clock);
  expect(await tryCode(once)).toBe(200);
  expect(await tryCode(once, 'pc-b')).toBe(403);
  // Four wrong tries leave a code alive; the fifth burns it.
  const kept = newCode(dir, 'Bureau', clock);
  for (let i = 0; i < PAIRING_TRIES - 1; i++) expect(await tryCode('0000-0000-0000-0000')).toBe(403);
  expect(await tryCode(kept, 'pc-b')).toBe(200);
  const burnt = newCode(dir, 'Salon', clock);
  for (let i = 0; i < PAIRING_TRIES; i++) expect(await tryCode('0000-0000-0000-0000')).toBe(403);
  expect(await tryCode(burnt, 'pc-c')).toBe(403);
  // A refusal says why, in French; a body of the wrong shape is a 400 that tries no code.
  const refused = await pair(url, { code: 'ABCD-EFGH-JKMN-PQRS', pc: 'pc-a', name: 'DESKTOP' });
  expect(((await refused.json()) as { error: string }).error).toMatch(/^Code de jumelage/);
  const fresh = newCode(dir, 'Cuisine', clock);
  for (const body of [{ code: fresh }, { code: fresh, pc: '', name: 'X' }, { code: fresh, pc: 'pc-d', name: 'x'.repeat(1000) }, '[]', '{']) {
    expect((await pair(url, body)).status, JSON.stringify(body)).toBe(400);
  }
  expect(await tryCode(fresh, 'pc-d')).toBe(200);
});

test('jumeler deux fois le même nom est refusé ; revoquer retire le PC et son code en attente', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  const tokens = Tokens.open(dir);
  try {
    expect(() => tokens.createCode('Portable', clock)).toThrow(/Portable/);
    expect(tokens.pcs()).toEqual([{ id: 'pc-a', name: 'Portable', machine: 'Machine Portable', pairedAt: T0 }]);
    tokens.createCode('Bureau', clock);
    expect(tokens.codes()).toEqual([{ name: 'Bureau', expiresAt: T0 + PAIRING_TTL_MS }]);
    expect(tokens.revoke('Portable')).toBe(true);
    expect(tokens.revoke('Bureau')).toBe(true);
    expect(tokens.revoke('Inconnu')).toBe(false);
    expect([tokens.pcs(), tokens.codes()]).toEqual([[], []]);
  } finally {
    tokens.close();
  }
  // Revoked: its token is worth nothing, at once.
  expect((await a.get('/hello', FORMAT)).status).toBe(401);
});

// ---------------------------------------------------------------------------------------------------------------------
// Access (Review Focus 3): refused without writing anything, and the server keeps serving.

test('accès : sans jeton ou avec un jeton révoqué, 401 ; signée d’un autre PC, 403 ; rien n’est écrit', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable');
  const w = await world(a);
  expect((await fetch(`${url}/hello`, { headers: FORMAT })).status).toBe(401);
  const anonymous = await fetch(`${url}/units`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: [] }) });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
  expect(((await anonymous.json()) as { error: string }).error).toMatch(/jeton/i);
  expect((await new Client(url, 'x'.repeat(43), 'pc-a').get('/hello', FORMAT)).status).toBe(401);
  expect((await new Client(url, 'pas un jeton', 'pc-a').get('/journal')).status).toBe(401);
  // A request that holds one write signed by another PC is refused whole, the writes before it included.
  const mine = a.unit(editNode(w.s, w.X, { title: 'à moi' }));
  const forged = { ...a.unit(editNode(w.s, w.G, { title: 'volé' })), pc: 'pc-b' };
  const r = await a.send('POST', '/units', { units: [mine, forged] });
  expect(r.status).toBe(403);
  expect(((await r.json()) as { error: string }).error).toMatch(/autre PC/);
  expect((await a.hello()).lastSeq).toBe(7);
  // Revoked while paired.
  const b = await paired(url, 'pc-b', 'Bureau');
  expect((await b.hello()).lastSeq).toBe(7);
  const tokens = Tokens.open(dir);
  tokens.revoke('Bureau');
  tokens.close();
  for (const path of ['/hello', '/journal', '/snapshot', '/events']) expect((await b.get(path, FORMAT)).status, path).toBe(401);
  expect((await b.send('POST', '/units', { units: [] })).status).toBe(401);
  // The other PC still works.
  expect(await a.units([mine])).toEqual([{ accepted: 8 }]);
});

test('requêtes abîmées : JSON invalide 400, corps trop gros 413, empreinte mal formée 400, octets faux 400 sans rien garder', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const w = await world(a);
  const status = async (p: Promise<Response>) => (await p).status;
  expect(await status(a.send('POST', '/units', '{"units": ['))).toBe(400);
  expect(await status(a.send('POST', '/units', '{"lots": []}'))).toBe(400);
  expect(await status(a.send('POST', '/units', { units: Array.from({ length: MAX_UNITS_PER_REQUEST + 1 }, () => ({})) }))).toBe(400);
  expect(await status(a.send('POST', '/units', { units: [] }, 'text/plain'))).toBe(415);
  expect(await status(a.send('POST', '/units', 'x'.repeat(MAX_BODY_BYTES + 1)))).toBe(413);
  // The pairing route, the only one without a token, reads a small body only; streamed (no length announced) too.
  expect(await status(pair(url, 'x'.repeat(MAX_PAIR_BODY_BYTES + 1)))).toBe(413);
  const chunks = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(MAX_PAIR_BODY_BYTES / 4).fill(0x20));
      c.close();
    },
  });
  const streamed = await fetch(`${url}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: chunks, duplex: 'half' } as RequestInit);
  expect(streamed.status).toBe(413);
  // Hashes that are not 64 lower-case hexadecimal digits.
  expect(await status(a.get('/files/abc'))).toBe(400);
  expect(await status(a.get(`/files/${'A'.repeat(64)}`))).toBe(400);
  expect(await status(a.send('PUT', '/files/..%5C..%5Cx', 'octets', 'application/octet-stream'))).toBe(400);
  expect(await status(a.send('POST', '/files/missing', { hashes: ['pas une empreinte'] }))).toBe(400);
  // Bytes that do not match their hash: refused, nothing kept (neither the blob nor a temporary).
  const hash = sha256('le vrai contenu');
  const wrong = await a.send('PUT', `/files/${hash}`, 'un autre contenu', 'application/octet-stream');
  expect(wrong.status).toBe(400);
  expect(((await wrong.json()) as { error: string }).error).toMatch(/empreinte/);
  expect(existsSync(filePath(baseDir(), { name: '', hash, size: 0 }))).toBe(false);
  const files = join(baseDir(), 'files');
  expect(existsSync(files) ? readdirSync(files, { recursive: true }) : []).toEqual([]);
  // A malformed operation, a file name that is not a plain one: the write is refused, nothing written.
  const results = await a.units([{ ...a.unit(editNode(w.s, w.X, { title: 'X2' })), ops: [{ t: 'node', before: null }] }]);
  expect(results).toEqual([{ refused: expect.stringMatching(/^Opération mal formée/) }]);
  const bytes = 'contenu';
  expect(await status(a.send('PUT', `/files/${sha256(bytes)}`, bytes, 'application/octet-stream'))).toBe(204);
  const escaping = a.unit(editNode(w.s, w.X, { files: [{ name: '..\\..\\evil.txt', hash: sha256(bytes), size: bytes.length }] }));
  expect(await a.units([escaping])).toEqual([{ refused: expect.stringMatching(/nom de fichier/) }]);
  // No route answers a browser: no CORS header, a preflight is refused; a request for another host is refused (DNS rebinding).
  const preflight = await fetch(`${url}/units`, { method: 'OPTIONS', headers: { Origin: 'https://exemple.org', 'Access-Control-Request-Method': 'POST' } });
  expect(preflight.status).toBe(405);
  expect([...preflight.headers.keys()].filter((k) => k.startsWith('access-control'))).toEqual([]);
  const foreign = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/hello`, { headers: { Host: 'cirrus.exemple.org', Authorization: `Bearer ${a.token}`, ...FORMAT } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end();
  });
  expect(foreign).toBe(403);
  expect(await status(a.get('/inconnue'))).toBe(404);
  expect(await status(a.send('DELETE', '/units', ''))).toBe(405);
  // Nothing written, and the server still serves.
  expect(await a.hello()).toMatchObject({ lastSeq: 7 });
  expect(await a.units([a.unit(editNode(w.s, w.X, { title: 'X2' }))])).toEqual([{ accepted: 8 }]);
});

test('hello : l’heure du serveur, son dernier numéro, s’il est vide ; un autre format répond 409 avec la raison', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  clock = T0 + 1234;
  expect(await a.hello()).toEqual({ serverTime: T0 + 1234, lastSeq: 0, empty: true });
  const s = emptyState();
  // Empty in the sense of D7: no node, no connection, no placement, no plan but a lobby.
  expect(await a.units([a.unit(run(s, createPlan(s, 'Lobby', 'lobby')))])).toEqual([{ accepted: 1 }]);
  expect(await a.hello()).toMatchObject({ lastSeq: 1, empty: true });
  expect(await a.units([a.unit(run(s, createPlan(s, 'Thèse', 'plan')))])).toEqual([{ accepted: 2 }]);
  expect(await a.hello()).toMatchObject({ lastSeq: 2, empty: false });
  const other = await a.get('/hello', { ...FORMAT, 'Cirrus-Schema': String(Number(FORMAT['Cirrus-Schema']) + 1) });
  expect(other.status).toBe(409);
  expect(((await other.json()) as { error: string }).error).toBe(
    `Ce serveur garde ses données dans un autre format (schéma ${FORMAT['Cirrus-Schema']}, ici ${Number(FORMAT['Cirrus-Schema']) + 1}) : mets à jour Cirrus, ou travaille sur un serveur local.`,
  );
  const none = await a.get('/hello');
  expect(none.status).toBe(409);
  expect(((await none.json()) as { error: string }).error).toMatch(/^Ce serveur garde ses données dans un autre format \(protocole \d+, ici \?/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Writes (D1, D4, D5)

test('écritures : acceptée, numérotée et relayée à deux flux ; le serveur garde le PC, l’heure et l’identifiant reçus', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const ea = await EventReader.open(a), eb = await EventReader.open(b);
  try {
    const w = await world(a);
    const fromA = await ea.units(4);
    expect(fromA.map((u) => u.seq)).toEqual([1, 3, 5, 7]);
    expect(await eb.units(4)).toEqual(fromA);
    const edit = b.unit(run(w.s, editNode(w.s, w.X, { title: 'X2' })));
    expect(await b.units([edit])).toEqual([{ accepted: 8 }]);
    expect(await ea.units(1)).toEqual([{ ...edit, seq: 8 }]);
    expect(await eb.units(1)).toEqual([{ ...edit, seq: 8 }]);
    const rows = await journal(a, 7);
    expect(rows).toEqual([expect.objectContaining({ localSeq: 8, serverSeq: 8, unit: edit.unit, actionId: edit.action, pc: 'pc-b', at: edit.at, kind: 'local', label: edit.label })]);
    expect(await a.hello()).toMatchObject({ lastSeq: 8, empty: false });
  } finally {
    ea.close();
    eb.close();
  }
});

test('écritures : en retard quand un « avant » ne correspond plus ; les suivantes de la requête aussi', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const w = await world(a);
  const seen = copy(w.s);
  expect(await a.units([a.unit(run(w.s, editNode(w.s, w.X, { title: 'X par A' })))])).toEqual([{ accepted: 8 }]);
  const late = b.unit(run(seen, editNode(seen, w.X, { summary: 'vu par B' })));
  const next = b.unit(run(seen, editNode(seen, w.G, { title: 'G par B' })));
  expect(await b.units([late, next])).toEqual([{ stale: 8 }, { stale: 8 }]);
  expect((await a.hello()).lastSeq).toBe(8);
  // Replayed on what it had missed, it passes.
  expect(await b.units([b.unit(run(w.s, editNode(w.s, w.X, { summary: 'vu par B' })))])).toEqual([{ accepted: 9 }]);
});

test('écritures : refusée quand elle ajoute une violation, l’état du serveur remis ; la même envoyée deux fois, appliquée une fois', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const ea = await EventReader.open(a);
  try {
    const w = await world(a);
    await ea.units(4);
    const seen = copy(w.s);
    // The inclusion: its connection and its two branches, lines 8 to 10.
    expect(await a.units([a.unit(run(w.s, include(w.s, w.P, w.X, w.G)))])).toEqual([{ accepted: 10 }]);
    // Each "before" holds, but together they would put X in two groups of P.
    const twice = b.unit(run(seen, include(seen, w.P, w.X, w.H)));
    const after = b.unit(run(seen, editNode(seen, w.H, { title: 'H2' })));
    expect(await b.units([twice, after])).toEqual([{ refused: 'Ce nœud est déjà dans un groupe de ce plan.' }, { stale: 10 }]);
    expect((await a.hello()).lastSeq).toBe(10);
    expect((await journal(a)).some((r) => r.unit === twice.unit)).toBe(false);
    // The server's state is as before: an edit made on it passes, and the refused write is refused again, not taken as known.
    const edit = b.unit(run(w.s, editNode(w.s, w.H, { title: 'H2' })));
    expect(await b.units([edit])).toEqual([{ accepted: 11 }]);
    expect(await b.units([twice])).toEqual([{ refused: 'Ce nœud est déjà dans un groupe de ce plan.' }]);
    // Sent again (its answer lost): accepted with its number, applied once, relayed once.
    expect(await b.units([edit, edit])).toEqual([{ accepted: 11 }, { accepted: 11 }]);
    expect((await journal(a)).filter((r) => r.unit === edit.unit)).toHaveLength(1);
    const last = a.unit(run(w.s, editNode(w.s, w.G, { title: 'G2' })));
    expect(await a.units([last])).toEqual([{ accepted: 12 }]);
    expect((await ea.units(3)).map((u) => [u.unit, u.seq])).toEqual([[expect.any(String), 10], [edit.unit, 11], [last.unit, 12]]);
    // A known identifier from another PC is not taken for its write.
    expect(await a.units([{ ...a.unit(editNode(w.s, w.G, { title: 'G3' })), unit: edit.unit }])).toEqual([{ refused: expect.stringMatching(/autre PC/) }]);
  } finally {
    ea.close();
  }
});

test('écritures : un fichier absent du serveur la refuse ; envoyé (et vérifié), elle passe', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const w = await world(a);
  const bytes = new TextEncoder().encode('\\documentclass{article}');
  const ref = { name: 'note.tex', hash: sha256(bytes), size: bytes.length };
  const u = a.unit(editNode(w.s, w.X, { files: [ref] }));
  expect(await a.units([u])).toEqual([{ refused: 'Fichier manquant au serveur.' }]);
  const missing = async () => ((await (await a.send('POST', '/files/missing', { hashes: [ref.hash, ref.hash] })).json()) as { missing: string[] }).missing;
  expect(await missing()).toEqual([ref.hash]);
  expect((await a.get(`/files/${ref.hash}`)).status).toBe(404);
  expect((await a.send('PUT', `/files/${ref.hash}`, bytes, 'application/octet-stream')).status).toBe(204);
  // Sent twice: the same blob.
  expect((await a.send('PUT', `/files/${ref.hash}`, bytes, 'application/octet-stream')).status).toBe(204);
  expect(await missing()).toEqual([]);
  const got = await a.get(`/files/${ref.hash}`);
  expect(got.status).toBe(200);
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  expect(readFileSync(filePath(baseDir(), ref))).toEqual(Buffer.from(bytes));
  applyOps(w.s, u.ops);
  expect(await a.units([u])).toEqual([{ accepted: 8 }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The stream (D2, Review Focus 2)

test('flux : la reprise après Last-Event-ID, sans trou ni doublon, puis le direct', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const first = await EventReader.open(a, { after: 0 });
  const w = await world(a);
  expect((await first.units(4)).map((u) => u.seq)).toEqual([1, 3, 5, 7]);
  // Cut; two writes accepted meanwhile.
  first.close();
  expect(await a.units([a.unit(run(w.s, editNode(w.s, w.X, { title: 'X2' }))), a.unit(run(w.s, editNode(w.s, w.G, { title: 'G2' })))])).toEqual([{ accepted: 8 }, { accepted: 9 }]);
  // Resumed after the second write received (Last-Event-ID wins over after).
  const again = await EventReader.open(a, { lastEventId: 3, after: 0 });
  try {
    expect((await again.units(4)).map((u) => u.seq)).toEqual([5, 7, 8, 9]);
    expect(await a.units([a.unit(run(w.s, editNode(w.s, w.H, { title: 'H2' })))])).toEqual([{ accepted: 10 }]);
    expect((await again.units(1)).map((u) => u.seq)).toEqual([10]);
    expect(again.queued).toBe(0);
  } finally {
    again.close();
  }
  // From the end: only what comes next.
  const live = await EventReader.open(a, { after: 10 });
  try {
    expect(await a.units([a.unit(run(w.s, editNode(w.s, w.H, { title: 'H3' })))])).toEqual([{ accepted: 11 }]);
    expect((await live.units(1)).map((u) => u.seq)).toEqual([11]);
  } finally {
    live.close();
  }
  // Inside a write (line 2 is X's node, 3 its placement), beyond the journal, not a number: refused.
  expect((await a.get('/events?after=2')).status).toBe(400);
  expect((await a.get('/events?after=12')).status).toBe(409);
  expect((await a.get('/events?after=-1')).status).toBe(400);
  expect((await a.get('/events', { 'Last-Event-ID': 'abc' })).status).toBe(400);
});

test('flux : une reprise pendant que des écritures arrivent ne perd ni ne double rien', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const w = await world(a);
  const edits: Unit[] = [];
  for (let i = 0; i < 60; i++) edits.push(a.unit(run(w.s, editNode(w.s, w.X, { title: `X${i}` }))));
  expect(await a.units(edits.slice(0, 30))).toHaveLength(30);
  const readers = await Promise.all([EventReader.open(a), EventReader.open(a, { after: 3 })]);
  try {
    const sent = Promise.all([a.units(edits.slice(30, 45)), a.units(edits.slice(45))]);
    const [all, fromThree] = await Promise.all([readers[0].units(64), readers[1].units(62)]);
    await sent;
    const seqs = [1, 3, 5, 7, ...Array.from({ length: 60 }, (_, i) => 8 + i)];
    expect(all.map((u) => u.seq)).toEqual(seqs);
    expect(fromThree.map((u) => u.seq)).toEqual(seqs.slice(2));
  } finally {
    for (const r of readers) r.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Restart (D1): the numbering and the state come back, from the snapshot and the journal's tail.

test('redémarrage : la numérotation et l’état reprennent, par l’instantané et la fin du journal, ou par les tables', async () => {
  let srv = await start();
  const a = await paired(srv.url, 'pc-a');
  const w = await world(a);
  const edit = a.unit(run(w.s, editNode(w.s, w.X, { title: 'X2' })));
  expect(await a.units([edit])).toEqual([{ accepted: 8 }]);
  await stop(srv);
  // The stop wrote the snapshot; then a line accepted after it (a server stopped without one: a crash) stays in the journal's tail.
  let base = LocalStore.open(baseDir(), { pc: 'test' });
  expect(base.readSnapshot()?.seq).toBe(8);
  const tail = run(w.s, editNode(w.s, w.G, { title: 'G2' }));
  expect(base.commit(tail, { at: T0, unit: 'queue', pc: 'pc-a', numbered: true })).toBe(9);
  base.close();
  srv = await start();
  let again = new Client(srv.url, a.token, 'pc-a');
  expect(await again.hello()).toMatchObject({ lastSeq: 9, empty: false });
  // Accepted before the stop, its answer lost: the same number, applied once.
  expect(await again.units([edit])).toEqual([{ accepted: 8 }]);
  // The state is the snapshot plus the tail: an edit made on it passes, numbered next.
  expect(await again.units([again.unit(run(w.s, editNode(w.s, w.G, { title: 'G3' })))])).toEqual([{ accepted: 10 }]);
  const stream = await EventReader.open(again, { after: 7 });
  expect((await stream.units(3)).map((u) => [u.unit, u.seq])).toEqual([[edit.unit, 8], ['queue', 9], [expect.any(String), 10]]);
  stream.close();
  await stop(srv);
  // Without a snapshot: from the tables.
  base = LocalStore.open(baseDir(), { pc: 'test' });
  base.dropSnapshot();
  base.close();
  srv = await start();
  again = new Client(srv.url, a.token, 'pc-a');
  expect(await again.units([again.unit(run(w.s, editNode(w.s, w.H, { title: 'H2' })))])).toEqual([{ accepted: 11 }]);
});

test('GET /snapshot : l’état du serveur tel qu’il est, et le numéro qu’il couvre ; GET /journal par pages', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const w = await world(a);
  expect(await a.units([a.unit(run(w.s, editNode(w.s, w.X, { title: 'X2' })))])).toEqual([{ accepted: 8 }]);
  const res = await a.get('/snapshot');
  expect(res.status).toBe(200);
  expect(res.headers.get('cirrus-seq')).toBe('8');
  const image = (s: State) => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));
  expect(image(decodeState(await res.arrayBuffer()))).toBe(image(w.s));
  const page = await a.get('/journal?after=1&limit=3');
  expect(((await page.json()) as { rows: ChangeRow[] }).rows.map((r) => [r.localSeq, r.serverSeq])).toEqual([[2, 2], [3, 3], [4, 4]]);
  for (const q of ['?after=-1', '?limit=0', '?limit=x']) expect((await a.get(`/journal${q}`)).status, q).toBe(400);
});

test('instantané du serveur : écrit toutes les SERVER_SNAPSHOT_UNITS écritures', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const w = await world(a);
  const edits: Unit[] = [];
  for (let i = 0; i < SERVER_SNAPSHOT_UNITS - 4; i++) edits.push(a.unit(run(w.s, editNode(w.s, w.X, { title: `X${i}` }))));
  for (let i = 0; i < edits.length; i += MAX_UNITS_PER_REQUEST) await a.units(edits.slice(i, i + MAX_UNITS_PER_REQUEST));
  const last = 7 + SERVER_SNAPSHOT_UNITS - 4;
  expect((await a.hello()).lastSeq).toBe(last);
  const base = LocalStore.open(baseDir(), { pc: 'test' });
  try {
    expect(base.readSnapshot()?.seq).toBe(last);
  } finally {
    base.close();
  }
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------------
// Address and command line

test('adresse : démarrer ailleurs que sur cette machine est refusé', async () => {
  for (const host of ['0.0.0.0', '192.168.1.10', '::', 'localhost.exemple.org']) {
    await expect(startServer({ dataDir: dir, port: 0, host }), host).rejects.toThrow("Le serveur n'écoute que sur cette machine tant qu'il n'a pas de HTTPS (plan 9).");
  }
  // Nothing created.
  expect(readdirSync(dir)).toEqual([]);
});

test('deux serveurs sur les mêmes données : le second est refusé', async () => {
  await start();
  await expect(startServer({ dataDir: dir, port: 0 })).rejects.toThrow(/autre serveur/);
});

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [MAIN, ...args, '--data', dir], { encoding: 'utf8' })).stdout;

test('ligne de commande : jumeler, pcs et revoquer pendant que le serveur tourne', async () => {
  const { url } = await start();
  const out = await cli('jumeler', 'Portable');
  const code = /\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(out)?.[1];
  expect(code, out).toBeDefined();
  const res = await pair(url, { code, pc: 'pc-a', name: 'DESKTOP-A' });
  expect(res.status).toBe(200);
  const a = new Client(url, ((await res.json()) as { token: string }).token, 'pc-a');
  expect((await a.hello()).lastSeq).toBe(0);
  expect(await cli('pcs')).toMatch(/Portable.*DESKTOP-A/);
  expect(await cli('revoquer', 'Portable')).toMatch(/Portable/);
  expect((await a.get('/hello', FORMAT)).status).toBe(401);
  await expect(cli('revoquer', 'Portable')).rejects.toThrow();
}, 30_000);
