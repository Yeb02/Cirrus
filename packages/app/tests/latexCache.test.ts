import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CompileRequest, DEFAULT_PREAMBLE } from '@cirrus/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
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
  unknownCites: [], known: [], resources: [{ name: 'b.png', hash: 'b'.repeat(64), size: 3 }, { name: 'a.png', hash: 'a'.repeat(64), size: 2 }], ...over,
});
const ENGINE = 'pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)';

test('PdfCache.key : la même requête donne la même clé ; ni l’emplacement ni les labels connus ne la changent ; un octet de plus, si', () => {
  const cache = new PdfCache(cacheDir, () => 2 ** 30);
  const k = cache.key(req(), ENGINE, 9);
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(cache.key(req(), ENGINE, 9)).toBe(k);
  expect(cache.key(req({ slot: 'file:n1:a.tex', known: [{ label: 'a', number: '1', page: '1', anchor: 'equation.1' }] }), ENGINE, 9)).toBe(k);
  // The resources count by name, whatever their order.
  expect(cache.key(req({ resources: [...req().resources].reverse() }), ENGINE, 9)).toBe(k);
  for (const other of [
    req({ source: 'Bonjour $x^2$. ' }), req({ preamble: `${DEFAULT_PREAMBLE}%` }), req({ mode: 'page' }), req({ refs: [{ label: 'mdl', title: 'MDL ', node: 'n2' }] }),
    req({ broken: [] }), req({ doubled: [{ label: 'd', title: 'D', node: null }] }), req({ cites: [] }), req({ unknownCites: ['x'] }),
    req({ resources: [{ name: 'a.png', hash: 'c'.repeat(64), size: 2 }] }),
  ]) expect(cache.key(other, ENGINE, 9)).not.toBe(k);
  expect(cache.key(req(), `${ENGINE}x`, 9)).not.toBe(k);
  expect(cache.key(req(), ENGINE, 9.5)).not.toBe(k);
  // The snippet width only counts in snippet mode; a standalone document ignores the preamble.
  expect(cache.key(req({ mode: 'page' }), ENGINE, 9)).toBe(cache.key(req({ mode: 'page' }), ENGINE, 12));
  const doc = req({ source: '\\documentclass{article}\\begin{document}x\\end{document}' });
  expect(cache.key({ ...doc, preamble: 'autre' }, ENGINE, 9)).toBe(cache.key(doc, ENGINE, 9));
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

test('PdfCache.trim : au-delà du plafond, le plus ancien part le premier ; une lecture rajeunit ; l’ordre passe à la session suivante', () => {
  let max = 10_000;
  const files = (...keys: string[]) => keys.flatMap((k) => [`${k}.json`, `${k}.pdf`]);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
  const cache = new PdfCache(cacheDir, () => max);
  for (const [i, k] of [a, b, c].entries()) cache.put(k, compiled(`job-${i}.pdf`, 3000), meta);
  // a is read: now the one used last, and b the one used longest ago.
  expect(cache.get(a)).not.toBeNull();
  max = 7000;
  cache.trim();
  expect(readdirSync(cacheDir).sort()).toEqual(files(a, c));
  // Another session lists the folder: the PDFs' dates give the order (a read refreshes its PDF's date).
  const t = Date.now() / 1000;
  utimesSync(join(cacheDir, `${a}.pdf`), t - 50, t - 50);
  utimesSync(join(cacheDir, `${c}.pdf`), t - 100, t - 100);
  max = 4000;
  const next = new PdfCache(cacheDir, () => max);
  next.trim();
  expect(readdirSync(cacheDir).sort()).toEqual(files(a));
  // The PDF just put stays, even alone over the ceiling.
  max = 100;
  next.put(d, compiled('job-9.pdf', 3000), meta);
  expect(readdirSync(cacheDir).sort()).toEqual(files(d));
  expect(next.get(d)).not.toBeNull();
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
