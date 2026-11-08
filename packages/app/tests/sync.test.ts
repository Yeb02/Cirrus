import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOp, checkState, createNode, createPlan, deleteEverywhere, editNode, type FileRef, groupOf, include, type RemoteUnit } from '@cirrus/core';
import { filePath, LocalStore, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { SyncClient, type SyncStatus } from '../src/main/sync/client.ts';
import { fileSecrets, pair, SERVER_FILE, type ServerConfig, type TokenCipher } from '../src/main/sync/config.ts';
import { DOWNLOADS_FILE, Downloads, hasBlob } from '../src/main/sync/downloads.ts';
import { readEvents } from '../src/main/sync/events.ts';
import { created, image, Lab, sleep, T0, TEST_PARAMS, until, type VirtualPc } from './support/virtualPc.ts';

// The main process's sync client (plan 5a, task 3), with two or three virtual PCs and a server in the process.

let lab: Lab | null = null;
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await lab?.close();
  lab = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cirrus-sync-'));
  dirs.push(d);
  return d;
};
const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * Two PCs paired with one server: A makes plan P and nodes X, G, H, N, K, L, M (M with a note.tex), B receives them;
 * both at rest.
 */
async function twoPcs() {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a'), b = await l.pc('pc-b');
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, files: FileRef[] = []) => created(a.act((s) => createNode(s, { plan: P, title, x, y: 0, k: 0, files })), 'node');
  const v0 = storeBytes(a.dir, 'note.tex', bytes('\\section{v0}'));
  const ids = { P, X: node('X', 0), G: node('G', 300), H: node('H', 600), N: node('N', 900), K: node('K', 1200), L: node('L', 1500), M: node('M', 1800, [v0]) };
  await l.settle();
  return { lab: l, a, b, v0, ...ids };
}

/** Every PC's state, in memory and read back from its base, equal to the server's, and valid. */
async function converged(l: Lab, pcs: VirtualPc[]) {
  const server = await l.state();
  expect(checkState(server)).toEqual([]);
  for (const pc of pcs) {
    expect(image(pc.s), pc.id).toBe(image(server));
    expect(image(pc.store.loadState()), pc.id).toBe(image(server));
    expect(checkState(pc.s), pc.id).toEqual([]);
  }
  return server;
}

test('le flux SSE : trames coupées n’importe où (au milieu d’un caractère UTF-8 aussi), \\n, \\r\\n ou \\r, commentaires ignorés, données sur plusieurs lignes', async () => {
  const e = bytes('é');
  const chunks: (string | Uint8Array)[] = [
    'id: 3\nevent: unit\nda', 'ta: {"a":', '1}\n\n: ping\n\n', 'data: un\r\ndata: deux\r\n\r\n', 'event: x\rdata: ', e.subarray(0, 1), e.subarray(1), '\r', '\ndata:y\n\n',
    'data: sans fin',
  ];
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(typeof x === 'string' ? bytes(x) : x); c.close(); } });
  const events = [];
  for await (const ev of readEvents(body)) events.push(ev);
  expect(events).toEqual([
    { id: '3', event: 'unit', data: '{"a":1}' },
    { id: '3', event: 'message', data: 'un\ndeux' },
    { id: '3', event: 'x', data: 'é\ny' },
  ]);
});

