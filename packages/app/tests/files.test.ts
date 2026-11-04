import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { FileRef } from '@cirrus/core';
import { type ChangeRow, filePath, importFile } from '@cirrus/store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  blobRequest, blobResponse, cleanCopies, contentTypeOf, FILE_SCHEME, historySummary, importPaths, isRunnable, openableCopy,
} from '../src/main/files.ts';

let dir: string, store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-app-files-'));
  store = join(dir, 'base');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

/** A file of `bytes` written under the temporary folder, then imported into the store. */
function stored(name: string, bytes: Uint8Array): FileRef {
  const src = join(dir, name);
  writeFileSync(src, bytes);
  return importFile(store, src);
}
const counting = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const urlOf = (ref: FileRef) => `${FILE_SCHEME}://blob/${ref.hash}/${encodeURIComponent(ref.name)}`;

test('blobRequest : le fichier entier, avec son type et sa taille', () => {
  const ref = stored('figure.png', counting(1000));
  // Sandboxed: a served SVG or HTML that became a document (the window navigating to it) runs no script.
  expect(blobRequest(store, urlOf(ref), null)).toEqual({
    status: 200, path: filePath(store, ref), start: 0, end: 999,
    headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '1000', 'Content-Type': 'image/png', 'Content-Security-Policy': 'sandbox' },
  });
  // The name only gives the type: an accented one, encoded, is read back.
  const pdf = stored('Résumé (v2) l’été #1.pdf', counting(10));
  expect(blobRequest(store, urlOf(pdf), null)).toMatchObject({ status: 200, headers: { 'Content-Type': 'application/pdf' } });
  // A query or a fragment reaches the handler (Chromium keeps them): not part of the name.
  expect(blobRequest(store, `${urlOf(ref)}?x=1#page=2`, null)).toMatchObject({ status: 200, headers: { 'Content-Type': 'image/png' } });
});

test('blobRequest : les trois formes de plage donnent 206, la fin incluse', () => {
  const ref = stored('a.bin', counting(1000));
  const url = urlOf(ref);
  expect(blobRequest(store, url, 'bytes=10-19')).toEqual({
    status: 206, path: filePath(store, ref), start: 10, end: 19,
    headers: {
      'Accept-Ranges': 'bytes', 'Content-Length': '10', 'Content-Range': 'bytes 10-19/1000', 'Content-Type': 'application/octet-stream',
      'Content-Security-Policy': 'sandbox',
    },
  });
  expect(blobRequest(store, url, 'bytes=990-')).toMatchObject({ status: 206, start: 990, end: 999, headers: { 'Content-Range': 'bytes 990-999/1000', 'Content-Length': '10' } });
  expect(blobRequest(store, url, 'bytes=-10')).toMatchObject({ status: 206, start: 990, end: 999, headers: { 'Content-Range': 'bytes 990-999/1000' } });
  // A last byte past the end is the end; a suffix longer than the file is the whole file.
  expect(blobRequest(store, url, 'bytes=995-5000')).toMatchObject({ status: 206, start: 995, end: 999, headers: { 'Content-Length': '5' } });
  expect(blobRequest(store, url, 'bytes=-5000')).toMatchObject({ status: 206, start: 0, end: 999 });
  // Not understood (several ranges, reversed, another unit): ignored, the whole file (RFC 9110, 14.2).
  for (const range of ['bytes=0-1,5-6', 'bytes=9-3', 'items=0-1', 'bytes=-']) {
    expect(blobRequest(store, url, range)).toMatchObject({ status: 200, start: 0, end: 999 });
  }
});

test('blobRequest : 416 au-delà de la taille, 404 pour une empreinte valide mais absente', () => {
  const ref = stored('a.bin', counting(1000));
  for (const range of ['bytes=1000-', 'bytes=2000-3000', 'bytes=-0']) {
    expect(blobRequest(store, urlOf(ref), range)).toEqual({
      status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '0', 'Content-Range': 'bytes */1000' },
    });
  }
  const empty = stored('vide.txt', new Uint8Array(0));
  expect(blobRequest(store, urlOf(empty), null)).toMatchObject({ status: 200, start: 0, end: -1, headers: { 'Content-Length': '0' } });
  expect(blobRequest(store, urlOf(empty), 'bytes=0-')).toMatchObject({ status: 416 });
  expect(blobRequest(store, urlOf({ ...ref, hash: 'f'.repeat(64) }), null)).toEqual({
    status: 404, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '0' },
  });
});

