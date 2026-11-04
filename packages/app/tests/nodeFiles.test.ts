import type { FileRef } from '@cirrus/core';
import { expect, test } from 'vitest';
import { mergeFiles } from '../src/renderer/files/merge.ts';
import {
  dropNotice, droppedPaths, EXECUTABLE_SHOWN, fileMenu, NOT_ON_DISK, openNotice, refusalNotice, systemOnClick,
} from '../src/renderer/files/nodeFiles.ts';

const sha = (c: string) => c.repeat(64);
const ref = (name: string, hash = sha('0'), size = 1): FileRef => ({ name, hash, size });
const MDL = 'Minimum Description Length Principle (MDL)';

test('refusalNotice : tous les refus en une seule notification, avec leur raison', () => {
  expect(refusalNotice([])).toBeNull();
  expect(refusalNotice([{ name: 'x', reason: 'c’est un dossier' }])).toBe('1 fichier non importé : x (c’est un dossier)');
  expect(refusalNotice([{ name: 'x', reason: 'c’est un dossier' }, { name: 'y', reason: 'plus de 200 Mo' }]))
    .toBe('2 fichiers non importés : x (c’est un dossier), y (plus de 200 Mo)');
});

test('dropNotice : « « nom » remplacé », les ajouts au nœud, les deux ensemble ; rien quand rien n’a changé', () => {
  const existing = [ref('Rapport.pdf', sha('1')), ref('notes.md', sha('2'))];
  expect(dropNotice(mergeFiles(existing, [ref('rapport.pdf', sha('3'))]), MDL)).toBe('« rapport.pdf » remplacé');
  expect(dropNotice(mergeFiles(existing, [ref('rapport.pdf', sha('3')), ref('NOTES.md', sha('4'))]), MDL)).toBe('2 fichiers remplacés');
  expect(dropNotice(mergeFiles(existing, [ref('figure.png', sha('5'))]), MDL)).toBe(`« figure.png » ajouté à « ${MDL} »`);
  expect(dropNotice(mergeFiles(existing, [ref('a.txt'), ref('b.txt')]), MDL)).toBe(`2 fichiers ajoutés à « ${MDL} »`);
  expect(dropNotice(mergeFiles(existing, [ref('a.txt'), ref('Rapport.pdf', sha('3')), ref('notes.md', sha('2'))]), MDL))
    .toBe(`« a.txt » ajouté à « ${MDL} » ; « Rapport.pdf » remplacé`);
  expect(dropNotice(mergeFiles(existing, existing), MDL)).toBeNull();
});

test('openNotice : l’exécutable montré dans l’explorateur, l’échec dit par le principal ; rien pour une ouverture faite', () => {
  expect(openNotice({ ok: true, shown: 'app' })).toBeNull();
  expect(openNotice({ ok: true, shown: 'folder' })).toBe(EXECUTABLE_SHOWN);
  expect(EXECUTABLE_SHOWN).toBe('Fichier exécutable : montré dans l’explorateur, sans l’ouvrir.');
  expect(openNotice({ ok: false, message: 'Impossible d’ouvrir « a.pdf » : le disque est plein.' })).toBe('Impossible d’ouvrir « a.pdf » : le disque est plein.');
});

test('fileMenu : « Ouvrir avec l’application du système » pour les images, les PDF et les autres genres seulement (décision du contrôleur)', () => {
  const all = [
    { action: 'system', label: 'Ouvrir avec l’application du système' }, { action: 'rename', label: 'Renommer' }, { action: 'remove', label: 'Retirer du nœud' },
  ];
  for (const name of ['figure.PNG', 'article.pdf', 'présentation.pptx', 'données.xlsx', 'outil.exe', 'raccourci.lnk']) expect(fileMenu(name), name).toEqual(all);
  // Text, code, LaTeX and tables are only shown in Cirrus (task 5): never handed to the system, scripts included.
  for (const name of ['notes_lecture.md', 'calcul.py', 'Énoncé.tex', 'mesures.csv', 'lancer.ps1', 'build.bat', 'Makefile']) {
    expect(fileMenu(name), name).toEqual(all.slice(1));
  }
});

test('systemOnClick : un clic ouvre par le système un fichier que Cirrus n’affiche pas, et lui seul', () => {
  for (const name of ['présentation.pptx', 'données.xlsx', 'outil.exe']) expect(systemOnClick(name), name).toBe(true);
  for (const name of ['figure.png', 'article.pdf', 'notes.md', 'calcul.py', 'mesures.csv', 'Énoncé.tex']) expect(systemOnClick(name), name).toBe(false);
});

test('droppedPaths : le chemin de chaque fichier du disque ; un fichier fait par une page est refusé, nommé', () => {
  const files = [new File(['a'], 'a.txt'), new File(['b'], 'image.png'), new File([''], 'dossier')];
  const paths = new Map([['a.txt', 'C:\\docs\\a.txt'], ['dossier', 'C:\\docs\\dossier']]);
  expect(droppedPaths(files, (f) => paths.get(f.name) ?? '')).toEqual({
    paths: ['C:\\docs\\a.txt', 'C:\\docs\\dossier'], refused: [{ name: 'image.png', reason: NOT_ON_DISK }],
  });
  expect(NOT_ON_DISK).toBe('pas un fichier du disque');
  expect(droppedPaths([], () => '')).toEqual({ paths: [], refused: [] });
});
