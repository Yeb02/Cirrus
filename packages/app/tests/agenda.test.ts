import { applyOps, CommandError, createNode, createPlan, deleteEverywhere, deleteSheet, emptyState, type Id, putAgendaEntry, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { agendaMonths, agendaRefusal, dayOf } from '../src/renderer/agenda.ts';
import { agendaBuild, SHEET_GONE, sheetBuild, sheetTextBuild } from '../src/renderer/actions.ts';
import { AGENDA_TAB, liveTabs, SHEETS_TAB } from '../src/renderer/tabs.ts';

const created = (ops: readonly { t: string; after?: unknown }[], t: string) => (ops.find((o) => o.t === t)!.after as { id: Id }).id;

function world() {
  const s = emptyState();
  const run = <A extends { ops: Parameters<typeof applyOps>[1] }>(a: A): A => { applyOps(s, a.ops); return a; };
  run(createPlan(s, 'Lobby', 'lobby'));
  const plan = created(run(createPlan(s, 'Thèse', 'plan')).ops, 'plan');
  const node = (title: string) => created(run(createNode(s, { plan, title, x: 0, y: 0, k: 0 })).ops, 'node');
  const put = (id: string, day: string, title: string, nodes: Id[] = []) => run(putAgendaEntry(s, { id, day, title, text: '', nodes }));
  return { s, plan, run, node, put };
}

const shape = (s: State, today: string) => agendaMonths(s, today).map((m) => [m.label, m.rows.map((r) => (r.kind === 'today' ? '—' : r.entry.title))]);

test('agendaMonths regroupe par mois, dans l’ordre des dates, et place la ligne d’aujourd’hui entre la veille et le lendemain', () => {
  const { s, put } = world();
  put('e3', '2026-12-01', 'Décembre');
  put('e1', '2026-11-13', 'Veille');
  put('e2', '2026-11-15', 'Lendemain');
  put('e0', '2026-10-31', 'Octobre');
  put('e4', '2026-11-14', 'Ce jour');
  expect(shape(s, '2026-11-14')).toEqual([
    ['octobre 2026', ['Octobre']],
    ['novembre 2026', ['Veille', '—', 'Ce jour', 'Lendemain']],
    ['décembre 2026', ['Décembre']],
  ]);
  // A month with no entry today still gets the line, in its place among the months.
  expect(shape(s, '2027-01-03').at(-1)).toEqual(['janvier 2027', ['—']]);
  expect(shape(s, '2026-11-20')[1]).toEqual(['novembre 2026', ['Veille', 'Ce jour', 'Lendemain', '—']]);
  expect(shape(s, '2026-09-02')[0]).toEqual(['septembre 2026', ['—']]);
  expect(shape(emptyState(), '2026-11-14')).toEqual([['novembre 2026', ['—']]]);
});

test('agendaMonths : un nœud lié jeté est marqué « trash », un nœud disparu « missing »', () => {
  const { s, run, node, put } = world();
  const kept = node('Gardé'), thrown = node('Jeté');
  put('e1', '2026-11-14', 'Réunion', [kept, thrown, 'n-inconnu']);
  run(deleteEverywhere(s, thrown));
  const entry = agendaMonths(s, '2026-11-14')[0].rows.find((r) => r.kind === 'entry')!;
  expect(entry.kind === 'entry' && entry.nodes).toEqual([
    { id: kept, title: 'Gardé' },
    { id: thrown, title: 'Jeté', gone: 'trash' },
    { id: 'n-inconnu', title: 'Nœud', gone: 'missing' },
  ]);
});

test('dayOf : la date locale AAAA-MM-JJ', () => {
  expect(dayOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
});

test('les bornes d’une entrée, dites en français, avant le cœur', () => {
  const e = { id: 'a', day: '2026-11-14', title: 'Réunion', text: '', nodes: [] as Id[] };
  expect(agendaRefusal(e)).toBeNull();
  expect(agendaRefusal({ ...e, title: '   ' })).toBe('Donnez un titre à l’entrée.');
  expect(agendaRefusal({ ...e, title: 'x'.repeat(201) })).toBe('Le titre d’une entrée compte au plus 200 caractères.');
  expect(agendaRefusal({ ...e, text: 'y'.repeat(20_001) })).toBe('Le texte d’une entrée compte au plus 20 000 caractères.');
  expect(agendaRefusal({ ...e, nodes: Array.from({ length: 51 }, (_, i) => `n${i}`) })).toBe('Une entrée lie au plus 50 nœuds.');
  expect(agendaRefusal({ ...e, day: '2026-02-30' })).toBe('Choisissez une date valide.');
  expect(agendaRefusal({ ...e, day: '' })).toBe('Choisissez une date valide.');
});

test('aucune action nulle : une entrée ou un feuillet identique à l’état ne s’écrit pas', () => {
  const { s, put } = world();
  put('e1', '2026-11-14', 'Réunion');
  expect(agendaBuild(s, { id: 'e1', day: '2026-11-14', title: 'Réunion', text: '', nodes: [] })).toBeNull();
  expect(agendaBuild(s, { id: 'e1', day: '2026-11-14', title: '  Réunion ', text: '', nodes: [] })).toBeNull();
  const b = agendaBuild(s, { id: 'e1', day: '2026-11-15', title: 'Réunion', text: '', nodes: [] });
  expect(b).not.toBeNull();
  expect(b!(s).label).toBe('Agenda : « Réunion »');
  const sheet = { id: 'f1', createdAt: 5, text: 'Idée' };
  expect(sheetBuild(s, sheet)).not.toBeNull();
  applyOps(s, sheetBuild(s, sheet)!(s).ops);
  expect(sheetBuild(s, sheet)).toBeNull();
  expect(s.sheets.get('f1')).toEqual(sheet);
});

test('liveTabs garde @agenda et @feuillets et écarte un identifiant inconnu', () => {
  const { s, plan } = world();
  const open = [AGENDA_TAB, plan, 'p-inconnu', SHEETS_TAB];
  expect([AGENDA_TAB, SHEETS_TAB]).toEqual(['@agenda', '@feuillets']);
  expect(liveTabs(s.plans, open, plan)).toEqual({ open: [AGENDA_TAB, plan, SHEETS_TAB], active: plan });
  const kept = [AGENDA_TAB, plan, SHEETS_TAB];
  expect(liveTabs(s.plans, kept, plan).open).toBe(kept);
});

test('relecture, mineur 2 : la frappe d’un feuillet disparu entre-temps ne le refait pas', () => {
  const { s } = world();
  applyOps(s, sheetBuild(s, { id: 'f1', createdAt: 5, text: '' })!(s).ops);
  expect(sheetTextBuild(s, 'f1', '')).toBeNull();
  const typed = sheetTextBuild(s, 'f1', 'Idée')!;
  applyOps(s, deleteSheet(s, 'f1').ops);
  expect(() => typed(s)).toThrow(CommandError);
  expect(() => typed(s)).toThrow(SHEET_GONE);
  expect(() => sheetTextBuild(s, 'f1', 'Idée')!(s)).toThrow(SHEET_GONE);
  expect(s.sheets.has('f1')).toBe(false);
});
