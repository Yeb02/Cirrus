import { expect, test } from 'vitest';
import type { NodeRec } from '../src/model.ts';
import { flowOf, invertOp, MAX_ID_CHARS, type Op, parseOp, SyncFormatError } from '../src/ops.ts';
import { applyOp, emptyState, OpConflictError } from '../src/state.ts';
import { MAX_LABEL_CHARS, MAX_OPS_PER_UNIT, parseRemoteUnit, parseUnit, type Unit } from '../src/sync.ts';

test('créer puis modifier un nœud', () => {
  const s = emptyState();
  const n: NodeRec = { id: 'n1', title: 'MDL', summary: '', tags: [], files: [] };
  applyOp(s, { t: 'node', before: null, after: n });
  applyOp(s, { t: 'node', before: n, after: { ...n, title: 'Minimum Description Length Principle (MDL)' } });
  expect(s.nodes.get('n1')!.title).toBe('Minimum Description Length Principle (MDL)');
});

test("l'opération inverse rétablit l'état", () => {
  const s = emptyState();
  const op: Op = { t: 'placement', before: null, after: { plan: 'p', node: 'n', x: 1, y: 2, k: 0 } };
  applyOp(s, op);
  applyOp(s, invertOp(op));
  expect(s.placements.size).toBe(0);
});

test('avant périmé : conflit, état intact', () => {
  const s = emptyState();
  const n: NodeRec = { id: 'n1', title: 'A', summary: '', tags: [], files: [] };
  applyOp(s, { t: 'node', before: null, after: n });
  expect(() => applyOp(s, { t: 'node', before: { ...n, title: 'autre' }, after: { ...n, title: 'B' } })).toThrow(OpConflictError);
  expect(s.nodes.get('n1')!.title).toBe('A');
});

test('flux de chaque opération', () => {
  expect(flowOf({ t: 'connection', before: null, after: null })).toBe('content');
  expect(flowOf({ t: 'branch', key: { plan: 'p', connection: 'c', node: 'n' }, before: false, after: true })).toBe('layout');
});

const H = (c: string) => c.repeat(64);
const node: NodeRec = {
  id: 'n1', title: 'MDL', summary: 'Résumé', tags: [{ key: 'lu' }, { key: 'statut', value: 'brouillon' }, { key: 'année', value: 2026 }],
  files: [{ name: 'note.tex', hash: H('a'), size: 12 }],
};
/** One operation of each type, with every optional field somewhere. */
const EVERY_OP: Op[] = [
  { t: 'node', before: null, after: node },
  { t: 'node', before: node, after: { ...node, trashedAt: 1_700_000_000_000 } },
  { t: 'node', before: null, after: { id: 'a1', title: 'Un passage', summary: '', tags: [], files: [], anchor: { pdf: 'n1', file: 'p.pdf', hash: H('b'), page: 2, rects: [[1, 2, 3, 4.5]], text: 'passage' } } },
  { t: 'connection', before: null, after: { id: 'c1', kind: 'knowledge', title: 'T', relation: 'R', tags: [], members: [{ node: 'n1', role: 'source' }, { node: 'n2', role: 'target' }] } },
  { t: 'connection', before: { id: 'c2', kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: 'n1', role: 'source' }, { node: 'g', role: 'target' }] }, after: { id: 'c2', kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: 'n1', role: 'source' }, { node: 'g', role: 'target' }], trashedAt: 5 } },
  { t: 'plan', before: null, after: { id: 'p1', name: 'Thèse', type: 'document' } },
  { t: 'tagKey', before: null, after: { key: 'statut', type: 'enum', scope: 'both', multi: false, required: true, defaultValue: 'brouillon', enumValues: [{ name: 'brouillon', rank: 1 }] } },
  { t: 'placement', before: { plan: 'p1', node: 'n1', x: 1, y: -2.5, k: 0 }, after: null },
  { t: 'branch', key: { plan: 'p1', connection: 'c1', node: 'n1' }, before: false, after: true },
  { t: 'connLayout', before: null, after: { plan: 'p1', connection: 'c1', marker: { x: 1, y: 2 }, angle: 0.5, handles: { n1: { b1: { x: 0, y: 0 }, b2: { x: 1, y: 1 } } } } },
  { t: 'phantom', before: null, after: { id: 'f1', plan: 'p1', connection: 'c1', of: { kind: 'absent', node: 'n2' }, x: 3, y: 4, k: 1, group: 'g' } },
  { t: 'preamble', before: { text: 'a' }, after: { text: 'b' } },
];

test('parseOp : chaque type d’opération fait l’aller-retour par JSON', () => {
  for (const op of EVERY_OP) {
    const wire = JSON.parse(JSON.stringify(op)) as unknown;
    expect(parseOp(wire), op.t).toEqual(op);
  }
});

