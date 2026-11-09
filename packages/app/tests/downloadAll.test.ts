import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOps, createAnnotation, createNode, createPlan, deleteEverywhere, editNode, emptyState, type FileRef, type Id } from '@cirrus/core';
import { filePath, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { DOWNLOADS_FILE, DownloadAll, Downloads, hasBlob, median } from '../src/main/sync/downloads.ts';
import type { DownloadAllProgress, ServerStatus } from '../src/main/sync/protocol.ts';
import { planText, progressText, referencedPdfs, statusLines } from '../src/renderer/sync/downloadAll.ts';
import { created, Lab, sleep, until, type VirtualPc } from './support/virtualPc.ts';

// « Tout télécharger » and the server's state (plan 5b, task 7, D8): every PDF the base refers to downloaded on this PC,
// told ahead of what it takes and refused without room, stopped cleanly (« Arrêter », the server lost, the app closed),
// never resumed by itself; the latency and the throughput the main process measures, and the server's space (GET
// /status). Virtual PCs against a server started in the process (support/virtualPc.ts): never the user's base.

const labs: Lab[] = [];
afterEach(async () => {
  for (const l of labs.splice(0)) await l.close();
});

async function lab(): Promise<Lab> {
  const l = await Lab.start();
  labs.push(l);
  return l;
}

const MiB = 2 ** 20, GiB = 2 ** 30;
const FILES = /^\/files\/[0-9a-f]{64}$/;

/** A PDF's bytes, distinct by `i`. */
function pdfBytes(i: number, size = 600): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size).fill(0x20);
  b.set(new TextEncoder().encode(`%PDF-1.4\n% article ${i}\n`));
  return b;
}

/**
 * A adds `n` PDFs, each in a node of its own; B (`params`) receives the nodes, never their bytes (a PDF comes at its
 * first reading, plan 5a, D6). B's disk says 5 Go free.
 */
async function pdfsOnServer(n: number, params: Partial<VirtualPc['params']> = {}) {
  const l = await lab();
  const a = await l.pc('pc-a'), b = await l.pc('pc-b', { params });
  b.free = 5 * GiB;
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  const bytes = new Map<string, Uint8Array>(), refs: FileRef[] = [];
  for (let i = 0; i < n; i++) {
    const data = pdfBytes(i, 600 + i);
    const ref = storeBytes(a.dir, `Article ${i}.pdf`, data);
    bytes.set(ref.hash, data);
    refs.push(ref);
    a.act((s) => createNode(s, { plan: P, title: `Article ${i}`, x: i * 200, y: 0, k: 0, files: [ref] }));
  }
  await l.settle();
  expect(refs.some((r) => hasBlob(b.dir, r.hash))).toBe(false);
  return { lab: l, a, b, refs, bytes };
}

const sum = (refs: FileRef[]) => refs.reduce((n, r) => n + r.size, 0);
const temporaries = (pc: VirtualPc) => {
  const files = join(pc.dir, 'files');
  return existsSync(files) ? (readdirSync(files, { recursive: true }) as string[]).filter((f) => f.includes('.import-')) : [];
};
const ended = (pc: VirtualPc) => until(() => pc.client.downloadAllProgress()?.end !== undefined, 5000, () => JSON.stringify(pc.allProgress));

// ---------------------------------------------------------------------------------------------------------------------
// The server's state

test('median : le milieu, ou la moyenne des deux du milieu ; null sans mesure', () => {
  expect([median([]), median([7]), median([50, 10]), median([50, 10, 40]), median([10, 40, 30, 20, 5])]).toEqual([null, 7, 30, 40, 20]);
});

test('la latence : la médiane des 5 derniers allers-retours de GET /status, mesurés par le principal ; hors connexion, aucune requête', async () => {
  const l = await lab();
  const b = await l.pc('pc-b');
  let t = 0;
  b.clock = () => t;
  // Each round trip of GET /status takes the next of these (ms), on B's clock.
  const trips = [50, 10, 40, 30, 20, 5];
  b.net.before = (_method, path) => { if (path === '/status') t += trips.shift()!; };
  await l.settle([b]);
  const first = await b.client.serverStatus();
  expect(first).toEqual({
    latencyMs: 50, throughput: null,
    server: { baseBytes: expect.any(Number), storeBytes: 0, storeFiles: 0, freeBytes: expect.any(Number), counting: expect.any(Boolean) },
  });
  expect((await b.client.serverStatus()).latencyMs).toBe(30);
  for (let i = 0; i < 2; i++) await b.client.serverStatus();
  expect((await b.client.serverStatus()).latencyMs).toBe(30);
  // The sixth: the first (50) no longer counts — 10, 40, 30, 20, 5.
  expect((await b.client.serverStatus()).latencyMs).toBe(20);
  expect(b.net.count('GET', '/status')).toBe(6);
  // The server lost: nothing asked, nothing known.
  await l.stopServer();
  await until(() => b.status?.state === 'offline');
  expect(await b.client.serverStatus()).toEqual({ latencyMs: null, throughput: null, server: null });
  expect(b.net.count('GET', '/status')).toBe(6);
});

