import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileRef } from '@cirrus/core';
import type { FetchFn, OpenDeps, PublicationRequest, PublicationResult } from '@cirrus/sources';
import { filePath } from '@cirrus/store';
import {
  MAX_ADDRESS_CHARS, MAX_FILE_BYTES, MAX_PUBLICATION_BODY_BYTES, MAX_PUBLICATION_FETCHES, MAX_PUBLICATION_META_BYTES, MAX_PUBLICATION_PDF_MS,
  MAX_PUBLICATION_TIMEOUT_MS,
} from '../src/bounds.ts';
import { nodeFetch, parsePublicationRequest } from '../src/publications.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, newCode, pair, sha256, T0 } from './support.ts';

// POST /publications (plan 5b, task 3, D2, D3): a publication imported by the server's network for a paired PC, its PDF
// kept in the server's store and given by its reference. The network is a fake, injected (startServer's `sources`):
// never the Internet. Every refusal leaves nothing written, and the server goes on serving.

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-publications-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const CSL_TYPE = 'application/vnd.citationstyles.csl+json';
const BIB_TYPE = 'application/x-bibtex';
const PUBLIC = '93.184.215.14';
const LOCAL = 'Adresse refusée : elle mène à une machine du réseau local.';
const PDF = new TextEncoder().encode('%PDF-1.4\n% Attention Is All You Need\n%%EOF\n');
const NOTE = new TextEncoder().encode('%PDF-1.7\n% une note sans identifiant\n%%EOF\n');
const ARXIV_CSL = { type: 'article', title: 'Attention Is All You Need', author: [{ family: 'Vaswani', given: 'Ashish' }], issued: { 'date-parts': [[2017]] } };
const ARXIV_BIB = '@misc{vaswani2017attention, title={Attention Is All You Need}, author={Vaswani, Ashish}, year={2017}}';
const BOOK_CSL = { type: 'book', title: 'Un livre', author: [{ family: 'Auteur', given: 'Une' }], issued: { 'date-parts': [[2008]] } };
const BOOK_BIB = '@book{auteur2008, title={Un livre}, author={Auteur, Une}, year={2008}}';

type Answer = (signal: AbortSignal) => Response | Promise<Response>;
const answer = (body: ConstructorParameters<typeof Response>[0], type: string, more: Record<string, string> = {}) => () =>
  new Response(body, { status: 200, headers: { 'content-type': type, ...more } });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const page = (pdfUrl: string) => answer(`<html><head><meta name="citation_pdf_url" content="${pdfUrl}"></head><body>x</body></html>`, 'text/html; charset=utf-8');

/** A body of « a » without end, 64 Kio at a time: cancelled once its reader stops. */
function endless() {
  const seen = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(64 * 1024).fill(0x61)); },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

/**
 * The answers of the fake network: the metadata by « <Accept> <address> » (doi.org redirecting an arXiv DOI to
 * data.crosscite.org, as recorded in plan 4c), arXiv's PDF, a book without PDF; the open web by its address, its names
 * resolved by NAMES. Never reached: interne.example and every local address.
 */
