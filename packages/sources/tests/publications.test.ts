import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRef } from '@cirrus/core';
import { expect, test } from 'vitest';
import { cslToFields } from '../src/csl.ts';
import { type FetchFn, fetchPublication, importPublication, type PublicationDeps } from '../src/fetch.ts';
import { arxivDoi, MAX_IDENTIFIER_CHARS, parseIdentifier } from '../src/identifier.ts';
import { IDENTIFIER_LINKS, PUBLICATION_SOURCES } from '../src/sources.ts';
import type { BodyInit } from './support.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
/**
 * The sources of the modules that may reach the network for a publication: this package's, the app's and the server's
 * (plan 5b, D2: the scan of plan 4c, over the app alone, followed sources.ts here).
 */
const src = join(here, '..', '..');
const SCANNED = ['sources', 'app', 'server'].map((p) => join(src, p, 'src'));

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
const ESSAI = { doi: '10.1234/essai' };
const ESSAI_URL = 'https://doi.org/10.1234/essai';
const CSL_OK = { type: 'article-journal', title: 'Un titre', author: [{ given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [[1843]] } };
const BIB_OK = '@article{lovelace1843, title={Un titre}, author={Lovelace, Ada}, year={1843}}';
const answer = (body: BodyInit | null, type: string, status = 200, more: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...more } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
/** The test DOI's two answers, CSL and BibTeX, unless `over` answers first. */
const essai = (over?: (url: string, accept: string) => Response | Promise<Response> | undefined) =>
  fakeFetch(async (url, accept) => {
    const o = await over?.(url, accept);
    if (o) return o;
    if (url !== ESSAI_URL) throw new TypeError('fetch failed');
    return accept === CSL_TYPE ? answer(JSON.stringify(CSL_OK), `${CSL_TYPE}; charset=utf-8`) : answer(BIB_OK, BIB_TYPE);
  });
/**
 * A body of `chunk` bytes at a time, without end (or `count` of them, `everyMs` apart): the chunks pulled, and whether
 * it was cancelled.
 */
function endless(chunk: number, count = Infinity, everyMs = 0) {
  const seen = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (seen.pulls >= count) { c.close(); return; }
      seen.pulls++;
      if (everyMs > 0) await new Promise((r) => setTimeout(r, everyMs));
      c.enqueue(new Uint8Array(chunk).fill(0x25));
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, seen };
}
const seconds = (ms: number) => `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;

test('parseIdentifier : DOI nu ou en lien, arXiv nouveau ou ancien, avec ou sans version, en lien abs ou pdf', () => {
  const cases: [string, ReturnType<typeof parseIdentifier>][] = [
    ['10.1007/978-0-387-49820-1', { doi: '10.1007/978-0-387-49820-1' }],
    ['  doi:10.1007/978-0-387-49820-1 ', { doi: '10.1007/978-0-387-49820-1' }],
    ['DOI: 10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C', { doi: '10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C' }],
    ['https://doi.org/10.1007/978-0-387-49820-1', { doi: '10.1007/978-0-387-49820-1' }],
    ['http://dx.doi.org/10.1000/a%3Cb%3E?x=1#y', { doi: '10.1000/a<b>' }],
    ['arXiv:2401.01234v2', { arxiv: '2401.01234v2' }],
    ['arxiv: 2401.01234', { arxiv: '2401.01234' }],
    ['2401.01234', { arxiv: '2401.01234' }],
    ['0704.0001', { arxiv: '0704.0001' }],
    ['https://arxiv.org/abs/2401.01234v2', { arxiv: '2401.01234v2' }],
    ['https://arxiv.org/pdf/2401.01234v2', { arxiv: '2401.01234v2' }],
    ['https://www.arxiv.org/pdf/2401.01234v2.pdf', { arxiv: '2401.01234v2' }],
    ['http://arxiv.org/abs/hep-th/9901001?context=hep-th', { arxiv: 'hep-th/9901001' }],
    ['hep-th/9901001', { arxiv: 'hep-th/9901001' }],
    ['arXiv:math.GT/0309136v2', { arxiv: 'math.GT/0309136v2' }],
    ['cond-mat/0001001', { arxiv: 'cond-mat/0001001' }],
    // arXiv's own DOI is an arXiv article: its PDF comes too (D6).
    ['10.48550/arXiv.1706.03762', { arxiv: '1706.03762' }],
    ['https://doi.org/10.48550/arxiv.hep-th/9901001', { arxiv: 'hep-th/9901001' }],
    // Plan 5b, D4: an address of another host whose path holds a DOI is that DOI (plan 4c refused these two).
    ['https://example.org/10.1000/x', { doi: '10.1000/x' }],
    ['https://doi.org.evil.example/10.1000/x', { doi: '10.1000/x' }],
  ];
  for (const [text, id] of cases) expect(parseIdentifier(text), text).toEqual(id);
  for (const text of [
    '', '   ', 'bonjour', '10.1/x', '10.1234', '10.1234/', '10.1234/a b', '10.1234/\u0000x', '10.1234/../x', '10.1234/./x', 'doi:', 'arXiv:', 'arXiv:bonjour',
    '2401.012', '2401.0123456', 'hep-th/990100', 'https://evil.example/abs/2401.01234', 'https://arxiv.org/list/hep-th/9901001',
    'https://doi.org/%E0%A4%A', 'javascript:alert(1)', 'file:///C:/10.1000/x', `10.1234/${'x'.repeat(MAX_IDENTIFIER_CHARS)}`,
  ]) {
    expect(parseIdentifier(text), JSON.stringify(text)).toBeNull();
  }
  expect(arxivDoi('2401.01234v2')).toBe('10.48550/arXiv.2401.01234');
  expect(arxivDoi('hep-th/9901001v1')).toBe('10.48550/arXiv.hep-th/9901001');
});

test('PUBLICATION_SOURCES : les hôtes permis et les adresses, en un seul endroit ; aucun autre module de l’app ne nomme ces hôtes', () => {
  expect(PUBLICATION_SOURCES.hosts).toEqual(['doi.org', 'api.crossref.org', 'data.crossref.org', 'api.datacite.org', 'data.datacite.org', 'data.crosscite.org', 'arxiv.org']);
  expect(PUBLICATION_SOURCES.doiUrl('10.1007/978-0-387-49820-1')).toBe('https://doi.org/10.1007/978-0-387-49820-1');
  // Each character a path would read otherwise is escaped; the DOI's « / » stays.
  expect(PUBLICATION_SOURCES.doiUrl('10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C'))
    .toBe('https://doi.org/10.1002/(SICI)1097-4636(199706)35%3A4%3C477%3A%3AAID-JBM8%3E3.0.CO%3B2-C');
  expect(PUBLICATION_SOURCES.doiUrl('10.1000/a?b#c%d')).toBe('https://doi.org/10.1000/a%3Fb%23c%25d');
  expect(PUBLICATION_SOURCES.arxivPdfUrl('2401.01234v2')).toBe('https://arxiv.org/pdf/2401.01234v2');
  expect(PUBLICATION_SOURCES.arxivPdfUrl('hep-th/9901001')).toBe('https://arxiv.org/pdf/hep-th/9901001');
  expect(IDENTIFIER_LINKS).toEqual({ doi: ['doi.org', 'dx.doi.org', 'www.doi.org'], arxiv: ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'] });
  const files = SCANNED.flatMap((dir) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => join(dir, f)));
  expect(files.length).toBeGreaterThan(50);
  for (const f of files) {
    if (f === join(src, 'sources', 'src', 'sources.ts')) continue;
    expect(readFileSync(f, 'utf8'), relative(src, f)).not.toMatch(/doi\.org|crossref\.org|datacite\.org|crosscite\.org|arxiv\.org/i);
  }
});

test('fetchPublication : une redirection vers un hôte non permis, hors HTTPS, ou sans fin est refusée, et sa cible jamais demandée', async () => {
  const cases: [string, string][] = [
    ['https://evil.example/vole', 'Redirection refusée : « doi.org » renvoie vers « evil.example », qui n’est pas un serveur permis.'],
    ['https://doi.org@evil.example/x', 'Redirection refusée : « doi.org » renvoie vers « evil.example », qui n’est pas un serveur permis.'],
    ['https://api.crossref.org:8443/x', 'Redirection refusée : « doi.org » renvoie vers « api.crossref.org:8443 », qui n’est pas un serveur permis.'],
    ['https://user:pass@api.crossref.org/x', 'Redirection refusée : « doi.org » renvoie vers « api.crossref.org », qui n’est pas un serveur permis.'],
    ['https://doi.org.evil.example/x', 'Redirection refusée : « doi.org » renvoie vers « doi.org.evil.example », qui n’est pas un serveur permis.'],
    ['http://api.crossref.org/x', 'Redirection refusée : « doi.org » renvoie vers une adresse qui n’est pas en HTTPS.'],
    ['file:///C:/Windows/win.ini', 'Redirection refusée : « doi.org » renvoie vers une adresse qui n’est pas en HTTPS.'],
  ];
  for (const [location, message] of cases) {
    const { fetch, calls } = essai((url) => (url === ESSAI_URL ? redirect(location) : undefined));
    expect(await fetchPublication(ESSAI, depsOf(fetch).deps), location).toEqual({ ok: false, message });
    expect(calls.every((c) => c.url === ESSAI_URL), location).toBe(true);
  }
  // A permitted chain is followed, a relative Location resolved against the address that gave it, each status of a redirect.
  for (const status of [301, 302, 303, 307, 308]) {
    const { fetch, calls } = essai((url) => {
      if (url === 'https://doi.org/10.1234/ancien') return redirect('/10.1234/relai', status);
      if (url === 'https://doi.org/10.1234/relai') return redirect('https://api.crossref.org/v1/works/10.1234/essai/transform', status);
      if (url === 'https://api.crossref.org/v1/works/10.1234/essai/transform') return redirect(ESSAI_URL, status);
    });
    const r = await fetchPublication({ doi: '10.1234/ancien' }, depsOf(fetch).deps);
    expect(r.ok, String(status)).toBe(true);
    expect(calls.filter((c) => c.accept === CSL_TYPE).map((c) => c.url)).toEqual([
      'https://doi.org/10.1234/ancien', 'https://doi.org/10.1234/relai', 'https://api.crossref.org/v1/works/10.1234/essai/transform', ESSAI_URL,
    ]);
  }
  // Without end: stopped after a few hops.
  const loop = essai((url) => (url.startsWith('https://doi.org/') ? redirect(`${url}x`) : undefined));
  expect(await fetchPublication(ESSAI, depsOf(loop.fetch).deps)).toEqual({ ok: false, message: 'Trop de redirections depuis « doi.org ».' });
  expect(loop.calls.filter((c) => c.accept === CSL_TYPE).length).toBe(6);
  // A redirect without Location, or with one that is no address.
  for (const r of [new Response(null, { status: 302 }), redirect('http://[zz')]) {
    const { fetch } = essai((url) => (url === ESSAI_URL ? r.clone() : undefined));
    expect(await fetchPublication(ESSAI, depsOf(fetch).deps)).toEqual({ ok: false, message: 'Réponse inattendue du serveur de DOI.' });
  }
});

test('fetchPublication : du HTML ou autre chose au lieu du CSL-JSON ou du BibTeX est « Réponse inattendue du serveur de DOI. »', async () => {
  const unexpected = { ok: false, message: 'Réponse inattendue du serveur de DOI.' };
  const csl = (body: string, type = CSL_TYPE) => essai((_url, accept) => (accept === CSL_TYPE ? answer(body, type) : undefined));
  const bib = (body: string, type = BIB_TYPE) => essai((_url, accept) => (accept === BIB_TYPE ? answer(body, type) : undefined));
  for (const f of [
    csl('<!DOCTYPE html><html><body>Choisissez un format</body></html>', 'text/html; charset=utf-8'),
    // HTML said to be JSON, JSON said to be HTML.
    csl('<html></html>'), csl(JSON.stringify(CSL_OK), 'text/html'),
    // JSON, but no publication: an array, a string, null, an object without title.
    csl('[1, 2]'), csl('"titre"'), csl('null'), csl('{"author": []}'), csl('{"title": "   "}'), csl(''),
    // A script is data: never run, and no title.
    csl('{"title": {"toString": "x"}}'), csl('(function () { return {} })()'),
    bib('<html><body>Not acceptable</body></html>', 'text/html'), bib(BIB_OK, 'application/json'), bib('pas une entrée'), bib(''),
  ]) {
    expect(await fetchPublication(ESSAI, depsOf(f.fetch).deps)).toEqual(unexpected);
  }
  // Their types as the servers write them, any case, parameters after them.
  for (const [cslType, bibType] of [['application/vnd.citationstyles.csl+json', 'application/x-bibtex'], ['Application/JSON; charset=UTF-8', 'text/x-bibtex; charset=utf-8']]) {
    const { fetch } = essai((_url, accept) => (accept === CSL_TYPE ? answer(JSON.stringify(CSL_OK), cslType) : answer(BIB_OK, bibType)));
    expect((await fetchPublication(ESSAI, depsOf(fetch).deps)).ok, `${cslType} ${bibType}`).toBe(true);
  }
});

test('fetchPublication : une réponse trop grosse est refusée sans être lue au-delà de son plafond', async () => {
  const body = endless(16 * 1024);
  const { fetch } = essai((_url, accept) => (accept === CSL_TYPE ? answer(body.stream, CSL_TYPE) : undefined));
  expect(await fetchPublication(ESSAI, depsOf(fetch, { maxKb: 64 }).deps)).toEqual({ ok: false, message: 'Réponse trop grosse du serveur de DOI (plus de 64 Ko).' });
  // 64 Ko then one chunk more, which passes the cap: the reading stops there, and the body is let go.
  expect(body.seen.pulls).toBeLessThanOrEqual(6);
  expect(body.seen.cancelled).toBe(true);
  // Said too big by its Content-Length: not read at all.
  const declared = endless(16 * 1024);
  const big = essai((_url, accept) => (accept === BIB_TYPE ? answer(declared.stream, BIB_TYPE, 200, { 'content-length': String(10 * 2 ** 20) }) : undefined));
  expect(await fetchPublication(ESSAI, depsOf(big.fetch, { maxKb: 64 }).deps)).toEqual({ ok: false, message: 'Réponse trop grosse du serveur de DOI (plus de 64 Ko).' });
  expect(declared.seen.pulls).toBe(0);
  // At its cap exactly: taken.
  const json = JSON.stringify(CSL_OK);
  const exact = essai((_url, accept) => (accept === CSL_TYPE ? answer(json.padEnd(1024, ' '), CSL_TYPE) : undefined));
  expect((await fetchPublication(ESSAI, depsOf(exact.fetch, { maxKb: 1 }).deps)).ok).toBe(true);
});

test('fetchPublication : un serveur qui ne répond pas, ou s’arrête en cours de réponse, est abandonné après publicationTimeoutMs', async () => {
  const message = `Le serveur de DOI ne répond pas (délai de ${seconds(200)} dépassé).`;
  // Never answers, and ignores the signal: given up all the same; the signal is aborted.
  let aborted = false;
  const never = fakeFetch((_url, _accept, signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise<Response>(() => {});
  });
  let t0 = performance.now();
  expect(await fetchPublication(ESSAI, depsOf(never.fetch, { timeoutMs: 200 }).deps)).toEqual({ ok: false, message });
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(aborted).toBe(true);
  // Starts its answer then stops.
  const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"title": ')); } });
  const half = essai((_url, accept) => (accept === CSL_TYPE ? answer(stalled, CSL_TYPE) : undefined));
  t0 = performance.now();
  expect(await fetchPublication(ESSAI, depsOf(half.fetch, { timeoutMs: 200 }).deps)).toEqual({ ok: false, message });
  expect(performance.now() - t0).toBeLessThan(2000);
  // Metadata: the delay is the whole exchange's, redirects and body included, even a body never idle that long.
  const trickle = endless(8, 10, 60);
  const slow = essai((_url, accept) => (accept === CSL_TYPE ? answer(trickle.stream, CSL_TYPE) : undefined));
  expect(await fetchPublication(ESSAI, depsOf(slow.fetch, { timeoutMs: 300 }).deps)).toEqual({ ok: false, message: `Le serveur de DOI ne répond pas (délai de ${seconds(300)} dépassé).` });
});

test('fetchPublication : le PDF d’arXiv ne va au magasin que s’il commence par %PDF et tient dans maxImportMb ; sinon la publication vient sans lui, et la raison est dite', async () => {
  const meta = (url: string, accept: string) => {
    if (url !== 'https://doi.org/10.48550/arXiv.2401.01234') return undefined;
    return accept === CSL_TYPE ? answer(JSON.stringify(CSL_OK), CSL_TYPE) : answer(BIB_OK, BIB_TYPE);
  };
  const ARXIV = { arxiv: '2401.01234v2' };
  const PDF_URL = 'https://arxiv.org/pdf/2401.01234v2';
  const run = async (pdf: (url: string) => Response | Promise<Response | undefined> | undefined, more: Partial<PublicationDeps> = {}) => {
    const f = fakeFetch(async (url, accept) => {
      const r = meta(url, accept) ?? (await pdf(url));
      if (!r) throw new TypeError('fetch failed');
      return r;
    });
    const d = depsOf(f.fetch, more);
    return { r: await fetchPublication(ARXIV, d.deps), stored: d.stored, calls: f.calls };
  };
  const without = (pdfMessage: string) => ({ ok: true, id: ARXIV, csl: CSL_OK, bibtex: BIB_OK, pdfMessage });

  const good = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  let x = await run((url) => (url === PDF_URL ? answer(good, 'application/pdf') : undefined));
  expect(x.r).toEqual({ ok: true, id: ARXIV, csl: CSL_OK, bibtex: BIB_OK, pdf: { name: '2401.01234v2.pdf', hash: createHash('sha256').update(good).digest('hex'), size: good.length } });
  expect(x.stored.map((s) => [s.name, [...s.bytes]])).toEqual([['2401.01234v2.pdf', [...good]]]);

  // An HTML page (« le PDF est en préparation »), even said to be a PDF.
  for (const body of ['<!DOCTYPE html><html>PDF en préparation</html>', ' %PDF-1.7', '%PD']) {
    x = await run((url) => (url === PDF_URL ? answer(body, 'application/pdf') : undefined));
    expect(x.r, body).toEqual(without('Le fichier reçu d’arXiv n’est pas un PDF.'));
    expect(x.stored).toEqual([]);
  }
  // Too large: read no further than maxImportMb.
  const big = endless(64 * 1024);
  x = await run((url) => (url === PDF_URL ? answer(big.stream, 'application/pdf') : undefined), { maxPdfBytes: 512 * 1024 });
  expect(x.r).toEqual(without(`Le PDF d’arXiv fait plus de ${(0.5).toLocaleString('fr-FR')} Mo.`));
  expect(big.seen.pulls).toBeLessThanOrEqual(10);
  expect(big.seen.cancelled).toBe(true);
  // A redirect elsewhere, never followed.
  x = await run((url) => (url === PDF_URL ? redirect('https://export.arxiv.org/pdf/2401.01234v2') : undefined));
  expect(x.r).toEqual(without('Redirection refusée : « arxiv.org » renvoie vers « export.arxiv.org », qui n’est pas un serveur permis.'));
  expect(x.calls.map((c) => c.url)).not.toContain('https://export.arxiv.org/pdf/2401.01234v2');
  // Unknown to arXiv, its server failing, the network gone meanwhile.
  x = await run((url) => (url === PDF_URL ? answer('<html>Not found</html>', 'text/html', 404) : undefined));
  expect(x.r).toEqual(without('Le PDF est introuvable sur arXiv.'));
  x = await run((url) => (url === PDF_URL ? answer('', 'text/plain', 503) : undefined));
  expect(x.r).toEqual(without('Le serveur d’arXiv a répondu par une erreur (HTTP 503).'));
  x = await run(() => undefined);
  expect(x.r).toEqual(without('Pas de connexion : le PDF d’arXiv n’a pas été téléchargé.'));
  // The store failing (the disk full): said, and the publication comes without it.
  x = await run((url) => (url === PDF_URL ? answer(good, 'application/pdf') : undefined), { store: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } });
  expect(x.r).toEqual(without('Le PDF d’arXiv n’a pas pu être enregistré dans la base.'));
  // Slow but never idle that long: the PDF's delay is a wait for data, not its whole download (larger than metadata).
  const trickle = endless(8, 10, 60);
  x = await run(async (url) => {
    if (url !== PDF_URL) return undefined;
    const head = new TextEncoder().encode('%PDF-1.4\n'), rest = trickle.stream.getReader();
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (first) { first = false; c.enqueue(head); return; }
        const p = await rest.read();
        if (p.done) c.close();
        else c.enqueue(p.value);
      },
    });
    return answer(body, 'application/pdf');
  }, { timeoutMs: 300 });
  expect(x.r.ok && x.r.pdf?.size).toBe(9 + 80);
});

test('fetchPublication : la première des deux demandes qui échoue arrête l’autre, sans attendre son délai', async () => {
  let aborted = false;
  const { fetch } = fakeFetch((_url, accept, signal) => {
    if (accept === CSL_TYPE) return answer('<html>DOI Not Found</html>', 'text/html', 404);
    // The BibTeX never answers, and ignores its signal.
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise<Response>(() => {});
  });
  const t0 = performance.now();
  expect(await fetchPublication(ESSAI, depsOf(fetch, { timeoutMs: 5000 }).deps)).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(aborted).toBe(true);
  // The BibTeX failing first: its reason, the CSL stopped.
  const other = fakeFetch((_url, accept) => (accept === BIB_TYPE ? redirect('https://evil.example/') : new Promise<Response>(() => {})));
  expect(await fetchPublication(ESSAI, depsOf(other.fetch, { timeoutMs: 5000 }).deps))
    .toEqual({ ok: false, message: 'Redirection refusée : « doi.org » renvoie vers « evil.example », qui n’est pas un serveur permis.' });
});

test('fetchPublication : une erreur HTTP du serveur de DOI est dite avec son code ; les demandes portent leur Accept', async () => {
  for (const status of [400, 403, 429, 500, 503]) {
    const { fetch } = essai((_url, accept) => (accept === CSL_TYPE ? answer('', 'text/plain', status) : undefined));
    expect(await fetchPublication(ESSAI, depsOf(fetch).deps)).toEqual({ ok: false, message: `Le serveur de DOI a répondu par une erreur (HTTP ${status}).` });
  }
  const { fetch } = essai((_url, accept) => (accept === BIB_TYPE ? answer('', 'text/html', 410) : undefined));
  expect(await fetchPublication(ESSAI, depsOf(fetch).deps)).toEqual({ ok: false, message: 'Publication introuvable.' });
});

test('importPublication : ce qui n’est pas un texte d’identifiant reconnu est « Identifiant non reconnu. », sans aucune demande', async () => {
  const { fetch, calls } = essai();
  for (const text of [42, null, undefined, {}, ['10.1234/essai'], 'bonjour', `10.1234/${'x'.repeat(MAX_IDENTIFIER_CHARS)}`]) {
    expect(await importPublication(text, depsOf(fetch).deps)).toEqual({ ok: false, message: 'Identifiant non reconnu.' });
  }
  expect(calls).toEqual([]);
  expect(await importPublication(' doi:10.1234/essai ', depsOf(fetch).deps)).toEqual({ ok: true, id: ESSAI, csl: CSL_OK, bibtex: BIB_OK });
});

test('cslToFields : titre, auteurs « Prénom Nom » et année, lus défensivement ; un champ inattendu est ignoré', () => {
  expect(cslToFields(CSL_OK)).toEqual({ title: 'Un titre', authors: ['Ada Lovelace'], year: '1843' });
  for (const csl of [null, undefined, 3, 'titre', [], [CSL_OK], {}, { title: 3 }, { title: '  \n ' }, { title: [] }, { title: [4] }, JSON.parse('{"__proto__": {"title": "piège"}}')]) {
    expect(cslToFields(csl), JSON.stringify(csl)).toBeNull();
  }
  expect(cslToFields({
    title: ['  Le <i>titre</i>\n  d’un  <scp>livre</scp> &amp; x &lt; y &#233;t&#xE9; ', 'autre'],
    author: [
      { given: 'Ludwig', 'dropping-particle': 'van', family: 'Beethoven' }, { given: 'Vincent', 'non-dropping-particle': 'van', family: 'Gogh' },
      { given: 'Martin Luther', family: 'King', suffix: 'Jr.' }, { literal: 'The ATLAS Collaboration' }, { family: 'Seul' }, { given: 'Prénom' },
      'pas un objet', null, 7, { given: 3, family: ['x'] }, { family: '  ' }, { family: '<b>Gras</b>' },
    ],
    issued: { 'date-parts': [['2008', 5]] },
  })).toEqual({
    title: 'Le titre d’un livre & x < y été',
    authors: ['Ludwig van Beethoven', 'Vincent van Gogh', 'Martin Luther King Jr.', 'The ATLAS Collaboration', 'Seul', 'Prénom', 'Gras'],
    year: '2008',
  });
  // A « < » that opens no tag stays.
  expect(cslToFields({ title: 'x < y et y > z' })?.title).toBe('x < y et y > z');
  // The year: issued, else the print or online publication; its raw text; else none.
  expect(cslToFields({ title: 'T', issued: { 'date-parts': [[null]] }, 'published-print': { 'date-parts': [[1999, 1]] } })?.year).toBe('1999');
  expect(cslToFields({ title: 'T', 'published-online': { 'date-parts': [[2001]] } })?.year).toBe('2001');
  expect(cslToFields({ title: 'T', issued: { raw: 'printemps 1977' } })?.year).toBe('1977');
  expect(cslToFields({ title: 'T', issued: { literal: 'sans date' } })?.year).toBeNull();
  expect(cslToFields({ title: 'T', issued: { 'date-parts': [[1e12]] } })?.year).toBeNull();
  expect(cslToFields({ title: 'T', issued: { 'date-parts': [[2.5]] } })?.year).toBeNull();
  expect(cslToFields({ title: 'T', issued: '2008', author: 'Li' })).toEqual({ title: 'T', authors: [], year: null });
});
