import { expect, test } from 'vitest';
import {
  type Action, type AgendaEntryRec, applyOps, CommandError, createNode, createPlan, decodeState, deleteAgendaEntry, deleteSheet, emptyState, encodeState,
  type Id, include, invertAction, moveNodes, NOT_A_GROUP, parseOp, placementOf, putAgendaEntry, putSheet, setGroupColor, type SheetRec, SNAPSHOT_VERSION,
  type State, SYNC_PROTOCOL_VERSION, toSnapshot,
} from '../src/index.ts';
import { created } from './helpers.ts';
import { crossed } from './twoPcs.ts';

// The format 2 (plan 6b, D1): agenda entries, sheets, and a placement's optional colour.

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };

/** A plan with group G holding node M, and node N in no group. */
function world() {
  const s = emptyState();
  const plan = created(run(s, createPlan(s, 'Thèse', 'plan')), 'plan');
  const mk = (title: string) => created(run(s, createNode(s, { plan, title, x: 0, y: 0, k: 0 })), 'node');
  const G = mk('Groupe'), M = mk('Membre'), N = mk('Seul');
  run(s, include(s, plan, M, G));
  return { s, plan, G, M, N };
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('accepté');
};

const ENTRY: AgendaEntryRec = { id: 'a-1', day: '2026-11-14', title: 'Relire le chapitre 2', text: 'Avec **soin**.', nodes: [] };
const SHEET: SheetRec = { id: 'f-1', createdAt: Date.UTC(2026, 10, 14, 9), text: 'Une idée.' };

test('un placement coloré fait l’aller-retour de l’instantané', () => {
  const { s, plan, G } = world();
  run(s, setGroupColor(s, plan, G, '#3a7bd5'));
  const d = decodeState(encodeState(s));
  expect(placementOf(d, plan, G)).toEqual({ ...placementOf(s, plan, G), color: '#3a7bd5' });
  expect(toSnapshot(d)).toEqual(toSnapshot(s));
  expect(SNAPSHOT_VERSION).toBe(1);
});

test('l’agenda et les feuillets font l’aller-retour de l’instantané', () => {
  const { s } = world();
  run(s, putAgendaEntry(s, ENTRY));
  run(s, putSheet(s, SHEET));
  const d = decodeState(encodeState(s));
  expect([...d.agenda.values()]).toEqual([ENTRY]);
  expect([...d.sheets.values()]).toEqual([SHEET]);
});

test('une couleur mal formée est refusée', () => {
  const p = { plan: 'p', node: 'n', x: 0, y: 0, k: 0 };
  expect(() => parseOp({ t: 'placement', before: null, after: { ...p, color: '#3a7bd5' } })).not.toThrow();
  for (const color of ['#3A7BD5', '#fff', 'bleu']) {
    expect(() => parseOp({ t: 'placement', before: null, after: { ...p, color } }), color).toThrow(/color/);
  }
});

test('setGroupColor refuse un nœud qui n’est pas un groupe ; null retire la couleur', () => {
  const { s, plan, G, N } = world();
  expect(refusal(() => setGroupColor(s, plan, N, '#3a7bd5'))).toBe(NOT_A_GROUP);
  expect(NOT_A_GROUP).toBe('Ce nœud n’est pas un groupe dans ce plan.');
  expect(() => setGroupColor(s, plan, G, '#FFF')).toThrow(CommandError);
  const a = run(s, setGroupColor(s, plan, G, '#3a7bd5'));
  expect(a.label).toBe('Couleur de « Groupe »');
  expect(placementOf(s, plan, G)!.color).toBe('#3a7bd5');
  run(s, setGroupColor(s, plan, G, null));
  expect(placementOf(s, plan, G)).not.toHaveProperty('color');
});

test('déplacer un groupe garde sa couleur', () => {
  const { s, plan, G } = world();
  run(s, setGroupColor(s, plan, G, '#3a7bd5'));
  run(s, moveNodes(s, plan, [{ node: G, x: 40, y: 20 }]));
  expect(placementOf(s, plan, G)).toMatchObject({ x: 40, y: 20, color: '#3a7bd5' });
});