test('serveur.json : le jeton chiffré sur le disque, relu ; un fichier abîmé ne donne aucun serveur ; dissocier l’efface', () => {
  const dir = tempDir();
  const xor: TokenCipher = { encrypt: (t) => Buffer.from(Buffer.from(t, 'utf8').map((x) => x ^ 0x5a)), decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8') };
  const secrets = fileSecrets(dir, xor), c: ServerConfig = { url: 'http://127.0.0.1:7310', token: 'Tk_'.repeat(14) + 'x', name: 'Portable' };
  expect(secrets.read()).toBeNull();
  secrets.write(c);
  expect(secrets.read()).toEqual(c);
  const text = readFileSync(join(dir, SERVER_FILE), 'utf8');
  expect(text).not.toContain(c.token);
  expect(JSON.parse(text)).toEqual({ url: c.url, name: c.name, token: expect.any(String) });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeFileSync(join(dir, SERVER_FILE), '{ pas du json');
  expect(secrets.read()).toBeNull();
  expect(warn).toHaveBeenCalled();
  secrets.write(c);
  secrets.write(null);
  expect(existsSync(join(dir, SERVER_FILE))).toBe(false);
  expect(secrets.read()).toBeNull();
});

test('jumeler : le code donne un jeton ; un code faux, une adresse invalide ou un serveur injoignable sont refusés avec leur raison', async () => {
  const l = (lab = await Lab.start());
  const c = await l.pairing('Portable', 'pc-p');
  expect(c).toEqual({ url: l.url, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), name: 'Portable' });
  await expect(pair(fetch, `${l.url}/`, 'AAAA-AAAA-AAAA-AAAA', 'pc-q', 'Autre')).rejects.toThrow(/^Code de jumelage faux, expiré ou déjà servi/);
  await expect(pair(fetch, 'ftp://127.0.0.1:7310', 'AAAA', 'pc-q', 'Autre')).rejects.toThrow(/^Adresse du serveur invalide/);
  await expect(pair(fetch, 'http://127.0.0.1:1', 'AAAA', 'pc-q', 'Autre')).rejects.toThrow(/^Serveur injoignable/);
});

test('sans serveur jumelé : le client ne fait rien, « off », aucune requête', async () => {
  const dir = tempDir(), store = LocalStore.open(dir, { pc: 'seul' });
  const statuses: SyncStatus[] = [], f = vi.fn<typeof fetch>();
  const client = new SyncClient({
    fetch: f, store, storeDir: dir, secrets: { read: () => null, write: () => {} }, reconcile: async () => {}, now: Date.now, params: () => TEST_PARAMS,
    status: (s) => { statuses.push(s); },
  });
  client.start();
  client.kick();
  await client.flush(50);
  expect(await client.fetchBlob('a'.repeat(64))).toBe(false);
  await client.stop();
  expect(statuses).toEqual([{ state: 'off' }]);
  expect(f).not.toHaveBeenCalled();
  expect(client.clockOffset()).toBe(0);
  store.close();
});

test('une action sur A est appliquée sur B en moins d’une seconde, reçue et numérotée dans sa base', async () => {
  const { lab: l, a, b, X } = await twoPcs();
  expect(image(b.s)).toBe(image(a.s));
  const t = Date.now();
  const u = a.act((s) => editNode(s, X, { title: 'X renommé sur A' }))!;
  await until(() => b.s.nodes.get(X)?.title === 'X renommé sur A');
  expect(Date.now() - t).toBeLessThan(1000);
  await l.settle();
  await converged(l, [a, b]);
  const rows = b.store.changesSince(0).filter((r) => r.unit === u.unit);
  expect(rows.map((r) => [r.kind, r.pc, r.serverSeq === null])).toEqual([['remote', 'pc-a', false]]);
  expect(a.status).toEqual({ state: 'live', pending: 0 });
  expect(b.status).toEqual({ state: 'live', pending: 0 });
  // A's own write came back to it as an acknowledgement: numbered in place, nothing undone.
  expect(a.store.changesSince(0).filter((r) => r.unit === u.unit).map((r) => [r.kind, r.serverSeq])).toEqual([['local', expect.any(Number)]]);
  expect(a.store.changesSince(0).some((r) => r.kind === 'rewind')).toBe(false);
});

