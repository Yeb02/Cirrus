import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MAX_SETTING_AHEAD_MS, MAX_SETTING_KEY_CHARS, MAX_SETTING_VALUE_BYTES, MAX_SETTINGS_KEPT, MAX_SETTINGS_PER_REQUEST } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, EventReader, newCode, pair, T0 } from './support.ts';

// The shared settings (plan 5a, task 6, D9, R23, R24): the server keeps each with the time of its last change and its
// PC; the more recent change wins, setting by setting, then the greater PC identifier; null goes back to the default.
// Every request is checked before anything is written; the event streams carry the settings changed.

let dir: string;
const running: RunningServer[] = [];
const readers: EventReader[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-reglages-'));
});
afterEach(async () => {
  for (const r of readers.splice(0)) r.close();
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0 });
  running.push(s);
  return s;
}

async function paired(url: string, pc: string): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, pc, T0), pc, name: `Machine ${pc}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

async function stream(c: Client): Promise<EventReader> {
  const r = await EventReader.open(c);
  readers.push(r);
  return r;
}

/** POST /settings: the server's rows for the keys sent, the answer checked to be a 200. */
async function put(c: Client, changes: Record<string, { value: unknown; at: number }>): Promise<Record<string, unknown>> {
  const res = await c.send('POST', '/settings', { changes });
  if (res.status !== 200) throw new Error(`POST /settings : ${res.status} ${await res.text()}`);
  return ((await res.json()) as { settings: Record<string, unknown> }).settings;
}

async function all(c: Client): Promise<Record<string, unknown>> {
  const res = await c.get('/settings');
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test('le plus récent gagne, réglage par réglage, puis l’identifiant du PC ; null revient au défaut ; le flux porte les réglages changés, pas les perdants', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a'), b = await paired(url, 'pc-b');
  const ra = await stream(a), rb = await stream(b);
  expect(await all(a)).toEqual({});
  // A first change: kept with its time and its PC, told to every stream.
  const factorA = { value: 3, at: T0 + 10, pc: 'pc-a' };
  expect(await put(a, { factor: { value: 3, at: T0 + 10 } })).toEqual({ factor: factorA });
  expect(await ra.settings()).toEqual({ factor: factorA });
  expect(await rb.settings()).toEqual({ factor: factorA });
  // Older: it loses; the answer gives the server's, and no stream hears of it.
  expect(await put(b, { factor: { value: 2, at: T0 + 5 } })).toEqual({ factor: factorA });
  // At the same time, the greater PC identifier wins (core's merge: « pc-b » > « pc-a »)…
  const factorB = { value: 2, at: T0 + 10, pc: 'pc-b' };
  expect(await put(b, { factor: { value: 2, at: T0 + 10 } })).toEqual({ factor: factorB });
  expect(await ra.settings()).toEqual({ factor: factorB });
  expect(await rb.settings()).toEqual({ factor: factorB });
  // …and the smaller one loses.
  expect(await put(a, { factor: { value: 4, at: T0 + 10 } })).toEqual({ factor: factorB });
  // Setting by setting: one key wins, the other loses, in the same request; only the winner is told.
  const scale = { value: [1, 2], at: T0 + 20, pc: 'pc-a' };
  expect(await put(a, { factor: { value: 5, at: T0 + 9 }, starSpacingPx: { value: [1, 2], at: T0 + 20 } })).toEqual({ factor: factorB, starSpacingPx: scale });
  for (const r of [ra, rb]) expect(await r.settings()).toEqual({ starSpacingPx: scale });
  // null: back to the default, kept with its time (an older change cannot bring the value back).
  const reset = { value: null, at: T0 + 30, pc: 'pc-a' };
  expect(await put(a, { factor: { value: null, at: T0 + 30 } })).toEqual({ factor: reset });
  for (const r of [ra, rb]) expect(await r.settings()).toEqual({ factor: reset });
  expect(await put(b, { factor: { value: 7, at: T0 + 25 } })).toEqual({ factor: reset });
  // The same change sent again (its answer lost): nothing new, no event.
  expect(await put(a, { factor: { value: null, at: T0 + 30 } })).toEqual({ factor: reset });
  expect(await all(b)).toEqual({ factor: reset, starSpacingPx: scale });
  // The streams heard nothing else: the next event is the next change.
  const text = { value: 'grid', at: T0 + 40, pc: 'pc-b' };
  await put(b, { background: { value: 'grid', at: T0 + 40 } });
  for (const r of [ra, rb]) expect(await r.settings()).toEqual({ background: text });
  expect([ra.queued, rb.queued]).toEqual([0, 0]);
  // Kept in serveur.db: a restart gives them back.
  for (const s of running.splice(0)) await s.close();
  const again = await start();
  expect(await all(new Client(again.url, a.token, 'pc-a'))).toEqual({ factor: reset, starSpacingPx: scale, background: text });
});

test('R24 : une requête abîmée ou hostile est refusée avant toute écriture, et le serveur continue', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const ok = { value: 1, at: T0 };
  // Without a token, or with a wrong one: 401, for reading as for writing.
  expect((await fetch(`${url}/settings`)).status).toBe(401);
  expect((await new Client(url, 'x'.repeat(43), 'pc-a').send('POST', '/settings', { changes: { factor: ok } })).status).toBe(401);
  // Not JSON, or not of JSON's type.
  expect((await a.send('POST', '/settings', '{pas du json')).status).toBe(400);
  expect((await a.send('POST', '/settings', JSON.stringify({ changes: { factor: ok } }), 'text/plain')).status).toBe(415);
  const bad: [string, unknown][] = [
    ['pas un objet', []],
    ['sans changes', { factor: ok }],
    ['changes pas un objet', { changes: [ok] }],
    ['un champ de trop', { changes: { factor: ok }, pc: 'pc-b' }],
    ['clé vide', { changes: { '': ok } }],
    ['clé avec une espace', { changes: { 'a b': ok } }],
    ['clé __proto__', { changes: JSON.parse('{"__proto__": {"value": 1, "at": 1}}') }],
    ['clé trop longue', { changes: { ['k'.repeat(MAX_SETTING_KEY_CHARS + 1)]: ok } }],
    ['heure en texte', { changes: { factor: { value: 1, at: '1' } } }],
    ['heure absente', { changes: { factor: { value: 1 } } }],
    ['heure nulle', { changes: { factor: { value: 1, at: null } } }],
    // Review of task 6, Minor 4: a time is whole milliseconds, from 0 to 2^53 − 1 (past it, `at + 1 === at`).
    ['heure fractionnaire', { changes: { factor: { value: 1, at: T0 + 0.5 } } }],
    ['heure négative', { changes: { factor: { value: 1, at: -1 } } }],
    ['heure au-delà de 2^53', { changes: { factor: { value: 1, at: 2 ** 53 } } }],
    // Review of task 6, round 2 (R26): more than MAX_SETTING_AHEAD_MS ahead of the server's clock (T0 here).
    ['heure trop en avance', { changes: { factor: ok, textScale: { value: 1, at: T0 + MAX_SETTING_AHEAD_MS + 1 } } }],
    ['heure de 2^53 − 1', { changes: { factor: { value: 1, at: 2 ** 53 - 1 } } }],
    ['valeur absente', { changes: { factor: { at: T0 } } }],
    ['un champ de trop dans un réglage', { changes: { factor: { value: 1, at: T0, pc: 'pc-b' } } }],
    ['réglage pas un objet', { changes: { factor: 3 } }],
    ['valeur trop grosse', { changes: { factor: ok, latexPackages: { value: ['x'.repeat(MAX_SETTING_VALUE_BYTES)], at: T0 } } }],
    ['trop de réglages', { changes: Object.fromEntries(Array.from({ length: MAX_SETTINGS_PER_REQUEST + 1 }, (_, i) => [`k${i}`, ok])) }],
  ];
  for (const [what, body] of bad) {
    const res = await a.send('POST', '/settings', body);
    expect(res.status, what).toBe(400);
    expect(((await res.json()) as { error: string }).error, what).toMatch(/réglage|Corps/i);
  }
  // A number too large for a double reads as Infinity: not a time.
  expect((await a.send('POST', '/settings', '{"changes": {"factor": {"value": 1, "at": 1e400}}}')).status).toBe(400);
  // Nothing was written by any of them: the request with one good key and one bad wrote neither.
  expect(await all(a)).toEqual({});
  const db = new DatabaseSync(join(dir, 'serveur.db'), { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
  // The most keys, each at its largest: taken.
  const most = Object.fromEntries(Array.from({ length: MAX_SETTINGS_PER_REQUEST }, (_, i) => [`k${i}`, ok]));
  expect(Object.keys(await put(a, most))).toHaveLength(MAX_SETTINGS_PER_REQUEST);
  const big = 'y'.repeat(MAX_SETTING_VALUE_BYTES - 2);
  expect(await put(a, { latexPackages: { value: big, at: T0 } })).toEqual({ latexPackages: { value: big, at: T0, pc: 'pc-a' } });
  // As far ahead as the server allows: taken.
  const ahead = T0 + MAX_SETTING_AHEAD_MS;
  expect(await put(a, { factor: { value: 1, at: ahead } })).toEqual({ factor: { value: 1, at: ahead, pc: 'pc-a' } });
});

test('revue de la tâche 6, Minor 3 : le serveur garde au plus MAX_SETTINGS_KEPT réglages ; une requête qui en ajouterait trop est refusée entière, rien d’écrit', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const r = await stream(a);
  const keys = (from: number, n: number, at = T0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${from + i}`, { value: 1, at }]));
  // Filled to the bound, by requests of MAX_SETTINGS_PER_REQUEST at most.
  for (let n = 0; n < MAX_SETTINGS_KEPT; n += MAX_SETTINGS_PER_REQUEST) {
    expect(Object.keys(await put(a, keys(n, Math.min(MAX_SETTINGS_PER_REQUEST, MAX_SETTINGS_KEPT - n))))).toHaveLength(Math.min(MAX_SETTINGS_PER_REQUEST, MAX_SETTINGS_KEPT - n));
  }
  await r.next(Math.ceil(MAX_SETTINGS_KEPT / MAX_SETTINGS_PER_REQUEST));
  // One more: refused, with the change to a kept key it carried; nothing written, nothing told.
  const res = await a.send('POST', '/settings', { changes: { ...keys(0, 1, T0 + 1), ...keys(MAX_SETTINGS_KEPT, 1) } });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(new RegExp(`${MAX_SETTINGS_KEPT} réglages`));
  const kept = await all(a);
  expect([Object.keys(kept).length, kept.k0]).toEqual([MAX_SETTINGS_KEPT, { value: 1, at: T0, pc: 'pc-a' }]);
  // A kept key still changes.
  expect(await put(a, keys(0, 1, T0 + 2))).toEqual({ k0: { value: 1, at: T0 + 2, pc: 'pc-a' } });
  expect(await r.settings()).toEqual({ k0: { value: 1, at: T0 + 2, pc: 'pc-a' } });
});
