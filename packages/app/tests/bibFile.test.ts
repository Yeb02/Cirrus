import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIB_MAX_BYTES } from '@cirrus/core';
import { filePath } from '@cirrus/store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bibPickOf, readBib } from '../src/main/bib.ts';
import { STORE_TEXTS_MAX, storeTexts } from '../src/main/files.ts';

let dir: string, store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-bib-main-'));
  store = join(dir, 'base');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('readBib : les octets d’un .bib du disque ; un dossier, un chemin réseau, un fichier absent ou trop grand refusés en français ; jamais lu au-delà du plafond', () => {
  const path = join(dir, 'bibliographie.bib'), bytes = new TextEncoder().encode('@misc{a, title = {Vitányi}}\n');
  writeFileSync(path, bytes);
  const r = readBib(path);
  expect(r).toEqual({ name: 'bibliographie.bib', bytes: new Uint8Array(bytes) });
  // The bytes only: their buffer is not a pool another read shares (they cross the IPC whole).
  expect('bytes' in r && r.bytes.buffer.byteLength).toBeLessThanOrEqual(bytes.length + 1);
  expect(readBib(path, bytes.length)).toEqual(r);
  expect(readBib(path, bytes.length - 1)).toEqual({ refused: `« bibliographie.bib » fait plus de ${((bytes.length - 1) / 2 ** 20).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo : un .bib de cette taille n’est pas lu.` });
  // The bound by default: what no text of BIB_MAX_CHARS characters can exceed, whatever its encoding.
  expect(readBib(path)).toEqual(r);
  expect(BIB_MAX_BYTES / 2 ** 20).toBeCloseTo(32, 3);
  const folder = join(dir, 'dossier.bib');
  mkdirSync(folder);
  expect(readBib(folder)).toEqual({ refused: '« dossier.bib » est un dossier : rien n’est importé.' });
  expect(readBib(join(dir, 'absent.bib'))).toEqual({ refused: '« absent.bib » est introuvable : rien n’est importé.' });
  expect(readBib('\\\\serveur\\partage\\refs.bib')).toEqual({ refused: '« refs.bib » est sur un chemin réseau ou de périphérique : il n’est pas lu.' });
  expect(readBib('//serveur/partage/refs.bib')).toEqual({ refused: '« refs.bib » est sur un chemin réseau ou de périphérique : il n’est pas lu.' });
  for (const bad of [undefined, 3, '', ['a.bib'], { path }]) expect(readBib(bad), JSON.stringify(bad)).toEqual({ refused: 'Lecture refusée : chemin invalide.' });
  // A name taken from the disk is cut in the message.
  const long = join(dir, `${'n'.repeat(150)}.bib`);
  expect(readBib(long)).toEqual({ refused: `« ${'n'.repeat(80)}… » est introuvable : rien n’est importé.` });
});

test('bibPickOf : le .bib que « Importer un fichier .bib… » prend sans le sélecteur, seulement sur une base de test en arrière-plan ou en capture', () => {
  const env = { CIRRUS_BIB_PICK: 'D:\\essai.bib', CIRRUS_DATA: 'D:\\base-de-test' };
  expect(bibPickOf({ ...env, CIRRUS_BACKGROUND: '1' }, false)).toBe('D:\\essai.bib');
  expect(bibPickOf(env, true)).toBe('D:\\essai.bib');
  // Never on the user's own base, nor in a window in front.
  expect(bibPickOf({ CIRRUS_BIB_PICK: 'D:\\essai.bib', CIRRUS_BACKGROUND: '1' }, true)).toBeNull();
  expect(bibPickOf(env, false)).toBeNull();
  expect(bibPickOf({ CIRRUS_DATA: 'D:\\base-de-test', CIRRUS_BACKGROUND: '1' }, true)).toBeNull();
});

test('storeTexts : des textes enregistrés en UTF-8 sans BOM, plusieurs à la fois, dans l’ordre ; une liste ou un texte refusé l’est en français, avant toute écriture', async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `k${i}.bib`, text: `${i === 0 ? '\uFEFF' : ''}@misc{k${i}, title = {Vitányi ${i % 25}}}\n` }));
  const refs = await storeTexts(store, items, 1000);
  expect(refs.map((r) => r.name)).toEqual(items.map((x) => x.name));
  refs.forEach((r, i) => {
    const bytes = Buffer.from(items[i].text.replace(/^\uFEFF/, ''), 'utf8');
    expect(r).toEqual({ name: items[i].name, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    expect(readFileSync(filePath(store, r))).toEqual(bytes);
  });
  const nothing = join(dir, 'vide');
  const refused: [unknown, string][] = [
    [null, 'Enregistrement refusé : liste de textes invalide.'],
    [Array.from({ length: STORE_TEXTS_MAX + 1 }, (_, i) => ({ name: `k${i}.bib`, text: '' })), 'Enregistrement refusé : liste de textes invalide.'],
    [[{ name: 'a.bib', text: 'x' }, { name: 'b.bib', text: 3 }], 'Enregistrement refusé : nom ou texte invalide.'],
    [[{ name: 'a.bib', text: 'x' }, 'b.bib'], 'Enregistrement refusé : nom ou texte invalide.'],
    [[{ name: 'a.bib', text: 'x' }, { name: '../b.bib', text: 'y' }], 'Le caractère « / » n’est pas permis dans un nom de fichier.'],
    [[{ name: 'a.bib', text: 'x' }, { name: 'b.bib', text: 'y'.repeat(2000) }], 'Le texte fait plus de 0 Mo : il n’est pas enregistré.'],
    [[{ name: 'a.bib', text: 'x'.repeat(600) }, { name: 'b.bib', text: 'y'.repeat(600) }], 'Les textes font plus de 0 Mo ensemble : ils ne sont pas enregistrés.'],
  ];
  for (const [bad, message] of refused) {
    await expect(storeTexts(nothing, bad, 1000), message).rejects.toThrow(message);
    expect(existsSync(join(nothing, 'files')), message).toBe(false);
  }
  expect(STORE_TEXTS_MAX).toBe(1000);
});
