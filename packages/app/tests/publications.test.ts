import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FileRef } from '@cirrus/core';
import { cslToFields, type FetchFn, fetchPublication, importPublication, type PublicationDeps, PUBLICATION_SOURCES } from '@cirrus/sources';
import { expect, test } from 'vitest';
import { testPickOf } from '../src/main/pick.ts';
import { replayDirOf, replayFetch, replayOpen } from '../src/main/publications/replay.ts';
import { requestFetch } from '../src/main/publications/request.ts';

/**
 * The publications' network in the app (plan 4c): Electron's requestFetch, and the replay of recorded answers with the
 * import of @cirrus/sources, whose own tests moved with it (plan 5b, D2).
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const DATA = join(here, 'data', 'publications');

/** A fake fetch answering by `route`, which records each call: its address, its Accept and its redirect mode. */
function fakeFetch(route: (url: string, accept: string, signal: AbortSignal) => Response | Promise<Response>) {
  const calls: { url: string; accept: string; redirect: string }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, accept: init.headers.Accept, redirect: init.redirect });
    return route(url, init.headers.Accept, init.signal);
  };
  return { fetch, calls };
}

/** The bytes stored, and deps around `fetch`: small caps, a short delay. */
function depsOf(fetch: FetchFn, more: Partial<PublicationDeps> = {}) {
  const stored: { name: string; bytes: Uint8Array }[] = [];
  const logged: string[] = [];
  const deps: PublicationDeps = {
    fetch,
    store: (name, bytes): FileRef => {
      stored.push({ name, bytes });
      return { name, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 2000, pdfMaxMs: 60_000, log: (m) => logged.push(m), ...more,
  };
  return { deps, stored, logged };
}

const CSL_TYPE = 'application/vnd.citationstyles.csl+json';
const BIB_TYPE = 'application/x-bibtex';

test('fetchPublication : un article d’arXiv rejoué — son CSL et son BibTeX par le DOI d’arXiv, puis son PDF au magasin', async () => {
  const { fetch, calls } = fakeFetch((url, accept, signal) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal }));
  const { deps, stored } = depsOf(fetch);
  const r = await fetchPublication({ arxiv: '1706.03762' }, deps);
  if (!r.ok) throw new Error(r.message);
  expect(cslToFields(r.csl)).toEqual({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin'],
    year: '2017',
  });
  expect(r.bibtex).toMatch(/^@\w+\{/);
  expect(r.bibtex).toContain('Attention Is All You Need');
  expect(r.id).toEqual({ arxiv: '1706.03762' });
  const pdf = readFileSync(join(DATA, 'arxiv-1706.03762.pdf'));
  expect(r.pdf).toEqual({ name: '1706.03762.pdf', hash: createHash('sha256').update(pdf).digest('hex'), size: pdf.length });
  expect(r.pdfMessage).toBeUndefined();
  expect(stored.map((s) => s.name)).toEqual(['1706.03762.pdf']);
  // Every request in HTTPS, to a permitted host, its redirects by hand; the metadata from doi.org first.
  for (const c of calls) {
    expect(PUBLICATION_SOURCES.hosts).toContain(new URL(c.url).hostname);
    expect(c.url.startsWith('https://')).toBe(true);
    expect(c.redirect).toBe('manual');
  }
  expect(calls.filter((c) => c.url === 'https://doi.org/10.48550/arXiv.1706.03762').map((c) => c.accept).sort()).toEqual([CSL_TYPE, BIB_TYPE]);
  // DataCite's content negotiation answers arXiv's DOI (the ruling of task 4: data.crosscite.org), its PDF from arXiv.
  expect(calls.map((c) => new URL(c.url).hostname).sort()).toEqual(['arxiv.org', 'data.crosscite.org', 'data.crosscite.org', 'doi.org', 'doi.org']);
  expect(calls.at(-1)).toEqual({ url: 'https://arxiv.org/pdf/1706.03762', accept: 'application/pdf', redirect: 'manual' });
});

test('fetchPublication : un livre de Crossref rejoué, sans PDF ; cslToFields lit le CSL d’un livre comme celui d’un article', async () => {
  const { fetch, calls } = fakeFetch((url, accept, signal) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal }));
  const { deps, stored } = depsOf(fetch);
  const r = await fetchPublication({ doi: '10.1007/978-0-387-49820-1' }, deps);
  if (!r.ok) throw new Error(r.message);
  expect(r.csl.type).toBe('book');
  expect(cslToFields(r.csl)).toEqual({ title: 'An Introduction to Kolmogorov Complexity and Its Applications', authors: ['Ming Li', 'Paul Vitányi'], year: '2008' });
  expect(r.bibtex).toMatch(/^@book\{/);
  expect(r.pdf).toBeUndefined();
  expect(r.pdfMessage).toBeUndefined();
  expect(stored).toEqual([]);
  expect(calls.some((c) => new URL(c.url).hostname === 'arxiv.org')).toBe(false);
});