test('blobRequest : 400 pour « .. », une empreinte trop courte, des majuscules ou une barre oblique inverse', () => {
  const ref = stored('a.png', counting(10));
  const h = ref.hash, bs = win32.sep;
  const bad = [
    `${FILE_SCHEME}://blob/../${h}/a.png`,
    `${FILE_SCHEME}://blob/${h}/../${h}/a.png`,
    `${FILE_SCHEME}://blob/..`,
    `${FILE_SCHEME}://blob/%2e%2e/a.png`,
    `${FILE_SCHEME}://blob/${h.slice(0, 63)}/a.png`,
    `${FILE_SCHEME}://blob/${h.toUpperCase()}/a.png`,
    `${FILE_SCHEME}://blob/${h.slice(0, 2)}${bs}${h}/a.png`,
    `${FILE_SCHEME}://blob/${h}/..${bs}a.png`,
    `${FILE_SCHEME}://blob${bs}${h}${bs}a.png`,
    `${FILE_SCHEME}://blob/${h}`,
    `${FILE_SCHEME}://blob/${h}/`,
    `${FILE_SCHEME}://blob/${h}/%E0%A4%A.png`,
    `${FILE_SCHEME}://autre/${h}/a.png`,
    `file:///${filePath(store, ref)}`,
  ];
  for (const url of bad) expect(blobRequest(store, url, null), url).toEqual({ status: 400, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '0' } });
});

test('blobResponse : les octets de la plage, et un fichier vide sans corps', async () => {
  const ref = stored('a.bin', counting(1000));
  const ranged = blobResponse(store, new Request(urlOf(ref), { headers: { Range: 'bytes=10-19' } }));
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get('content-range')).toBe('bytes 10-19/1000');
  expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(counting(1000).subarray(10, 20));
  const whole = blobResponse(store, new Request(urlOf(ref)));
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(counting(1000));
  const empty = blobResponse(store, new Request(urlOf(stored('vide.txt', new Uint8Array(0)))));
  expect(empty.status).toBe(200);
  expect((await empty.arrayBuffer()).byteLength).toBe(0);
  expect(blobResponse(store, new Request(`${FILE_SCHEME}://blob/${'0'.repeat(64)}/a.bin`)).status).toBe(404);
});

