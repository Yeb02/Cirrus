import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Action, applyOps, BIB_MAX_PROBLEMS, BIB_NAME_CHARS, CITE_KEY_TAG, CommandError, editNode, type FileRef, groupOf, invertAction, parseBibtex, placementKey, type State,
  type TagValue,
} from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { bibBlock, buildScene, DEFAULT_PARAMS as P, offsetPolygon, type PlanScene, type SceneItem } from '@cirrus/view';
import { beforeEach, expect, test } from 'vitest';
import { BIB_STORE_BATCH, bibImportBuild, bibNotice, bibStoreFailure, bibText, planBib, type PlannedBib, storeBibs } from '../src/renderer/publications/bib.ts';
import { readableStep } from '../src/renderer/actions.ts';

const BIB_NAME = 'bibliographie.bib';
const BIB = readFileSync(fileURLToPath(new URL(`../../fixtures/assets/${BIB_NAME}`, import.meta.url)), 'utf8');
const LI = 'An Introduction to Kolmogorov Complexity and Its Applications';
const lineOf = (text: string, start: string) => text.split('\n').findIndex((l) => l.startsWith(start)) + 1;

let s: State, ids: FixtureIds, sc: PlanScene;
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-bib-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  sc = buildScene(s, ids.plans.lobby, measure, P);
});
const run = (a: Action) => { applyOps(s, a.ops); return a; };
const tag = (key: string, value: string): TagValue => ({ key, value });
const SKY = { x: 9000, y: 9000 };
/** A FileRef standing for each planned .bib, as storeTexts gives them. */
const refsOf = (b: PlannedBib): FileRef[] => b.items.map((x, i) => ({ name: x.plan.bib!.name, hash: i.toString(16).padStart(64, '0'), size: x.plan.bib!.text.length }));
const itemsOf = (b: PlannedBib) => { const refs = refsOf(b); return b.items.map((x, i) => ({ plan: x.plan, file: refs[i] })); };
const created = (a: Action) => a.ops.filter((o) => o.t === 'node' && o.before === null).map((o) => s.nodes.get((o as { after: { id: string } }).after.id)!);

test('planBib : le .bib de la base de test — sept publications, le livre de la base écarté par sa clé et nommé, l’entrée abîmée dite par sa ligne', () => {
  const b = planBib(s, BIB_NAME, BIB, P.publicationMaxAuthors);
  expect(b.name).toBe(BIB_NAME);
  expect(b.items.map((x) => x.plan.key)).toEqual(['shannon1948', 'kolmogorov1965', 'solomonoff1964', 'rissanen1978', 'grunwald2007', 'vaswani2017attention', 'hutter2005']);
  expect(b.items.map((x) => x.line)).toEqual(['@article{shannon1948', '@article{DBLP', '@article{solomonoff', '@article{rissanen', '@book{grunwald', '@misc{vaswani', '@book{hutter'].map((l) => lineOf(BIB, l)));
  const shannon = b.items[0].plan;
  expect(shannon.title).toBe('A Mathematical Theory of Communication');
  expect(shannon.tags).toEqual([tag('auteur', 'Claude E. Shannon'), tag('date_de_publication', '1948'), tag(CITE_KEY_TAG, 'shannon1948'), tag('doi', '10.1002/j.1538-7305.1948.tb01338.x')]);
  expect(shannon.bib!.name).toBe('shannon1948.bib');
  // The entry alone: the file's macros resolved (pit), its month kept as one.
  expect(b.items[1].plan.bib!.text).toContain('journal = {Problems of Information Transmission}');
  expect(shannon.bib!.text).toContain('month = jul');
  expect(b.items[4].plan.title).toBe('The Minimum Description Length Principle');
  expect(b.items[4].plan.tags[0]).toEqual(tag('auteur', 'Peter D. Grünwald'));
  expect(b.items[5].plan.tags.at(-1)).toEqual(tag('arxiv', '1706.03762'));
  expect(b.duplicates).toEqual([{ line: lineOf(BIB, '@book{li2008'), title: LI, why: `Déjà dans la base (même clé BibTeX) : « ${LI} ».` }]);
  expect(b.problems.map((p) => p.line)).toEqual([lineOf(BIB, '@article{casse2020')]);
  expect(b.problems[0].message).toMatch(/^Entrée « casse2020 » abîmée : « , » ou « } » est attendu après le champ « title »/);
  expect([b.omitted, b.stopped]).toEqual([0, null]);
});

