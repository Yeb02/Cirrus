import { expect, test } from 'vitest';
import { bibPickOf } from '../src/main/bib.ts';
import { freeBytesOf, pdfPickOf } from '../src/main/pick.ts';

// « Choisir un PDF… » (plan 5b, D5) takes CIRRUS_PDF_PICK instead of opening the system's dialog, as « Importer un
// fichier .bib… » takes CIRRUS_BIB_PICK: only on a test base in a window out of the user's way.
test('pdfPickOf : le PDF que « Choisir un PDF… » prend sans le sélecteur, seulement sur une base de test en arrière-plan ou en capture', () => {
  const env = { CIRRUS_PDF_PICK: 'D:\\essai.pdf', CIRRUS_DATA: 'D:\\base-de-test' };
  expect(pdfPickOf({ ...env, CIRRUS_BACKGROUND: '1' }, false)).toBe('D:\\essai.pdf');
  expect(pdfPickOf(env, true)).toBe('D:\\essai.pdf');
  // Never on the user's own base (no CIRRUS_DATA), nor in a window in front of the user's work.
  expect(pdfPickOf({ CIRRUS_PDF_PICK: 'D:\\essai.pdf', CIRRUS_BACKGROUND: '1' }, true)).toBeNull();
  expect(pdfPickOf(env, false)).toBeNull();
  expect(pdfPickOf({ ...env, CIRRUS_BACKGROUND: '0' }, false)).toBeNull();
  expect(pdfPickOf({ CIRRUS_DATA: 'D:\\base-de-test', CIRRUS_BACKGROUND: '1' }, true)).toBeNull();
  expect(pdfPickOf({ ...env, CIRRUS_PDF_PICK: '' }, true)).toBeNull();
  // The .bib's variable is not the PDF's, nor the PDF's the .bib's.
  expect(pdfPickOf({ CIRRUS_BIB_PICK: 'D:\\essai.bib', CIRRUS_DATA: 'D:\\base-de-test' }, true)).toBeNull();
  expect(bibPickOf({ CIRRUS_PDF_PICK: 'D:\\essai.pdf', CIRRUS_DATA: 'D:\\base-de-test' }, true)).toBeNull();
});

// « Tout télécharger » reads CIRRUS_FREE_BYTES instead of the disk's free space (plan 5b, task 8: its question captured
// to the pixel), under the same rule: a test base in a window out of the user's way, and a whole number of bytes.
test('freeBytesOf : l’espace libre que « Tout télécharger » lit à la place du disque, seulement sur une base de test', async () => {
  const env = { CIRRUS_FREE_BYTES: '51539607552', CIRRUS_DATA: 'D:\\base-de-test' };
  expect(await freeBytesOf({ ...env, CIRRUS_BACKGROUND: '1' }, false)?.('D:\\base-de-test')).toBe(51539607552);
  expect(await freeBytesOf(env, true)?.('D:\\base-de-test')).toBe(51539607552);
  expect(freeBytesOf({ CIRRUS_FREE_BYTES: '51539607552', CIRRUS_BACKGROUND: '1' }, true)).toBeUndefined();
  expect(freeBytesOf(env, false)).toBeUndefined();
  for (const value of ['', '-1', '1.5', '48 Go', '1e9', '99999999999999999']) expect(freeBytesOf({ ...env, CIRRUS_FREE_BYTES: value }, true)).toBeUndefined();
});