test('le débit : la médiane des 5 derniers transferts d’au moins 1 Mio, envois et téléchargements ; les plus petits ne comptent pas ; null avant', async () => {
  const l = await lab();
  // B downloads one file at a time: each measured on its own on B's clock.
  const a = await l.pc('pc-a'), b = await l.pc('pc-b', { params: { syncDownloads: 1 } });
  let ta = 0, tb = 0;
  a.clock = () => ta;
  b.clock = () => tb;
  // Each file A sends takes half a second on its clock; each one B downloads, a second on its own.
  a.net.before = (method, path) => { if (method === 'PUT' && FILES.test(path)) ta += 500; };
  b.net.before = (method, path) => { if (method === 'GET' && FILES.test(path)) tb += 1000; };
  await l.settle();
  expect((await a.client.serverStatus()).throughput).toBeNull();
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  // Not PDFs: B downloads them as soon as it receives the node (plan 5a, D6).
  const files = [storeBytes(a.dir, 'grand.bin', new Uint8Array(2 * MiB).fill(1)), storeBytes(a.dir, 'juste.bin', new Uint8Array(MiB).fill(2)),
    storeBytes(a.dir, 'petit.bin', new Uint8Array(MiB - 1).fill(3))];
  a.act((s) => createNode(s, { plan: P, title: 'Données', x: 0, y: 0, k: 0, files }));
  await l.settle();
  await until(() => files.every((f) => hasBlob(b.dir, f.hash)));
  // In bytes per second: 2 Mio and 1 Mio in half a second each — 1 Mio less one byte does not count.
  expect((await a.client.serverStatus()).throughput).toBe((4 * MiB + 2 * MiB) / 2);
  expect((await b.client.serverStatus()).throughput).toBe((2 * MiB + MiB) / 2);
});

// ---------------------------------------------------------------------------------------------------------------------
// « Tout télécharger »

test('le plan : les PDF absents de ce PC seulement, chacun une fois, leur volume d’après les références, et la place libre de son disque ; rien demandé au serveur', async () => {
  const { b, refs } = await pdfsOnServer(4, { syncDownloads: 2 });
  expect(await b.client.fetchBlob(refs[0].hash)).toBe(true);
  const plan = await b.client.downloadAllPlan([...refs, refs[1], { name: 'x.pdf', hash: 'pas une empreinte', size: 3 }, { name: 'y.pdf', hash: refs[2].hash, size: -1 }, null]);
  expect(plan).toEqual({ count: 3, bytes: sum(refs.slice(1)), freeBytes: 5 * GiB });
  expect(b.net.count('GET', FILES)).toBe(1);
  // Started: syncDownloads at a time, each checked; told as each ends.
  b.net.holdFiles();
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await until(() => b.net.count('GET', FILES) === 3);
  await sleep(30);
  expect(b.net.count('GET', FILES)).toBe(3);
  b.net.releaseFiles();
  await ended(b);
  expect(b.client.downloadAllProgress()).toEqual({ done: 3, failed: 0, total: 3, doneBytes: sum(refs.slice(1)), totalBytes: sum(refs.slice(1)), end: 'done' });
  expect(b.allProgress.map((p) => [p.done, p.end])).toEqual([[0, undefined], [1, undefined], [2, undefined], [3, 'done']]);
  for (const r of refs) expect(new Uint8Array(readFileSync(filePath(b.dir, r))).length).toBe(r.size);
  expect(b.net.count('GET', FILES)).toBe(4);
  // Nothing left to do.
  expect(await b.client.downloadAllPlan(refs)).toMatchObject({ count: 0, bytes: 0 });
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: false, reason: 'none', plan: { count: 0, bytes: 0, freeBytes: 5 * GiB } });
});

