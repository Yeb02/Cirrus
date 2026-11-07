import type { FileRef } from '@cirrus/core';
import { expect, test } from 'vitest';
import { NODE_MIME } from '../src/renderer/files/annotations.ts';
import { mergeFiles } from '../src/renderer/files/merge.ts';
import {
  carried, carriesFiles, dropNotice, droppedPaths, dropRoute, dropZone, EXECUTABLE_SHOWN, fileMenu, NOT_ON_DISK, openNotice, refusalNotice, refusesStrayDrop,
  systemOnClick,
} from '../src/renderer/files/nodeFiles.ts';
import { nodeOpenedBy } from '../src/renderer/ui/panels/Panels.tsx';

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
  const full = { action: 'full', label: 'Ouvrir en plein écran' }, system = { action: 'system', label: 'Ouvrir avec l’application du système' };
  const rest = [{ action: 'rename', label: 'Renommer' }, { action: 'remove', label: 'Retirer du nœud' }];
  // Shown in Cirrus (task 5), and handed to the system on request.
  for (const name of ['figure.PNG', 'article.pdf']) expect(fileMenu(name), name).toEqual([full, system, ...rest]);
  // Not shown in Cirrus: handed to the system.
  for (const name of ['présentation.pptx', 'données.xlsx', 'outil.exe', 'raccourci.lnk']) expect(fileMenu(name), name).toEqual([system, ...rest]);
  // Text, code, LaTeX and tables are only shown in Cirrus (task 5): never handed to the system, scripts included.
  for (const name of ['notes_lecture.md', 'calcul.py', 'Énoncé.tex', 'mesures.csv', 'lancer.ps1', 'build.bat', 'Makefile']) {
    expect(fileMenu(name), name).toEqual([full, ...rest]);
  }
});

test('systemOnClick : un clic ouvre par le système un fichier que Cirrus n’affiche pas, et lui seul', () => {
  for (const name of ['présentation.pptx', 'données.xlsx', 'outil.exe']) expect(systemOnClick(name), name).toBe(true);
  for (const name of ['figure.png', 'article.pdf', 'notes.md', 'calcul.py', 'mesures.csv', 'Énoncé.tex']) expect(systemOnClick(name), name).toBe(false);
  // Perl, Ruby and PHP scripts are shown in Cirrus: a click never hands them to Windows, which may run them (final review).
  for (const name of ['extraire.pl', 'Outils.pm', 'tâche.rb', 'index.php']) {
    expect(systemOnClick(name), name).toBe(false);
    expect(fileMenu(name).map((it) => it.action), name).toEqual(['full', 'rename', 'remove']);
  }
});

/**
 * Where a drop lands, as `closest` sees it: the element's tag and classes, then its ancestors' up to the app, each
 * written `tag.class.class` — a stand-in for the page's elements, for class selectors.
 */
const at = (...path: string[]) => ({
  closest: (selectors: string) => (selectors.split(',').some((s) => path.some((el) => el.split('.').slice(1).includes(s.trim().slice(1)))) ? {} : null),
});
const APP = ['div.app'], MAIN = [...APP, 'div.main'], GRAPH = [...MAIN, 'div.graph'];
const FILES = { types: ['Files'] }, TEXT = { types: ['text/plain'] };

test('refusesStrayDrop : un fichier que rien n’a pris est refusé par la fenêtre ; un fichier pris, un texte tiré, rien ne l’est (Review Focus 2)', () => {
  expect(refusesStrayDrop({ defaultPrevented: false, dataTransfer: FILES })).toBe(true);
  // Taken by the graph or a pop-up (their default prevented), or several kinds, files among them.
  expect(refusesStrayDrop({ defaultPrevented: true, dataTransfer: FILES })).toBe(false);
  expect(refusesStrayDrop({ defaultPrevented: false, dataTransfer: { types: ['text/uri-list', 'Files'] } })).toBe(true);
  // Text dragged in a field is the field's.
  expect(refusesStrayDrop({ defaultPrevented: false, dataTransfer: TEXT })).toBe(false);
  expect(refusesStrayDrop({ defaultPrevented: false, dataTransfer: null })).toBe(false);
  expect(carriesFiles({ dataTransfer: FILES })).toBe(true);
  expect(carriesFiles({ dataTransfer: TEXT })).toBe(false);
});