test('planBib : les doublons à l’intérieur du fichier — même DOI, même clé, même titre et même année — nommés par leur ligne ; deux clés non sûres ne se comparent pas', () => {
  const text = [
    '@article{a1, title = {Premier}, year = 2001, doi = {10.5555/UN}}',
    '@article{a2, title = {Autre titre}, year = 2002, doi = {10.5555/un}}',
    '@article{cle2003, title = {Troisième}, year = 2003}',
    '@article{cle2003, title = {Quatrième}, year = 2004}',
    '@misc{t5, title = {Le Même Titre}, year = 2005}',
    '@misc{t6, title = {le même titre !}, year = 2005}',
    '@misc{DBLP:x/1, title = {Sept}, year = 2007}',
    '@misc{DBLP:x/1, title = {Huit}, year = 2008}',
  ].join('\n');
  const b = planBib(s, 'f.bib', text, 50);
  expect(b.items.map((x) => x.plan.title)).toEqual(['Premier', 'Troisième', 'Le Même Titre', 'Sept', 'Huit']);
  expect(b.duplicates).toEqual([
    { line: 2, title: 'Autre titre', why: 'Déjà plus haut dans le fichier, ligne 1 (même DOI) : « Premier ».' },
    { line: 4, title: 'Quatrième', why: 'Déjà plus haut dans le fichier, ligne 3 (même clé BibTeX) : « Troisième ».' },
    { line: 6, title: 'le même titre !', why: 'Déjà plus haut dans le fichier, ligne 5 (même titre et même année) : « Le Même Titre ».' },
  ]);
  // Two unsafe keys: their author-and-year keys, one after the other.
  expect(b.items.slice(3).map((x) => x.plan.key)).toEqual(['sept2007', 'huit2008']);
  // The key set aside with its entry is said once, as a duplicate (review M2); the unsafe one kept, by the parser.
  expect(b.problems).toEqual([{ line: 8, message: 'Entrée « DBLP:x/1 » : la clé est déjà celle de l’entrée de la ligne 7.' }]);
  // One said once even past the problems the parser lists: its count goes down.
  const many = planBib(s, 'g.bib', [...Array.from({ length: 300 }, (_, i) => `@misc{b${i} title}`), '@misc{k1, title = {A}}', '@misc{K1, title = {B}}'].join('\n'), 50);
  expect(many.duplicates.map((d) => d.line)).toEqual([302]);
  expect(many.omitted).toBe(300 - BIB_MAX_PROBLEMS);
  // The only one past the list: no « Et N autres problèmes. » counted as a problem any more.
  const one = planBib(s, 'g.bib', [...Array.from({ length: BIB_MAX_PROBLEMS }, (_, i) => `@misc{b${i} title}`), '@misc{k1, title = {A}}', '@misc{K1, title = {B}}'].join('\n'), 50);
  expect([one.omitted, one.problems.length]).toEqual([0, BIB_MAX_PROBLEMS]);
  expect(bibNotice(one, 1, 2).split('\n').at(-1)).toBe(`– et ${(BIB_MAX_PROBLEMS - 2).toLocaleString('fr-FR')} autres.`);
});

test('planBib (revue M1, M2) : deux clés qui ne diffèrent que par la casse sont un doublon, comme pour BibTeX, et dit une fois', () => {
  const b = planBib(s, 'f.bib', '@misc{Smith2020, title = {Un}, author = {Smith, A.}, year = 2020}\n@misc{smith2020, title = {Deux}, author = {Smith, B.}, year = 2020}', 50);
  expect(b.items.map((x) => x.plan.key)).toEqual(['Smith2020']);
  expect(b.duplicates).toEqual([{ line: 2, title: 'Deux', why: 'Déjà plus haut dans le fichier, ligne 1 (même clé BibTeX) : « Un ».' }]);
  expect(b.problems).toEqual([]);
});