test('parseOp : un champ manquant, un NaN, une chaîne trop longue, un type ou une clé inconnus sont refusés en français', () => {
  const long = 'x'.repeat(MAX_ID_CHARS + 1);
  const { summary: _summary, ...noSummary } = node;
  const bad: unknown[] = [
    null, 'node', { t: 'node' }, { t: 'nœud', before: null, after: node },
    { t: 'node', before: null, after: noSummary },
    { t: 'node', before: null, after: { ...node, extra: 1 } },
    { t: 'node', before: null, after: null },
    { t: 'node', before: node, after: { ...node, id: 'n2' } },
    { t: 'node', before: null, after: { ...node, id: long } },
    { t: 'node', before: null, after: { ...node, id: '' } },
    { t: 'node', before: null, after: { ...node, trashedAt: Number.NaN } },
    { t: 'node', before: null, after: { ...node, tags: [{ key: 'année', value: Number.POSITIVE_INFINITY }] } },
    { t: 'node', before: null, after: { ...node, files: [{ name: 'a.txt', hash: 'A'.repeat(64), size: 1 }] } },
    { t: 'node', before: null, after: { ...node, files: [{ name: 'a.txt', hash: H('a'), size: -1 }] } },
    { t: 'node', before: null, after: { ...node, anchor: { pdf: 'n1', file: 'p.pdf', hash: H('b'), page: 0, rects: [[1, 2, 3, 4]], text: '' } } },
    { t: 'connection', before: null, after: { id: 'c', kind: 'lien', title: '', relation: '', tags: [], members: [] } },
    { t: 'connection', before: null, after: { id: 'c', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: 'n', role: 'chef' }] } },
    { t: 'plan', before: null, after: { id: 'p', name: 'P', type: 'carte' } },
    { t: 'tagKey', before: null, after: { key: 'k', type: 'word', scope: 'node', multi: 'non', required: false } },
    { t: 'placement', before: null, after: { plan: 'p', node: 'n', x: Number.NaN, y: 0, k: 0 } },
    { t: 'branch', key: { plan: 'p', connection: 'c', node: long }, before: false, after: true },
    { t: 'branch', key: { plan: 'p', connection: 'c', node: 'n' }, before: 0, after: true },
    { t: 'connLayout', before: null, after: { plan: 'p', connection: 'c', handles: { n: { b1: { x: 0 }, b2: { x: 0, y: 0 } } } } },
    { t: 'phantom', before: null, after: { id: 'f', plan: 'p', connection: 'c', of: { kind: 'loin', node: 'n' }, x: 0, y: 0, k: 0 } },
    { t: 'preamble', before: null, after: { text: 42 } },
  ];
  for (const x of bad) {
    expect(() => parseOp(x), JSON.stringify(x)?.slice(0, 120)).toThrow(SyncFormatError);
    expect(() => parseOp(x)).toThrow(/^Opération mal formée/);
  }
});

test('parseUnit : la forme d’une écriture, son libellé borné, son nombre d’opérations', () => {
  const unit: Unit = { unit: 'u1', action: 'a1', label: 'Créer « MDL »', at: 1_700_000_000_000, pc: 'pc-a', ops: [EVERY_OP[0]] };
  expect(parseUnit(JSON.parse(JSON.stringify(unit)))).toEqual(unit);
  const bad: unknown[] = [
    { ...unit, label: 'x'.repeat(MAX_LABEL_CHARS + 1) }, { ...unit, at: Number.NaN }, { ...unit, pc: '' }, { ...unit, ops: [] },
    { ...unit, ops: [{ t: 'node', before: null }] }, { ...unit, seq: 3 }, { ...unit, unit: 'u'.repeat(MAX_ID_CHARS + 1) },
    { ...unit, ops: { length: 1, 0: EVERY_OP[0] } },
  ];
  for (const x of bad) expect(() => parseUnit(x), JSON.stringify(x).slice(0, 120)).toThrow(SyncFormatError);
  // Counted before any operation is read.
  expect(() => parseUnit({ ...unit, ops: Array.from({ length: MAX_OPS_PER_UNIT + 1 }) })).toThrow(/opérations/);
  // A received unit carries its number at the server: its last line's, at least as many as its operations.
  expect(parseRemoteUnit(JSON.parse(JSON.stringify({ ...unit, seq: 7 })))).toEqual({ ...unit, seq: 7 });
  for (const seq of [0, -1, 1.5, Number.NaN, '7', undefined]) expect(() => parseRemoteUnit({ ...unit, seq, ops: [EVERY_OP[0], EVERY_OP[1]] }), String(seq)).toThrow(SyncFormatError);
});
