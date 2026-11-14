import type { Action, AgendaEntryRec, NodeRec, Op, SheetRec } from '@cirrus/core';
import { expect, test } from 'vitest';
import { stepNotice } from '../src/renderer/stepNotice.ts';

// What an undone or redone step says (spec 6.4; final review of plan 6b, I2): where it acted, when that is not shown.
const sheet: SheetRec = { id: 's1', createdAt: 0, text: 'Idée' };
const entry: AgendaEntryRec = { id: 'e1', day: '2026-11-14', title: 'Réunion', text: '', nodes: [] };
const node = { id: 'n1', title: 'Nœud' } as unknown as NodeRec;
const SHEET: Op = { t: 'sheet', before: null, after: sheet };
const AGENDA: Op = { t: 'agenda', before: null, after: entry };
const NODE: Op = { t: 'node', before: null, after: node };
const act = (label: string, ...ops: Op[]): Action => ({ id: 'a', label, ops });
const NAMES: Record<string, string> = { p1: 'Thèse', p2: 'Article', p3: 'Lobby' };
const name = (id: string) => NAMES[id] ?? '?';

test('depuis le graphe, un pas des feuillets ou de l’agenda le dit, par la sorte de ses opérations', () => {
  expect(stepNotice('Annulé', act('Texte du feuillet', SHEET), [], 'p1', 'graph', name)).toBe('Annulé dans les feuillets : Texte du feuillet');
  expect(stepNotice('Rétabli', act('Nouvelle entrée', AGENDA), [], 'p1', 'graph', name)).toBe('Rétabli dans l’agenda : Nouvelle entrée');
  expect(stepNotice('Annulé', act('Les deux', AGENDA, SHEET), [], 'p1', 'graph', name)).toBe('Annulé dans l’agenda et les feuillets : Les deux');
  // A sheet made a node in the plan shown: its node appears or goes there, seen; nothing said.
  expect(stepNotice('Annulé', act('En faire un nœud', NODE, SHEET), ['p1'], 'p1', 'graph', name)).toBeNull();
});

test('depuis le graphe, un pas d’un autre plan nomme ce plan, comme avant ; du plan montré, rien', () => {
  expect(stepNotice('Annulé', act('Déplacer', NODE), ['p2'], 'p1', 'graph', name)).toBe('Annulé dans le plan « Article » : Déplacer');
  expect(stepNotice('Annulé', act('Déplacer', NODE), ['p2', 'p3'], 'p1', 'graph', name)).toBe('Annulé dans les plans « Article », « Lobby » : Déplacer');
  expect(stepNotice('Annulé', act('Déplacer', NODE), ['p1', 'p2'], 'p1', 'graph', name)).toBeNull();
  expect(stepNotice('Annulé', act('Renommer', NODE), [], 'p1', 'graph', name)).toBeNull();
});

test('depuis l’agenda ou les feuillets, un pas qui n’y touche pas le dit ; un pas qui y touche, rien', () => {
  expect(stepNotice('Annulé', act('Nouvelle entrée', AGENDA), [], 'p1', 'agenda', name)).toBeNull();
  expect(stepNotice('Annulé', act('Texte du feuillet', SHEET), [], 'p1', 'sheets', name)).toBeNull();
  // Shown: the sheet comes back in its tab.
  expect(stepNotice('Annulé', act('En faire un nœud', NODE, SHEET), ['p1'], 'p1', 'sheets', name)).toBeNull();
  // A plan's step: no plan is shown, even the last one (`active`), so each is named; a content step names none.
  expect(stepNotice('Annulé', act('Déplacer', NODE), ['p1'], 'p1', 'agenda', name)).toBe('Annulé dans le plan « Thèse » : Déplacer');
  expect(stepNotice('Rétabli', act('Renommer', NODE), [], 'p1', 'sheets', name)).toBe('Rétabli : Renommer');
  // The other tab's records: named.
  expect(stepNotice('Annulé', act('Texte du feuillet', SHEET), [], 'p1', 'agenda', name)).toBe('Annulé dans les feuillets : Texte du feuillet');
  expect(stepNotice('Annulé', act('Nouvelle entrée', AGENDA), [], 'p1', 'sheets', name)).toBe('Annulé dans l’agenda : Nouvelle entrée');
});