test('des actions des deux côtés en même temps, puis le repos : les trois états sont égaux et valides, le plus récent gagne, l’écarté est nommé', async () => {
  const { lab: l, a, b, P, X, G, H, N, K, L, M, v0 } = await twoPcs();
  await until(() => existsSync(filePath(b.dir, v0)));
  // A's actions, then B's a second later (the PCs' clocks follow the lab's): neither has seen the other's.
  l.clock += 1000;
  a.act((s) => editNode(s, X, { title: 'X par A' }));
  a.act((s) => editNode(s, G, { summary: 'résumé par A' }));
  a.act((s) => editNode(s, H, { tags: [{ key: 'lu' }] }));
  a.act((s) => deleteEverywhere(s, N));
  a.act((s) => include(s, P, X, G));
  a.act((s) => include(s, P, K, L));
  const v1 = storeBytes(a.dir, 'note.tex', bytes('\\section{v1}'));
  a.act((s) => editNode(s, M, { files: [v1] }));
  l.clock += 1000;
  b.act((s) => editNode(s, X, { title: 'X par B' }));
  b.act((s) => editNode(s, G, { title: 'G par B' }));
  b.act((s) => editNode(s, H, { tags: [{ key: 'important' }] }));
  b.act((s) => editNode(s, N, { title: 'N gardé' }));
  b.act((s) => include(s, P, X, H));
  b.act((s) => include(s, P, L, K));
  const v2 = storeBytes(b.dir, 'note.tex', bytes('\\section{v2}'));
  b.act((s) => editNode(s, M, { files: [v2] }));
  await l.settle();
  const server = await converged(l, [a, b]);
  // The same field: the latest wins; two fields, two tags: both; deleted on one side, renamed on the other: kept, renamed.
  expect(server.nodes.get(X)!.title).toBe('X par B');
  expect([server.nodes.get(G)!.title, server.nodes.get(G)!.summary]).toEqual(['G par B', 'résumé par A']);
  expect(server.nodes.get(H)!.tags).toEqual(expect.arrayContaining([{ key: 'lu' }, { key: 'important' }]));
  expect([server.nodes.get(N)!.title, server.nodes.get(N)!.trashedAt]).toEqual(['N gardé', undefined]);
  // Two groups for X, a cycle of K and L: one inclusion each, the other dropped and named.
  expect([G, H]).toContain(groupOf(server, P, X));
  expect([groupOf(server, P, K), groupOf(server, P, L)].filter(Boolean)).toHaveLength(1);
  // (Each label names the titles its PC saw: each had renamed X first.)
  const dropped = [...a.dropped, ...b.dropped];
  expect(dropped).toHaveLength(2);
  expect(dropped.some((m) => /^« Mettre « X par [AB] » dans « [GH] » » écartée : /.test(m))).toBe(true);
  expect(dropped.some((m) => /^« Mettre « [KL] » dans « [KL] » » écartée : /.test(m))).toBe(true);
  // The same .tex on both: the latest (B's) keeps the name, A's is kept as a conflict copy, and a notification says so.
  const files = server.nodes.get(M)!.files;
  expect(files.find((f) => f.name === 'note.tex')!.hash).toBe(v2.hash);
  expect(files.find((f) => f.name.startsWith('note (conflit du '))!.hash).toBe(v1.hash);
  expect([...a.notices, ...b.notices]).toEqual([expect.stringMatching(/^Un \.tex a été modifié sur deux PC : l’autre version est gardée sous « note \(conflit du /)]);
});

test('B hors ligne (serveur arrêté) agit, l’app fermée puis rouverte avec ses actions en attente ; au retour du serveur, tout passe dans les deux sens', async () => {
  const { lab: l, a, b, P, X, G } = await twoPcs();
  await l.stopServer();
  await until(() => a.status?.state === 'offline' && b.status?.state === 'offline');
  b.act((s) => editNode(s, X, { title: 'X hors ligne sur B' }));
  const n = created(b.act((s) => createNode(s, { plan: P, title: 'Nouveau sur B', x: 0, y: 400, k: 0 })), 'node');
  a.act((s) => editNode(s, G, { title: 'G pendant la panne' }));
  await until(() => b.status?.state === 'offline' && b.status.pending === 2);
  expect(a.status).toEqual({ state: 'offline', pending: 1 });
  await b.restart();
  expect(b.pending).toHaveLength(2);
  await l.startServer();
  await l.settle();
  await converged(l, [a, b]);
  expect(a.s.nodes.get(X)!.title).toBe('X hors ligne sur B');
  expect(a.s.nodes.get(n)!.title).toBe('Nouveau sur B');
  expect(b.s.nodes.get(G)!.title).toBe('G pendant la panne');
});

test('le flux coupé au milieu d’un lot, au milieu d’une trame : reprise où il s’était arrêté, rien de perdu ni de doublé', async () => {
  const { lab: l, a, b, P } = await twoPcs();
  b.net.hold();
  for (let i = 0; i < 20; i++) a.act((s) => createNode(s, { plan: P, title: `n${i}`, x: i * 250, y: 600, k: 0 }));
  await l.settle([a]);
  const opened = b.net.count('GET', '/events'), calls = b.reconciled.length;
  b.net.cutAfter(2500);
  b.net.release();
  await l.settle();
  await converged(l, [a, b]);
  expect(b.net.count('GET', '/events')).toBeGreaterThan(opened);
  expect(b.statuses.some((s) => s.state === 'offline')).toBe(true);
  // Each line the server numbered written once in B's base, none missing.
  const numbers = b.store.changesSince(0).filter((r) => r.kind !== 'rewind' && !r.superseded).map((r) => r.serverSeq);
  expect(numbers).toEqual(Array.from({ length: await l.lastSeq() }, (_, i) => i + 1));
  // Received in batches (syncReceiveBatchMs), not one reconciliation per write.
  expect(b.reconciled.length - calls).toBeLessThan(20);
});

test('l’envoi : dans l’ordre, au plus syncBatchUnits par requête ; flush rend la main quand le serveur a tout ; le rattrapage, puis « live »', async () => {
  const { lab: l, a, b, P } = await twoPcs();
  await b.client.stop();
  a.params = { ...a.params, syncBatchUnits: 3 };
  const sent = a.net.batches.length, units: string[] = [];
  for (let i = 0; i < 7; i++) units.push(a.act((s) => createNode(s, { plan: P, title: `m${i}`, x: i * 250, y: 900, k: 0 }))!.unit);
  await a.client.flush(5000);
  // The server holds them all, in A's order, before their acknowledgements are back maybe.
  const journal = (await l.journal()).map((r) => r.unit);
  expect([...new Set(journal)].slice(-7)).toEqual(units);
  expect(a.net.batches.slice(sent)).toEqual([3, 3, 1]);
  // B, behind: catching up while its stream is held, live once it has received what the server held at its hello.
  b.net.hold();
  b.client.start();
  await until(() => b.status?.state === 'catching-up');
  expect(b.status).toEqual({ state: 'catching-up', behind: (await l.lastSeq()) - b.store.lastServerSeq() });
  b.net.release();
  await l.settle();
  await converged(l, [a, b]);
  // Stopped, nothing is sent: flush returns at once.
  await b.client.stop();
  const t = Date.now();
  await b.client.flush(5000);
  expect(Date.now() - t).toBeLessThan(1000);
});

test('les téléchargements : syncDownloads à la fois au plus, chacun vérifié ; un téléchargement demandé passe devant', async () => {
  const dir = tempDir(), blobs = Array.from({ length: 10 }, (_, i) => bytes(`fichier ${i}`));
  const hashes = blobs.map((b) => createHash('sha256').update(b).digest('hex'));
  let active = 0, most = 0;
  const asked: string[] = [];
  const downloads = new Downloads(dir, async (hash) => {
    asked.push(hash);
    active++;
    most = Math.max(most, active);
    await sleep(5);
    active--;
    const b = blobs[hashes.indexOf(hash)];
    return new Response(b, { headers: { 'Content-Length': String(b.length) } });
  }, () => 3);
  downloads.want(hashes.slice(0, 9));
  expect(await downloads.fetch(hashes[9])).toBe(true);
  await until(() => hashes.every((h) => hasBlob(dir, h)));
  // Three queued at once, and the one asked for besides.
  expect(most).toBe(4);
  expect(asked.indexOf(hashes[9])).toBe(3);
  expect(new Set(asked).size).toBe(asked.length);
  // Queued again, nothing to fetch: all there.
  downloads.want(hashes);
  expect(asked).toHaveLength(10);
});

test('le chemin « en retard » : B attend d’avoir reçu jusqu’au numéro donné, rejoue son action, puis la renvoie', async () => {
  const { lab: l, a, b, X } = await twoPcs();
  b.net.hold();
  a.act((s) => editNode(s, X, { summary: 'résumé de A' }));
  await l.settle([a]);
  const last = await l.lastSeq();
  b.act((s) => editNode(s, X, { title: 'X par B' }));
  await until(() => b.net.results.length > 0);
  expect(b.net.results).toEqual([{ stale: last }]);
  // Nothing sent again before it has received up to that number.
  await sleep(40);
  expect(b.net.count('POST', '/units')).toBe(1);
  expect(b.pending).toHaveLength(1);
  b.net.release();
  await l.settle();
  const server = await converged(l, [a, b]);
  expect([server.nodes.get(X)!.title, server.nodes.get(X)!.summary]).toEqual(['X par B', 'résumé de A']);
  expect(b.net.results).toEqual([{ stale: last }, { accepted: last + 1 }]);
  expect(b.dropped).toEqual([]);
});

test('le chemin « refusé » : deux inclusions du même nœud ; celle du serveur reste, l’autre est écartée et nommée', async () => {
  const { lab: l, a, b, P, X, G, H } = await twoPcs();
  b.net.hold();
  a.act((s) => include(s, P, X, G));
  await l.settle([a]);
  const u = b.act((s) => include(s, P, X, H))!;
  await until(() => b.dropped.length > 0);
  const message = 'Ce nœud est déjà dans un groupe de ce plan.';
  expect(b.net.results).toEqual([{ refused: message }]);
  expect(b.reconciled.at(-1)).toEqual({ incoming: [], refused: [{ unit: u.unit, message }] });
  expect(b.dropped).toEqual([`« Mettre « X » dans « H » » écartée : ${message}`]);
  expect(groupOf(b.s, P, X)).toBeUndefined();
  b.net.release();
  await l.settle();
  await converged(l, [a, b]);
  expect(groupOf(b.s, P, X)).toBe(G);
  expect(b.net.count('POST', '/units')).toBe(1);
});

test('fichiers : un .txt ajouté sur A arrive au magasin de B ; un PDF seulement après fetchBlob ; chacun envoyé une fois, vérifié par son empreinte', async () => {
  const { lab: l, a, b, X, G, H } = await twoPcs();
  const txt = storeBytes(a.dir, 'notes.txt', bytes('des notes')), pdf = storeBytes(a.dir, 'Article.PDF', bytes('%PDF-1.4 pas vraiment'));
  const asked = a.net.count('POST', '/files/missing');
  a.act((s) => editNode(s, X, { files: [txt, pdf] }));
  await l.settle();
  // The same .txt on another node, later: the server holds it, known since — nothing asked, nothing sent.
  a.act((s) => editNode(s, H, { files: [txt] }));
  await l.settle();
  expect([a.net.count('PUT', `/files/${txt.hash}`), a.net.count('PUT', `/files/${pdf.hash}`), a.net.count('POST', '/files/missing') - asked]).toEqual([1, 1, 1]);
  await until(() => existsSync(filePath(b.dir, txt)));
  expect(readFileSync(filePath(b.dir, txt), 'utf8')).toBe('des notes');
  // The PDF waits for its first reading: never asked for.
  expect(existsSync(filePath(b.dir, pdf))).toBe(false);
  expect(b.net.count('GET', `/files/${pdf.hash}`)).toBe(0);
  expect(await b.client.fetchBlob(pdf.hash)).toBe(true);
  expect(readFileSync(filePath(b.dir, pdf), 'utf8')).toBe('%PDF-1.4 pas vraiment');
  // Already here: no request; unknown to the server: false.
  expect(await b.client.fetchBlob(txt.hash)).toBe(true);
  expect(b.net.count('GET', `/files/${txt.hash}`)).toBe(1);
  expect(await b.client.fetchBlob('0'.repeat(64))).toBe(false);
  // Bytes that are not those of their hash: refused, nothing kept, no temporary left.
  const other = storeBytes(a.dir, 'autre.pdf', bytes('%PDF autre'));
  a.act((s) => editNode(s, G, { files: [other] }));
  await l.settle();
  b.net.corruptBlobs = true;
  expect(await b.client.fetchBlob(other.hash)).toBe(false);
  expect(existsSync(filePath(b.dir, other))).toBe(false);
  expect(readdirSync(join(b.dir, 'files')).filter((f) => f.startsWith('.import-'))).toEqual([]);
  b.net.corruptBlobs = false;
  expect(await b.client.fetchBlob(other.hash)).toBe(true);
});

test('des téléchargements interrompus par stop() (la veille) ou par la fermeture de l’app ne sont pas perdus : ils reprennent au démarrage suivant (R9)', async () => {
  const { lab: l, a, b, P } = await twoPcs();
  const list = join(b.dir, DOWNLOADS_FILE);
  /** Six .txt files on a new node of A's. */
  const sixFiles = (from: number) => {
    const refs = Array.from({ length: 6 }, (_, i) => storeBytes(a.dir, `notes-${from + i}.txt`, bytes(`notes ${from + i}`)));
    a.act((s) => createNode(s, { plan: P, title: `fichiers ${from}`, x: from * 100, y: 1200, k: 0, files: refs }));
    return refs;
  };
  const here = (refs: FileRef[]) => refs.every((f) => existsSync(filePath(b.dir, f)));
  const gets = () => b.net.count('GET', /^\/files\//);
  // Asleep mid-download: four under way (syncDownloads), two queued; stopped, then started again, on the same client.
  b.net.holdFiles();
  let asked = gets();
  const first = sixFiles(0);
  await until(() => gets() === asked + 4);
  await b.client.stop();
  expect(first.some((f) => existsSync(filePath(b.dir, f)))).toBe(false);
  expect((JSON.parse(readFileSync(list, 'utf8')) as { hashes: string[] }).hashes.sort()).toEqual(first.map((f) => f.hash).sort());
  b.net.releaseFiles();
  b.client.start();
  await until(() => here(first));
  // The app closed mid-download, then opened again: a new client on the same base reads the list back.
  b.net.holdFiles();
  asked = gets();
  const second = sixFiles(6);
  await until(() => gets() === asked + 4);
  await b.restart();
  await until(() => here(second));
  // Nothing left to download: the list is gone.
  await until(() => !existsSync(list));
  await l.settle();
  await converged(l, [a, b]);
});

test('le client arrêté entre l’acceptation et sa réponse, puis une réponse perdue : rien n’est doublé au serveur', async () => {
  const { lab: l, a, b, X, G } = await twoPcs();
  // Its acknowledgements held on the wire: the write stays pending at B when its client stops.
  b.net.hold();
  b.net.onUnitsAnswered = () => {
    b.net.onUnitsAnswered = null;
    void b.client.stop();
    throw new TypeError('fetch failed');
  };
  const u = b.act((s) => editNode(s, X, { title: 'X par B' }))!;
  await until(() => b.status?.state === 'off');
  expect(b.net.results).toEqual([{ accepted: expect.any(Number) }]);
  expect(b.store.pendingUnits().map((x) => x.unit)).toEqual([u.unit]);
  await b.restart();
  await l.settle();
  await converged(l, [a, b]);
  expect((await l.journal()).filter((r) => r.unit === u.unit)).toHaveLength(u.ops.length);
  // The answer lost while the client runs: offline, back, the write sent again; the server gives it its number again.
  // (After the restart, B may have sent its first write again before its acknowledgement came: that answer is counted out.)
  const r0 = b.net.results.length;
  b.net.hold();
  b.net.onUnitsAnswered = () => {
    b.net.onUnitsAnswered = null;
    throw new TypeError('fetch failed');
  };
  const v = b.act((s) => editNode(s, G, { title: 'G par B' }))!;
  await until(() => b.net.results.length === r0 + 2);
  expect(b.net.results[r0 + 1]).toEqual(b.net.results[r0]);
  expect(b.net.results[r0]).toEqual({ accepted: expect.any(Number) });
  expect(b.statuses.some((s) => s.state === 'offline')).toBe(true);
  b.net.release();
  await l.settle();
  await converged(l, [a, b]);
  expect((await l.journal()).filter((r) => r.unit === v.unit)).toHaveLength(v.ops.length);
  expect(a.s.nodes.get(G)!.title).toBe('G par B');
});

test('une horloge de PC en avance de 10 min : l’avertissement, et l’heure des actions corrigée ; en avance d’une heure, il ne gagne pas les conflits', async () => {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a', { skewMs: 10 * 60_000 }), b = await l.pc('pc-b'), c = await l.pc('pc-c', { skewMs: 3_600_000 });
  await l.settle();
  expect(a.client.clockOffset()).toBe(-600_000);
  expect(a.status).toEqual({ state: 'live', pending: 0, clockWarning: 'L\'horloge de ce PC diffère de celle du serveur de 10 minutes : règle-la.' });
  expect(c.status!.clockWarning).toBe('L\'horloge de ce PC diffère de celle du serveur de 60 minutes : règle-la.');
  expect(b.status).toEqual({ state: 'live', pending: 0 });
  expect(b.client.clockOffset()).toBe(0);
  l.clock += 5000;
  const p = a.act((s) => createPlan(s, 'P', 'plan'))!;
  const X = created(a.act((s) => createNode(s, { plan: created(p, 'plan'), title: 'X', x: 0, y: 0, k: 0 })), 'node');
  expect(p.at).toBe(T0 + 5000);
  await l.settle();
  expect((await l.journal()).filter((r) => r.unit === p.unit).map((r) => r.at)).toEqual([T0 + 5000]);
  // C, an hour ahead, renames X; B a second later, by the server's clock: B's is the latest, and wins.
  l.clock += 1000;
  c.act((s) => editNode(s, X, { title: 'X par C' }));
  l.clock += 1000;
  b.act((s) => editNode(s, X, { title: 'X par B' }));
  await l.settle();
  const server = await converged(l, [a, b, c]);
  expect(server.nodes.get(X)!.title).toBe('X par B');
});

/**
 * A client whose server is a fake `fetch`, on a base of its own, for the tests under a simulated clock: reconnections
 * from 1 s to 30 s; each /hello's time logged.
 */
function fakeClient(f: typeof fetch, reconcile: (incoming: RemoteUnit[]) => Promise<void> = async () => {}) {
  const dir = tempDir(), store = LocalStore.open(dir, { pc: 'pc-r' }), statuses: SyncStatus[] = [];
  const client = new SyncClient({
    fetch: f, store, storeDir: dir, secrets: { read: () => ({ url: 'http://127.0.0.1:7310', token: 't'.repeat(43), name: 'R' }), write: () => {} },
    reconcile, now: () => Date.now(), params: () => ({ ...TEST_PARAMS, syncRetryMinMs: 1000, syncRetryMaxMs: 30_000 }), status: (s) => { statuses.push(s); },
  });
  return { client, store, statuses };
}

test('la reconnexion espace ses essais de syncRetryMinMs à syncRetryMaxMs (horloge simulée) ; arrêtée, elle cesse', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const hellos: number[] = [];
  const { client, store, statuses } = fakeClient(async (input) => {
    if (new URL(String(input)).pathname === '/hello') hellos.push(Date.now());
    throw new TypeError('fetch failed');
  });
  const t0 = Date.now();
  client.start();
  await vi.advanceTimersByTimeAsync(91_000);
  expect(hellos.map((t) => t - t0)).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000]);
  expect(statuses).toEqual([{ state: 'connecting' }, { state: 'offline', pending: 0 }]);
  await client.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(hellos).toHaveLength(8);
  expect(statuses.at(-1)).toEqual({ state: 'off' });
  store.close();
});