const ROUTES: Record<string, Answer> = {
  [`${CSL_TYPE} https://doi.org/10.48550/arXiv.1706.03762`]: redirect('https://data.crosscite.org/10.48550%2FarXiv.1706.03762'),
  [`${BIB_TYPE} https://doi.org/10.48550/arXiv.1706.03762`]: redirect('https://data.crosscite.org/10.48550%2FarXiv.1706.03762'),
  [`${CSL_TYPE} https://data.crosscite.org/10.48550%2FarXiv.1706.03762`]: answer(JSON.stringify(ARXIV_CSL), `${CSL_TYPE}; charset=utf-8`),
  [`${BIB_TYPE} https://data.crosscite.org/10.48550%2FarXiv.1706.03762`]: answer(ARXIV_BIB, `${BIB_TYPE}; charset=utf-8`),
  'application/pdf https://arxiv.org/pdf/1706.03762': answer(PDF, 'application/pdf'),
  [`${CSL_TYPE} https://doi.org/10.1000/livre`]: answer(JSON.stringify(BOOK_CSL), CSL_TYPE),
  [`${BIB_TYPE} https://doi.org/10.1000/livre`]: answer(BOOK_BIB, BIB_TYPE),
  [`${CSL_TYPE} https://doi.org/10.1007/cirrus-introuvable`]: () => new Response('introuvable', { status: 404 }),
  [`${BIB_TYPE} https://doi.org/10.1007/cirrus-introuvable`]: () => new Response('introuvable', { status: 404 }),
  'https://editeur.example/note.pdf': answer(NOTE, 'application/pdf'),
  'https://editeur.example/vers-interne': redirect('https://127.0.0.1/x'),
  'https://editeur.example/vers-http': redirect('http://editeur.example/note.pdf'),
  'https://editeur.example/page-interne': page('https://interne.example/a.pdf'),
  'https://interne.example/a.pdf': answer(NOTE, 'application/pdf'),
  'https://meta.example/latest/meta-data': answer('secret', 'text/plain'),
  'https://double.example/note.pdf': answer(NOTE, 'application/pdf'),
  'https://v6.example/note.pdf': answer(NOTE, 'application/pdf'),
  'https://mapped.example/note.pdf': answer(NOTE, 'application/pdf'),
};
const NAMES: Record<string, string[]> = {
  'editeur.example': [PUBLIC], 'grosse.example': [PUBLIC], 'interne.example': ['10.0.0.5'], 'meta.example': ['169.254.169.254'],
  'double.example': [PUBLIC, '127.0.0.1'], 'v6.example': ['::1'], 'mapped.example': ['::ffff:127.0.0.1'],
};

/** A fake network (startServer's `sources`): every request, resolution and connection recorded. */
function fakeNetwork(routes: Record<string, Answer> = ROUTES) {
  const asked: string[] = [];
  const resolved: string[] = [];
  const connected: string[] = [];
  const fetch: FetchFn = async (url, init) => {
    asked.push(url);
    const route = routes[`${init.headers.Accept} ${url}`] ?? routes[url];
    if (!route) throw new TypeError('fetch failed');
    return route(init.signal);
  };
  const open: Pick<OpenDeps, 'resolve' | 'connect'> = {
    resolve: async (host) => {
      resolved.push(host);
      const found = NAMES[host];
      if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return found.map((address) => ({ address, family: isIP(address) === 6 ? 6 as const : 4 as const }));
    },
    connect: async (req) => {
      connected.push(`${req.address} ${req.hostname}${req.path}`);
      const route = routes[`https://${req.hostname}${req.path}`];
      if (!route) throw Object.assign(new Error(`connect ECONNREFUSED ${req.address}:443`), { code: 'ECONNREFUSED' });
      return route(req.signal);
    },
  };
  return { sources: { fetch, open }, asked, resolved, connected };
}

async function start(network = fakeNetwork()): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0, sources: network.sources });
  running.push(s);
  return s;
}

