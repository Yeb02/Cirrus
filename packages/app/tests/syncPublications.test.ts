import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNode, type FileRef, type Id } from '@cirrus/core';
import { importPublication } from '@cirrus/sources';
import { filePath, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { fileResponse } from '../src/main/files.ts';
import { replayFetch, replayOpen } from '../src/main/publications/replay.ts';
import { importPublicationVia, type ViaDeps } from '../src/main/publications/via.ts';
import { fileUrl } from '../src/renderer/files/kind.ts';
import { AppPc } from './support/appPc.ts';
import { Lab, PUBLICATIONS_DATA, until } from './support/virtualPc.ts';

// A publication's import by the server (plan 5b, task 3, D2): a PC paired and connected asks the server, which imports
// it by its own network and keeps the PDF; the PC downloads it at its first reading, and never sends it back. Without a
// server, or the server unreachable, the PC imports it itself, as in plan 4c. The server's network and the PC's are the
// recorded answers (tests/data/publications): never the Internet.

let lab: Lab | null = null;
const apps: AppPc[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
});

async function app(l: Lab, name: string): Promise<AppPc> {
  const a = new AppPc(l, name);
  apps.push(a);
  return a.open();
}

/** An app PC paired with the lab's server, its client live. */
async function pairedApp(l: Lab): Promise<AppPc> {
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.status.pending === 0, 5000, () => JSON.stringify(a.statuses));
  return a;
}

/**
 * The import as the main process makes it (ipc/publications.ts): the server's when it may, else this PC's own, on the
 * recorded answers, its PDF into the PC's store. `local`: the texts the PC imported itself; `logged`: the console's lines.
 */
function importer(a: AppPc) {
  const local: string[] = [];
  const logged: string[] = [];
  const deps: ViaDeps = {
    local: (text, options) => {
      local.push(String(text));
      const p = a.params;
      return importPublication(text, {
        fetch: replayFetch(PUBLICATIONS_DATA), store: (name, bytes) => storeBytes(a.dir, name, bytes),
        maxKb: p.publicationMaxKb, maxPdfBytes: p.maxImportMb * 2 ** 20, timeoutMs: p.publicationTimeoutMs, pdfMaxMs: p.publicationPdfMaxMs,
        open: { ...replayOpen(PUBLICATIONS_DATA), timeoutMs: p.publicationTimeoutMs, pdfMaxMs: p.publicationPdfMaxMs },
      }, options);
    },
    server: () => a.host.publicationImporter(),
    params: () => a.params,
    log: (m) => { logged.push(m); },
  };
  return { run: (text: unknown, options?: unknown) => importPublicationVia(text, options, deps), local, logged };
}

const ARXIV_PDF = new Uint8Array(readFileSync(join(PUBLICATIONS_DATA, 'arxiv-1706.03762.pdf')));
const PDF_REF: FileRef = { name: '1706.03762.pdf', hash: createHash('sha256').update(ARXIV_PDF).digest('hex'), size: ARXIV_PDF.length };
const BOOK = '10.1007/978-0-387-49820-1';
const onServer = (l: Lab, hash: string) => existsSync(join(l.dataDir, 'base', 'files', hash.slice(0, 2), hash));

/** The node of the import put down in the lobby, `files` with it, through the interface's session: its identifier. */
async function putDown(a: AppPc, files: FileRef[]): Promise<Id> {
  const before = new Set(a.session.state.nodes.keys());
  const lobby = [...a.session.state.plans.values()][0].id;
  expect((await a.session.run((s) => createNode(s, { plan: lobby, title: 'Attention Is All You Need', x: 0, y: 0, k: 0, files }))).ok).toBe(true);
  return [...a.session.state.nodes.keys()].find((k) => !before.has(k))!;
}