test('dropZone et dropRoute : un dépôt va au nœud ou au groupe du graphe, au nœud d’un pop-up, et nulle part ailleurs (Review Focus 2)', () => {
  const node = { kind: 'node' as const, id: 'n', node: 'n' }, group = { kind: 'group' as const, id: 'g', node: 'g' };
  const far = { kind: 'phantom' as const, id: 'ph1', node: 'loin', phantom: 'node' as const };
  const absent = { kind: 'phantom' as const, id: 'ph2', node: 'loin', phantom: 'absent' as const };
  const canvas = at(...GRAPH, 'div.canvas-host', 'canvas');
  /** The route of files let go at `target`: on the graph, onto `item` (none: the background), as GraphView reads it. */
  const graphDrop = (target: ReturnType<typeof at>, item?: Parameters<typeof nodeOpenedBy>[0]) => {
    const zone = dropZone(target);
    return dropRoute(zone, zone === 'graph' ? nodeOpenedBy(item, false) : null);
  };
  /** The route of files let go at `target`, in the pop-up of `owner` (null: a node gone), as NodePopup reads it. */
  const popupDrop = (target: ReturnType<typeof at>, owner: string | null) => {
    const zone = dropZone(target);
    return dropRoute(zone, zone === 'popup' ? owner : null);
  };
  const cases: [string, ReturnType<typeof dropRoute>][] = [];
  const check = (where: string, route: ReturnType<typeof dropRoute>, expected: ReturnType<typeof dropRoute>) => {
    expect(route, where).toEqual(expected);
    cases.push([where, route]);
  };
  // On the graph: the node or the group under the point, a far node's phantom for its node (spec 8.5); elsewhere, a notice.
  check('un nœud', graphDrop(canvas, node), { to: 'node', node: 'n' });
  check('un groupe', graphDrop(canvas, group), { to: 'node', node: 'g' });
  check('le fantôme d’un nœud lointain', graphDrop(canvas, far), { to: 'node', node: 'loin' });
  check('un fantôme absent', graphDrop(canvas, absent), { to: 'notice' });
  check('le fond du graphe', graphDrop(canvas), { to: 'notice' });
  // What floats over the graph and refuses files: a connection's pop-up, a question.
  check('le pop-up d’une connexion', graphDrop(at(...GRAPH, 'div.popup', 'ul', 'li'), node), { to: 'refused' });
  check('une question', graphDrop(at(...GRAPH, 'div.ask', 'button'), node), { to: 'refused' });
  // A node's pop-up takes them anywhere on it, its list of files and its fields included; not once its node is gone.
  const popup = [...MAIN, 'div.panels', 'section.panel.node-popup'];
  check('la liste des fichiers d’un pop-up', popupDrop(at(...popup, 'div.body', 'ul.files', 'li.file.with-thumb', 'span.name'), 'mdl'), { to: 'node', node: 'mdl' });
  check('le titre d’un pop-up', popupDrop(at(...popup, 'header', 'input.title'), 'mdl'), { to: 'node', node: 'mdl' });
  check('le pop-up d’un nœud supprimé', popupDrop(at(...popup, 'div.body', 'p.dim'), null), { to: 'refused' });
  // Anywhere else: refused.
  check('les onglets', graphDrop(at(...APP, 'div.tabs', 'div.tab.on')), { to: 'refused' });
  check('les réglages', graphDrop(at(...MAIN, 'aside.settings', 'div.control')), { to: 'refused' });
  check('un champ de texte des réglages', graphDrop(at(...MAIN, 'aside.settings', 'div.control', 'input.list')), { to: 'refused' });
  check('l’aperçu d’un fichier', popupDrop(at(...MAIN, 'div.panels', 'section.panel.file-preview', 'div.body', 'div.viewer'), 'mdl'), { to: 'refused' });
  check('le plein écran', graphDrop(at(...APP, 'div.full-screen', 'div.viewer')), { to: 'refused' });
  check('une notification', graphDrop(at(...MAIN, 'div.toasts', 'div.toast')), { to: 'refused' });
  expect(dropZone(null)).toBeNull();
  // Wherever files are let go, the window never shows them: taken (their default prevented: a node's files, or the
  // graph's notice), or refused by the window's guard.
  for (const [where, route] of cases) {
    const taken = route.to !== 'refused';
    expect(refusesStrayDrop({ defaultPrevented: taken, dataTransfer: FILES }), where).toBe(!taken);
  }
});

