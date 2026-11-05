import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOps, CITE_KEY_TAG, editNode, type State, type TexError } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { filePath, LocalStore } from '@cirrus/store';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fileKind } from '../src/renderer/files/kind.ts';
import { LatexRegistry, type Origin } from '../src/renderer/latex/registry.ts';
import { buildRequest } from '../src/renderer/latex/request.ts';
import { scanTex } from '../src/renderer/latex/scan.ts';
import { completionsFor, diagnosticsFor, lineStartOf, refContext, suggestionOptions } from '../src/renderer/ui/latex/editorLogic.ts';

// One test base for the whole file, never the user's: each test reads its state from the store again.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-latexeditor-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const MDL = 'Minimum Description Length Principle (MDL)';
const run = (s: State, a: Action) => applyOps(s, a.ops);
function textsOf(s: State): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of s.nodes.values()) for (const f of n.files) if (fileKind(f.name) === 'tex') out.set(f.hash, readFileSync(filePath(dir, f), 'utf8'));
  return out;
}
/** `text` with « | » for the cursor: the text without it, and the cursor's offset. */
const at = (text: string) => ({ doc: text.replace('|', ''), pos: text.indexOf('|') });
const ctxOf = (text: string) => { const { doc, pos } = at(text); return refContext(doc, pos); };
/** Each line's first offset, 1-based; past the last line, the text's length + 1 (as if a line break ended it). */
const lineStarts = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (line: number) => (line - 1 < starts.length ? starts[line - 1] : text.length + 1);
};

test('refContext : dans les accolades d’une ref ou d’une citation, le début du nom et ce qui est tapé ; ailleurs, null', () => {
  expect(ctxOf('Voir \\ref{md|')).toEqual({ kind: 'ref', from: 10, prefix: 'md' });
  expect(ctxOf('\\eqref{|}')).toEqual({ kind: 'ref', from: 7, prefix: '' });
  expect(ctxOf('\\cite{LI|')).toEqual({ kind: 'cite', from: 6, prefix: 'LI' });
  // A list: the name being typed, after the last comma and its spaces; a citation's optional arguments, a star.
  expect(ctxOf('\\cite[p.~3]{li2008, so|}')).toEqual({ kind: 'cite', from: 20, prefix: 'so' });
  expect(ctxOf('\\cref*{kc:def,ent|')).toEqual({ kind: 'ref', from: 14, prefix: 'ent' });
  expect(ctxOf('\\citep [voir] [p.~2] {|')).toEqual({ kind: 'cite', from: 22, prefix: '' });
  // A single ref takes its whole argument, as LaTeX reads it.
  expect(ctxOf('\\ref{a,b|')).toEqual({ kind: 'ref', from: 5, prefix: 'a,b' });
  for (const outside of [
    'Voir \\ref{a} et |', '\\label{kc|', '\\section{Intro|', '% \\ref{md|', '\\\\ref{md|', 'ref{md|', '\\ref{a}|', '\\ref{a\\b|', '\\ref{a\n|', 'texte|',
  ]) {
    expect(ctxOf(outside), outside).toBeNull();
  }
  // « \% » is text, not a comment.
  expect(ctxOf('50 \\% voir \\ref{|')).toEqual({ kind: 'ref', from: 16, prefix: '' });
});

test('completionsFor : les labels avec le titre de leur nœud, les clés avec la citation courte, sans casse ni accents', () => {
  const s = store.loadState(), registry = LatexRegistry.build(s, textsOf(s));
  expect(completionsFor(ctxOf('\\ref{md|')!, registry)).toEqual([{ label: 'mdl:enonce', detail: MDL }]);
  expect(completionsFor(ctxOf('\\cite{LI|')!, registry)).toEqual([{ label: 'li2008', detail: 'Li et Vitányi, 2008' }]);
  // Every label, the tag of a title among them, each once, in the French order.
  expect(completionsFor(ctxOf('\\eqref{|')!, registry)).toEqual([
    { label: 'ent:def', detail: 'Entropie de Shannon' }, { label: 'kc:def', detail: 'Complexité de Kolmogorov' },
    { label: 'kc:section', detail: 'Complexité de Kolmogorov' }, { label: 'mdl:enonce', detail: MDL }, { label: 'solomonoff', detail: 'Induction de Solomonoff' },
  ]);
  // Accents and case: « É » typed finds « e », « E » finds « é ».
  run(s, editNode(s, ids.nodes.occam, { summary: '\\label{écart}' }));
  const accented = LatexRegistry.build(s, textsOf(s));
  expect(completionsFor({ kind: 'ref', from: 0, prefix: 'EC' }, accented).map((c) => c.label)).toEqual(['écart']);
  expect(completionsFor({ kind: 'ref', from: 0, prefix: 'Én' }, accented).map((c) => c.label)).toEqual(['ent:def']);
  expect(completionsFor({ kind: 'cite', from: 0, prefix: 'x' }, accented)).toEqual([]);
});

