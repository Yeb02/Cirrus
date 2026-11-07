import { expect, test } from 'vitest';
import { ANNOTATION_TITLE_CHARS, annotationTitle, validAnchor } from '../src/annotation.ts';
import {
  type Action, CommandError, createAnnotation, createNode, createPlan, deleteEverywhere, editNode, include, placeNode, removeFromPlan,
} from '../src/commands.ts';
import { UndoStack } from '../src/history.ts';
import { checkState, groupOf } from '../src/invariants.ts';
import type { Anchor, Id, NodeRec } from '../src/model.ts';
import { applyOp, canonical, checkRecord, emptyState, nodeRow, placedIn, type State } from '../src/state.ts';

const run = (s: State, a: Action): Action => { for (const op of a.ops) applyOp(s, op); return a; };
const created = (a: Action, t: 'node' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

const HASH = '0123456789abcdef'.repeat(4);
const anchor = (extra: Partial<Anchor> = {}): Anchor => ({
  pdf: 'pdf', file: 'Li_Vitányi_chapitre_1.pdf', hash: HASH, page: 1, rects: [[72, 581, 300, 594.8], [72, 565, 180.5, 578.8]],
  text: 'La complexité de Kolmogorov d’une chaîne', ...extra,
});

/** A plan and a PDF's node placed in it. */
function world() {
  const s = emptyState();
  const plan = created(run(s, createPlan(s, 'Lecture', 'plan')), 'plan');
  const pdf = created(run(s, createNode(s, { plan, title: 'An Introduction to Kolmogorov Complexity', x: 0, y: 0, k: 1 })), 'node');
  return { s, plan, pdf };
}

test('validAnchor : la page, les rectangles, le texte et l’empreinte dans leurs bornes', () => {
  expect(validAnchor(anchor())).toBe(true);
  const rect: [number, number, number, number] = [0, 0, 10, 10];
  const ok: Partial<Anchor>[] = [
    { page: 1 }, { page: 412 }, { rects: [rect] }, { rects: Array(500).fill(rect) }, { rects: [[-3.5, 1e6, 0, -0]] },
    { text: '' }, { text: 'é'.repeat(20_000) },
  ];
  for (const extra of ok) expect(validAnchor(anchor(extra)), JSON.stringify(extra).slice(0, 80)).toBe(true);
  const bad: Record<string, unknown>[] = [
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: Number.NaN }, { page: Infinity }, { page: '1' }, { page: undefined },
    { rects: [] }, { rects: Array(501).fill(rect) }, { rects: [[0, 0, 10, Number.NaN]] }, { rects: [[0, 0, Infinity, 10]] },
    { rects: [[0, 0, 10]] }, { rects: [[0, 0, 10, 10, 20]] }, { rects: [['0', 0, 10, 10]] }, { rects: [null] }, { rects: 'x' }, { rects: undefined },
    { text: 'é'.repeat(20_001) }, { text: 3 }, { text: undefined },
    { hash: HASH.slice(1) }, { hash: `${HASH}0` }, { hash: `${HASH.slice(1)}g` }, { hash: HASH.toUpperCase() }, { hash: 42 },
    { pdf: '' }, { pdf: 7 }, { file: '' }, { file: null },
  ];
  for (const extra of bad) expect(validAnchor({ ...anchor(), ...extra }), JSON.stringify(extra).slice(0, 80)).toBe(false);
  for (const junk of [null, undefined, 3, 'anchor', [], [anchor()]]) expect(validAnchor(junk), String(junk)).toBe(false);
});

test('annotationTitle : le début du passage sur une ligne, coupé à `max` caractères puis « … »', () => {
  expect(ANNOTATION_TITLE_CHARS).toBe(80);
  // A selection breaks at each line of the page: one space instead, none at the ends.
  expect(annotationTitle('  La complexité\nde Kolmogorov\t d’une   chaîne \n', 80)).toBe('La complexité de Kolmogorov d’une chaîne');
  expect(annotationTitle('abcdefghij', 10)).toBe('abcdefghij');
  expect(annotationTitle('abcdefghijk', 10)).toBe('abcdefghij…');
  // No space before the ellipsis.
  expect(annotationTitle('abcd efghijk', 5)).toBe('abcd…');
  // Characters, not UTF-16 units: a letter outside the BMP is never cut in two.
  expect(annotationTitle('𝒦𝒦𝒦𝒦', 3)).toBe('𝒦𝒦𝒦…');
  expect(annotationTitle('ab𝒦d', 3)).toBe('ab𝒦…');
  const long = 'x'.repeat(20_000);
  expect(annotationTitle(long, ANNOTATION_TITLE_CHARS)).toBe(`${'x'.repeat(80)}…`);
  expect(annotationTitle('', 80)).toBe('');
});

test('createAnnotation : un nœud qui garde son ancre, dans aucun plan ; Ctrl+Z le retire', () => {
  const { s, pdf } = world();
  const a = anchor({ pdf });
  const title = annotationTitle(a.text, ANNOTATION_TITLE_CHARS);
  const action = createAnnotation(s, a, title);
  expect(action.label).toBe('Annoter « La complexité de Kolmogorov d’une chaîne », p. 1');
  // Placed nowhere (spec 12 [C]): its only operation is its record.
  expect(action.ops.map((o) => o.t)).toEqual(['node']);
  run(s, action);
  const id = created(action, 'node'), n = s.nodes.get(id)!;
  expect(n).toEqual({ id, title, summary: '', tags: [], files: [], anchor: a });
  expect(placedIn(s, nodeRow(s, id))).toHaveLength(0);
  expect([...s.placements.values()].some((p) => p.node === id)).toBe(false);
  expect(checkState(s)).toEqual([]);
  // Its own copy: the caller's anchor changed afterwards changes nothing.
  a.rects[0][0] = 999;
  a.rects.push([1, 2, 3, 4]);
  expect(n.anchor!.rects).toEqual([[72, 581, 300, 594.8], [72, 565, 180.5, 578.8]]);
  // One undo step.
  const stack = new UndoStack();
  stack.record(action);
  const before = canonical([...s.nodes.values()]);
  run(s, stack.undo(s)!);
  expect(s.nodes.has(id)).toBe(false);
  run(s, stack.redo(s)!);
  expect(canonical([...s.nodes.values()])).toBe(before);
});