test('planBib (règle du contrôleur, revue M3) : les clés propres sûres du fichier sont réservées avant toute clé fabriquée — une entrée garde la sienne, un \\cite existant la désigne', () => {
  const b = planBib(s, 'f.bib', '@misc{DBLP:x/1, title = {A}, author = {Li, M.}, year = 2008}\n@misc{li2008b, title = {B}, author = {Li, M.}, year = 2008}\n@misc{li2008c, title = {C}, author = {Li, M.}, year = 2008}', 50);
  // li2008 is the base's book's; li2008b and li2008c are the next entries' own: the first gets li2008d.
  expect(b.items.map((x) => x.plan.key)).toEqual(['li2008d', 'li2008b', 'li2008c']);
  // Reserved, never a mark: the entry made li2008d is no duplicate of the one whose own key it would have been.
  const c = planBib(s, 'f.bib', '@misc{DBLP:x/1, title = {A}, author = {Vitányi, P.}, year = 2009}\n@misc{vitanyi2009, title = {B}, author = {Vitányi, P.}, year = 2009}', 50);
  expect(c.items.map((x) => x.plan.key)).toEqual(['vitanyi2009b', 'vitanyi2009']);
  expect(c.duplicates).toEqual([]);
});

test('planBib (règle du contrôleur ; revue M3) : la première entrée He_2016, contredite par un nœud de la base, reçoit he2016b — he2016 étant la clé propre de la seconde, réservée — et la seconde, sans identifiant, garde he2016 sans être un doublon', () => {
  run(editNode(s, ids.nodes.monde, { title: 'Deep Residual Learning for Image Recognition', tags: [tag('clé_bibtex', 'He_2016'), tag('doi', '10.1109/CVPR.2016.90'), tag('date_de_publication', '2016')] }));
  const text = [
    '@inproceedings{He_2016, title={Identity Mappings in Deep Residual Networks}, author={He, Kaiming}, year={2016}, doi={10.1007/978-3-319-46493-0_38}}',
    '@misc{he2016, title={Une autre œuvre de He}, author={He, Kaiming}, year={2016}}',
  ].join('\n');
  const b = planBib(s, 'he.bib', text, 50);
  expect(b.duplicates).toEqual([]);
  expect(b.items.map((x) => x.plan.key)).toEqual(['he2016b', 'he2016']);
  // The marks: each entry's own key only.
  expect(b.items.map((x) => x.plan.marks.keys)).toEqual([['He_2016'], ['he2016']]);
});

test('bibStoreFailure (revue M6) : la raison du magasin, telle que le principal l’a dite, est dans la notification', () => {
  expect(bibStoreFailure(new Error('Error invoking remote method \'cirrus:files:store-texts\': Error: Les textes font plus de 200 Mo ensemble : ils ne sont pas enregistrés.')))
    .toBe('Les fichiers .bib des publications n’ont pas pu être enregistrés dans la base : Les textes font plus de 200 Mo ensemble : ils ne sont pas enregistrés. Rien n’est importé.');
  expect(bibStoreFailure('ENOSPC')).toBe('Les fichiers .bib des publications n’ont pas pu être enregistrés dans la base : ENOSPC. Rien n’est importé.');
});