test('un flux qui s’ouvre puis se ferme aussitôt ne remet pas l’attente à zéro ; une connexion qui a fait ses preuves, si (revue de la tâche 3, I1)', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const hellos: number[] = [], reconciled: number[] = [];
  /** What the server's stream does: end at once, stay open, bring one write then end 200 ms later; or the server is down. */
  let mode: 'closes' | 'holds' | 'unit' | 'down' = 'closes';
  let held: ReadableStreamDefaultController<Uint8Array> | null = null;
  const unit = { unit: 'u1', action: 'a1', label: 'Créer le plan « P »', at: 0, pc: 'pc-x', ops: [{ t: 'plan', before: null, after: { id: 'p1', name: 'P', type: 'plan' } }], seq: 1 };
  const { client, store, statuses } = fakeClient(async (input) => {
    const path = new URL(String(input)).pathname, m = mode;
    if (path === '/hello') hellos.push(Date.now());
    if (m === 'down') throw new TypeError('fetch failed');
    if (path === '/hello') return Response.json({ serverTime: Date.now(), lastSeq: 0, empty: false });
    if (path !== '/events') throw new Error(`requête inattendue : ${path}`);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        if (m === 'closes') c.close();
        else if (m === 'holds') held = c;
        else {
          c.enqueue(bytes(`id: 1\nevent: unit\ndata: ${JSON.stringify(unit)}\n\n`));
          setTimeout(() => c.close(), 200);
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }, async (incoming) => { reconciled.push(incoming.length); });
  const t0 = Date.now();
  client.start();
  // Streams that open then end at once: the pauses grow as if the server were down.
  await vi.advanceTimersByTimeAsync(15_000);
  // A stream that stays open syncRetryMaxMs: the connection has proven itself, the next pause is the shortest.
  mode = 'holds';
  await vi.advanceTimersByTimeAsync(16_000 + 30_000);
  mode = 'closes';
  held!.close();
  await vi.advanceTimersByTimeAsync(4000);
  // A reconciliation written: proven too.
  mode = 'unit';
  await vi.advanceTimersByTimeAsync(4000);
  mode = 'down';
  await vi.advanceTimersByTimeAsync(4000);
  expect(hellos.map((t) => t - t0)).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 62_000, 64_000, 68_000, 69_200, 71_200]);
  expect(reconciled).toEqual([1]);
  expect(statuses).toContainEqual({ state: 'live', pending: 0 });
  await client.stop();
  store.close();
});