test('createAnnotation garde ses seuls champs connus de l’ancre', () => {
  const { s, pdf } = world();
  const action = run(s, createAnnotation(s, { ...anchor({ pdf }), extra: 'non' } as Anchor, 'x'));
  expect(Object.keys(s.nodes.get(created(action, 'node'))!.anchor!).sort()).toEqual(['file', 'hash', 'page', 'pdf', 'rects', 'text']);
});

test('createAnnotation refuse, en français, un PDF absent ou à la corbeille, et une ancre invalide', () => {
  const { s, pdf } = world();
  const fail = (a: Anchor) => { try { createAnnotation(s, a, 'x'); } catch (e) { return e; } return null; };
  const missing = fail(anchor({ pdf: 'ailleurs' }));
  expect(missing).toBeInstanceOf(CommandError);
  expect((missing as Error).message).toBe('Le PDF à annoter n’existe pas.');
  const invalid = fail(anchor({ pdf, page: 0 }));
  expect(invalid).toBeInstanceOf(CommandError);
  expect((invalid as Error).message).toBe('Ce passage ne peut pas être annoté.');
  run(s, deleteEverywhere(s, pdf));
  const trashed = fail(anchor({ pdf }));
  expect(trashed).toBeInstanceOf(CommandError);
  expect((trashed as Error).message).toBe('Le PDF à annoter est à la corbeille.');
  expect([...s.nodes.values()].some((n) => n.anchor)).toBe(false);
});

test('une annotation est un nœud comme un autre : renommée, résumée, posée dans le nœud du PDF qui devient un groupe', () => {
  const { s, plan, pdf } = world();
  const id = created(run(s, createAnnotation(s, anchor({ pdf }), 'Début')), 'node');
  run(s, editNode(s, id, { title: 'Définition de K', summary: 'La longueur du plus court programme.' }));
  expect(s.nodes.get(id)).toMatchObject({ title: 'Définition de K', summary: 'La longueur du plus court programme.', anchor: anchor({ pdf }) });
  run(s, placeNode(s, plan, id, 0, 120, 0));
  run(s, include(s, plan, id, pdf));
  expect(groupOf(s, plan, id)).toBe(pdf);
  expect(checkState(s)).toEqual([]);
  // The PDF's node gone to the trash: the annotation stays valid (its lists say what is missing, plan 4c task 2).
  run(s, deleteEverywhere(s, pdf));
  expect(s.nodes.get(id)!.anchor!.pdf).toBe(pdf);
  expect(checkState(s)).toEqual([]);
});

test('une annotation retirée de son dernier plan reste vivante, sans plan ; « Supprimer partout » la met à la corbeille (décision du contrôleur, tâche 3)', () => {
  const { s, plan, pdf } = world();
  const id = created(run(s, createAnnotation(s, anchor({ pdf }), 'Début')), 'node');
  run(s, placeNode(s, plan, id, 0, 120, 0));
  run(s, include(s, plan, id, pdf));
  // « Ici seulement », from its last plan: out of it and of its group there, but alive, its anchor kept (D1: kept under its PDF).
  const removed = run(s, removeFromPlan(s, plan, id));
  expect(s.nodes.get(id)!.trashedAt).toBeUndefined();
  expect(s.nodes.get(id)!.anchor).toEqual(anchor({ pdf }));
  expect(placedIn(s, nodeRow(s, id))).toHaveLength(0);
  expect(groupOf(s, plan, id)).toBeUndefined();
  expect(removed.ops.some((o) => o.t === 'node')).toBe(false);
  expect(checkState(s)).toEqual([]);
  // A node without an anchor leaving its last plan still goes to the trash (spec 7).
  run(s, removeFromPlan(s, plan, pdf));
  expect(s.nodes.get(pdf)!.trashedAt).toBeDefined();
  // « Supprimer partout »: the annotation goes to the trash, placed or not.
  run(s, deleteEverywhere(s, id));
  expect(s.nodes.get(id)!.trashedAt).toBeDefined();
  expect(checkState(s)).toEqual([]);
});

test('un nœud à l’ancre invalide est refusé avant toute écriture, par le même contrôle que la base (checkRecord)', () => {
  const { s, pdf } = world();
  const node = (a: unknown): NodeRec => ({ id: 'n', title: 'n', summary: '', tags: [], files: [], anchor: a as Anchor });
  expect(() => checkRecord({ t: 'node', before: null, after: node(anchor({ pdf })) })).not.toThrow();
  for (const a of [anchor({ page: 0 }), anchor({ rects: [] }), anchor({ hash: 'x' }), { ...anchor(), text: undefined }, null, 'p. 1']) {
    const op = { t: 'node', before: null, after: node(a) } as const;
    expect(() => checkRecord(op), JSON.stringify(a)).toThrow(/invalid node anchor/);
    expect(() => applyOp(s, op), JSON.stringify(a)).toThrow(/invalid node anchor/);
    expect(s.nodes.has('n')).toBe(false);
  }
});