test('bibImportBuild : une seule action « Importer 7 publications », le bloc centré sous le curseur au cran lisible, chaque nœud avec ses tags et son <clé>.bib ; un seul Ctrl+Z retire tout', () => {
  const b = planBib(s, BIB_NAME, BIB, 50), items = itemsOf(b);
  const lines = items.map((x) => measure(x.plan.title));
  const zoom = 0.25, k = readableStep(zoom, P);
  const a = run(bibImportBuild(items, sc, SKY, zoom, P, lines)!(s));
  expect(a.label).toBe('Importer 7 publications');
  const nodes = created(a);
  expect(nodes.map((n) => n.title)).toEqual(items.map((x) => x.plan.title));
  const offsets = bibBlock(7, k, P, lines);
  nodes.forEach((n, i) => {
    expect(n.tags).toEqual(items[i].plan.tags);
    expect(n.files).toEqual([items[i].file]);
    expect(s.placements.get(placementKey(ids.plans.lobby, n.id))).toEqual({ plan: ids.plans.lobby, node: n.id, x: SKY.x + offsets[i].x, y: SKY.y + offsets[i].y, k });
    expect(groupOf(s, ids.plans.lobby, n.id)).toBeUndefined();
  });
  run(invertAction(a));
  for (const n of nodes) expect(s.nodes.has(n.id)).toBe(false);
  // One publication: its own label.
  expect(bibImportBuild(items.slice(0, 1), sc, SKY, zoom, P)!(s).label).toBe('Importer une publication');
  expect(bibImportBuild([], sc, SKY, zoom, P)).toBeNull();
});

test('bibImportBuild : sous le curseur dans l’enveloppe d’un groupe, tout le bloc y entre, comme un collage ; revérifié au calcul, rien n’est créé si une publication ou une clé est entrée entre-temps', () => {
  const b = planBib(s, BIB_NAME, BIB, 50), items = itemsOf(b);
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!] as SceneItem;
  const at = offsetPolygon(g.hull!, g.pad! * 0.4).reduce((q, x) => (x.y > q.y ? x : q));
  const a = run(bibImportBuild(items, sc, at, 0.25, P)!(s));
  for (const n of created(a)) expect(groupOf(s, ids.plans.lobby, n.id)).toBe(ids.nodes.groupeML);
  // Imported again by then: refused, the node named, nothing made.
  const count = s.nodes.size;
  expect(() => bibImportBuild(items, sc, SKY, 0.25, P)!(s)).toThrow(CommandError);
  expect(() => bibImportBuild(items, sc, SKY, 0.25, P)!(s)).toThrow(/^Déjà dans la base \(même DOI\) : « A Mathematical Theory of Communication »\. Rien n’est importé/);
  expect(s.nodes.size).toBe(count);
  run(invertAction(a));
  // A key made for the block, taken meanwhile by a node with another identity: refused too.
  run(editNode(s, ids.nodes.occam, { tags: [tag('clé_bibtex', 'KOLMOGOROV1965'), tag('doi', '10.9999/autre')] }));
  expect(() => bibImportBuild(items, sc, SKY, 0.25, P)!(s)).toThrow('La clé « kolmogorov1965 » a été prise entre-temps. Rien n’est importé : recommence l’import du fichier.');
});

test('bibNotice : les publications posées, les doublons écartés en nommant le nœud existant, les entrées abîmées par leur ligne', () => {
  const b = planBib(s, BIB_NAME, BIB, 50);
  expect(bibNotice(b, 7, 5)).toBe([
    `7 publications importées de « ${BIB_NAME} ».`,
    '1 doublon écarté :',
    `– ligne ${lineOf(BIB, '@book{li2008')}, « ${LI} » : déjà dans la base (même clé BibTeX) : « ${LI} ».`,
    '1 problème de lecture :',
    `– ligne ${lineOf(BIB, '@article{casse2020')} : ${b.problems[0].message}`,
  ].join('\n'));
  expect(bibNotice({ ...b, duplicates: [], problems: [] }, 1, 5)).toBe(`1 publication importée de « ${BIB_NAME} ».`);
});