test('carried et dropRoute (plan 4c, tâche 3) : un nœud tiré d’une liste n’est jamais pris pour des fichiers ; sur le graphe il se pose, ailleurs rien', () => {
  const NODE = { types: [NODE_MIME] };
  expect(carried({ dataTransfer: NODE })).toBe('node');
  expect(carried({ dataTransfer: FILES })).toBe('files');
  // Both (no list of Cirrus gives that): the node, never files.
  expect(carried({ dataTransfer: { types: [NODE_MIME, 'Files'] } })).toBe('node');
  expect(carried({ dataTransfer: TEXT })).toBeNull();
  expect(carried({ dataTransfer: null })).toBeNull();
  expect(carriesFiles({ dataTransfer: NODE })).toBe(false);
  expect(carriesFiles({ dataTransfer: { types: [NODE_MIME, 'Files'] } })).toBe(false);
  // The window's guard never refuses it: it is no file Chromium would show, and nothing takes it outside the graph.
  expect(refusesStrayDrop({ defaultPrevented: false, dataTransfer: NODE })).toBe(false);
  const canvas = at(...GRAPH, 'div.canvas-host', 'canvas');
  /** The route of what `dataTransfer` carries, let go at `target` onto the node `under` (as GraphView or NodePopup reads it). */
  const route = (target: ReturnType<typeof at>, under: string | null, dataTransfer: { types: string[] }) => {
    const what = carried({ dataTransfer });
    return what === null ? null : dropRoute(dropZone(target), under, what);
  };
  // On the graph: placed in the plan shown, whatever lies under the point (its host is read in the plan: placeDroppedBuild);
  // files there go to that node, as before.
  expect(route(canvas, 'n', NODE)).toEqual({ to: 'place' });
  expect(route(canvas, null, NODE)).toEqual({ to: 'place' });
  expect(route(canvas, 'n', FILES)).toEqual({ to: 'node', node: 'n' });
  expect(route(canvas, null, FILES)).toEqual({ to: 'notice' });
  expect(dropRoute('graph', 'n')).toEqual({ to: 'node', node: 'n' });
  // A node's pop-up (its files, its fields), what floats over the graph, a preview, the full screen, the tabs: nothing.
  const popup = [...MAIN, 'div.panels', 'section.panel.node-popup', 'div.body'];
  expect(route(at(...popup, 'ul.files', 'li.file'), 'mdl', NODE)).toEqual({ to: 'refused' });
  expect(route(at(...popup, 'ol.annotation-list', 'li'), 'mdl', NODE)).toEqual({ to: 'refused' });
  expect(route(at(...popup, 'ul.files', 'li.file'), 'mdl', FILES)).toEqual({ to: 'node', node: 'mdl' });
  for (const where of [
    at(...GRAPH, 'div.popup', 'ul', 'li'), at(...GRAPH, 'div.ask', 'button'), at(...MAIN, 'div.panels', 'section.panel.file-preview', 'div.body', 'aside.annotation-margin'),
    at(...APP, 'div.full-screen', 'div.viewer'), at(...APP, 'div.tabs', 'div.tab.on'),
  ]) expect(route(where, null, NODE)).toEqual({ to: 'refused' });
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