test('pas assez de place : refusé d’avance, rien demandé au serveur ; juste assez, il passe', async () => {
  const { b, refs } = await pdfsOnServer(2, { downloadAllReserveMb: 1 });
  const bytes = sum(refs);
  // The reserve (downloadAllReserveMb: 1 Mo) would not stay free.
  b.free = bytes + MiB - 1;
  const plan = { count: 2, bytes, freeBytes: b.free };
  expect(await b.client.downloadAllPlan(refs)).toEqual(plan);
  expect(planText(plan, 1).ok).toBe(false);
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: false, reason: 'room', plan });
  expect(b.client.downloadAllProgress()).toBeNull();
  expect(b.net.count('GET', FILES)).toBe(0);
  b.free = bytes + MiB;
  expect(planText({ ...plan, freeBytes: b.free }, 1).ok).toBe(true);
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await ended(b);
  expect(b.client.downloadAllProgress()?.end).toBe('done');
  expect(refs.every((r) => hasBlob(b.dir, r.hash))).toBe(true);
});

test('« Arrêter », puis une relance qui ne prend que ce qui manque ; rien n’est gardé pour le démarrage suivant', async () => {
  const { b, refs, bytes } = await pdfsOnServer(4, { syncDownloads: 1 });
  // Two done, the third held at the server's door.
  b.onAll = (p) => { if (p.done === 2 && p.end === undefined) b.net.holdFiles(); };
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await until(() => b.net.count('GET', FILES) === 3);
  // A second start while one runs: refused.
  expect(await b.client.downloadAllStart(refs)).toMatchObject({ ok: false, reason: 'running' });
  b.client.downloadAllStop();
  expect(b.client.downloadAllProgress()).toEqual({ done: 2, failed: 0, total: 4, doneBytes: sum(refs.slice(0, 2)), totalBytes: sum(refs), end: 'stopped' });
  await sleep(30);
  // The one under way aborted, the fourth never asked; nothing half written, nothing kept for the next start.
  expect(b.net.count('GET', FILES)).toBe(3);
  expect([hasBlob(b.dir, refs[2].hash), hasBlob(b.dir, refs[3].hash)]).toEqual([false, false]);
  expect(temporaries(b)).toEqual([]);
  expect(existsSync(join(b.dir, DOWNLOADS_FILE))).toBe(false);
  expect(b.allProgress.at(-1)?.end).toBe('stopped');
  // Started again: only what is still missing.
  b.onAll = null;
  b.net.releaseFiles();
  expect(await b.client.downloadAllPlan(refs)).toMatchObject({ count: 2, bytes: sum(refs.slice(2)) });
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await ended(b);
  expect(b.client.downloadAllProgress()).toEqual({ done: 2, failed: 0, total: 2, doneBytes: sum(refs.slice(2)), totalBytes: sum(refs.slice(2)), end: 'done' });
  for (const r of refs) expect(new Uint8Array(readFileSync(filePath(b.dir, r)))).toEqual(bytes.get(r.hash));
  expect(b.net.count('GET', FILES)).toBe(5);
});

test('le serveur perdu en route : arrêt propre, rien de partiel au magasin ; rien de repris au démarrage suivant, puis une relance', async () => {
  const { lab: l, b, refs, bytes } = await pdfsOnServer(3, { syncDownloads: 1 });
  // Once the first is done, the connection breaks in the middle of the next file: half its bytes, then nothing.
  b.onAll = (p) => {
    if (p.done !== 1 || p.end !== undefined) return;
    b.net.respond = (method, path) => {
      if (method !== 'GET' || !FILES.test(path)) return null;
      const data = bytes.get(path.slice('/files/'.length))!;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) c.error(new TypeError('terminated'));
          else c.enqueue(data.slice(0, data.length >> 1));
          sent = true;
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Length': String(data.length) } });
    };
  };
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await ended(b);
  expect(b.client.downloadAllProgress()).toEqual({ done: 1, failed: 0, total: 3, doneBytes: refs[0].size, totalBytes: sum(refs), end: 'lost' });
  expect(b.net.count('GET', FILES)).toBe(2);
  expect([hasBlob(b.dir, refs[1].hash), hasBlob(b.dir, refs[2].hash)]).toEqual([false, false]);
  expect(temporaries(b)).toEqual([]);
  expect(existsSync(join(b.dir, DOWNLOADS_FILE))).toBe(false);
  // The app closed and opened again: connected, nothing of it resumes.
  b.onAll = null;
  await b.restart();
  await l.settle([b]);
  await sleep(50);
  expect(b.net.count('GET', FILES)).toBe(0);
  expect(b.client.downloadAllProgress()).toBeNull();
  // Started again: the two missing.
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await ended(b);
  expect(b.client.downloadAllProgress()).toMatchObject({ done: 2, total: 2, end: 'done' });
});