test('bibNotice : lisible avec 2 000 doublons ou 1 000 problèmes — bibNoticeLines lignes par liste, puis « et N autres » ; les noms tirés du fichier coupés', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `@article{k${i}, title = {Titre ${i}}, year = 2000, doi = {10.5555/${i}}}`).join('\n');
  const first = planBib(s, 'grand.bib', text, 50);
  run(bibImportBuild(itemsOf(first), sc, SKY, 1, P)!(s));
  const again = planBib(s, 'grand.bib', text, 50);
  expect(again.items).toEqual([]);
  expect(again.duplicates).toHaveLength(2000);
  const dup = bibNotice(again, 0, 5).split('\n');
  expect(dup).toEqual([
    'Aucune publication importée de « grand.bib » : aucune entrée nouvelle.',
    `${(2000).toLocaleString('fr-FR')} doublons écartés :`,
    ...Array.from({ length: 5 }, (_, i) => `– ligne ${i + 1}, « Titre ${i} » : déjà dans la base (même DOI) : « Titre ${i} ».`),
    `– et ${(1995).toLocaleString('fr-FR')} autres.`,
  ]);
  // A thousand broken entries: the parser lists BIB_MAX_PROBLEMS, counts the rest; the notification, as many lines as set.
  const broken = planBib(s, 'abime.bib', Array.from({ length: 1000 }, (_, i) => `@misc{b${i} title}`).join('\n'), 50);
  const lines = bibNotice(broken, 0, 3).split('\n');
  expect(lines).toHaveLength(1 + 1 + 3 + 1);
  expect(lines[0]).toBe('Aucune publication importée de « abime.bib » : il ne contient aucune entrée lisible.');
  expect(lines[1]).toBe(`${(1000).toLocaleString('fr-FR')} problèmes de lecture :`);
  expect(lines[5]).toBe(`– et ${(1000 - 3).toLocaleString('fr-FR')} autres.`);
  expect(broken.problems).toHaveLength(BIB_MAX_PROBLEMS + 1);
  // A macro of 200 000 characters named nowhere, a title of a megabyte twice: cut, the whole notification short.
  const huge = 'T'.repeat(1 << 20);
  const hostile = planBib(s, `${'n'.repeat(500)}.bib`, `@string{a = ${'m'.repeat(200_000)}}\n@misc{x1, title = {${huge}}, year = 2000}\n@misc{x2, title = {${huge}}, year = 2000}`, 50);
  expect(hostile.duplicates).toHaveLength(1);
  const said = bibNotice(hostile, hostile.items.length, 5);
  expect(said.length).toBeLessThan(2000);
  for (const l of said.split('\n')) expect(l.length).toBeLessThan(4 * BIB_NAME_CHARS + 120);
  expect(said).toContain(`${'T'.repeat(BIB_NAME_CHARS)}…`);
  // An empty file, or one without entries: said, nothing to put down.
  expect(bibNotice(planBib(s, 'vide.bib', '', 50), 0, 5)).toBe('« vide.bib » ne contient aucune entrée BibTeX : rien n’est importé.');
  expect(bibNotice(planBib(s, 'rien.bib', '@comment{x}\n@string{a = "b"}', 50), 0, 5)).toBe('« rien.bib » ne contient aucune entrée BibTeX : rien n’est importé.');
});

test('bibNotice : un fichier trop grand, ou lu en partie, le dit en tête', () => {
  const big = planBib(s, 'gros.bib', ' '.repeat(16 * 2 ** 20 + 1), 50);
  expect(big.items).toEqual([]);
  expect(bibNotice(big, 0, 5).split('\n')).toEqual([
    'Aucune publication importée de « gros.bib » : il ne contient aucune entrée lisible.',
    `Le fichier fait ${(16 * 2 ** 20 + 1).toLocaleString('fr-FR')} caractères, plus que les ${(16 * 2 ** 20).toLocaleString('fr-FR')} qu’un .bib peut compter : il n’est pas lu.`,
  ]);
  const head = '@a(k,t={\n'.repeat(1230) + '%}\n'.repeat(1230) + '#';
  const part = planBib(s, 'partiel.bib', '@misc{avant, title = {Lue}}\n' + Array.from({ length: 300 }, (_, i) => `@misc{b${i} title}`).join('\n') + '\n' + head + 'x'.repeat(2_000_000), 50);
  const lines = bibNotice(part, 1, 2).split('\n');
  expect(lines[0]).toBe('1 publication importée de « partiel.bib ».');
  expect(lines[1]).toMatch(/^Le fichier est trop abîmé pour être lu en entier : la lecture s’arrête ligne \d+\.$/);
  expect(lines[2]).toMatch(/^\d[\d\s]* problèmes de lecture :$/);
  expect(lines).toHaveLength(2 + 1 + 2 + 1);
});

