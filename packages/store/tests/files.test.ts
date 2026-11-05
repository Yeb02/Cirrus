import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filePath, importFile, storeBytes } from '../src/files.ts';

let dir: string;
let storeDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-files-'));
  storeDir = join(dir, 'store');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Every blob under files/, temporaries excluded. */
const blobs = () => readdirSync(join(storeDir, 'files'), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.startsWith('.'));

test("importer copie le fichier ; modifier l'original n'affecte pas la copie", () => {
  const src = join(dir, 'notes.txt');
  writeFileSync(src, 'version 1');
  const ref = importFile(storeDir, src);
  expect(ref.size).toBe(9);
  expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(src, 'version 2, modifiée');
  expect(readFileSync(filePath(storeDir, ref), 'utf8')).toBe('version 1');
});

test('même contenu sous deux noms : une copie, deux références (Review Focus 3)', () => {
  const a = join(dir, 'a.py'), b = join(dir, 'b.py');
  writeFileSync(a, 'print(42)\n');
  writeFileSync(b, 'print(42)\n');
  const ra = importFile(storeDir, a), rb = importFile(storeDir, b);
  expect(ra.hash).toBe(rb.hash);
  expect([ra.name, rb.name]).toEqual(['a.py', 'b.py']);
  expect(blobs()).toHaveLength(1);
});

test("nom accentué conservé à l'affichage, nom neutre sur disque (Review Focus 3)", () => {
  const src = join(dir, 'Enoncé_détaillé.tex');
  writeFileSync(src, '\\section{MDL}');
  const ref = importFile(storeDir, src);
  expect(ref.name).toBe('Enoncé_détaillé.tex');
  const rel = filePath(storeDir, ref).slice(storeDir.length);
  expect(rel).toMatch(/^[0-9a-f/\\:.A-Za-z_-]+$/);
  expect(readFileSync(filePath(storeDir, ref), 'utf8')).toBe('\\section{MDL}');
});

test('storeBytes : l’empreinte et la taille justes ; le même contenu une seconde fois ne crée pas de doublon (plan 4b, tâche 5)', () => {
  const bytes = new TextEncoder().encode('\\section{Complexité}\n');
  const ref = storeBytes(storeDir, 'complexité.tex', bytes);
  expect(ref).toEqual({ name: 'complexité.tex', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  expect(new Uint8Array(readFileSync(filePath(storeDir, ref)))).toEqual(bytes);
  expect(storeBytes(storeDir, 'autre.tex', bytes)).toEqual({ ...ref, name: 'autre.tex' });
  // One blob, no temporary left; the same content as a file imported is that blob too.
  expect(blobs()).toHaveLength(1);
  expect(readdirSync(join(storeDir, 'files'), { recursive: true }).filter((n) => String(n).includes('.import-'))).toEqual([]);
  const src = join(dir, 'copie.tex');
  writeFileSync(src, bytes);
  expect(importFile(storeDir, src).hash).toBe(ref.hash);
  expect(blobs()).toHaveLength(1);
  // Empty: a blob too.
  expect(storeBytes(storeDir, 'vide.tex', new Uint8Array(0))).toMatchObject({ size: 0, hash: createHash('sha256').digest('hex') });
});
