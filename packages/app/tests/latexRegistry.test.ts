import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, applyOps, CITE_KEY_TAG, deleteConnection, deleteEverywhere, editConnection, editNode, type FileRef, type Id, LABEL_TAG, type NodeRec,
  removeFromPlan, type State, type TagValue,
} from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { filePath, LocalStore } from '@cirrus/store';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { fileKind } from '../src/renderer/files/kind.ts';
import { LatexRegistry, shortCitation, slotOf } from '../src/renderer/latex/registry.ts';
import { scanTex } from '../src/renderer/latex/scan.ts';
import { loadTexTexts } from '../src/renderer/latex/texts.ts';

// One test base for the whole file, never the user's: each test reads its state from the store again.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-latexregistry-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const MB = 2 ** 20;
const MDL = 'Minimum Description Length Principle (MDL)';
const kv = (key: string, value: string | number): TagValue => ({ key, value });
/** Applies an action computed on `s` to `s`, as the session does once it is written. */
const run = (s: State, a: Action) => applyOps(s, a.ops);
/** The texts of the base's .tex, by hash, read from the store as loadTexTexts would. */
function textsOf(s: State): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of s.nodes.values()) for (const f of n.files) if (fileKind(f.name) === 'tex') out.set(f.hash, readFileSync(filePath(dir, f), 'utf8'));
  return out;
}
const texOf = (s: State, node: Id, name: string) => s.nodes.get(node)!.files.find((f) => f.name === name)!;

test('slotOf : un emplacement par source', () => {
  expect(slotOf({ kind: 'summary', node: 'n1' })).toBe('summary:n1');
  expect(slotOf({ kind: 'relation', connection: 'c1' })).toBe('relation:c1');
  expect(slotOf({ kind: 'file', node: 'n1', name: 'a b:é.tex' })).toBe('file:n1:a b:é.tex');
});

test('registre : un label défini dans deux nœuds a deux définitions, dans l’ordre des identifiants', () => {
  const s = store.loadState();
  run(s, editNode(s, ids.nodes.mdl, { summary: 'Rappel\\footnote{x}\n\\label{ent:def}' }));
  const defs = LatexRegistry.build(s, textsOf(s)).definitions('ent:def');
  expect(defs.map((d) => d.node)).toEqual([ids.nodes.entropie, ids.nodes.mdl].sort());
  expect(defs).toContainEqual({ label: 'ent:def', origin: { kind: 'summary', node: ids.nodes.mdl }, line: 2, title: MDL, node: ids.nodes.mdl });
  expect(defs).toContainEqual({
    label: 'ent:def', origin: { kind: 'summary', node: ids.nodes.entropie }, line: 1, title: 'Entropie de Shannon', node: ids.nodes.entropie,
  });
  // Twice in one source: two definitions.
  run(s, editNode(s, ids.nodes.mdl, { summary: '\\label{deux}\\label{deux}' }));
  expect(LatexRegistry.build(s, textsOf(s)).definitions('deux')).toHaveLength(2);
  expect(LatexRegistry.build(s, textsOf(s)).definitions('inconnu')).toEqual([]);
});

test('registre : un nœud ou une connexion à la corbeille ne définit plus rien', () => {
  const s = store.loadState();
  run(s, editConnection(s, ids.connections.mdlSolomonoff, { relation: 'Un analogue \\label{rel:bayes}.' }));
  // Entropie is in the lobby only: it goes to the trash.
  run(s, removeFromPlan(s, ids.plans.lobby, ids.nodes.entropie));
  expect(s.nodes.get(ids.nodes.entropie)!.trashedAt).toBeDefined();
  run(s, deleteEverywhere(s, ids.nodes.kolmogorov));
  run(s, deleteConnection(s, ids.connections.mdlSolomonoff));
  run(s, editNode(s, ids.nodes.trashed, { summary: '\\label{brouillon}', tags: [kv(LABEL_TAG, 'brouillon2')] }));
  const r = LatexRegistry.build(s, textsOf(s));
  for (const label of ['ent:def', 'kc:def', 'kc:section', 'rel:bayes', 'brouillon', 'brouillon2']) expect(r.definitions(label), label).toEqual([]);
  expect(r.labels().map((d) => d.label).sort()).toEqual(['mdl:enonce', 'solomonoff']);
});

