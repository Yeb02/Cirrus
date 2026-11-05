import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOps, CITE_KEY_TAG, deleteEverywhere, editNode, type Id, type KnownLabel, preambleText, setPreamble, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { filePath, LocalStore } from '@cirrus/store';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fileKind } from '../src/renderer/files/kind.ts';
import { LatexRegistry, shortCitation } from '../src/renderer/latex/registry.ts';
import { buildRequest } from '../src/renderer/latex/request.ts';

// One test base for the whole file, never the user's: each test reads its state from the store again.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-latexrequest-'));
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
const fileOf = (s: State, node: Id, name: string) => s.nodes.get(node)!.files.find((f) => f.name === name)!;

test('buildRequest : complexité.tex de la base de test', () => {
  const s = store.loadState(), texts = textsOf(s), registry = LatexRegistry.build(s, texts);
  const tex = fileOf(s, ids.nodes.kolmogorov, 'complexité.tex');
  const known: KnownLabel[] = [{ label: 'kc:def', number: '1', page: '1', anchor: 'equation.0.1' }];
  const req = buildRequest({ origin: { kind: 'file', node: ids.nodes.kolmogorov, name: tex.name }, source: texts.get(tex.hash)!, s, registry, known });
  expect(req).toMatchObject({ slot: `file:${ids.nodes.kolmogorov}:complexité.tex`, mode: 'page', source: texts.get(tex.hash), preamble: preambleText(s) });
  expect(req.refs).toEqual([
    { label: 'mdl:enonce', title: MDL, node: ids.nodes.mdl },
    // An equation of Entropie's summary.
    { label: 'ent:def', title: 'Entropie de Shannon', node: ids.nodes.entropie },
    // The label tag of Solomonoff's title.
    { label: 'solomonoff', title: 'Induction de Solomonoff', node: ids.nodes.solomonoff },
  ]);
  expect(req.broken).toEqual(['absent:label']);
  expect(req.doubled).toEqual([]);
  expect(req.cites).toEqual([{ key: 'li2008', text: 'Li et Vitányi, 2008', node: ids.nodes.publication }]);
  expect(req.doubledCites).toEqual([]);
  expect(req.unknownCites).toEqual([]);
  // Its own label: its number comes from its .aux (known), not from the registry.
  expect(req.refs.map((r) => r.label)).not.toContain('kc:def');
  expect(req.known).toEqual(known);
  expect(req.resources).toEqual([fileOf(s, ids.nodes.kolmogorov, 'schéma_compression.png')]);
});

test('buildRequest : un résumé et une relation se compilent en snippet ; une relation n’a pas de fichiers', () => {
  const s = store.loadState(), registry = LatexRegistry.build(s, textsOf(s));
  run(s, setPreamble(s, '\\documentclass{article}\n\\usepackage{amsmath}\n'));
  const summary = buildRequest({ origin: { kind: 'summary', node: ids.nodes.mdl }, source: 'Voir \\ref{solomonoff} et \\cite{li2009}.', s, registry, known: [] });
  expect(summary).toMatchObject({
    slot: `summary:${ids.nodes.mdl}`, mode: 'snippet', preamble: '\\documentclass{article}\n\\usepackage{amsmath}\n',
    refs: [{ label: 'solomonoff', title: 'Induction de Solomonoff', node: ids.nodes.solomonoff }], broken: [], cites: [], unknownCites: ['li2009'],
  });
  // Every file of the node, its .tex among them (\input{Enoncé_détaillé}).
  expect(summary.resources).toEqual(s.nodes.get(ids.nodes.mdl)!.files);
  const relation = buildRequest({ origin: { kind: 'relation', connection: ids.connections.mdlSolomonoff }, source: '\\ref{mdl:enonce}', s, registry, known: [] });
  expect(relation).toMatchObject({ slot: `relation:${ids.connections.mdlSolomonoff}`, mode: 'snippet', refs: [{ label: 'mdl:enonce', node: ids.nodes.mdl }], resources: [] });
});

test('buildRequest : un doublon avec sa première définition, le texte tel que tapé l’emporte sur le registre, une clé portée par deux nœuds', () => {
  const s = store.loadState();
  // ent:def defined twice (Entropie, Occam); li2008 on two nodes (MDL, the publication).
  run(s, editNode(s, ids.nodes.occam, { summary: '\\label{ent:def} \\label{propre}' }));
  run(s, editNode(s, ids.nodes.mdl, { tags: [...s.nodes.get(ids.nodes.mdl)!.tags, { key: CITE_KEY_TAG, value: 'li2008' }] }));
  const registry = LatexRegistry.build(s, new Map());
  const [first] = [ids.nodes.entropie, ids.nodes.occam].sort();
  const doubled = buildRequest({ origin: { kind: 'summary', node: ids.nodes.kolmogorov }, source: '\\eqref{ent:def} \\ref{ent:def}', s, registry, known: [] });
  expect(doubled.doubled).toEqual([{ label: 'ent:def', title: s.nodes.get(first)!.title, node: first }]);
  expect(doubled.refs).toEqual([]);
  // Occam's summary as typed now, not yet in the state: it still defines ent:def (its own number wins, the duplicate is
  // the editor's), no longer propre (the registry's older version of this very source does not count), and cites li2008.
  const typed = buildRequest({
    origin: { kind: 'summary', node: ids.nodes.occam }, source: '\\label{ent:def} \\ref{ent:def} \\ref{propre} \\ref{solomonoff} \\ref{solomonoff} \\cite{li2008, li2008}',
    s, registry, known: [],
  });
  expect(typed).toMatchObject({ refs: [{ label: 'solomonoff' }], broken: ['propre'], doubled: [] });
  // li2008 on two nodes: red in the preview, with the first's citation (Review Focus 5), not among the cites.
  const [byId] = [ids.nodes.mdl, ids.nodes.publication].sort();
  expect(typed.cites).toEqual([]);
  expect(typed.doubledCites).toEqual([{ key: 'li2008', text: shortCitation(s.nodes.get(byId)!), node: byId }]);
  // Once one of them is in the trash, the other is the key's only node.
  run(s, deleteEverywhere(s, ids.nodes.mdl));
  const after = buildRequest({ origin: { kind: 'summary', node: ids.nodes.occam }, source: '\\cite{li2008}', s, registry, known: [] });
  expect(after).toMatchObject({ cites: [{ key: 'li2008', text: 'Li et Vitányi, 2008', node: ids.nodes.publication }], doubledCites: [], unknownCites: [] });
});
