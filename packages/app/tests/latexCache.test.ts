import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CompileRequest, DEFAULT_PREAMBLE } from '@cirrus/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FILE_SCHEME, latexRequest } from '../src/main/files.ts';
import { PdfCache } from '../src/main/latex/cache.ts';

let dir: string, cacheDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-latex-cache-'));
  cacheDir = join(dir, 'cache');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const req = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  slot: 'summary:n1', mode: 'snippet', source: 'Bonjour $x^2$.', preamble: DEFAULT_PREAMBLE,
  refs: [{ label: 'mdl', title: 'MDL', node: 'n2' }], broken: ['absent'], doubled: [], cites: [{ key: 'li2008', text: 'Li et Vitányi, 2008', node: 'n3' }],
  doubledCites: [], unknownCites: [], known: [], resources: [{ name: 'b.png', hash: 'b'.repeat(64), size: 3 }, { name: 'a.png', hash: 'a'.repeat(64), size: 2 }],
  widthCm: 9, ...over,
});
const ENGINE = 'pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)';

test('PdfCache.key : la même requête donne la même clé ; ni l’emplacement ni les labels connus ne la changent ; un octet de plus, si', () => {
  const cache = new PdfCache(cacheDir, () => 2 ** 30);
  const k = cache.key(req(), ENGINE);
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(cache.key(req(), ENGINE)).toBe(k);
  expect(cache.key(req({ slot: 'file:n1:a.tex', known: [{ label: 'a', number: '1', page: '1', anchor: 'equation.1' }] }), ENGINE)).toBe(k);
  // The resources count by name, whatever their order.
  expect(cache.key(req({ resources: [...req().resources].reverse() }), ENGINE)).toBe(k);
  for (const other of [
    req({ source: 'Bonjour $x^2$. ' }), req({ preamble: `${DEFAULT_PREAMBLE}%` }), req({ mode: 'page' }), req({ refs: [{ label: 'mdl', title: 'MDL ', node: 'n2' }] }),
    req({ broken: [] }), req({ doubled: [{ label: 'd', title: 'D', node: null }] }), req({ cites: [] }), req({ unknownCites: ['x'] }),
    req({ doubledCites: [{ key: 'li2008', text: 'Li et Vitányi, 2008', node: 'n3' }] }),
    req({ resources: [{ name: 'a.png', hash: 'c'.repeat(64), size: 2 }] }),
  ]) expect(cache.key(other, ENGINE)).not.toBe(k);
  expect(cache.key(req(), `${ENGINE}x`)).not.toBe(k);
  // The request's width (final review, M1), in snippet mode only; a standalone document ignores the preamble.
  expect(cache.key(req({ widthCm: 9.5 }), ENGINE)).not.toBe(k);
  expect(cache.key(req({ mode: 'page', widthCm: null }), ENGINE)).toBe(cache.key(req({ mode: 'page', widthCm: 12 }), ENGINE));
  const doc = req({ source: '\\documentclass{article}\\begin{document}x\\end{document}' });
  expect(cache.key({ ...doc, preamble: 'autre' }, ENGINE)).toBe(cache.key(doc, ENGINE));
});

/** A fake compiled PDF of `n` bytes in the work folder, as pdfLaTeX leaves it. */
function compiled(name: string, n: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(n, 1));
  return p;
}
const meta = { pages: 2, labels: [{ label: 'a', number: '1', page: '1', anchor: 'equation.1' }], log: 'journal', passes: 2 };

test('PdfCache : put déplace le PDF, get le rend avec ses labels, son journal et ses passes', () => {
  const cache = new PdfCache(cacheDir, () => 2 ** 30);
  const key = 'a'.repeat(64);
  expect(cache.get(key)).toBeNull();
  const src = compiled('job-1.pdf', 100);
  expect(cache.put(key, src, meta)).toEqual({ key, size: 100, pages: 2 });
  expect(existsSync(src)).toBe(false);
  expect(cache.get(key)).toEqual({ pdf: { key, size: 100, pages: 2 }, labels: meta.labels, log: 'journal', passes: 2 });
  // A PDF without its description, or a description without its PDF, is a miss, and goes.
  rmSync(join(cacheDir, `${key}.json`));
  expect(cache.get(key)).toBeNull();
  expect(readdirSync(cacheDir)).toEqual([]);
  cache.put(key, compiled('job-2.pdf', 10), meta);
  rmSync(join(cacheDir, `${key}.pdf`));
  expect(cache.get(key)).toBeNull();
  expect(readdirSync(cacheDir)).toEqual([]);
  // A description that does not parse is a miss too.
  cache.put(key, compiled('job-3.pdf', 10), meta);
  writeFileSync(join(cacheDir, `${key}.json`), '{');
  expect(cache.get(key)).toBeNull();
  expect(cache.get('pas une clé')).toBeNull();
});

