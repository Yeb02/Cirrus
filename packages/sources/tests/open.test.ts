import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRef } from '@cirrus/core';
import { expect, test } from 'vitest';
import { type FetchFn, importPublication, type PublicationDeps } from '../src/fetch.ts';
import { MAX_ADDRESS_CHARS } from '../src/identifier.ts';
import type { OpenDeps } from '../src/guard.ts';
import { endless, html, HTTPS_ONLY, LOCAL, NO_PDF, pdf, PDF_BYTES, PUBLIC, redirect, web } from './support.ts';

/** Plan 5b, D3: the import of an address of any site, through the guards of the open web; D4 before it. */

const DATA = join(fileURLToPath(new URL('.', import.meta.url)), 'data');
const page = (name: string) => readFileSync(join(DATA, name), 'utf8');
const UNRECOGNIZED = 'Identifiant non reconnu.';
const CSL_TYPE = 'application/vnd.citationstyles.csl+json';
const ACL = { doi: '10.18653/v1/N19-1423' };
const ACL_PAGE = 'https://aclanthology.org/N19-1423/';
const CSL = { type: 'paper-conference', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', author: [{ given: 'Jacob', family: 'Devlin' }], issued: { 'date-parts': [[2019]] } };
const BIB = '@inproceedings{devlin-etal-2019-bert, title = {BERT}, author = {Devlin, Jacob}, year = {2019}}';
const ARXIV_CSL = { type: 'article', title: 'Attention Is All You Need', author: [{ given: 'Ashish', family: 'Vaswani' }], issued: { 'date-parts': [[2017]] } };
const ARXIV_BIB = '@misc{vaswani2017, title = {Attention Is All You Need}, year = {2017}}';
const ref = (name: string, bytes: Uint8Array): FileRef => ({ name, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });

/**
 * An import's deps: the DOI resolver's answers (the ACL's DOI, arXiv's DOI and PDF; anything else, no network) and a fake
 * open web; what was stored, asked of the resolver, logged.
 */
function setup(routes: Parameters<typeof web>[0], names: Parameters<typeof web>[1] = {}, more: Partial<PublicationDeps> = {}, open: Partial<OpenDeps> = {}) {
  const asked: string[] = [];
  const fetch: FetchFn = async (url, init) => {
    asked.push(url);
    const accept = init.headers.Accept;
    const meta = (csl: object, bib: string) => new Response(accept === CSL_TYPE ? JSON.stringify(csl) : bib, { headers: { 'content-type': accept } });
    if (url === 'https://doi.org/10.18653/v1/N19-1423') return meta(CSL, BIB);
    if (url === 'https://doi.org/10.48550/arXiv.1706.03762') return meta(ARXIV_CSL, ARXIV_BIB);
    if (url === 'https://arxiv.org/pdf/1706.03762') return new Response(PDF_BYTES, { headers: { 'content-type': 'application/pdf' } });
    if (url === 'https://doi.org/10.1000/inconnu') return new Response('<html>DOI Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    throw new TypeError('fetch failed');
  };
  const w = web(routes, names, open);
  const stored: { name: string; bytes: Uint8Array }[] = [];
  const logged: string[] = [];
  const deps: PublicationDeps = {
    fetch, store: (name, bytes) => { stored.push({ name, bytes }); return ref(name, bytes); },
    maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 2000, pdfMaxMs: 60_000, log: (m) => logged.push(m), open: w.deps, ...more,
  };
  return { deps, asked, stored, logged, resolved: w.resolved, connected: w.connected };
}

test('importPublication : une adresse de PDF donne { kind: "pdf" }, le PDF au magasin sous son nom', async () => {
  const s = setup({ 'public.example/papiers/attention.pdf': () => pdf(PDF_BYTES), 'public.example/telecharger?id=7': () => pdf(PDF_BYTES) }, { 'public.example': [PUBLIC] });
  expect(await importPublication('https://public.example/papiers/attention.pdf', s.deps)).toEqual({ ok: true, kind: 'pdf', pdf: ref('attention.pdf', PDF_BYTES) });
  expect(s.stored.map((x) => x.name)).toEqual(['attention.pdf']);
  // Its name from no « .pdf »: a plain one. And `pdf: false` keeps it: the address is the PDF asked for.
  expect(await importPublication('  https://public.example/telecharger?id=7 ', s.deps, { pdf: false })).toEqual({ ok: true, kind: 'pdf', pdf: ref('publication.pdf', PDF_BYTES) });
  expect(s.asked).toEqual([]);
  // The store failing: said.
  const full = setup({ 'public.example/a.pdf': () => pdf(PDF_BYTES) }, { 'public.example': [PUBLIC] }, { store: () => { throw new Error('ENOSPC'); } });
  expect(await importPublication('https://public.example/a.pdf', full.deps)).toEqual({ ok: false, message: 'Le PDF n’a pas pu être enregistré dans la base.' });
  expect(full.logged.join('\n')).toContain('ENOSPC');
});

test('importPublication : une page avec citation_doi et citation_pdf_url donne les métadonnées et le PDF', async () => {
  const routes = { 'aclanthology.org/N19-1423/': () => html(page('acl.html')), 'aclanthology.org/N19-1423.pdf': () => pdf(PDF_BYTES) };
  const s = setup(routes, { 'aclanthology.org': [PUBLIC] });
  expect(await importPublication(ACL_PAGE, s.deps)).toEqual({ ok: true, id: ACL, csl: CSL, bibtex: BIB, pdf: ref('N19-1423.pdf', PDF_BYTES) });
  expect(s.asked).toEqual(['https://doi.org/10.18653/v1/N19-1423', 'https://doi.org/10.18653/v1/N19-1423']);
  expect(s.connected.map((c) => [c.address, c.path, c.headers.Accept])).toEqual([[PUBLIC, '/N19-1423/', expect.stringContaining('text/html')], [PUBLIC, '/N19-1423.pdf', 'application/pdf']]);
  expect(s.stored.map((x) => x.name)).toEqual(['N19-1423.pdf']);
  // `pdf: false` (a PDF dropped): the metadata only, the page's PDF never asked.
  const without = setup(routes, { 'aclanthology.org': [PUBLIC] });
  expect(await importPublication(ACL_PAGE, without.deps, { pdf: false })).toEqual({ ok: true, id: ACL, csl: CSL, bibtex: BIB });
  expect(without.connected.map((c) => c.path)).toEqual(['/N19-1423/']);
  expect(without.stored).toEqual([]);
  // Its DOI unknown to the resolver: refused, and its PDF not downloaded.
  const unknown = setup({ 'public.example/': () => html('<meta name="citation_doi" content="10.1000/inconnu"><meta name="citation_pdf_url" content="/a.pdf">') }, { 'public.example': [PUBLIC] });
  expect(await importPublication('https://public.example/', unknown.deps)).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(unknown.connected.map((c) => c.path)).toEqual(['/']);
});

test('importPublication : une page dont citation_pdf_url est interne donne les métadonnées sans PDF, avec la raison', async () => {
  const names = { 'public.example': [PUBLIC], 'interne.example': ['10.0.0.5'] };
  for (const [target, message] of [
    ['https://interne.example/a.pdf', LOCAL], ['https://127.0.0.1/a.pdf', LOCAL], ['https://[::1]/a.pdf', LOCAL], ['https://169.254.169.254/latest/meta-data/', LOCAL],
    ['https://public.example:8443/a.pdf', 'Adresse refusée : seul le port 443 est accepté.'], ['/connexion', NO_PDF],
  ] as const) {
    const s = setup({
      'public.example/article': () => html(`<meta name="citation_doi" content="10.18653/v1/N19-1423"><meta name="citation_pdf_url" content="${target}">`),
      'public.example/connexion': () => html('<html>Connectez-vous</html>'),
    }, names);
    expect(await importPublication('https://public.example/article', s.deps), target).toEqual({ ok: true, id: ACL, csl: CSL, bibtex: BIB, pdfMessage: message });
    expect(s.connected.every((c) => c.address === PUBLIC), target).toBe(true);
    expect(s.stored, target).toEqual([]);
  }
  // A redirect of the page's PDF toward the local network: the same.
  const s = setup({
    'public.example/article': () => html('<meta name="citation_doi" content="10.18653/v1/N19-1423"><meta name="citation_pdf_url" content="/a.pdf">'),
    'public.example/a.pdf': () => redirect('https://interne.example/a.pdf'),
  }, names);
  expect(await importPublication('https://public.example/article', s.deps)).toEqual({ ok: true, id: ACL, csl: CSL, bibtex: BIB, pdfMessage: LOCAL });
  expect(s.resolved).toEqual(['public.example', 'public.example', 'interne.example']);
});

test('importPublication : une page sans DOI qui mène à un PDF (PMLR, NeurIPS, OpenReview) donne { kind: "pdf" } ; sans rien, « Cette page ne mène à aucun PDF. »', async () => {
  const names = { 'proceedings.mlr.press': [PUBLIC], 'proceedings.neurips.cc': [PUBLIC], 'openreview.net': [PUBLIC], 'public.example': [PUBLIC], 'interne.example': ['10.0.0.5'] };
  const s = setup({
    'proceedings.mlr.press/v139/radford21a.html': () => html(page('pmlr.html')), 'proceedings.mlr.press/v139/radford21a/radford21a.pdf': () => pdf(PDF_BYTES),
    'proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html': () => html(page('neurips.html')),
    'proceedings.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf': () => pdf(PDF_BYTES),
    'openreview.net/forum?id=YicbFdNTTy': () => html(page('openreview.html')), 'openreview.net/pdf?id=YicbFdNTTy': () => pdf(PDF_BYTES),
    'public.example/rien': () => html('<html><head><title>Rien</title></head></html>'),
    'public.example/image': () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } }),
    'public.example/interne': () => html('<meta name="citation_pdf_url" content="https://interne.example/a.pdf">'),
  }, names);
  // PMLR's link written in http: asked in https.
  expect(await importPublication('https://proceedings.mlr.press/v139/radford21a.html', s.deps)).toEqual({ ok: true, kind: 'pdf', pdf: ref('radford21a.pdf', PDF_BYTES) });
  expect(await importPublication('https://proceedings.neurips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html', s.deps))
    .toEqual({ ok: true, kind: 'pdf', pdf: ref('3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf', PDF_BYTES) });
  expect(await importPublication('https://openreview.net/forum?id=YicbFdNTTy', s.deps)).toEqual({ ok: true, kind: 'pdf', pdf: ref('publication.pdf', PDF_BYTES) });
  // `pdf: false` too: without identifier, the PDF is all the page gives.
  expect(await importPublication('https://openreview.net/forum?id=YicbFdNTTy', s.deps, { pdf: false })).toEqual({ ok: true, kind: 'pdf', pdf: ref('publication.pdf', PDF_BYTES) });
  expect(s.asked).toEqual([]);
  expect(await importPublication('https://public.example/rien', s.deps)).toEqual({ ok: false, message: NO_PDF });
  expect(await importPublication('https://public.example/image', s.deps)).toEqual({ ok: false, message: NO_PDF });
  // Without DOI, its PDF refused: the reason.
  expect(await importPublication('https://public.example/interne', s.deps)).toEqual({ ok: false, message: LOCAL });
  expect(s.stored.map((x) => x.name)).toEqual(['radford21a.pdf', '3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf', 'publication.pdf', 'publication.pdf']);
});