test('registre : un label d’une relation porte le titre de la connexion', () => {
  const s = store.loadState();
  run(s, editConnection(s, ids.connections.mdlSolomonoff, { relation: 'Un analogue\n\\label{rel:bayes}.' }));
  expect(LatexRegistry.build(s, textsOf(s)).definitions('rel:bayes')).toEqual([
    { label: 'rel:bayes', origin: { kind: 'relation', connection: ids.connections.mdlSolomonoff }, line: 2, title: 'Analogue bayésien', node: null },
  ]);
});

test('registre : le tag label: solomonoff définit solomonoff, d’origine title, avec le titre du nœud', () => {
  const r = LatexRegistry.build(store.loadState(), new Map());
  expect(r.definitions('solomonoff')).toEqual([
    { label: 'solomonoff', origin: { kind: 'title', node: ids.nodes.solomonoff }, line: 0, title: 'Induction de Solomonoff', node: ids.nodes.solomonoff },
  ]);
});

test('registre : un tag label qui reprend le \\label d’un .tex d’un autre nœud donne deux définitions', () => {
  const s = store.loadState();
  const pub = s.nodes.get(ids.nodes.publication)!;
  run(s, editNode(s, pub.id, { tags: [...pub.tags, kv(LABEL_TAG, 'kc:def')] }));
  const defs = LatexRegistry.build(s, textsOf(s)).definitions('kc:def');
  expect(defs).toHaveLength(2);
  expect(defs).toContainEqual({
    label: 'kc:def', origin: { kind: 'file', node: ids.nodes.kolmogorov, name: 'complexité.tex' }, line: 4, title: 'Complexité de Kolmogorov',
    node: ids.nodes.kolmogorov,
  });
  expect(defs).toContainEqual({ label: 'kc:def', origin: { kind: 'title', node: pub.id }, line: 0, title: pub.title, node: pub.id });
  // The .tex are sources only once read: without their texts, only the tag.
  expect(LatexRegistry.build(s, new Map()).definitions('kc:def')).toEqual([defs.find((d) => d.origin.kind === 'title')]);
});

test('registre : citeNodes(\'li2008\') donne la publication de la base de test, citeKeys sa citation courte', () => {
  const s = store.loadState();
  const r = LatexRegistry.build(s, textsOf(s));
  expect(r.citeNodes('li2008')).toEqual([ids.nodes.publication]);
  expect(r.citeNodes('li2009')).toEqual([]);
  expect(r.citeKeys()).toEqual([{ key: 'li2008', node: ids.nodes.publication, text: 'Li et Vitányi, 2008' }]);
  // A key on two nodes: both, by identifier.
  run(s, editNode(s, ids.nodes.mdl, { tags: [...s.nodes.get(ids.nodes.mdl)!.tags, kv(CITE_KEY_TAG, 'li2008')] }));
  expect(LatexRegistry.build(s, new Map()).citeNodes('li2008')).toEqual([ids.nodes.mdl, ids.nodes.publication].sort());
});

