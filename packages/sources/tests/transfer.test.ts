import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { fetchPublication } from '../src/fetch.ts';
import { openFetch } from '../src/guard.ts';
import { duration, readBody, Refusal, Transfer } from '../src/transfer.ts';
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

test('une longueur annoncée ne réserve pas sa taille : 200 Mo annoncés, 8 octets envoyés, puis plus rien, coûtent 1 Mio au plus', async () => {
  const MIB = 2 ** 20;
  const t = new Transfer({ timeoutMs: 300, pdfMaxMs: 60_000 }, { late: () => new Refusal('délai'), tooLong: () => new Refusal('trop long'), offline: () => new Refusal('hors ligne') });
  const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('%PDF-1.7')); } });
  const res = new Response(stalled, { headers: { 'content-type': 'application/pdf', 'content-length': String(200 * MIB) } });
  const sizes: number[] = [];
  await expect(readBody(res, t, () => ({ cap: 200 * MIB, tooBig: new Refusal('trop gros'), stall: true }), (n) => sizes.push(n))).rejects.toThrow('délai');
  t.close();
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(MIB);
  // An honest body of 3 Mio, said so, in 64 Kio pieces: grown as it comes, never past what was said.
  const t2 = new Transfer({ timeoutMs: 2000, pdfMaxMs: 60_000 }, { late: () => new Refusal('délai'), tooLong: () => new Refusal('trop long'), offline: () => new Refusal('hors ligne') });
  let sent = 0;
  const honest = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= 3 * MIB) { c.close(); return; }
      c.enqueue(new Uint8Array(64 * 1024).fill(0x25));
      sent += 64 * 1024;
    },
  });
  const grown: number[] = [];
  const r = await readBody(new Response(honest, { headers: { 'content-length': String(3 * MIB) } }), t2, () => ({ cap: 200 * MIB, tooBig: null, stall: false }), (n) => grown.push(n));
  t2.close();
  expect(r.bytes.length).toBe(3 * MIB);
  expect(grown).toEqual([MIB, 2 * MIB, 3 * MIB]);
  // A body that says 64 Kio and sends 4 Mio: past what it said, it doubles, never a copy per piece.
  const t3 = new Transfer({ timeoutMs: 2000, pdfMaxMs: 60_000 }, { late: () => new Refusal('délai'), tooLong: () => new Refusal('trop long'), offline: () => new Refusal('hors ligne') });
  let more = 0;
  const liar = new ReadableStream<Uint8Array>({
    pull(c) {
      if (more >= 4 * MIB) { c.close(); return; }
      c.enqueue(new Uint8Array(64 * 1024));
      more += 64 * 1024;
    },
  });
  const lied: number[] = [];
  const l = await readBody(new Response(liar, { headers: { 'content-length': String(64 * 1024) } }), t3, () => ({ cap: 200 * MIB, tooBig: null, stall: false }), (n) => lied.push(n));
  t3.close();
  expect(l.bytes.length).toBe(4 * MIB);
  expect(lied).toEqual([64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, MIB, 2 * MIB, 4 * MIB]);
});

test('duration : une durée en secondes sous la minute, en minutes au-delà', () => {
  expect([duration(700), duration(10_000), duration(59_000), duration(60_000), duration(90_000), duration(300_000), duration(3_600_000)])
    .toEqual([`${(0.7).toLocaleString('fr-FR')} s`, '10 s', '59 s', '1 min', `${(1.5).toLocaleString('fr-FR')} min`, '5 min', '60 min']);
});