test('agenda et feuillets : création, modification, suppression, annulation', () => {
  const { s, M } = world();
  const image = () => JSON.stringify([[...s.agenda.values()], [...s.sheets.values()]]);
  const steps: ((x: State) => Action)[] = [
    (x) => putAgendaEntry(x, ENTRY),
    (x) => putAgendaEntry(x, { ...ENTRY, title: 'Relire le chapitre 3', nodes: [M] }),
    (x) => putSheet(x, SHEET),
    (x) => putSheet(x, { ...SHEET, text: 'Une autre idée.' }),
    (x) => deleteAgendaEntry(x, ENTRY.id),
    (x) => deleteSheet(x, SHEET.id),
  ];
  const labels: string[] = [];
  for (const step of steps) {
    const before = image(), a = run(s, step(s));
    labels.push(a.label);
    expect(image()).not.toBe(before);
    run(s, invertAction(a));
    expect(image()).toBe(before);
    run(s, a);
  }
  expect(labels).toEqual([
    'Agenda : « Relire le chapitre 2 »', 'Agenda : « Relire le chapitre 3 »', 'Feuillet', 'Feuillet', 'Supprimer « Relire le chapitre 3 » de l’agenda',
    'Supprimer un feuillet',
  ]);
  expect([s.agenda.size, s.sheets.size]).toEqual([0, 0]);
  expect(() => deleteSheet(s, SHEET.id)).toThrow(CommandError);
  expect(() => deleteAgendaEntry(s, ENTRY.id)).toThrow(CommandError);
});

test('les ops de l’agenda et des feuillets : flux content, sujet leur identifiant', async () => {
  const { flowOf, subjectOf } = await import('../src/ops.ts');
  const s = emptyState();
  for (const a of [putAgendaEntry(s, ENTRY), putSheet(s, SHEET)]) {
    expect(a.ops.map((o) => [o.t, flowOf(o), subjectOf(o)])).toEqual([[a.ops[0].t, 'content', (a.ops[0].after as { id: Id }).id]]);
  }
});

test('les bornes de l’agenda', () => {
  const s = emptyState();
  expect(() => putAgendaEntry(s, { ...ENTRY, title: 'x'.repeat(200), text: 'y'.repeat(20_000), nodes: Array.from({ length: 50 }, (_, i) => `n${i}`) })).not.toThrow();
  expect(() => putAgendaEntry(s, { ...ENTRY, day: '2024-02-29' })).not.toThrow();
  const bad: Partial<AgendaEntryRec>[] = [
    { day: '2026-02-30' }, { day: '2026-13-01' }, { day: '2026-1-01' }, { title: '   ' }, { title: 'x'.repeat(201) }, { text: 'y'.repeat(20_001) },
    { nodes: Array.from({ length: 51 }, (_, i) => `n${i}`) }, { nodes: ['n1', 'n2', 'n1'] },
  ];
  for (const patch of bad) {
    const e = { ...ENTRY, ...patch };
    expect(() => putAgendaEntry(s, e), JSON.stringify(patch).slice(0, 60)).toThrow(CommandError);
    expect(() => parseOp({ t: 'agenda', before: null, after: e }), JSON.stringify(patch).slice(0, 60)).toThrow();
  }
});

test('les bornes d’un feuillet', () => {
  const s = emptyState();
  expect(() => putSheet(s, { ...SHEET, text: 'z'.repeat(100_000) })).not.toThrow();
  for (const patch of [{ text: 'z'.repeat(100_001) }, { createdAt: 1.5 }, { createdAt: Number.POSITIVE_INFINITY }]) {
    const sh = { ...SHEET, ...patch };
    expect(() => putSheet(s, sh), Object.keys(patch)[0]).toThrow(CommandError);
    expect(() => parseOp({ t: 'sheet', before: null, after: sh }), Object.keys(patch)[0]).toThrow();
  }
});

test.each([
  { order: 'mine first', at: { mine: 1, theirs: 2 } },
  { order: 'mine first', at: { mine: 2, theirs: 1 } },
  { order: 'theirs first', at: { mine: 1, theirs: 2 } },
  { order: 'theirs first', at: { mine: 2, theirs: 1 } },
] as const)('deux PC modifient deux feuillets différents ($order, $at.mine/$at.theirs) : les deux restent', ({ order, at }) => {
  const s = emptyState(), A: SheetRec = { ...SHEET, id: 'f-a' }, B: SheetRec = { ...SHEET, id: 'f-b' };
  run(s, putSheet(s, A));
  run(s, putSheet(s, B));
  const { server, dropped } = crossed(s, (x) => putSheet(x, { ...A, text: 'Mien.' }), (x) => putSheet(x, { ...B, text: 'Sien.' }), order, at);
  expect(dropped).toEqual([]);
  expect([server.sheets.get('f-a')!.text, server.sheets.get('f-b')!.text]).toEqual(['Mien.', 'Sien.']);
});

test('les versions', () => {
  expect(SYNC_PROTOCOL_VERSION).toBe(2);
});
