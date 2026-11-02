import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filePath, importFile } from '../src/files.ts';

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