async function paired(url: string, pc = 'pc-a'): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, pc, T0), pc, name: `Machine ${pc}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

/** The PC's caps as it sends them: small, a delay that never passes during a test. */
const CAPS = { maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 10_000, pdfMaxMs: 60_000 };
const ask = (c: Client, text: string, more: Record<string, unknown> = {}) => c.send('POST', '/publications', { text, ...CAPS, ...more });
async function imported(c: Client, text: string, more: Record<string, unknown> = {}): Promise<PublicationResult> {
  const res = await ask(c, text, more);
  expect(res.status, text).toBe(200);
  return (await res.json()) as PublicationResult;
}

/** The server's store: every file kept, temporaries included. */
const stored = () => {
  const files = join(dir, 'base', 'files');
  return existsSync(files) ? (readdirSync(files, { recursive: true }) as string[]).filter((f) => !/^[0-9a-f]{2}$/.test(f)) : [];
};
const refOf = (name: string, bytes: Uint8Array): FileRef => ({ name, hash: sha256(bytes), size: bytes.length });

test('bornes : celles des publications, nommées dans bounds.ts', () => {
  expect([MAX_PUBLICATION_BODY_BYTES, MAX_PUBLICATION_FETCHES, MAX_PUBLICATION_TIMEOUT_MS, MAX_PUBLICATION_META_BYTES, MAX_PUBLICATION_PDF_MS])
    .toEqual([16 * 1024, 2, 60_000, 8 * 2 ** 20, 600_000]);
  // The text, an address of MAX_ADDRESS_CHARS at most (final review of plan 5b, M1), fits the body whatever its characters,
  // each of them 6 bytes at most in JSON (« \u0001 »), with the PC's caps at their largest.
  const worst = JSON.stringify({ text: '\u0001'.repeat(MAX_ADDRESS_CHARS), maxKb: Number.MAX_VALUE, maxPdfBytes: Number.MAX_VALUE, timeoutMs: Number.MAX_VALUE, pdfMaxMs: Number.MAX_VALUE });
  expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(MAX_PUBLICATION_BODY_BYTES);
});

test('un texte de MAX_ADDRESS_CHARS caractères est accepté (une adresse signée de plus de 1 000 caractères), pas au-delà ; même fait de caractères que JSON écrit en 6 octets', async () => {
  expect(MAX_ADDRESS_CHARS).toBe(2048);
  expect(parsePublicationRequest({ text: 'a'.repeat(MAX_ADDRESS_CHARS), ...CAPS }).text).toHaveLength(MAX_ADDRESS_CHARS);
  expect(() => parsePublicationRequest({ text: 'a'.repeat(MAX_ADDRESS_CHARS + 1), ...CAPS })).toThrow(/^Demande d’import invalide : « text » attendu, une chaîne de 2048 caractères au plus/);
  const net = fakeNetwork();
  const { url } = await start(net);
  const a = await paired(url);
  // Read whole, then answered as the PC's own import answers it: no identifier, no address, nothing asked of the network.
  expect(await imported(a, '\u0001'.repeat(MAX_ADDRESS_CHARS))).toEqual({ ok: false, message: 'Identifiant non reconnu.' });
  expect(await imported(a, '中'.repeat(MAX_ADDRESS_CHARS))).toEqual({ ok: false, message: 'Identifiant non reconnu.' });
  expect(net.asked).toEqual([]);
  expect(net.resolved).toEqual([]);
});

test('un article d’arXiv importé par le réseau du serveur (rejoué) : son PDF gardé au magasin du serveur, sa référence rendue, puis servi par GET /files', async () => {
  const net = fakeNetwork();
  const { url } = await start(net);
  const a = await paired(url);
  const r = await imported(a, 'arXiv:1706.03762');
  const pdf = refOf('1706.03762.pdf', PDF);
  expect(r).toEqual({ ok: true, id: { arxiv: '1706.03762' }, csl: ARXIV_CSL, bibtex: ARXIV_BIB, pdf });
  // Kept by the server, once checked: its bytes at their hash.
  expect(new Uint8Array(readFileSync(filePath(join(dir, 'base'), pdf)))).toEqual(PDF);
  expect(stored()).toEqual([join(pdf.hash.slice(0, 2), pdf.hash)]);
  // The redirect followed by hand, each target permitted; the PDF asked last.
  expect(net.asked).toEqual([
    'https://doi.org/10.48550/arXiv.1706.03762', 'https://doi.org/10.48550/arXiv.1706.03762',
    'https://data.crosscite.org/10.48550%2FarXiv.1706.03762', 'https://data.crosscite.org/10.48550%2FarXiv.1706.03762',
    'https://arxiv.org/pdf/1706.03762',
  ]);
  // The PC downloads it as any file of the server (plan 5a, D6).
  const res = await a.get(`/files/${pdf.hash}`);
  expect(res.status).toBe(200);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  // Counted in the server's store (plan 5b, task 7: GET /status), once: imported again, the same blob.
  const store = async () => {
    for (;;) {
      const s = (await (await a.get('/status')).json()) as { storeBytes: number; storeFiles: number; counting: boolean };
      if (!s.counting) return [s.storeFiles, s.storeBytes];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  expect(await store()).toEqual([1, PDF.length]);
  expect(await imported(a, 'arXiv:1706.03762')).toMatchObject({ ok: true, pdf });
  expect(await store()).toEqual([1, PDF.length]);
});

test('un DOI sans PDF ; `pdf: false` : ni demandé ni gardé ; un PDF d’une adresse ouverte : `{ kind: "pdf" }`, gardé ; introuvable : le refus du réseau, tel quel', async () => {
  const net = fakeNetwork();
  const { url } = await start(net);
  const a = await paired(url);
  expect(await imported(a, '10.1000/livre')).toEqual({ ok: true, id: { doi: '10.1000/livre' }, csl: BOOK_CSL, bibtex: BOOK_BIB });
  expect(stored()).toEqual([]);
  const r = await imported(a, 'arXiv:1706.03762', { pdf: false });
  expect(r).toEqual({ ok: true, id: { arxiv: '1706.03762' }, csl: ARXIV_CSL, bibtex: ARXIV_BIB });
  expect(net.asked).not.toContain('https://arxiv.org/pdf/1706.03762');
  expect(stored()).toEqual([]);
  const note = refOf('note.pdf', NOTE);
  expect(await imported(a, 'https://editeur.example/note.pdf')).toEqual({ ok: true, kind: 'pdf', pdf: note });
  expect(net.connected).toEqual([`${PUBLIC} editeur.example/note.pdf`]);
  expect(stored()).toEqual([join(note.hash.slice(0, 2), note.hash)]);
  expect(await imported(a, '10.1007/cirrus-introuvable')).toEqual({ ok: false, message: 'Publication introuvable.' });
});

test('Review Focus 1 : une adresse interne, écrite ou résolue, une redirection vers elle ou vers http, le PDF d’une page qui y mène — refusés avant toute connexion, en français, rien d’écrit ; le serveur continue', async () => {
  const net = fakeNetwork();
  const { url } = await start(net);
  const a = await paired(url);
  const cases: [string, string][] = [
    ['https://127.0.0.1/x', LOCAL],
    ['https://2130706433/', LOCAL],
    ['https://0x7f.1/', LOCAL],
    ['https://[::1]/x', LOCAL],
    ['https://[::ffff:7f00:1]/x', LOCAL],
    ['https://[fd00::1]/x', LOCAL],
    ['https://interne.example/a.pdf', LOCAL],
    ['https://meta.example/latest/meta-data', LOCAL],
    ['https://double.example/note.pdf', LOCAL],
    ['https://v6.example/note.pdf', LOCAL],
    ['https://mapped.example/note.pdf', LOCAL],
    ['https://editeur.example/vers-interne', LOCAL],
    ['https://editeur.example/page-interne', LOCAL],
    ['http://editeur.example/note.pdf', 'Seules les adresses https sont acceptées.'],
    ['https://editeur.example/vers-http', 'Seules les adresses https sont acceptées.'],
  ];
  for (const [text, message] of cases) expect(await imported(a, text), text).toEqual({ ok: false, message });
  // Only the public addresses were connected to: the pages that redirect, or lead, to a local one or to http.
  expect(net.connected).toEqual([`${PUBLIC} editeur.example/vers-interne`, `${PUBLIC} editeur.example/page-interne`, `${PUBLIC} editeur.example/vers-http`]);
  expect(net.asked).toEqual([]);
  expect(stored()).toEqual([]);
  // The server goes on: an import that may be made is.
  expect(await imported(a, 'https://editeur.example/note.pdf')).toMatchObject({ ok: true, kind: 'pdf' });
});

test('corps trop gros, mal formé, champ inconnu, nombre faux, texte trop long : refusés avant le réseau, rien d’écrit ; sans jeton ou jeton faux, 401', async () => {
  const net = fakeNetwork();
  const { url } = await start(net);
  const a = await paired(url);
  const status = async (p: Promise<Response>) => (await p).status;
  const body = (more: Record<string, unknown>) => ({ text: 'arXiv:1706.03762', ...CAPS, ...more });
  // Over MAX_PUBLICATION_BODY_BYTES: 413, by its announced length or as it streams.
  expect(await status(a.send('POST', '/publications', JSON.stringify(body({ text: 'a'.repeat(MAX_PUBLICATION_BODY_BYTES) }))))).toBe(413);
  const chunks = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(MAX_PUBLICATION_BODY_BYTES / 4).fill(0x20));
      c.close();
    },
  });
  const streamed = await fetch(`${url}/publications`, {
    method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: chunks, duplex: 'half',
  } as RequestInit);
  expect(streamed.status).toBe(413);
  // Malformed: not JSON, not JSON said, not an object, a field unknown or missing, a text too long or not one, a number
  // that is not a finite positive one, `pdf` other than false.
  expect(await status(a.send('POST', '/publications', '{"text":'))).toBe(400);
  expect(await status(a.send('POST', '/publications', body({}), 'text/plain'))).toBe(415);
  const caps = JSON.stringify(CAPS).slice(1, -1);
  const malformed: string[] = [
    '[]', '"arXiv:1706.03762"', 'null', JSON.stringify(body({ autre: 1 })), `{"text":"x",${caps},"__proto__":{"pdf":false}}`, `{"text":"x",${caps},"constructor":1}`,
    JSON.stringify({ text: 'arXiv:1706.03762' }), JSON.stringify(body({ text: 'a'.repeat(MAX_ADDRESS_CHARS + 1) })), JSON.stringify(body({ text: 42 })),
    JSON.stringify(body({ pdf: true })), JSON.stringify(body({ pdf: 'false' })), JSON.stringify(body({ pdf: null })),
    JSON.stringify(body({ maxKb: 0 })), JSON.stringify(body({ maxKb: -1 })), JSON.stringify(body({ maxPdfBytes: '1024' })), JSON.stringify(body({ timeoutMs: null })),
    `{"text":"x","maxKb":64,"maxPdfBytes":1048576,"timeoutMs":10000,"pdfMaxMs":1e400}`,
  ];
  for (const b of malformed) {
    const res = await a.send('POST', '/publications', b);
    expect(res.status, b.slice(0, 80)).toBe(400);
    expect(((await res.json()) as { error: string }).error, b.slice(0, 80)).toMatch(/^Demande d’import invalide/);
  }
  // A token absent, unknown or malformed: 401, before the body is read.
  const anonymous = await fetch(`${url}/publications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body({})) });
  expect(anonymous.status).toBe(401);
  expect(await status(new Client(url, 'x'.repeat(43), 'pc-a').send('POST', '/publications', body({})))).toBe(401);
  expect(await status(a.get('/publications'))).toBe(405);
  expect(net.asked).toEqual([]);
  expect(net.resolved).toEqual([]);
  expect(stored()).toEqual([]);
  // The server goes on.
  expect(await imported(a, 'arXiv:1706.03762')).toMatchObject({ ok: true, pdf: refOf('1706.03762.pdf', PDF) });
});