test('bibText : UTF-8, avec ou sans BOM ; Windows-1252 ; UTF-16 avec BOM ; un binaire refusé, nommé', () => {
  const e = '@misc{a, title = {Vitányi}}';
  const utf8 = new TextEncoder().encode(e);
  expect(bibText({ name: 'a.bib', bytes: utf8 })).toEqual({ text: e });
  expect(bibText({ name: 'a.bib', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]) })).toEqual({ text: e });
  const latin = Uint8Array.from([...e].map((c) => c.charCodeAt(0)));
  expect(bibText({ name: 'a.bib', bytes: latin })).toEqual({ text: e });
  const utf16 = new Uint8Array([0xff, 0xfe, ...[...e].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
  expect(bibText({ name: 'a.bib', bytes: utf16 })).toEqual({ text: e });
  expect(bibText({ name: 'image.bib', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) })).toEqual({ refused: '« image.bib » n’est pas un fichier texte : rien n’est importé.' });
});

test('storeBibs : par lots de BIB_STORE_BATCH, dans l’ordre, la progression dite ; arrêté, plus rien n’est envoyé ; un refus du magasin rejette', async () => {
  const texts = Array.from({ length: 250 }, (_, i) => ({ name: `k${i}.bib`, text: `@misc{k${i}}\n` }));
  const batches: number[] = [], progress: number[] = [];
  const store = async (batch: { name: string; text: string }[]) => { batches.push(batch.length); return batch.map((t) => ({ name: t.name, hash: '0'.repeat(64), size: t.text.length })); };
  const refs = await storeBibs(texts, store, (n) => progress.push(n), () => false);
  expect(BIB_STORE_BATCH).toBe(100);
  expect(batches).toEqual([100, 100, 50]);
  expect(progress).toEqual([100, 200, 250]);
  expect(refs!.map((r) => r.name)).toEqual(texts.map((t) => t.name));
  // Stopped (Escape) after the first batch: no other is sent.
  let stop = false;
  batches.length = 0;
  expect(await storeBibs(texts, async (batch) => { stop = true; return store(batch); }, () => {}, () => stop)).toBeNull();
  expect(batches).toEqual([100]);
  await expect(storeBibs(texts, () => Promise.reject(new Error('ENOSPC')), () => {}, () => false)).rejects.toThrow('ENOSPC');
});

test('un .bib de 2 000 entrées : l’analyse, le plan et l’action sous la seconde, trois fois', () => {
  const text = Array.from({ length: 2000 }, (_, i) => [
    `@article{auteur${i}${i % 7 === 0 ? ':dblp' : ''},`,
    `  author = {Nom${i}, Pr{\\'e}nom and von Autre, Jean and Troisième, Personne},`,
    `  title = {Un {titre} n°${i} -- avec des {\\"u}mlauts et des accents {\\'e}},`,
    '  journal = {Revue}, volume = 3, pages = {1--20},',
    `  year = ${1900 + (i % 120)}, month = mar${i % 3 === 0 ? `, doi = {10.5555/x.${i}}` : ''}`,
    '}',
  ].join('\n')).join('\n') + `\n@book{li2008, title = {${LI}}, year = 2008}`;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    const b = planBib(s, 'bibliotheque.bib', text, 50);
    const t1 = performance.now();
    const items = itemsOf(b), lines = items.map((x) => measure(x.plan.title));
    const a = bibImportBuild(items, sc, SKY, 1, P, lines)!(s);
    const t2 = performance.now();
    console.log(`2 000 entrées, passe ${pass + 1} : lecture et plan ${(t1 - t0).toFixed(0)} ms, action ${(t2 - t1).toFixed(0)} ms, en tout ${(t2 - t0).toFixed(0)} ms`);
    expect(b.items).toHaveLength(2000);
    expect(b.duplicates.map((d) => d.title)).toEqual([LI]);
    expect(a.label).toBe(`Importer ${(2000).toLocaleString('fr-FR')} publications`);
    expect(a.ops.filter((o) => o.t === 'node')).toHaveLength(2000);
    expect(t2 - t0).toBeLessThan(1000);
  }
});