test('PdfCache.trim : au-delà du plafond, le plus ancien part le premier ; une lecture rajeunit ; l’ordre passe à la session suivante', async () => {
  let max = 10_000;
  const files = (...keys: string[]) => keys.flatMap((k) => [`${k}.json`, `${k}.pdf`]);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
  const cache = new PdfCache(cacheDir, () => max);
  for (const [i, k] of [a, b, c].entries()) cache.put(k, compiled(`job-${i}.pdf`, 3000), meta);
  // a is read: now the one used last, and b the one used longest ago.
  expect(cache.get(a)).not.toBeNull();
  max = 7000;
  cache.trim();
  // The entries leave at once; their files, in the background.
  await cache.settled();
  expect(readdirSync(cacheDir).sort()).toEqual(files(a, c));
  // Another session lists the folder: the PDFs' dates give the order (a read refreshes its PDF's date); listed, the
  // cache is trimmed if a lower ceiling now applies.
  const t = Date.now() / 1000;
  utimesSync(join(cacheDir, `${a}.pdf`), t - 50, t - 50);
  utimesSync(join(cacheDir, `${c}.pdf`), t - 100, t - 100);
  max = 4000;
  const next = new PdfCache(cacheDir, () => max);
  await next.load();
  await next.settled();
  expect(readdirSync(cacheDir).sort()).toEqual(files(a));
  // The PDF just put stays, even alone over the ceiling.
  max = 100;
  next.put(d, compiled('job-9.pdf', 3000), meta);
  await next.settled();
  expect(readdirSync(cacheDir).sort()).toEqual(files(d));
  expect(next.get(d)).not.toBeNull();
});

test('PdfCache.has : ni l’ordre du cache ni la date du PDF ne changent (plan 5b, D1)', async () => {
  let max = 10_000;
  const files = (...keys: string[]) => keys.flatMap((k) => [`${k}.json`, `${k}.pdf`]);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
  const cache = new PdfCache(cacheDir, () => max);
  for (const [i, k] of [a, b, c].entries()) cache.put(k, compiled(`job-${i}.pdf`, 3000), meta);
  const old = new Date(2020, 0, 1);
  utimesSync(join(cacheDir, `${a}.pdf`), old, old);
  expect([a, b, c, d, 'pas une clé'].map((k) => cache.has(k))).toEqual([true, true, true, false, false]);
  expect(statSync(join(cacheDir, `${a}.pdf`)).mtimeMs).toBe(old.getTime());
  // a is still the one used longest ago: the first to go (a get would have kept it).
  max = 7000;
  cache.trim();
  await cache.settled();
  expect(readdirSync(cacheDir).sort()).toEqual(files(b, c));
  // Before the folder is listed, its files answer.
  const next = new PdfCache(cacheDir, () => 2 ** 30);
  expect([a, b, c].map((k) => next.has(k))).toEqual([false, true, true]);
});

/** `n` entries written straight into the cache folder, as an earlier session left them, the first the oldest. */
function earlier(n: number, pdfBytes = 10): string[] {
  mkdirSync(cacheDir, { recursive: true });
  const t = Date.now() / 1000;
  return Array.from({ length: n }, (_, i) => {
    const key = createHash('sha256').update(String(i)).digest('hex');
    writeFileSync(join(cacheDir, `${key}.pdf`), Buffer.alloc(pdfBytes, 1));
    writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify(meta));
    utimesSync(join(cacheDir, `${key}.pdf`), t - 10_000 + i, t - 10_000 + i);
    return key;
  });
}

test('PdfCache : avant que l’index soit prêt, get trouve une entrée par sa seule clé, sans lister le dossier ; load() le liste ensuite, en lots (revue finale, I3)', async () => {
  const keys = earlier(2000);
  const stray = join(cacheDir, 'intrus.txt'), orphan = join(cacheDir, `${'c'.repeat(64)}.pdf`);
  writeFileSync(stray, 'x');
  writeFileSync(orphan, 'x');
  const cache = new PdfCache(cacheDir, () => 2 ** 30);
  // A first get of the session: the folder is not listed (the stray file is still there), the entry is found by its key.
  expect(cache.get(keys[1234])).toEqual({ pdf: { key: keys[1234], size: 10, pages: 2 }, labels: meta.labels, log: 'journal', passes: 2 });
  expect(cache.get('d'.repeat(64))).toBeNull();
  expect(existsSync(stray)).toBe(true);
  const loading = cache.load();
  // A put while the folder is listed is kept, and counted once.
  cache.put('e'.repeat(64), compiled('job-1.pdf', 10), meta);
  await loading;
  // Listed: what is not an entry, and a PDF without its description, are gone; every entry is counted once.
  expect(existsSync(stray)).toBe(false);
  expect(existsSync(orphan)).toBe(false);
  const entry = 10 + Buffer.byteLength(JSON.stringify(meta));
  expect(cache.bytes).toBe(2001 * entry);
  expect(cache.get(keys[0])).not.toBeNull();
  expect(cache.get('e'.repeat(64))).not.toBeNull();
  // A key the listing does not know is a miss, without touching the disk.
  expect(cache.get('d'.repeat(64))).toBeNull();
  // load() once a session: called again, the same listing.
  expect(cache.load()).toBe(cache.load());
});