test('importPublication : une page avec citation_arxiv_id — l’article d’arXiv, avec le PDF de la page s’il y en a un, sinon celui d’arXiv', async () => {
  const s = setup({
    'public.example/a': () => html('<meta name="citation_arxiv_id" content="1706.03762">'),
    'public.example/b': () => html('<meta name="citation_arxiv_id" content="arXiv:1706.03762"><meta name="citation_pdf_url" content="/b.pdf">'),
    'public.example/b.pdf': () => pdf(PDF_BYTES),
  }, { 'public.example': [PUBLIC] });
  expect(await importPublication('https://public.example/a', s.deps)).toEqual({ ok: true, id: { arxiv: '1706.03762' }, csl: ARXIV_CSL, bibtex: ARXIV_BIB, pdf: ref('1706.03762.pdf', PDF_BYTES) });
  expect(s.asked.at(-1)).toBe('https://arxiv.org/pdf/1706.03762');
  s.asked.length = 0;
  expect(await importPublication('https://public.example/b', s.deps)).toEqual({ ok: true, id: { arxiv: '1706.03762' }, csl: ARXIV_CSL, bibtex: ARXIV_BIB, pdf: ref('b.pdf', PDF_BYTES) });
  expect(s.asked).not.toContain('https://arxiv.org/pdf/1706.03762');
});

