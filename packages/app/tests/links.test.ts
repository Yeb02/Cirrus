import { type Action, applyOps, createNode, createPlan, deleteEverywhere, emptyState, type Id, placeNode, type State } from '@cirrus/core';
import { afterEach, expect, test, vi } from 'vitest';
import { LinkHover, linkMenu } from '../src/renderer/links.ts';

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const idOf = (a: Action, t: 'plan' | 'node'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

/** The lobby, two plans P and Q; node `a` in the lobby and P, node `b` in Q only, node `t` in the trash. */
function base() {
  const s = emptyState();
  const lobby = idOf(run(s, createPlan(s, 'Lobby', 'lobby')), 'plan'), p = idOf(run(s, createPlan(s, 'P', 'plan')), 'plan');
  const q = idOf(run(s, createPlan(s, 'Q', 'plan')), 'plan');
  const mk = (title: string, where: Id) => idOf(run(s, createNode(s, { plan: where, title, x: 0, y: 0, k: 0 })), 'node');
  const a = mk('A', lobby);
  run(s, placeNode(s, p, a, 400, 0, 0));
  const b = mk('B', q), t = mk('T', q);
  run(s, deleteEverywhere(s, t));
  return { s, lobby, p, q, a, b, t };
}

afterEach(() => { vi.useRealTimers(); });

test('linkMenu (plan 6b, D5) : un nœud dans ce plan et le lobby — l’ouvrir, le voir ici ou dans le lobby ; rien à importer', () => {
  const { s, lobby, p, a } = base();
  expect(linkMenu(s, a, p, []).map((i) => i.action)).toEqual(['open', 'here', `plan:${lobby}`]);
  expect(linkMenu(s, a, p, []).map((i) => i.label)).toEqual(['Ouvrir le pop-up', 'Voir dans ce plan', 'Voir dans « Lobby »']);
});

test('linkMenu : un nœud d’un autre plan seulement — ses plans dans l’ordre de « Voir dans un autre plan », puis « Importer ici »', () => {
  const { s, p, q, b } = base();
  expect(linkMenu(s, b, p, []).map((i) => i.action)).toEqual(['open', `plan:${q}`, 'import']);
  expect(linkMenu(s, b, p, []).at(-1)!.label).toBe('Importer ici');
});

test('linkMenu : un nœud jeté ou disparu n’a que « Ouvrir le pop-up », qui le dira', () => {
  const { s, p, t } = base();
  expect(linkMenu(s, t, p, []).map((i) => i.action)).toEqual(['open']);
  expect(linkMenu(s, 'absent', p, []).map((i) => i.action)).toEqual(['open']);
});

test('LinkHover (D5) : l’aperçu attend linkPreviewDelayMs, et ne vient pas si le pointeur part avant ; il part avec lui', () => {
  vi.useFakeTimers();
  const shown: (Id | null)[] = [];
  const hover = new LinkHover(() => 400, (t) => shown.push(t?.node ?? null));
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  hover.enter('n', rect);
  vi.advanceTimersByTime(399);
  expect(shown).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(shown).toEqual(['n']);
  hover.leave();
  expect(shown).toEqual(['n', null]);
  // Gone before the delay: nothing shows, nothing to hide.
  hover.enter('m', rect);
  vi.advanceTimersByTime(200);
  hover.leave();
  vi.advanceTimersByTime(1000);
  expect(shown).toEqual(['n', null]);
});

test('LinkHover : d’un lien à l’autre, l’aperçu du premier part, le second attend son délai ; dispose ne laisse rien venir après (Review Focus 3)', () => {
  vi.useFakeTimers();
  const shown: (Id | null)[] = [];
  const hover = new LinkHover(() => 400, (t) => shown.push(t?.node ?? null));
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  hover.enter('n', rect);
  vi.advanceTimersByTime(400);
  hover.enter('m', rect);
  expect(shown).toEqual(['n', null]);
  vi.advanceTimersByTime(400);
  expect(shown).toEqual(['n', null, 'm']);
  // The pop-up that carried the link closes meanwhile (its links unmount: leave), or the layer goes (dispose).
  hover.enter('o', rect);
  hover.dispose();
  vi.advanceTimersByTime(1000);
  expect(shown).toEqual(['n', null, 'm', null]);
});