test('contentTypeOf : les images de la tâche 2, le PDF, sinon des octets', () => {
  const types: [string, string][] = [
    ['a.png', 'image/png'], ['a.JPG', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp'],
    ['a.bmp', 'image/bmp'], ['a.svg', 'image/svg+xml'], ['a.avif', 'image/avif'], ['a.ico', 'image/x-icon'], ['article.Pdf', 'application/pdf'],
    ['notes.txt', 'application/octet-stream'], ['mesures.csv', 'application/octet-stream'], ['Makefile', 'application/octet-stream'],
  ];
  for (const [name, type] of types) expect(contentTypeOf(name), name).toBe(type);
});

test('importPaths : un fichier accentué importé ; un dossier, un fichier trop gros et un chemin absent refusés avec leur raison', () => {
  const maxBytes = 2 ** 20;
  const accented = join(dir, 'Énoncé détaillé.tex');
  writeFileSync(accented, 'Soit $x$ une suite.');
  mkdirSync(join(dir, 'dossier'));
  writeFileSync(join(dir, 'gros.bin'), new Uint8Array(maxBytes + 1));
  // Exactly the limit is accepted.
  writeFileSync(join(dir, 'juste.bin'), new Uint8Array(maxBytes));
  const r = importPaths(store, [accented, join(dir, 'dossier'), join(dir, 'gros.bin'), join(dir, 'absent.txt'), join(dir, 'juste.bin')], maxBytes);
  expect(r.refused).toEqual([
    { name: 'dossier', reason: 'c’est un dossier' },
    { name: 'gros.bin', reason: 'plus de 1 Mo' },
    { name: 'absent.txt', reason: 'introuvable' },
  ]);
  expect(r.refs.map((f) => [f.name, f.size])).toEqual([['Énoncé détaillé.tex', 19], ['juste.bin', maxBytes]]);
  expect(readFileSync(filePath(store, r.refs[0]), 'utf8')).toBe('Soit $x$ une suite.');
  // Under the default limit, the same file goes in.
  expect(importPaths(store, [join(dir, 'gros.bin')], 200 * 2 ** 20)).toMatchObject({ refs: [{ name: 'gros.bin', size: maxBytes + 1 }], refused: [] });
});

test('isRunnable : scripts, exécutables et raccourcis, quelle que soit la casse (Review Focus 3)', () => {
  for (const name of ['Script.PY', 'a.ps1', 'raccourci.lnk', 'setup.exe', 'x.appref-ms', 'tâche.bat', 'a.js']) expect(isRunnable(name), name).toBe(true);
  // Windows drops trailing dots and spaces (« a.bat. » opens as « a.bat »), and « .lnk » alone has the extension .lnk.
  for (const name of ['a.bat.', 'a.cmd ', 'a.vbs. .', '.lnk']) expect(isRunnable(name), name).toBe(true);
  for (const name of ['notes.txt', 'figure.png', 'article.pdf', 'Makefile', 'py', 'a.python', 'a.py.txt']) expect(isRunnable(name), name).toBe(false);
});

test('openableCopy : même contenu, même nom, en lecture seule, réutilisée au second appel', () => {
  const ref = stored('Présentation finale.pptx', counting(5000));
  const root = join(dir, 'ouverts');
  const p = openableCopy(store, ref, root);
  expect(p).toBe(join(root, ref.hash.slice(0, 16), 'Présentation finale.pptx'));
  expect(readFileSync(p)).toEqual(readFileSync(filePath(store, ref)));
  expect(statSync(p).mode & 0o200).toBe(0);
  expect(openableCopy(store, ref, root)).toBe(p);
  // Nothing left over beside it (the copy is written to a temporary name, then renamed).
  expect(readdirSync(join(root, ref.hash.slice(0, 16)))).toEqual(['Présentation finale.pptx']);
  // The same content under another name: a second copy, beside the first.
  const other = openableCopy(store, { ...ref, name: 'copie.pptx' }, root);
  expect(readdirSync(join(root, ref.hash.slice(0, 16))).sort()).toEqual(['Présentation finale.pptx', 'copie.pptx'].sort());
  expect(statSync(other).mode & 0o200).toBe(0);
});

test('openableCopy : un nom ou une empreinte qui sortirait du dossier des copies est refusé', () => {
  const ref = stored('a.txt', counting(10));
  const root = join(dir, 'ouverts');
  const bs = win32.sep;
  for (const name of ['..', '.', '', `..${bs}..${bs}a.bat`, '../a.bat', 'a.txt:flux', 'a.txt.', 'CON', 'nul.txt', 'a?.txt']) {
    expect(() => openableCopy(store, { ...ref, name }, root), name).toThrow();
  }
  expect(() => openableCopy(store, { ...ref, hash: `..${bs}${ref.hash.slice(3)}` }, root)).toThrow();
  expect(existsSync(join(dir, 'a.bat'))).toBe(false);
  // A blob missing from the store: refused too, with nothing left in the copies.
  expect(() => openableCopy(store, { ...ref, hash: 'e'.repeat(64) }, root)).toThrow();
  expect(existsSync(join(root, 'e'.repeat(16))) ? readdirSync(join(root, 'e'.repeat(16))) : []).toEqual([]);
});

test('cleanCopies : efface les copies en lecture seule et leurs dossiers ; un dossier absent ne fait rien', () => {
  const root = join(dir, 'ouverts');
  cleanCopies(root);
  const a = openableCopy(store, stored('a.pdf', counting(10)), root);
  const b = openableCopy(store, stored('b.py', counting(20)), root);
  expect(statSync(a).mode & 0o200).toBe(0);
  cleanCopies(root);
  expect(existsSync(a) || existsSync(b)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});

/** A journal line of `actionId`, written at `at`. */
const row = (actionId: string, at: number, localSeq: number): ChangeRow => ({
  localSeq, serverSeq: null, actionId, label: 'Modifier', flow: 'content', at, pc: 'pc1', subject: 'n1',
  op: { t: 'node', id: 'n1', before: null, after: null },
} as unknown as ChangeRow);

test('historySummary : création, dernière modification et nombre d’actions distinctes', () => {
  expect(historySummary([row('a1', 2000, 1), row('a1', 1000, 2), row('a2', 5000, 3)])).toEqual({ created: 1000, modified: 5000, changes: 2 });
  expect(historySummary([])).toEqual({ created: null, modified: null, changes: 0 });
});