test('importPublication : une adresse http, une adresse sans réseau ouvert, une adresse d’éditeur (D4), ce qui n’est pas une adresse', async () => {
  const routes = { 'public.example/x': () => html('<meta name="citation_pdf_url" content="/x.pdf">'), 'public.example/x.pdf': () => pdf(PDF_BYTES) };
  const names = { 'public.example': [PUBLIC] };
  let s = setup(routes, names);
  expect(await importPublication('http://public.example/x', s.deps)).toEqual({ ok: false, message: HTTPS_ONLY });
  expect(await importPublication('ftp://public.example/x.pdf', s.deps)).toEqual({ ok: false, message: HTTPS_ONLY });
  expect(await importPublication('https://moi:secret@public.example/x', s.deps)).toEqual({ ok: false, message: 'Adresse refusée : elle contient un nom d’utilisateur ou un mot de passe.' });
  // Not an address: as before, unrecognized, nothing asked (« doi: » or « arXiv: » are no schemes of an address).
  for (const text of ['bonjour', 'doi:', 'arXiv:bonjour', 'javascript:alert(1)', 'https://', `https://public.example/${'x'.repeat(MAX_ADDRESS_CHARS)}`]) {
    expect(await importPublication(text, s.deps), text).toEqual({ ok: false, message: UNRECOGNIZED });
  }
  expect(s.resolved.length + s.connected.length + s.asked.length).toBe(0);
  // Without the open web (`open` null or absent): an address that is no identifier is unrecognized, as in plan 4c.
  for (const open of [null, undefined]) {
    s = setup(routes, names, { open });
    expect(await importPublication('https://public.example/x', s.deps)).toEqual({ ok: false, message: UNRECOGNIZED });
    expect(await importPublication('http://public.example/x', s.deps)).toEqual({ ok: false, message: UNRECOGNIZED });
    expect(s.resolved.length + s.connected.length).toBe(0);
  }
  // A publisher's address: its DOI, read without asking the publisher (D4).
  s = setup(routes, names);
  const r = await importPublication('https://dl.acm.org/doi/pdf/10.18653/v1/N19-1423', s.deps);
  expect(r).toEqual({ ok: true, id: ACL, csl: CSL, bibtex: BIB });
  expect(s.resolved.length + s.connected.length).toBe(0);
});

test('importPublication : une page énorme est lue sous son plafond, ses balises de tête trouvées', async () => {
  const head = new TextEncoder().encode('<html><head><meta name="citation_doi" content="10.18653/v1/N19-1423"><meta name="citation_pdf_url" content="/a.pdf"></head><body>');
  const body = endless(16 * 1024, Infinity, 0, head);
  const s = setup({ 'public.example/': () => html(body.stream), 'public.example/a.pdf': () => pdf(PDF_BYTES) }, { 'public.example': [PUBLIC] });
  expect(await importPublication('https://public.example/', s.deps)).toEqual({ ok: true, id: ACL, csl: CSL, bibtex: BIB, pdf: ref('a.pdf', PDF_BYTES) });
  // publicationMaxKb (64 Ko here), then one piece more: no further.
  expect(body.seen.pulls).toBeLessThanOrEqual(6);
  expect(body.seen.cancelled).toBe(true);
});