test('les plafonds du PC ramenés sous les bornes du serveur : métadonnées, PDF, délais', async () => {
  // At the parse: each cap at most its bound; a lower one kept. The request read has the shape sent (PublicationRequest
  // of @cirrus/sources), its caps brought under the bounds.
  const read: PublicationRequest = parsePublicationRequest({ text: 'x', maxKb: 1e9, maxPdfBytes: 1e15, timeoutMs: 1e9, pdfMaxMs: 1e9 });
  expect(read).toStrictEqual({
    text: 'x', maxKb: MAX_PUBLICATION_META_BYTES / 1024, maxPdfBytes: MAX_FILE_BYTES, timeoutMs: MAX_PUBLICATION_TIMEOUT_MS, pdfMaxMs: MAX_PUBLICATION_PDF_MS,
  });
  expect(parsePublicationRequest({ text: 'x', pdf: false, ...CAPS })).toEqual({ text: 'x', pdf: false, ...CAPS });
  // At the route: a metadata answer announced over 8 Mio is refused, as the bound says it; a PDF over MAX_FILE_BYTES
  // likewise, though the PC allowed more.
  const big = String(MAX_PUBLICATION_META_BYTES + 1);
  const huge = endless();
  const net = fakeNetwork({
    ...ROUTES,
    [`${CSL_TYPE} https://doi.org/10.1000/gros`]: answer(JSON.stringify(BOOK_CSL), CSL_TYPE, { 'content-length': big }),
    [`${BIB_TYPE} https://doi.org/10.1000/gros`]: answer(BOOK_BIB, BIB_TYPE),
    'application/pdf https://arxiv.org/pdf/1706.03762': answer(PDF, 'application/pdf', { 'content-length': String(MAX_FILE_BYTES + 1) }),
    'https://grosse.example/page': () => new Response(huge.stream, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const { url } = await start(net);
  const a = await paired(url);
  const unbounded = { maxKb: 1e9, maxPdfBytes: 1e15, timeoutMs: 1e9, pdfMaxMs: 1e9 };
  expect(await imported(a, '10.1000/gros', unbounded)).toEqual({
    ok: false, message: `Réponse trop grosse du serveur de DOI (plus de ${(8192).toLocaleString('fr-FR')} Ko).`,
  });
  expect(await imported(a, 'arXiv:1706.03762', unbounded)).toMatchObject({
    ok: true, pdfMessage: `Le PDF d’arXiv fait plus de ${(1024).toLocaleString('fr-FR')} Mo.`,
  });
  // A page without end is read up to the bound, then let go: it gives no PDF.
  expect(await imported(a, 'https://grosse.example/page', unbounded)).toEqual({ ok: false, message: 'Cette page ne mène à aucun PDF.' });
  expect(huge.seen.cancelled).toBe(true);
  expect(stored()).toEqual([]);
});

test('relecture, I1 : le réseau du serveur qui n’aboutit pas (pas de connexion, nom non résolu, délai dépassé) : 502, sa raison en erreur, rien d’écrit — le PC importe alors lui-même ; un refus de la publication reste un 200', async () => {
  // An answer that never comes, but stops with its request.
  const never: Answer = (signal) => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const net = fakeNetwork({
    ...ROUTES,
    [`${CSL_TYPE} https://doi.org/10.1000/lent`]: never,
    [`${BIB_TYPE} https://doi.org/10.1000/lent`]: never,
    'https://editeur.example/lent.pdf': never,
  });
  const { url } = await start(net);
  const a = await paired(url);
  const quick = { timeoutMs: 200 };
  const late = `délai de ${(0.2).toLocaleString('fr-FR')} s dépassé`;
  const cases: [string, string][] = [
    // No answer recorded: the network fails as without a connection.
    ['10.1000/sans-reseau', 'Pas de connexion.'],
    // A name the server's resolver does not know.
    ['https://inconnu.example/note.pdf', 'Pas de connexion.'],
    ['10.1000/lent', `Le serveur de DOI ne répond pas (${late}).`],
    ['https://editeur.example/lent.pdf', `Le site « editeur.example » ne répond pas (${late}).`],
  ];
  for (const [text, message] of cases) {
    const res = await ask(a, text, quick);
    expect(res.status, text).toBe(502);
    expect(await res.json(), text).toEqual({ error: message });
  }
  expect(stored()).toEqual([]);
  // What the network answered stays the import's answer, a 200: the PC says it, and does not import it again.
  expect(await imported(a, '10.1007/cirrus-introuvable')).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(await imported(a, 'https://interne.example/a.pdf')).toEqual({ ok: false, message: LOCAL });
});

/** A network whose metadata of `10.1000/lent-<n>` waits for `release`, or for its request to be aborted. */
function heldNetwork() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const aborted: string[] = [];
  const held: Answer = async (signal) => {
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }).catch((e: unknown) => { aborted.push('abandonné'); throw e; });
    return new Response(JSON.stringify(BOOK_CSL), { status: 200, headers: { 'content-type': CSL_TYPE } });
  };
  const heldBib: Answer = async (signal) => {
    await held(signal);
    return new Response(BOOK_BIB, { status: 200, headers: { 'content-type': BIB_TYPE } });
  };
  const routes: Record<string, Answer> = { ...ROUTES };
  for (const n of [1, 2, 3]) {
    routes[`${CSL_TYPE} https://doi.org/10.1000/lent-${n}`] = held;
    routes[`${BIB_TYPE} https://doi.org/10.1000/lent-${n}`] = heldBib;
  }
  return { network: fakeNetwork(routes), release: () => open(), aborted };
}