test('le disque de ce PC qui refuse un fichier (plein, interdit) : arrêt propre, dit, rien de gardé pour le démarrage suivant', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { b, refs } = await pdfsOnServer(2, { syncDownloads: 1 });
  // The store's folder of files is a file: nothing can be written in it, as on a full disk (syncFiles.test.ts).
  writeFileSync(join(b.dir, 'files'), 'pas un dossier');
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await ended(b);
  expect(b.client.downloadAllProgress()).toEqual({ done: 0, failed: 0, total: 2, doneBytes: 0, totalBytes: sum(refs), end: 'disk' });
  expect(b.net.count('GET', FILES)).toBe(1);
  expect(existsSync(join(b.dir, DOWNLOADS_FILE))).toBe(false);
  expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/non enregistré dans la base/));
  warn.mockRestore();
});

test('l’app fermée pendant un téléchargement : interrompu, le fichier à moitié reçu effacé, rien de gardé pour le démarrage suivant', async () => {
  const { b, refs, bytes } = await pdfsOnServer(2, { syncDownloads: 1 });
  // The first file's bytes come half, then wait — until the request is aborted.
  b.net.respond = (method, path, signal) => {
    if (method !== 'GET' || !FILES.test(path)) return null;
    const data = bytes.get(path.slice('/files/'.length))!;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(data.slice(0, data.length >> 1));
          return;
        }
        await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
        c.error(signal?.reason ?? new Error('interrompu'));
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Length': String(data.length) } });
  };
  expect(await b.client.downloadAllStart(refs)).toEqual({ ok: true });
  await until(() => temporaries(b).length === 1);
  await b.client.stop();
  expect(b.client.downloadAllProgress()).toMatchObject({ done: 0, total: 2, end: 'interrupted' });
  expect(temporaries(b)).toEqual([]);
  expect(refs.some((r) => hasBlob(b.dir, r.hash))).toBe(false);
  expect(existsSync(join(b.dir, DOWNLOADS_FILE))).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// The queue, without a server: Downloads and DownloadAll on a request the test answers

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A store's folder, and blobs of distinct bytes by their hashes. */
function queueOf(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-tout-')), blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  dirs.push(dir);
  for (let i = 0; i < n; i++) {
    const b = pdfBytes(i);
    blobs.set(createHash('sha256').update(b).digest('hex'), b);
  }
  return { dir, blobs, hashes: [...blobs.keys()] };
}
const answer = (b: Uint8Array<ArrayBuffer>) => new Response(b, { status: 200, headers: { 'Content-Length': String(b.length) } });

test('Downloads : ceux de « Tout télécharger » ne sont ni écrits à côté de la base, ni réessayés à la connexion suivante ; ceux de la synchro le restent', async () => {
  const { dir, blobs, hashes: [kept, once1, once2, once3] } = queueOf(4);
  const asked: string[] = [];
  let network: 'held' | 'down' | 'up' = 'held';
  const downloads = new Downloads(dir, (hash, signal) => {
    asked.push(hash);
    if (network === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (network === 'up') return Promise.resolve(answer(blobs.get(hash)!));
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, () => 2);
  // Two under way (one of each), two queued: stopped, only the synchronisation's is kept for the next start.
  downloads.want([kept]);
  downloads.wantOnce([once1, once2, once3]);
  expect(asked).toEqual([kept, once1]);
  await downloads.stop();
  expect(JSON.parse(readFileSync(join(dir, DOWNLOADS_FILE), 'utf8'))).toEqual({ hashes: [kept] });
  // Broken by the network: only the synchronisation's is tried again.
  network = 'down';
  downloads.want([kept]);
  downloads.wantOnce([once1]);
  await until(() => asked.length === 4);
  await sleep(10);
  network = 'up';
  downloads.retry();
  await until(() => hasBlob(dir, kept));
  await sleep(10);
  expect(asked.slice(4)).toEqual([kept]);
  expect(hasBlob(dir, once1)).toBe(false);
  expect(existsSync(join(dir, DOWNLOADS_FILE))).toBe(false);
});

test('DownloadAll : un téléchargement de la fois d’avant, arrêté mais pas encore fini, est demandé de nouveau par la suivante ; un PDF ouvert pendant n’est pas arrêté avec elle', async () => {
  const { dir, blobs, hashes: [first, opened] } = queueOf(2);
  const asked: string[] = [];
  let hold = true;
  // Held, a request ends a moment after its abort: still under way when the next one starts.
  const downloads = new Downloads(dir, (hash, signal) => {
    asked.push(hash);
    if (!hold) return Promise.resolve(answer(blobs.get(hash)!));
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true });
      if (hash === opened) setTimeout(() => resolve(answer(blobs.get(hash)!)), 30);
    });
  }, () => 4);
  const told: DownloadAllProgress[] = [];
  const all = new DownloadAll(downloads, (p) => told.push(p));
  all.start(new Map([[first, 600], [opened, 601]]));
  // The second PDF opened meanwhile (fetch): it no longer belongs to the one under way, and « Arrêter » leaves it.
  const read = downloads.fetch(opened);
  all.stop('stopped');
  hold = false;
  all.start(new Map([[first, 600]]));
  expect(await read).toBe(true);
  await until(() => all.current()?.end !== undefined);
  expect(all.current()).toEqual({ done: 1, failed: 0, total: 1, doneBytes: 600, totalBytes: 600, end: 'done' });
  expect([hasBlob(dir, first), hasBlob(dir, opened)]).toEqual([true, true]);
  expect(asked).toEqual([first, opened, first]);
  expect(told.map((p) => p.end)).toEqual([undefined, 'stopped', undefined, 'done']);
});