test('diagnosticsFor : complexité.tex — un label inconnu à sa place, un label défini ailleurs aussi, une erreur à sa ligne', () => {
  const s = store.loadState();
  // kc:def also in Occam's summary.
  run(s, editNode(s, ids.nodes.occam, { summary: 'Voir \\begin{equation}\\label{kc:def}x\\end{equation}' }));
  const texts = textsOf(s), registry = LatexRegistry.build(s, texts);
  const tex = s.nodes.get(ids.nodes.kolmogorov)!.files.find((f) => f.name === 'complexité.tex')!;
  const text = texts.get(tex.hash)!;
  const own: Origin = { kind: 'file', node: ids.nodes.kolmogorov, name: tex.name };
  const req = buildRequest({ origin: own, source: text, s, registry, known: [], widthCm: 9 });
  const lineStart = lineStarts(text);
  const absent = text.indexOf('absent:label'), kcDef = text.indexOf('\\label{kc:def}') + '\\label{'.length;
  expect(diagnosticsFor(scanTex(text), req, registry, own, null, lineStart)).toEqual([
    { from: kcDef, to: kcDef + 'kc:def'.length, severity: 'error', message: 'Ce label existe déjà dans « Rasoir d’Occam formalisé »' },
    { from: absent, to: absent + 'absent:label'.length, severity: 'error', message: 'Label inconnu : absent:label' },
  ]);
  // A compilation error at line 4: line 4 whole.
  const error: TexError = { message: 'Undefined control sequence.', line: 4, where: 'source' };
  const diags = diagnosticsFor(scanTex(text), req, registry, own, error, lineStart);
  expect(diags).toContainEqual({ from: lineStart(4), to: lineStart(5) - 1, severity: 'error', message: 'Undefined control sequence.' });
  expect(text.slice(lineStart(4), lineStart(5) - 1)).toBe('\\begin{equation}\\label{kc:def}');
  // An error of the preamble, or without a line: not in the editor (the banner says it).
  for (const e of [{ ...error, where: 'preamble' as const }, { ...error, line: null }]) {
    expect(diagnosticsFor(scanTex(text), req, registry, own, e, lineStart)).toHaveLength(2);
  }
});

test('diagnosticsFor : un label en double ici ou ailleurs, une clé inconnue, une clé portée par deux nœuds', () => {
  const s = store.loadState();
  // ent:def doubled (Entropie and MDL), li2008 on two nodes (the publication and MDL).
  run(s, editNode(s, ids.nodes.mdl, { summary: '\\label{ent:def}', tags: [...s.nodes.get(ids.nodes.mdl)!.tags, { key: CITE_KEY_TAG, value: 'li2008' }] }));
  const registry = LatexRegistry.build(s, textsOf(s));
  const own: Origin = { kind: 'summary', node: ids.nodes.occam };
  const text = '\\label{deux}\\label{deux} \\ref{ent:def} \\cite{li2008, inconnue} \\ref{solomonoff}';
  const req = buildRequest({ origin: own, source: text, s, registry, known: [], widthCm: 9 });
  const span = (name: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = text.indexOf(name, i + 1);
    return { from: i, to: i + name.length };
  };
  expect(diagnosticsFor(scanTex(text), req, registry, own, null, lineStarts(text))).toEqual([
    { ...span('deux', 0), severity: 'error', message: 'Label défini plusieurs fois : deux' },
    { ...span('deux', 1), severity: 'error', message: 'Label défini plusieurs fois : deux' },
    { ...span('ent:def'), severity: 'error', message: 'Label défini plusieurs fois : ent:def' },
    { ...span('li2008'), severity: 'error', message: 'Clé de citation portée par plusieurs nœuds : li2008' },
    { ...span('inconnue'), severity: 'error', message: 'Clé de citation inconnue : inconnue' },
  ]);
});

test('diagnosticsFor : un nom coupé par un commentaire est marqué sur toute sa portée, sous son nom', () => {
  const s = store.loadState(), registry = LatexRegistry.build(s, textsOf(s));
  const own: Origin = { kind: 'summary', node: ids.nodes.occam };
  const text = '\\ref{abs%\n  ent}';
  const req = buildRequest({ origin: own, source: text, s, registry, known: [], widthCm: 9 });
  expect(diagnosticsFor(scanTex(text), req, registry, own, null, lineStarts(text))).toEqual([
    { from: 5, to: text.length - 1, severity: 'error', message: 'Label inconnu : absent' },
  ]);
});

test('lineStartOf : le premier caractère d’une ligne, comptée à partir de 1 ; la longueur + 1 après la dernière', () => {
  const text = 'a\nbc\n\nd';
  const expected = lineStarts(text);
  for (let line = 1; line <= 6; line++) expect(lineStartOf(text, line), String(line)).toBe(expected(line));
  expect(lineStartOf('', 1)).toBe(0);
  expect(lineStartOf('', 2)).toBe(1);
});

test('suggestionOptions : le nombre de suggestions montrées et leur délai sont des réglages (plan 4b, tâche 6)', () => {
  expect(suggestionOptions(DEFAULT_PARAMS)).toEqual({ maxRenderedOptions: 100, activateOnTypingDelay: 100 });
  expect(suggestionOptions({ ...DEFAULT_PARAMS, latexSuggestionsMax: 30, latexSuggestionDelayMs: 0 })).toEqual({ maxRenderedOptions: 30, activateOnTypingDelay: 0 });
});
