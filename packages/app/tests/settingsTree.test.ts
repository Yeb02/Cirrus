import { PARAM_SPECS } from '@cirrus/view';
import { expect, test } from 'vitest';
import { settingsTree } from '../src/renderer/ui/settingsTree.ts';

const keysOf = (tree: ReturnType<typeof settingsTree>) => tree.flatMap((r) => r.groups.flatMap((g) => [...g.main, ...g.advanced].map((s) => s.key)));

test('sans recherche : chaque réglage une fois, sous sa rubrique et son groupe, les principaux à part des avancés', () => {
  const tree = settingsTree('');
  expect(keysOf(tree).sort()).toEqual(PARAM_SPECS.map((s) => s.key).sort());
  expect(tree.map((r) => r.title)).toEqual(['Apparence', 'Navigation', 'Fenêtres', 'Fichiers', 'LaTeX', 'Performances et base', 'Serveur']);
  const latex = tree.find((r) => r.title === 'LaTeX')!;
  expect(latex.groups.map((g) => g.name)).toEqual(['Résumé compilé', 'Compilation', 'Éditeur LaTeX', 'Paquets et installation']);
  expect(latex.groups[0].main.map((s) => s.key)).toEqual(['latexSnippetWidthCm']);
  expect(latex.groups[0].advanced.map((s) => s.key)).toEqual(['latexSnippetMaxZoom']);
  for (const r of tree) for (const g of r.groups) {
    expect(g.main.every((s) => s.section === 'graphique' && s.group === g.name)).toBe(true);
    expect(g.advanced.every((s) => s.section === 'avancé' && s.group === g.name)).toBe(true);
  }
});

test('la recherche trouve les libellés sans tenir compte des accents ni de la casse', () => {
  expect(keysOf(settingsTree('largeur du resume'))).toEqual(['latexSnippetWidthCm']);
  expect(keysOf(settingsTree('  LARGEUR  du   Résumé '))).toEqual(['latexSnippetWidthCm']);
  expect(keysOf(settingsTree('etoiles'))).toEqual(expect.arrayContaining(['starColor', 'starSizePx', 'starBrightness']));
});

test('une recherche qui nomme un groupe ou une rubrique en montre tous les réglages', () => {
  expect(keysOf(settingsTree('pdf'))).toEqual(expect.arrayContaining(['pdfPagesAhead', 'pdfZoomStep', 'pdfCanvasMaxMp', 'thumbPx']));
  const latex = PARAM_SPECS.filter((s) => ['Résumé compilé', 'Compilation', 'Éditeur LaTeX', 'Paquets et installation'].includes(s.group)).map((s) => s.key);
  expect(keysOf(settingsTree('latex')).sort()).toEqual(expect.arrayContaining(latex.sort()));
});

test('une recherche sans réponse ne laisse ni rubrique ni groupe vide', () => {
  expect(settingsTree('xyzzy')).toEqual([]);
  for (const r of settingsTree('zoom')) {
    expect(r.groups.length).toBeGreaterThan(0);
    for (const g of r.groups) expect(g.main.length + g.advanced.length).toBeGreaterThan(0);
  }
});