test('fetchPublication : un DOI inconnu (la réponse enregistrée de doi.org) est « Publication introuvable. », rien n’est stocké', async () => {
  const { fetch } = fakeFetch((url, accept, signal) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal }));
  const { deps, stored } = depsOf(fetch);
  expect(await fetchPublication({ doi: '10.1007/cirrus-introuvable' }, deps)).toEqual({ ok: false, message: 'Publication introuvable.' });
  // An arXiv identifier unknown to DataCite: its PDF is not even asked for.
  const off = fakeFetch(() => new Response('<html>DOI Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
  expect(await fetchPublication({ arxiv: '9912.99999' }, depsOf(off.fetch).deps)).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(off.calls.some((c) => c.url.includes('/pdf/'))).toBe(false);
  expect(stored).toEqual([]);
});

test('fetchPublication : sans réseau, « Pas de connexion. », quelle que soit l’erreur de la pile réseau, et le PDF n’est pas demandé', async () => {
  for (const error of [new TypeError('fetch failed'), new Error('net::ERR_INTERNET_DISCONNECTED'), new Error('net::ERR_NAME_NOT_RESOLVED')]) {
    const { fetch, calls } = fakeFetch(() => { throw error; });
    const { deps, logged } = depsOf(fetch);
    expect(await fetchPublication({ arxiv: '1706.03762' }, deps)).toEqual({ ok: false, message: 'Pas de connexion.' });
    expect(calls.every((c) => c.url.startsWith('https://doi.org/'))).toBe(true);
    // The cause goes to the console, not to the user.
    expect(logged.join('\n')).toContain(error.message);
  }
  // The replay of a request it did not record: as without a network.
  const { fetch } = fakeFetch((url, accept, signal) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal }));
  expect(await fetchPublication({ doi: '10.1234/jamais-enregistre' }, depsOf(fetch).deps)).toEqual({ ok: false, message: 'Pas de connexion.' });
});

test('importPublication : `pdf: false` (un PDF déposé, task 5, D8) — les métadonnées seules, le PDF d’arXiv ni demandé ni stocké ; toute autre option garde le téléchargement', async () => {
  const replayed = () => fakeFetch((url, accept, signal) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal }));
  const without = replayed(), d = depsOf(without.fetch);
  const r = await importPublication('arXiv:1706.03762', d.deps, { pdf: false });
  if (!r.ok) throw new Error(r.message);
  if ('kind' in r) throw new Error('un PDF sans identifiant');
  expect(r.pdf).toBeUndefined();
  expect(r.pdfMessage).toBeUndefined();
  expect(d.stored).toEqual([]);
  expect(without.calls.some((c) => new URL(c.url).hostname === 'arxiv.org')).toBe(false);
  // What the page may send instead: the PDF is downloaded, as before.
  for (const options of [undefined, null, 'non', { pdf: 'false' }, { pdf: true }, []]) {
    const withPdf = replayed(), e = depsOf(withPdf.fetch);
    const x = await importPublication('arXiv:1706.03762', e.deps, options);
    expect(x.ok && x.pdf?.name, JSON.stringify(options)).toBe('1706.03762.pdf');
  }
});

