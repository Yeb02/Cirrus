import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_ID_CHARS } from '@cirrus/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MAX_PRESENCE_BODY_BYTES, MAX_PRESENCE_ENTRIES } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Tokens } from '../src/tokens.ts';
import { Client, newCode, pair, T0 } from './support.ts';

// « .tex ouvert ailleurs » (plan 5b, task 5, D6): each paired PC sends the files it has open in full screen (PUT
// /presence { open: [{ node, name }] }), which replaces its list in serveur.db; the answer names the same files open on
// the other PCs, with their names and since when. Names compare as at reimport (the core's fileNameKey). A revocation
// drops the PC's list; a restart keeps them all. Every body is checked whole before anything is written.

let dir: string;
let clock: number;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-presence-'));
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

/** A PC paired under `name` (as `jumeler` names it), its machine named otherwise. */
async function paired(url: string, pc: string, name: string): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, name, clock), pc, name: `Machine ${name}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

interface Other { node: string; name: string; pc: string; since: number }

/** PUT /presence: the others' entries, the answer checked to be a 200. */
async function put(c: Client, open: { node: string; name: string }[]): Promise<Other[]> {
  const res = await c.send('PUT', '/presence', { open });
  if (res.status !== 200) throw new Error(`PUT /presence : ${res.status} ${await res.text()}`);
  return ((await res.json()) as { others: Other[] }).others;
}

/** The rows of serveur.db's presence table, read beside the server. */
function rows(): Record<string, unknown>[] {
  const db = new DatabaseSync(join(dir, 'serveur.db'), { readOnly: true });
  try {
    return db.prepare('SELECT pc, node, name, since FROM open_tex ORDER BY pc, node, name').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

test('la liste d’un PC remplacée à chaque envoi ; les mêmes fichiers ouverts ailleurs rendus avec le nom du PC et l’heure du serveur ; les noms comparés comme au réimport', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable'), b = await paired(url, 'pc-b', 'Bureau'), c = await paired(url, 'pc-c', 'Salon');
  // A opens two .tex: nobody else has them.
  expect(await put(a, [{ node: 'n1', name: 'complexité.tex' }, { node: 'n2', name: 'b.tex' }])).toEqual([]);
  // B opens the first a minute later, spelled otherwise (case, decomposed accent): A's, named as `jumeler` named it.
  clock = T0 + 60_000;
  expect(await put(b, [{ node: 'n1', name: 'COMPLEXITÉ.TEX' }])).toEqual([{ node: 'n1', name: 'complexité.tex', pc: 'Portable', since: T0 }]);
  // The same name in another node is another file.
  expect(await put(c, [{ node: 'n3', name: 'complexité.tex' }])).toEqual([]);
  // A sends its list again, the first still open: its time kept; B's named in turn. Its second closed: gone.
  clock = T0 + 120_000;
  expect(await put(a, [{ node: 'n1', name: 'complexité.tex' }])).toEqual([{ node: 'n1', name: 'COMPLEXITÉ.TEX', pc: 'Bureau', since: T0 + 60_000 }]);
  expect(rows()).toEqual([
    { pc: 'pc-a', node: 'n1', name: 'complexité.tex', since: T0 },
    { pc: 'pc-b', node: 'n1', name: 'COMPLEXITÉ.TEX', since: T0 + 60_000 },
    { pc: 'pc-c', node: 'n3', name: 'complexité.tex', since: T0 + 60_000 },
  ]);
  // C opens A's and B's file too: both, the earliest first.
  expect(await put(c, [{ node: 'n3', name: 'complexité.tex' }, { node: 'n1', name: 'Complexité.tex' }])).toEqual([
    { node: 'n1', name: 'complexité.tex', pc: 'Portable', since: T0 },
    { node: 'n1', name: 'COMPLEXITÉ.TEX', pc: 'Bureau', since: T0 + 60_000 },
  ]);
  // A closes everything: an empty list; B no longer hears of it. A file listed twice counts once.
  expect(await put(a, [])).toEqual([]);
  expect(await put(b, [{ node: 'n1', name: 'complexité.tex' }, { node: 'n1', name: 'COMPLEXITÉ.tex' }])).toEqual([{ node: 'n1', name: 'Complexité.tex', pc: 'Salon', since: T0 + 120_000 }]);
  expect(rows().filter((r) => r.pc === 'pc-b')).toEqual([{ pc: 'pc-b', node: 'n1', name: 'complexité.tex', since: T0 + 60_000 }]);
});

test('une révocation retire la liste du PC : revoquer, ou POST /unpair ; les autres restent', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable'), b = await paired(url, 'pc-b', 'Bureau'), c = await paired(url, 'pc-c', 'Salon');
  const file = { node: 'n1', name: 'a.tex' };
  await put(a, [file]);
  await put(b, [file]);
  // At the same time, by name.
  expect(await put(c, [file])).toEqual([
    { ...file, pc: 'Bureau', since: T0 },
    { ...file, pc: 'Portable', since: T0 },
  ]);
  // `revoquer "Portable"`, the server running: A's list gone with it.
  const tokens = Tokens.open(dir);
  try {
    expect(tokens.revoke('Portable')).toBe(true);
  } finally {
    tokens.close();
  }
  expect(await put(c, [file])).toEqual([{ ...file, pc: 'Bureau', since: T0 }]);
  // B unpairs itself (R15): its list goes too.
  expect((await b.send('POST', '/unpair', {})).status).toBe(204);
  expect(await put(c, [file])).toEqual([]);
  expect(rows()).toEqual([{ pc: 'pc-c', node: 'n1', name: 'a.tex', since: T0 }]);
});

test('les listes gardées dans serveur.db : un redémarrage du serveur les rend', async () => {
  const s = await start();
  const a = await paired(s.url, 'pc-a', 'Portable'), b = await paired(s.url, 'pc-b', 'Bureau');
  await put(a, [{ node: 'n1', name: 'a.tex' }]);
  running.splice(running.indexOf(s), 1);
  await s.close();
  clock = T0 + 3_600_000;
  const again = await start();
  expect(await put(new Client(again.url, b.token, 'pc-b'), [{ node: 'n1', name: 'a.tex' }])).toEqual([{ node: 'n1', name: 'a.tex', pc: 'Portable', since: T0 }]);
});

test('un corps abîmé ou hostile est refusé avant toute écriture, la liste d’avant gardée ; MAX_PRESENCE_ENTRIES au plus ; le serveur continue', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a', 'Portable'), b = await paired(url, 'pc-b', 'Bureau');
  await put(a, [{ node: 'n1', name: 'a.tex' }]);
  // Without a token, or with a wrong one: 401; another method than PUT: 405.
  expect((await fetch(`${url}/presence`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"open":[]}' })).status).toBe(401);
  expect((await new Client(url, 'x'.repeat(43), 'pc-a').send('PUT', '/presence', { open: [] })).status).toBe(401);
  expect((await a.get('/presence')).status).toBe(405);
  // Not JSON, not of JSON's type, too big.
  expect((await a.send('PUT', '/presence', '{"open": [')).status).toBe(400);
  expect((await a.send('PUT', '/presence', JSON.stringify({ open: [] }), 'text/plain')).status).toBe(415);
  expect((await a.send('PUT', '/presence', JSON.stringify({ open: [] }) + ' '.repeat(MAX_PRESENCE_BODY_BYTES))).status).toBe(413);
  const entry = { node: 'n2', name: 'b.tex' };
  const bad: [string, unknown][] = [
    ['pas un objet', [entry]],
    ['sans open', {}],
    ['open pas une liste', { open: entry }],
    ['un champ de trop', { open: [entry], pc: 'pc-b' }],
    ['entrée pas un objet', { open: ['b.tex'] }],
    ['entrée sans nom', { open: [{ node: 'n2' }] }],
    ['entrée sans nœud', { open: [{ name: 'b.tex' }] }],
    ['un champ de trop dans une entrée', { open: [{ ...entry, since: 1 }] }],
    ['nœud vide', { open: [{ node: '', name: 'b.tex' }] }],
    ['nœud pas un texte', { open: [{ node: 3, name: 'b.tex' }] }],
    ['nœud trop long', { open: [{ node: 'n'.repeat(MAX_ID_CHARS + 1), name: 'b.tex' }] }],
    ['nom pas un texte', { open: [{ node: 'n2', name: null }] }],
    ['nom vide', { open: [{ node: 'n2', name: '' }] }],
    ['nom avec un dossier', { open: [{ node: 'n2', name: 'a/b.tex' }] }],
    ['nom avec un flux', { open: [{ node: 'n2', name: 'b.tex:x' }] }],
    ['nom réservé', { open: [{ node: 'n2', name: 'nul.tex' }] }],
    ['nom avec un caractère de contrôle', { open: [{ node: 'n2', name: 'b\u0001.tex' }] }],
    ['trop d’entrées', { open: Array.from({ length: MAX_PRESENCE_ENTRIES + 1 }, (_, i) => ({ node: `n${i}`, name: 'b.tex' })) }],
  ];
  for (const [what, body] of bad) {
    const res = await a.send('PUT', '/presence', body);
    expect(res.status, what).toBe(400);
    expect(((await res.json()) as { error: string }).error, what).toMatch(/ouverts|Corps|Fichier/);
  }
  const big = await a.send('PUT', '/presence', { open: Array.from({ length: MAX_PRESENCE_ENTRIES + 1 }, (_, i) => ({ node: `n${i}`, name: 'b.tex' })) });
  expect(((await big.json()) as { error: string }).error).toMatch(new RegExp(`${MAX_PRESENCE_ENTRIES} fichiers`));
  // Nothing was written by any of them: A's list is the one before.
  expect(rows()).toEqual([{ pc: 'pc-a', node: 'n1', name: 'a.tex', since: T0 }]);
  expect(await put(b, [{ node: 'n1', name: 'a.tex' }])).toEqual([{ node: 'n1', name: 'a.tex', pc: 'Portable', since: T0 }]);
  // The most entries, at their longest node: taken.
  const most = Array.from({ length: MAX_PRESENCE_ENTRIES }, (_, i) => ({ node: `${i}`.padStart(MAX_ID_CHARS, 'n'), name: 'b.tex' }));
  expect(await put(a, most)).toEqual([]);
  expect(rows().filter((r) => r.pc === 'pc-a')).toHaveLength(MAX_PRESENCE_ENTRIES);
});