test('jumelé et connecté : l’import passe par le serveur, les réglages du PC pour plafonds ; son PDF reste au serveur, et l’action qui crée le nœud ne l’envoie pas', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const imp = importer(a);
  const r = await imp.run('arXiv:1706.03762');
  expect(r).toMatchObject({ ok: true, id: { arxiv: '1706.03762' }, csl: { title: 'Attention Is All You Need' }, pdf: PDF_REF });
  expect([imp.local, imp.logged]).toEqual([[], []]);
  const p = a.params;
  expect(a.net.publications).toEqual([
    { text: 'arXiv:1706.03762', maxKb: p.publicationMaxKb, maxPdfBytes: p.maxImportMb * 2 ** 20, timeoutMs: p.publicationTimeoutMs, pdfMaxMs: p.publicationPdfMaxMs },
  ]);
  // The server's network asked, the PDF kept by the server; none at the PC.
  expect(l.serverAsked).toContain('https://arxiv.org/pdf/1706.03762');
  expect(onServer(l, PDF_REF.hash)).toBe(true);
  expect(existsSync(filePath(a.dir, PDF_REF))).toBe(false);
  // The node made with it: the server asked which files it lacks (D6) — not this one —, nothing sent, the write taken.
  const X = await putDown(a, [PDF_REF]);
  await until(() => a.store.pendingCount() === 0 && a.session.pending.length === 0, 5000, () => JSON.stringify(a.statuses));
  expect(a.net.count('POST', '/files/missing')).toBeGreaterThan(0);
  expect(a.net.count('PUT', /^\/files\//)).toBe(0);
  expect((await l.state()).nodes.get(X)?.files).toEqual([PDF_REF]);
  // A PDF dropped (`pdf: false`, plan 4c, D8): said to the server, whose answer brings none.
  const meta = await imp.run('arXiv:1706.03762', { pdf: false });
  expect(meta).toMatchObject({ ok: true, id: { arxiv: '1706.03762' } });
  expect(meta).not.toHaveProperty('pdf');
  expect(a.net.publications.at(-1)).toMatchObject({ text: 'arXiv:1706.03762', pdf: false });
  expect(imp.local).toEqual([]);
});

test('le PDF importé par le serveur se télécharge à sa première lecture (cirrus-file:), vérifié et gardé ; ensuite, lu au PC', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const r = await importer(a).run('arXiv:1706.03762');
  expect(r).toMatchObject({ ok: true, pdf: PDF_REF });
  expect(existsSync(filePath(a.dir, PDF_REF))).toBe(false);
  const read = async () => {
    const res = await Promise.resolve(fileResponse(a.dir, join(a.dir, 'cache'), new Request(fileUrl(PDF_REF)), a.host.blobFetcher()));
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  expect(await read()).toEqual({ status: 200, bytes: ARXIV_PDF });
  expect(existsSync(filePath(a.dir, PDF_REF))).toBe(true);
  expect(await read()).toEqual({ status: 200, bytes: ARXIV_PDF });
  expect(a.net.count('GET', `/files/${PDF_REF.hash}`)).toBe(1);
});

test('serveur arrêté : l’import se fait au PC, sans rien demander au serveur ; le PDF part avec l’action au retour du serveur', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  await l.stopServer();
  await until(() => a.status?.state === 'offline', 5000, () => JSON.stringify(a.statuses));
  const imp = importer(a);
  expect(await imp.run('arXiv:1706.03762')).toMatchObject({ ok: true, pdf: PDF_REF });
  expect([imp.local, imp.logged]).toEqual([['arXiv:1706.03762'], []]);
  expect(a.net.count('POST', '/publications')).toBe(0);
  expect(existsSync(filePath(a.dir, PDF_REF))).toBe(true);
  const X = await putDown(a, [PDF_REF]);
  expect(a.store.pendingCount()).toBe(1);
  await l.startServer();
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0, 5000, () => JSON.stringify(a.statuses));
  // The PDF sent before the write, as any file added (plan 5a, D6); the server's network never asked.
  expect(a.net.count('PUT', `/files/${PDF_REF.hash}`)).toBe(1);
  expect(onServer(l, PDF_REF.hash)).toBe(true);
  expect((await l.state()).nodes.get(X)?.files).toEqual([PDF_REF]);
  expect(l.serverAsked).toEqual([]);
});

