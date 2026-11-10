import { expect, test } from 'vitest';
import { overlayClosesSearch } from '../src/renderer/search/overlay.ts';

// The search box and what the graph asks over it (plan 6a, final review): a question or the graph's menu that opens
// closes the box, so that a question is never hidden under its list. The decision is pure.

const none = { question: false, menu: false };

test('overlayClosesSearch : une question ou le menu du graphe qui s’ouvre ferme la recherche', () => {
  expect(overlayClosesSearch(none, { question: true, menu: false })).toBe(true);
  expect(overlayClosesSearch(none, { question: false, menu: true })).toBe(true);
  expect(overlayClosesSearch(none, { question: true, menu: true })).toBe(true);
});

test('overlayClosesSearch : rien de nouveau, rien à fermer — ni quand l’un se ferme, ni quand l’un était déjà là', () => {
  expect(overlayClosesSearch(none, none)).toBe(false);
  expect(overlayClosesSearch({ question: true, menu: false }, none)).toBe(false);
  expect(overlayClosesSearch({ question: false, menu: true }, none)).toBe(false);
  // Already there: a box opened since (Ctrl+K over a menu) is not closed by the menu that was open before it.
  expect(overlayClosesSearch({ question: false, menu: true }, { question: false, menu: true })).toBe(false);
  expect(overlayClosesSearch({ question: true, menu: false }, { question: true, menu: false })).toBe(false);
  // One closes as the other opens: the one that opens closes the box.
  expect(overlayClosesSearch({ question: false, menu: true }, { question: true, menu: false })).toBe(true);
});
