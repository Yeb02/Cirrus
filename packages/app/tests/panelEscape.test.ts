import { expect, test } from 'vitest';
import { ESCAPE_CANDIDATES, escapeYielded, hasEscapeFirst, type OnScreen } from '../src/renderer/ui/panelEscape.ts';

// What an Escape is left to before a side panel of the base's tools (plan 6a, final review): the decision on the elements
// on screen, with fake elements — a class list and the ancestors' classes, which is all it reads.

/** An element with these classes, inside elements with these classes. */
const el = (classes: string[], inside: string[] = []): OnScreen => ({
  classList: { contains: (name) => classes.includes(name) },
  closest: (selector) => (selector.startsWith('.') && [...classes, ...inside].includes(selector.slice(1)) ? {} : null),
});

test('hasEscapeFirst : un pop-up volant libre, un pop-up de connexion, un menu, un titre en cours, un plein écran prennent Échap avant le panneau', () => {
  expect(hasEscapeFirst(el(['panel', 'node-popup'], ['panels']))).toBe(true);
  expect(hasEscapeFirst(el(['panel', 'connection-popup'], ['panels']))).toBe(true);
  expect(hasEscapeFirst(el(['menu', 'context-menu']))).toBe(true);
  expect(hasEscapeFirst(el(['title-editor']))).toBe(true);
  expect(hasEscapeFirst(el(['full-screen', 'compare-view']))).toBe(true);
});

test('hasEscapeFirst : un pop-up épinglé ne prend pas Échap (seule la croix le ferme)', () => {
  expect(hasEscapeFirst(el(['panel', 'node-popup', 'pinned'], ['panels']))).toBe(false);
  expect(hasEscapeFirst(el(['panel', 'pinned'], ['panels']))).toBe(false);
  expect(hasEscapeFirst(el(['panel', 'connection-popup', 'pinned'], ['panels']))).toBe(false);
});

test('hasEscapeFirst : un panneau hors de .panels (un latéral) n’est pas un pop-up volant', () => {
  expect(hasEscapeFirst(el(['panel']))).toBe(false);
});

test('hasEscapeFirst : la recherche et le dialogue d’import ne prennent Échap que sous le focus, et alors personne d’autre ne le voit : ils ne passent pas avant le panneau', () => {
  expect(hasEscapeFirst(el(['search-box']))).toBe(false);
  expect(hasEscapeFirst(el(['publication-dialog']))).toBe(false);
  expect(ESCAPE_CANDIDATES).not.toContain('search-box');
  expect(ESCAPE_CANDIDATES).not.toContain('publication-dialog');
});

test('escapeYielded : rien à l’écran, ou seulement des pop-ups épinglés, la recherche, le dialogue : le panneau se ferme ; un pop-up libre parmi eux, non', () => {
  expect(escapeYielded([])).toBe(false);
  const pinned = el(['panel', 'pinned'], ['panels']), loose = el(['panel'], ['panels']);
  expect(escapeYielded([pinned])).toBe(false);
  expect(escapeYielded([pinned, pinned])).toBe(false);
  expect(escapeYielded([pinned, loose])).toBe(true);
  expect(escapeYielded([el(['search-box']), el(['publication-dialog']), pinned])).toBe(false);
  expect(escapeYielded([el(['panel', 'connection-popup'], ['panels'])])).toBe(true);
});