test('le serveur perdu pendant la demande, en erreur (5xx, 503 occupé), qui refuse la demande ou répond de travers : l’import se fait au PC, dit en une ligne dans la console', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const imp = importer(a);
  const book = { ok: true, id: { doi: BOOK } };
  a.net.before = (_method, path) => {
    if (path === '/publications') throw new TypeError('fetch failed');
  };
  expect(await imp.run(BOOK)).toMatchObject(book);
  expect(imp.logged).toEqual([expect.stringMatching(/fetch failed/)]);
  a.net.before = null;
  const answers: Response[] = [
    Response.json({ error: 'Le serveur importe déjà d’autres publications : réessaie dans un instant.' }, { status: 503 }),
    Response.json({ error: 'Erreur interne du serveur.' }, { status: 500 }),
    Response.json({ error: 'Route inconnue.' }, { status: 404 }),
    new Response('pas du JSON', { status: 200 }),
    Response.json({ ok: true, kind: 'pdf', pdf: { name: '../évadé.pdf', hash: PDF_REF.hash, size: 1 } }),
  ];
  a.net.respond = (method, path) => (method === 'POST' && path === '/publications' ? answers.shift() ?? null : null);
  for (let i = 0; i < 5; i++) expect(await imp.run(BOOK)).toMatchObject(book);
  expect(imp.local).toEqual(Array(6).fill(BOOK));
  expect(imp.logged).toHaveLength(6);
  expect(imp.logged[1]).toMatch(/réessaie dans un instant/);
  expect(imp.logged[2]).toMatch(/Erreur interne du serveur/);
  expect(imp.logged[3]).toMatch(/Route inconnue/);
  expect(a.net.count('POST', '/publications')).toBe(6);
  // None reached the server's network.
  expect(l.serverAsked).toEqual([]);
});

test('relecture, I1 : le réseau du serveur qui ne passe pas (un proxy, une inspection TLS qu’Electron sait traverser) : le serveur répond 502, le PC importe lui-même, une ligne dans la console', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const imp = importer(a);
  l.serverNetworkDown = true;
  expect(await imp.run(BOOK)).toMatchObject({ ok: true, id: { doi: BOOK } });
  // An address of the open web: the server's resolver fails, the PC's answers.
  expect(await imp.run('https://editeur.example/papiers/note.pdf')).toMatchObject({ ok: true, kind: 'pdf', pdf: { name: 'note.pdf' } });
  expect(imp.local).toEqual([BOOK, 'https://editeur.example/papiers/note.pdf']);
  expect(imp.logged).toEqual([expect.stringMatching(/Pas de connexion\./), expect.stringMatching(/Pas de connexion\./)]);
  expect(a.net.count('POST', '/publications')).toBe(2);
  expect(l.serverAsked.length).toBeGreaterThan(0);
});

test('relecture, mineur 3 : un jeton révoqué au serveur — l’import se fait au PC (401), une ligne dans la console ; le statut de la synchro n’en bouge pas', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const imp = importer(a);
  const statuses = a.statuses.length;
  l.revoke('Portable');
  expect(await imp.run(BOOK)).toMatchObject({ ok: true, id: { doi: BOOK } });
  expect(imp.local).toEqual([BOOK]);
  expect(imp.logged).toEqual([expect.stringMatching(/révoqué/)]);
  expect(a.net.count('POST', '/publications')).toBe(1);
  // The import's refusal is not the connection's: the client goes on as it was, until its stream learns of the token.
  expect(a.statuses.length).toBe(statuses);
  expect(a.status?.state).toBe('live');
  expect(l.serverAsked).toEqual([]);
});

test('un refus du serveur (« Publication introuvable. », une adresse du réseau local) est dit tel quel, sans être refait au PC ; un texte qui n’est pas une demande ne part pas', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const imp = importer(a);
  expect(await imp.run('10.1007/cirrus-introuvable')).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(await imp.run('https://interne.example/a.pdf')).toEqual({ ok: false, message: 'Adresse refusée : elle mène à une machine du réseau local.' });
  expect([imp.local, imp.logged]).toEqual([[], []]);
  expect(a.net.count('POST', '/publications')).toBe(2);
  // Not a string, or too long: the PC refuses it itself, as in plan 4c, without asking the server.
  expect(await imp.run(42)).toEqual({ ok: false, message: 'Identifiant non reconnu.' });
  expect(await imp.run(`arXiv:${'1'.repeat(1000)}`)).toEqual({ ok: false, message: 'Identifiant non reconnu.' });
  expect(a.net.count('POST', '/publications')).toBe(2);
});

test('non jumelé : l’import se fait au PC, comme au plan 4c, sans aucune requête à un serveur', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(a.host.publicationImporter()).toBeNull();
  const imp = importer(a);
  expect(await imp.run('arXiv:1706.03762')).toMatchObject({ ok: true, pdf: PDF_REF });
  expect([imp.local, imp.logged]).toEqual([['arXiv:1706.03762'], []]);
  expect(existsSync(filePath(a.dir, PDF_REF))).toBe(true);
  expect(a.net.requests).toEqual([]);
  expect(l.serverAsked).toEqual([]);
});
