import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { fetchPublication } from '../src/fetch.ts';
import { openFetch } from '../src/guard.ts';
import { duration } from '../src/transfer.ts';
import { endless, html, pdf, PDF_BYTES, PUBLIC, web } from './support.ts';

/** The reading of a body and its delays, shared by the metadata's exchange and the open web's (review of task 2, I1, I2). */

const CHUNKED = fileURLToPath(new URL('chunked.ts', import.meta.url));

test('un million de morceaux d’un octet : la mémoire suit les octets, pas les morceaux (openFetch et le PDF d’arXiv, dans un Node au tas de 64 Mo)', () => {
  for (const which of ['open', 'arxiv']) {
    const t0 = performance.now();
    const run = spawnSync(process.execPath, ['--max-old-space-size=64', CHUNKED, '1000000', which], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, `${which} : ${run.stderr.slice(-300)}`).toBe(0);
    const out = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { ok: boolean; size: number; ms: number };
    expect([which, out.ok, out.size]).toEqual([which, true, 1_000_005]);
    expect(out.ms, which).toBeLessThan(15_000);
    expect(performance.now() - t0, which).toBeLessThan(30_000);
  }
  // A million empty pieces before the first bytes: read through, none kept.
  const run = spawnSync(process.execPath, ['--max-old-space-size=64', CHUNKED, '1000000', 'empty'], { encoding: 'utf8', timeout: 60_000 });
  expect(run.status, `empty : ${run.stderr.slice(-300)}`).toBe(0);
  expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, size: 5 });
});

test('un PDF qui goutte sans jamais se taire assez longtemps est arrêté après publicationPdfMaxMs, au réseau ouvert comme chez arXiv', async () => {
  // A byte every 50 ms: never idle for the delay (300 ms), past the whole download's bound (700 ms).
  const trickle = () => endless(1, Infinity, 50, PDF_BYTES);
  const body = trickle();
  const w = web({ 'public.example/a.pdf': () => pdf(body.stream) }, { 'public.example': [PUBLIC] }, { timeoutMs: 300, pdfMaxMs: 700 });
  let t0 = performance.now();
  expect(await openFetch('https://public.example/a.pdf', w.deps, 'application/pdf', { page: 1024, pdf: 2 ** 20 }))
    .toEqual({ ok: false, message: `Le téléchargement du PDF a dépassé ${duration(700)} : arrêté.` });
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(body.seen.cancelled).toBe(true);
  // arXiv's PDF: the publication comes without it, the reason said.
  const arxiv = trickle();
  t0 = performance.now();
  const r = await fetchPublication({ arxiv: '1706.03762' }, {
    fetch: async (url, init) => (url.includes('/pdf/')
      ? pdf(arxiv.stream)
      : new Response(init.headers.Accept.includes('csl') ? '{"title":"T"}' : '@misc{x, title={T}}', { headers: { 'content-type': init.headers.Accept } })),
    store: (name, bytes) => ({ name, hash: 'h', size: bytes.length }), maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 300, pdfMaxMs: 700,
  });
  expect(r.ok && 'pdfMessage' in r && r.pdfMessage).toBe(`Le téléchargement du PDF d’arXiv a dépassé ${duration(700)} : arrêté.`);
  expect(performance.now() - t0).toBeLessThan(2000);
  // The bound counts a PDF only: a page that trickles keeps its whole delay (300 ms here).
  const page = endless(1, Infinity, 50);
  const p = web({ 'public.example/': () => html(page.stream) }, { 'public.example': [PUBLIC] }, { timeoutMs: 300, pdfMaxMs: 60_000 });
  expect((await openFetch('https://public.example/', p.deps, 'text/html', { page: 1024, pdf: 2 ** 20 })).ok).toBe(false);
});

test('une longueur déclarée fausse ne sert qu’à la première taille du tampon : plus courte, plus longue, pas un entier', async () => {
  const routes = Object.fromEntries(['1.5', '3', '999999', '-4', 'abc'].map((length, i) => [`public.example/${i}.pdf`, () => pdf(PDF_BYTES, { 'content-length': length })]));
  const w = web(routes, { 'public.example': [PUBLIC] });
  for (let i = 0; i < 5; i++) {
    const r = await openFetch(`https://public.example/${i}.pdf`, w.deps, 'application/pdf', { page: 1024, pdf: 2 ** 20 });
    expect(r.ok && [r.pdf, r.bytes.length], String(i)).toEqual([true, PDF_BYTES.length]);
  }
});

test('duration : une durée en secondes sous la minute, en minutes au-delà', () => {
  expect([duration(700), duration(10_000), duration(59_000), duration(60_000), duration(90_000), duration(300_000), duration(3_600_000)])
    .toEqual([`${(0.7).toLocaleString('fr-FR')} s`, '10 s', '59 s', '1 min', `${(1.5).toLocaleString('fr-FR')} min`, '5 min', '60 min']);
});