test('PdfCache.trim : au-delà du plafond, ramené au seuil bas, le plus ancien d’abord, ses fichiers effacés en arrière-plan ; les put suivants, sous le plafond, n’effacent rien et ne trient rien (revue finale, I3)', async () => {
  const keys = earlier(10, 1000);
  const entry = 1000 + Buffer.byteLength(JSON.stringify(meta));
  // The ceiling holds exactly the ten; trimmed, down to seven of them (the low-water mark, 70 %).
  const cache = new PdfCache(cacheDir, () => 10 * entry, () => 7 * entry);
  // Read at the start of the session: the oldest entry is now the one used last.
  expect(cache.get(keys[0])).not.toBeNull();
  await cache.load();
  expect(cache.bytes).toBe(10 * entry);
  const left = (k: string) => existsSync(join(cacheDir, `${k}.pdf`));
  const sort = vi.spyOn(Array.prototype, 'sort');
  // Over the ceiling: down to seven, the four used longest ago going (keys 1 to 4; key 0 was read), never the one just put.
  cache.put('f'.repeat(64), compiled('job-1.pdf', 1000), meta);
  const afterTrim = cache.bytes;
  // Key 1 compiled again before its files are deleted: kept. It and the next two stay under the ceiling, which they
  // reach: nothing goes.
  cache.put(keys[1], compiled('job-2.pdf', 1000), meta);
  for (const [i, k] of ['a', 'b'].entries()) cache.put(k.repeat(64), compiled(`job-${i + 3}.pdf`, 1000), meta);
  const sorts = sort.mock.calls.length;
  sort.mockRestore();
  await cache.settled();
  expect(afterTrim).toBe(7 * entry);
  expect(cache.bytes).toBe(10 * entry);
  expect(keys.map(left)).toEqual([true, true, false, false, false, true, true, true, true, true]);
  expect(['f', 'a', 'b'].map((k) => left(k.repeat(64)))).toEqual([true, true, true]);
  expect(cache.get(keys[1])).not.toBeNull();
  // The order is kept as the entries are used: trimming sorts nothing.
  expect(sorts).toBe(0);
});

test('latexRequest : 200, 206, 400 pour une clé invalide, 404 pour une clé absente', () => {
  mkdirSync(cacheDir, { recursive: true });
  const key = 'e'.repeat(64);
  writeFileSync(join(cacheDir, `${key}.pdf`), Buffer.alloc(1000, 7));
  const url = `${FILE_SCHEME}://latex/${key}/r%C3%A9sum%C3%A9.pdf`;
  expect(latexRequest(cacheDir, url, null)).toEqual({
    status: 200, path: join(cacheDir, `${key}.pdf`), start: 0, end: 999,
    headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '1000', 'Content-Type': 'application/pdf', 'Content-Security-Policy': 'sandbox' },
  });
  expect(latexRequest(cacheDir, url, 'bytes=10-19')).toEqual({
    status: 206, path: join(cacheDir, `${key}.pdf`), start: 10, end: 19,
    headers: {
      'Accept-Ranges': 'bytes', 'Content-Length': '10', 'Content-Range': 'bytes 10-19/1000', 'Content-Type': 'application/pdf', 'Content-Security-Policy': 'sandbox',
    },
  });
  expect(latexRequest(cacheDir, url, 'bytes=2000-')).toMatchObject({ status: 416, headers: { 'Content-Range': 'bytes */1000' } });
  for (const bad of [
    `${FILE_SCHEME}://latex/${key.slice(1)}/x.pdf`, `${FILE_SCHEME}://latex/${key.toUpperCase()}/x.pdf`, `${FILE_SCHEME}://latex/${key}`,
    `${FILE_SCHEME}://latex/../${key}/x.pdf`, `${FILE_SCHEME}://latex/${key}/a/b.pdf`, `${FILE_SCHEME}://blob/${key}/x.pdf`,
    `${FILE_SCHEME}://latex/${key}/%E0%A4%A.pdf`, `${FILE_SCHEME}://latex\\${key}/x.pdf`,
  ]) expect(latexRequest(cacheDir, bad, null).status, bad).toBe(400);
  expect(latexRequest(cacheDir, `${FILE_SCHEME}://latex/${'f'.repeat(64)}/x.pdf`, null).status).toBe(404);
});