async function until(ok: () => boolean, what: string): Promise<void> {
  const limit = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > limit) throw new Error(`Attente dépassée : ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('au-delà de MAX_PUBLICATION_FETCHES imports en cours : 503, en français, rien demandé ni écrit ; ensuite, de nouveau servi', async () => {
  const { network, release } = heldNetwork();
  const { url } = await start(network);
  const a = await paired(url);
  const b = await paired(url, 'pc-b');
  // Two slow imports, held by the network.
  const first = ask(a, '10.1000/lent-1');
  const second = ask(b, '10.1000/lent-2');
  await until(() => network.asked.includes('https://doi.org/10.1000/lent-1') && network.asked.includes('https://doi.org/10.1000/lent-2'), 'deux imports en cours');
  // A third, of either PC: refused at once, the network not asked.
  const third = await ask(a, 'arXiv:1706.03762');
  expect(third.status).toBe(503);
  expect(await third.json()).toEqual({ error: 'Le serveur importe déjà d’autres publications : réessaie dans un instant.' });
  expect(network.asked.filter((u) => u.includes('1706.03762'))).toEqual([]);
  expect(stored()).toEqual([]);
  release();
  for (const res of await Promise.all([first, second])) {
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, csl: BOOK_CSL });
  }
  // The places given back: served again.
  expect(await imported(a, 'arXiv:1706.03762')).toMatchObject({ ok: true, pdf: refOf('1706.03762.pdf', PDF) });
});

test('un PC qui abandonne sa demande libère sa place, l’import arrêté ; l’arrêt du serveur n’attend pas un import en cours', async () => {
  const { network, aborted } = heldNetwork();
  const s = await start(network);
  const a = await paired(s.url);
  const gone = new AbortController();
  const left = fetch(`${s.url}/publications`, {
    method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '10.1000/lent-1', ...CAPS }), signal: gone.signal,
  }).catch(() => null);
  // Answered by no one once the server stops: its rejection awaited at the end.
  const kept = ask(a, '10.1000/lent-2').catch(() => null);
  await until(() => network.asked.filter((u) => u.includes('lent-')).length === 4, 'deux imports en cours');
  gone.abort();
  await left;
  // Its import stopped (its requests aborted): a place is free.
  await until(() => aborted.length === 2, 'l’import abandonné arrêté');
  expect(await imported(a, '10.1000/livre')).toMatchObject({ ok: true, csl: BOOK_CSL });
  // The server stops at once, the import under way aborted with it.
  const t0 = Date.now();
  running.splice(running.indexOf(s), 1);
  await s.close();
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await kept).toBeNull();
  expect(aborted.length).toBe(4);
});

test('nodeFetch, le réseau du serveur : le fetch de Node à redirections manuelles — un 3xx revient tel quel, avec sa Location ; sa cible jamais demandée', async () => {
  const seen: string[] = [];
  const http = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.accept}`);
    if (req.url === '/a') res.writeHead(302, { Location: '/b' }).end();
    else res.writeHead(200, { 'Content-Type': 'text/plain' }).end('b');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  try {
    const port = (http.address() as AddressInfo).port;
    const res = await nodeFetch(`http://127.0.0.1:${port}/a`, { headers: { Accept: 'application/pdf' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    expect([res.status, res.headers.get('location')]).toEqual([302, '/b']);
    await res.body?.cancel();
    expect(seen).toEqual(['/a application/pdf']);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