// ---------------------------------------------------------------------------------------------------------------------
// The interface: the PDFs counted, the texts

/** A hash for tests: `i` in 64 hexadecimal digits. */
const h = (i: number) => i.toString(16).padStart(64, '0');
const ref = (name: string, i: number, size = 1000 + i): FileRef => ({ name, hash: h(i), size });

test('referencedPdfs : les PDF des dossiers des nœuds et des ancres des annotations vivantes, sans doublon ; ni une annotation à la corbeille, ni une version que seul l’historique garde, ni un nœud à la corbeille', () => {
  const s = emptyState();
  // An action applied to the state: the identifier of the record of kind `t` it creates.
  const run = (a: Action, t: 'node' | 'plan'): Id => {
    applyOps(s, a.ops);
    return (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
  };
  const P = run(createPlan(s, 'P', 'plan'), 'plan');
  const node = (title: string, files: FileRef[]): Id => run(createNode(s, { plan: P, title, x: 0, y: 0, k: 0, files }), 'node');
  const annotate = (pdf: Id, file: FileRef): Id => run(createAnnotation(s, { pdf, file: file.name, hash: file.hash, page: 1, rects: [[0, 0, 10, 10]], text: 'passage' }, 'passage'), 'node');
  // X: a PDF annotated, then re-imported — the annotation, live, keeps its version (sized by the file under its name now).
  const X = node('X', [ref('Article.pdf', 1), ref('notes.txt', 2)]);
  annotate(X, ref('Article.pdf', 1));
  applyOps(s, editNode(s, X, { files: [ref('Article.pdf', 3), ref('notes.txt', 2)] }).ops);
  annotate(X, ref('Article.pdf', 3));
  // Y: a PDF re-imported, its first version annotated by nobody: only the history keeps it.
  const Y = node('Y', [ref('Livre.pdf', 5)]);
  applyOps(s, editNode(s, Y, { files: [ref('Livre.pdf', 6)] }).ops);
  // Z: re-imported too, its first version annotated by an annotation since in the trash.
  const Z = node('Z', [ref('Thèse.pdf', 7)]);
  applyOps(s, deleteEverywhere(s, annotate(Z, ref('Thèse.pdf', 7))).ops);
  applyOps(s, editNode(s, Z, { files: [ref('Thèse.pdf', 8)] }).ops);
  // The same PDF in another node; one in capitals; a node in the trash.
  node('W', [ref('Copie.pdf', 3), ref('MAJUSCULES.PDF', 10)]);
  applyOps(s, deleteEverywhere(s, node('T', [ref('Corbeille.pdf', 9)])).ops);
  const byHash = (a: FileRef, b: FileRef) => (a.hash < b.hash ? -1 : 1);
  expect(referencedPdfs(s).sort(byHash)).toEqual([
    { name: 'Article.pdf', hash: h(1), size: ref('Article.pdf', 3).size }, ref('Article.pdf', 3), ref('Livre.pdf', 6), ref('Thèse.pdf', 8), ref('MAJUSCULES.PDF', 10),
  ]);
});

test('les textes du bloc : la question, le refus, l’avancement et ses fins, l’état du serveur ; les tailles à la française, une espace insécable avant l’unité', () => {
  const nb = ' ';
  expect(planText({ count: 37, bytes: 1.2 * GiB, freeBytes: 48 * GiB }, 1024)).toEqual({ ok: true, text: `37 PDF à télécharger, 1,2${nb}Go ; 48,0${nb}Go libres sur ce disque.` });
  expect(planText({ count: 1, bytes: 340 * MiB, freeBytes: 48 * GiB }, 1024)).toEqual({ ok: true, text: `1 PDF à télécharger, 340${nb}Mo ; 48,0${nb}Go libres sur ce disque.` });
  expect(planText({ count: 37, bytes: 1.2 * GiB, freeBytes: 0.8 * GiB }, 1024)).toEqual({ ok: false, text: `Pas assez de place : 1,2${nb}Go à télécharger, 819${nb}Mo libres.` });
  // What would leave exactly the reserve free passes; a byte more does not.
  expect(planText({ count: 2, bytes: GiB, freeBytes: GiB + 1024 * MiB }, 1024).ok).toBe(true);
  expect(planText({ count: 2, bytes: GiB + 1, freeBytes: GiB + 1024 * MiB }, 1024).ok).toBe(false);
  expect(planText({ count: 0, bytes: 0, freeBytes: GiB }, 1024)).toEqual({ ok: false, text: 'Tous les PDF de la base sont déjà sur ce PC.' });
  const p = (o: Partial<DownloadAllProgress>): DownloadAllProgress => ({ done: 12, failed: 0, total: 37, doneBytes: 340 * MiB, totalBytes: 1.2 * GiB, ...o });
  expect(progressText(p({}))).toBe(`12 PDF sur 37, 340${nb}Mo sur 1,2${nb}Go`);
  expect(progressText(p({ done: 37, end: 'done' }))).toBe('37 PDF téléchargés.');
  expect(progressText(p({ done: 1, total: 1, end: 'done' }))).toBe('1 PDF téléchargé.');
  expect(progressText(p({ done: 35, failed: 2, end: 'done' }))).toBe('35 PDF sur 37 téléchargés ; 2 n’ont pas pu l’être (absents du serveur, ou abîmés).');
  expect(progressText(p({ done: 36, failed: 1, end: 'done' }))).toBe('36 PDF sur 37 téléchargés ; 1 n’a pas pu l’être (absent du serveur, ou abîmé).');
  expect(progressText(p({ end: 'stopped' }))).toBe('Téléchargement arrêté : 12 PDF sur 37.');
  expect(progressText(p({ end: 'lost' }))).toBe('Serveur perdu : téléchargement arrêté à 12 PDF sur 37.');
  expect(progressText(p({ end: 'disk' }))).toBe('PDF non enregistré sur ce PC : le disque est plein, ou Windows y refuse l’écriture. Téléchargement arrêté à 12 PDF sur 37.');
  expect(progressText(p({ end: 'interrupted' }))).toBe('Téléchargement interrompu à 12 PDF sur 37.');
  // The server's state: its lines, a value « — » until known.
  const known: ServerStatus = { latencyMs: 12.4, throughput: 4 * MiB, server: { baseBytes: 1.2 * MiB, storeBytes: 340 * MiB, storeFiles: 12, freeBytes: 48 * GiB, counting: false } };
  expect(statusLines(known)).toEqual([
    ['Latence', '12 ms'], ['Débit', `4,0${nb}Mo/s`], ['Base du serveur', `1,2${nb}Mo`], ['Magasin du serveur', `12 fichiers, 340${nb}Mo`], ['Espace libre du serveur', `48,0${nb}Go`],
  ]);
  expect(statusLines({ ...known, latencyMs: 0.42, server: { ...known.server!, storeFiles: 1, counting: true } }).slice(0, 4).map(([, v]) => v)).toEqual([
    '0,4 ms', `4,0${nb}Mo/s`, `1,2${nb}Mo`, `1 fichier, 340${nb}Mo (décompte en cours)`,
  ]);
  expect(statusLines(null).map(([, v]) => v)).toEqual(['—', '—', '—', '—', '—']);
  expect(statusLines({ latencyMs: null, throughput: null, server: null }).map(([, v]) => v)).toEqual(['—', '—', '—', '—', '—']);
});