test('un jeton révoqué : « Serveur : <raison> », sans nouvel essai', async () => {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a');
  await l.settle();
  l.revoke('PC-A');
  a.act((s) => createPlan(s, 'P', 'plan'));
  await until(() => a.status?.state === 'refused');
  expect(a.status).toEqual({ state: 'refused', message: 'Jeton absent, inconnu ou révoqué : jumelle ce PC de nouveau.' });
  const n = a.net.requests.length;
  await sleep(100);
  expect(a.net.requests).toHaveLength(n);
});

test('une écriture reçue qui ne s’applique pas : la réception s’arrête, « refused » et diverged, sans boucler', async () => {
  const { a, b, X } = await twoPcs();
  // B's state no longer follows the server's: X renamed there without any write.
  applyOp(b.s, { t: 'node', before: b.s.nodes.get(X)!, after: { ...b.s.nodes.get(X)!, title: 'Z' } });
  a.act((s) => editNode(s, X, { title: 'X par A' }));
  await until(() => b.status?.state === 'refused');
  expect(b.status).toEqual({ state: 'refused', message: expect.stringMatching(/^La base de ce PC ne suit plus celle du serveur : /), diverged: true });
  const requests = b.net.requests.length, calls = b.reconciled.length;
  await sleep(100);
  expect([b.net.requests.length, b.reconciled.length]).toEqual([requests, calls]);
  expect(b.s.nodes.get(X)!.title).toBe('Z');
});