test('registre : reconstruire après la modification d’un seul résumé n’analyse que lui', () => {
  let count = 0;
  const analyse = (text: string) => { count++; return scanTex(text); };
  const s = store.loadState(), texts = textsOf(s);
  const first = LatexRegistry.build(s, texts, undefined, analyse);
  // Two summaries (MDL, Entropie), three relations (Analogue bayésien, Déduction jointe, Source hors plan), two .tex.
  expect(count).toBe(7);
  count = 0;
  run(s, editNode(s, ids.nodes.entropie, { summary: '\\label{ent:autre}' }));
  const second = LatexRegistry.build(s, texts, first, analyse);
  expect(count).toBe(1);
  expect(second.definitions('ent:def')).toEqual([]);
  expect(second.definitions('ent:autre')).toHaveLength(1);
  // A title changed, nothing analysed again: the definitions take the new title.
  count = 0;
  run(s, editNode(s, ids.nodes.mdl, { title: 'MDL' }));
  const third = LatexRegistry.build(s, texts, second, analyse);
  expect(count).toBe(0);
  expect(third.definitions('mdl:enonce')[0]).toMatchObject({ title: 'MDL', node: ids.nodes.mdl, line: 1 });
  // The analysis of a source the registry holds is given back for the same text, made again for another.
  count = 0;
  const kc = { kind: 'file' as const, node: ids.nodes.kolmogorov, name: 'complexité.tex' };
  expect(third.scanOf(kc, texts.get(texOf(s, ids.nodes.kolmogorov, 'complexité.tex').hash)!).labels).toHaveLength(2);
  expect(count).toBe(0);
  expect(third.scanOf(kc, '\\label{a}').labels).toHaveLength(1);
});

test('registre : une définition sans titre est « Sans titre »', () => {
  const s = store.loadState();
  run(s, editConnection(s, ids.connections.split, { relation: '\\label{sans}' }));
  expect(LatexRegistry.build(s, new Map()).definitions('sans')[0].title).toBe('Sans titre');
});

const publication = (tags: TagValue[], title = 'Un livre'): NodeRec => ({ id: 'n', title, summary: '', tags, files: [] });

test('shortCitation : un auteur, deux, trois, aucun, et une date absente', () => {
  const date = kv('date_de_publication', '2008');
  expect(shortCitation(publication([kv('auteur', 'Ming Li'), date]))).toBe('Li, 2008');
  expect(shortCitation(publication([kv('auteur', 'Ming Li'), kv('auteur', 'Paul Vitányi'), date]))).toBe('Li et Vitányi, 2008');
  expect(shortCitation(publication([kv('auteur', 'Ming Li'), kv('auteur', 'Paul Vitányi'), kv('auteur', 'Ray Solomonoff'), date]))).toBe('Li et al., 2008');
  expect(shortCitation(publication([date]))).toBe('Un livre, 2008');
  expect(shortCitation(publication([kv('auteur', 'Ming Li'), kv('auteur', ' Paul  Vitányi ')]))).toBe('Li et Vitányi');
  expect(shortCitation(publication([]))).toBe('Un livre');
  // The year: the first four digits in a row, whatever the form of the date.
  expect(shortCitation(publication([kv('auteur', 'Li'), kv('date_de_publication', '2008-05-01')]))).toBe('Li, 2008');
  expect(shortCitation(publication([kv('auteur', 'Li'), kv('date_de_publication', '05/2008')]))).toBe('Li, 2008');
  expect(shortCitation(publication([kv('auteur', 'Li'), kv('date_de_publication', 2008)]))).toBe('Li, 2008');
  expect(shortCitation(publication([kv('auteur', 'Li'), kv('date_de_publication', 'inconnue')]))).toBe('Li');
});

/**
 * A fetch serving the store's blobs (cirrus-file://blob/<hash>/<name>), or `extra` by hash, else 404, a turn of the
 * event loop later: records the hashes asked and the most requests in flight at once.
 */
function storeFetch(extra: Map<string, Uint8Array> = new Map()) {
  let inFlight = 0, most = 0;
  const asked: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    const hash = /^cirrus-file:\/\/blob\/([0-9a-f]{64})\//.exec(url)![1];
    asked.push(hash);
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    let bytes = extra.get(hash);
    if (!bytes) {
      try { bytes = readFileSync(filePath(dir, { name: '', hash, size: 0 })); } catch { return new Response(null, { status: 404 }); }
    }
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { fetch, asked, most: () => most };
}
const signal = () => new AbortController().signal;
const hashOf = (i: number) => i.toString(16).padStart(64, '0');