test('requestFetch : net.request d’Electron en fetch à redirections manuelles, sans cookies ni cache', async () => {
  class FakeRequest extends EventEmitter {
    headers: Record<string, string> = {};
    aborted = false;
    ended = false;
    setHeader(k: string, v: string) { this.headers[k] = v; }
    abort() { this.aborted = true; }
    end() { this.ended = true; }
  }
  const made: { options: unknown; req: FakeRequest }[] = [];
  const f = requestFetch((options) => {
    const req = new FakeRequest();
    made.push({ options, req });
    return req;
  });
  const init = (signal = new AbortController().signal) => ({ headers: { Accept: CSL_TYPE }, redirect: 'manual' as const, signal });

  // A redirect: given as its status and absolute Location, the request stopped there (never followed by Electron).
  let p = f('https://doi.org/10.1234/essai', init());
  expect(made[0].options).toEqual({ url: 'https://doi.org/10.1234/essai', method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
  expect(made[0].req.headers).toEqual({ Accept: CSL_TYPE });
  expect(made[0].req.ended).toBe(true);
  made[0].req.emit('redirect', 302, 'GET', 'https://api.crossref.org/v1/works/10.1234/essai/transform', {});
  let res = await p;
  expect([res.status, res.headers.get('location'), made[0].req.aborted]).toEqual([302, 'https://api.crossref.org/v1/works/10.1234/essai/transform', true]);

  // A response: its status, its headers (several values joined), its body streamed.
  p = f('https://doi.org/10.1234/essai', init());
  const incoming = Object.assign(Readable.from([Buffer.from('{"title"'), Buffer.from(': "x"}')]), {
    statusCode: 200, headers: { 'content-type': CSL_TYPE, 'x-plusieurs': ['a', 'b'] },
  });
  made[1].req.emit('response', incoming);
  res = await p;
  expect([res.status, res.headers.get('content-type'), res.headers.get('x-plusieurs')]).toEqual([200, CSL_TYPE, 'a, b']);
  expect(await res.text()).toBe('{"title": "x"}');
  // A status without body.
  p = f('https://doi.org/x', init());
  made[2].req.emit('response', Object.assign(Readable.from([]), { statusCode: 204, headers: {} }));
  expect((await p).status).toBe(204);

  // The network's error, as it came.
  p = f('https://doi.org/x', init());
  made[3].req.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  await expect(p).rejects.toThrow('net::ERR_INTERNET_DISCONNECTED');
  // Aborted (the delay): the request stopped, the promise rejected with the reason.
  const abort = new AbortController();
  p = f('https://doi.org/x', init(abort.signal));
  abort.abort(new Error('délai'));
  await expect(p).rejects.toThrow('délai');
  expect(made[4].req.aborted).toBe(true);
  // Aborted before: no request at all.
  const before = new AbortController();
  before.abort(new Error('déjà'));
  await expect(f('https://doi.org/x', init(before.signal))).rejects.toThrow('déjà');
  expect(made.length).toBe(5);
});

test('replayFetch et replayDirOf : les réponses enregistrées, seulement sur une base de test en arrière-plan ou en capture', async () => {
  const replay = replayFetch(DATA);
  const signal = new AbortController().signal;
  const r = await replay('https://doi.org/10.1007/978-0-387-49820-1', { headers: { Accept: CSL_TYPE }, redirect: 'manual', signal });
  expect(r.status).toBeGreaterThanOrEqual(300);
  expect(r.headers.get('location')).toMatch(/^https:\/\//);
  await expect(replay('https://doi.org/10.1234/jamais', { headers: { Accept: CSL_TYPE }, redirect: 'manual', signal })).rejects.toThrow(TypeError);
  // Every recorded body is a plain name of the folder.
  const index = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as { responses: { url: string; body?: string }[] };
  for (const x of index.responses) if (x.body !== undefined) expect(readdirSync(DATA)).toContain(x.body);

  const env = { CIRRUS_PUBLICATIONS_REPLAY: 'D:\\rejeu', CIRRUS_DATA: 'D:\\base-de-test' };
  expect(replayDirOf({ ...env, CIRRUS_BACKGROUND: '1' }, false)).toBe('D:\\rejeu');
  expect(replayDirOf(env, true)).toBe('D:\\rejeu');
  // Never on the user's own base, nor in a window in front.
  expect(replayDirOf({ CIRRUS_PUBLICATIONS_REPLAY: 'D:\\rejeu', CIRRUS_BACKGROUND: '1' }, true)).toBeNull();
  expect(replayDirOf(env, false)).toBeNull();
  expect(replayDirOf({ ...env, CIRRUS_BACKGROUND: '0' }, false)).toBeNull();
  expect(replayDirOf({ CIRRUS_DATA: 'D:\\base-de-test', CIRRUS_BACKGROUND: '1' }, true)).toBeNull();
  expect(replayDirOf({ ...env, CIRRUS_PUBLICATIONS_REPLAY: '', CIRRUS_BACKGROUND: '1' }, false)).toBeNull();
  // The pickers' one rule (testPickOf), not a copy of it (final review of plan 5b, M4).
  for (const e of [env, { ...env, CIRRUS_BACKGROUND: '1' }, { CIRRUS_PUBLICATIONS_REPLAY: 'D:\\rejeu' }, {}]) {
    for (const capture of [false, true]) expect(replayDirOf(e, capture)).toBe(testPickOf(e, 'CIRRUS_PUBLICATIONS_REPLAY', capture));
  }
});

test('replayOpen : le réseau ouvert rejoué (plan 5b, D3) — les noms et les réponses écrits, sous les gardes de @cirrus/sources, jamais le réseau', async () => {
  const LOCAL = { ok: false, message: 'Adresse refusée : elle mène à une machine du réseau local.' };
  const open = { ...replayOpen(DATA), timeoutMs: 2000, pdfMaxMs: 60_000 };
  const signal = new AbortController().signal;
  // A name: the addresses written for it, else as getaddrinfo fails.
  expect(await open.resolve('editeur.example')).toEqual([{ address: '93.184.215.14', family: 4 }]);
  await expect(open.resolve('example.org')).rejects.toThrow(/ENOTFOUND/);
  // A connection: only to an address written for its name.
  const ask = (address: string, path: string) => open.connect({ address, family: 4, hostname: 'editeur.example', path, headers: { Accept: 'application/pdf' }, signal });
  expect((await ask('93.184.215.14', '/papiers/note.pdf')).status).toBe(200);
  await expect(ask('10.9.9.9', '/papiers/note.pdf')).rejects.toThrow(TypeError);
  await expect(ask('93.184.215.14', '/jamais')).rejects.toThrow(TypeError);

  // Through the import: a page, its DOI's metadata (replayFetch's Crossref answers) and its PDF.
  const { fetch } = fakeFetch((url, accept, s) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal: s }));
  const { deps, stored } = depsOf(fetch, { open });
  const page = await importPublication('https://editeur.example/articles/shannon-1948', deps);
  if (!page.ok || 'kind' in page) throw new Error(JSON.stringify(page));
  expect([page.id, cslToFields(page.csl)?.title, page.pdf?.name, page.pdfMessage]).toEqual([
    { doi: '10.1002/j.1538-7305.1948.tb01338.x' }, 'A Mathematical Theory of Communication', 'shannon-1948.pdf', undefined,
  ]);
  const shannon = readFileSync(join(DATA, 'editeur-shannon-1948.pdf'));
  expect(stored.map((s) => [s.name, Buffer.from(s.bytes).equals(shannon)])).toEqual([['shannon-1948.pdf', true]]);
  // A PDF without identifier, after a redirect.
  const note = readFileSync(join(DATA, 'editeur-note.pdf'));
  expect(await importPublication('https://editeur.example/ancienne-adresse', deps))
    .toEqual({ ok: true, kind: 'pdf', pdf: { name: 'note.pdf', hash: createHash('sha256').update(note).digest('hex'), size: note.length } });
  // The guards, on answers written all the same: a local name, a page whose PDF is local, an address in http.
  expect(await importPublication('https://interne.example/a.pdf', deps)).toEqual(LOCAL);
  expect(await importPublication('https://editeur.example/interne', deps)).toEqual(LOCAL);
  expect(await importPublication('http://editeur.example/papiers/note.pdf', deps)).toEqual({ ok: false, message: 'Seules les adresses https sont acceptées.' });
  // Not written: as without a network, never the real one.
  expect(await importPublication('https://editeur.example/jamais', deps)).toEqual({ ok: false, message: 'Pas de connexion.' });
  expect(await importPublication('https://example.org/', deps)).toEqual({ ok: false, message: 'Pas de connexion.' });
  expect(stored.map((s) => s.name)).toEqual(['shannon-1948.pdf', 'note.pdf']);
});

test('replayOpen (plan 5b, tâche 4) : la page d’OpenReview mène à un PDF sans identifiant, l’adresse de l’ACM se lit comme son DOI par doi.org, sans demander l’éditeur', async () => {
  const open = { ...replayOpen(DATA), timeoutMs: 2000, pdfMaxMs: 60_000 };
  const { fetch, calls } = fakeFetch((url, accept, s) => replayFetch(DATA)(url, { headers: { Accept: accept }, redirect: 'manual', signal: s }));
  const { deps, stored } = depsOf(fetch, { open });
  // OpenReview's shape: no DOI, `citation_pdf_url` at /pdf?id=…: a PDF as dropped, named by the store for want of a file name of its own.
  const vit = readFileSync(join(DATA, 'openreview-vit.pdf'));
  expect(await importPublication('https://openreview.net/forum?id=YicbFdNTTy', deps))
    .toEqual({ ok: true, kind: 'pdf', pdf: { name: 'publication.pdf', hash: createHash('sha256').update(vit).digest('hex'), size: vit.length } });
  expect(stored.map((s) => [s.name, Buffer.from(s.bytes).equals(vit)])).toEqual([['publication.pdf', true]]);
  // The ACM's address (D4): its DOI, asked of doi.org (Crossref's answers), never of dl.acm.org.
  const acm = await importPublication('https://dl.acm.org/doi/10.1145/3292500.3330701', deps);
  if (!acm.ok || 'kind' in acm) throw new Error(JSON.stringify(acm));
  expect([acm.id, cslToFields(acm.csl), acm.pdf]).toEqual([
    { doi: '10.1145/3292500.3330701' },
    { title: 'Optuna: A Next-generation Hyperparameter Optimization Framework', authors: ['Takuya Akiba', 'Shotaro Sano', 'Toshihiko Yanase', 'Takeru Ohta', 'Masanori Koyama'], year: '2019' },
    undefined,
  ]);
  expect(acm.bibtex).toContain('@inproceedings{Akiba_2019,');
  expect(calls.some((c) => c.url.includes('dl.acm.org'))).toBe(false);
  expect(calls.filter((c) => c.url.startsWith('https://doi.org/10.1145/')).map((c) => c.accept).sort()).toEqual(['application/vnd.citationstyles.csl+json', 'application/x-bibtex']);
});