test('loadTexTexts : les .tex de la base, quatre à la fois ; ceux déjà lus ne sont pas relus', async () => {
  const s = store.loadState();
  const extra = new Map<string, Uint8Array>(), refs: FileRef[] = [];
  for (let i = 1; i <= 6; i++) {
    const bytes = new TextEncoder().encode(`\\label{occam:${i}} é`);
    extra.set(hashOf(i), bytes);
    refs.push({ name: `note${i}.TEX`, hash: hashOf(i), size: bytes.length });
  }
  run(s, editNode(s, ids.nodes.occam, { files: [...refs, { name: 'pas_du_tex.txt', hash: hashOf(99), size: 3 }] }));
  const f = storeFetch(extra);
  vi.stubGlobal('fetch', f.fetch);
  const texts = await loadTexTexts(s, new Map(), MB, signal());
  expect(texts.size).toBe(8);
  expect(texts.get(texOf(s, ids.nodes.kolmogorov, 'complexité.tex').hash)).toBe(readFileSync(new URL('../../fixtures/assets/complexité.tex', import.meta.url), 'utf8'));
  expect(texts.get(hashOf(3))).toBe('\\label{occam:3} é');
  expect(f.asked).not.toContain(hashOf(99));
  expect(f.most()).toBe(4);
  // Again, with what was read: nothing more.
  const again = await loadTexTexts(s, texts, MB, signal());
  expect(f.fetch).toHaveBeenCalledTimes(8);
  expect(again).toEqual(texts);
  expect(LatexRegistry.build(s, again).definitions('occam:6')).toMatchObject([{ origin: { kind: 'file', node: ids.nodes.occam, name: 'note6.TEX' } }]);
});

test('loadTexTexts : un .tex plus grand que le plafond, binaire ou introuvable compte comme vide, sans planter (Review Focus 5)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = store.loadState();
  const big: FileRef = { name: 'gros.tex', hash: hashOf(1), size: MB + 1 };
  const binary: FileRef = { name: 'binaire.tex', hash: hashOf(2), size: 4 };
  const gone: FileRef = { name: 'absent.tex', hash: hashOf(3), size: 10 };
  run(s, editNode(s, ids.nodes.occam, { files: [big, binary, gone] }));
  const f = storeFetch(new Map([[hashOf(1), new Uint8Array(MB + 1)], [hashOf(2), new Uint8Array([0x5c, 0, 0x6c, 0x61])]]));
  vi.stubGlobal('fetch', f.fetch);
  const texts = await loadTexTexts(s, new Map(), MB, signal());
  for (const ref of [big, binary, gone]) expect(texts.get(ref.hash), ref.name).toBe('');
  // Beyond the ceiling, not even its head is read.
  expect(f.asked).not.toContain(hashOf(1));
  expect(warn).toHaveBeenCalledOnce();
  const r = LatexRegistry.build(s, texts);
  expect(r.labels().map((d) => d.label)).not.toContain('');
});

test('loadTexTexts : ni les .tex d’un nœud à la corbeille, ni les textes des fichiers partis ; un signal levé arrête tout', async () => {
  const s = store.loadState();
  run(s, deleteEverywhere(s, ids.nodes.kolmogorov));
  const f = storeFetch();
  vi.stubGlobal('fetch', f.fetch);
  const texts = await loadTexTexts(s, new Map([[hashOf(7), 'un texte d’avant']]), MB, signal());
  expect([...texts.keys()]).toEqual([texOf(s, ids.nodes.mdl, 'Enoncé_détaillé.tex').hash]);
  const stopped = new AbortController();
  stopped.abort();
  await expect(loadTexTexts(store.loadState(), new Map(), MB, stopped.signal)).rejects.toThrow();
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
