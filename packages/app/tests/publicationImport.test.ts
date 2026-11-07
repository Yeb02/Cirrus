import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Action, applyOps, CITE_KEY_TAG, CommandError, editNode, type FileRef, groupOf, invertAction, parseBibtex, placementKey, type State, type TagValue,
} from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { buildScene, DEFAULT_PARAMS as P, offsetPolygon, type PlanScene, type SceneItem } from '@cirrus/view';
import { beforeEach, expect, test } from 'vitest';
import { importPublication, type PublicationDeps, type PublicationResult } from '../src/main/publications/fetch.ts';
import { replayFetch } from '../src/main/publications/replay.ts';
import { findIdentifier } from '../src/renderer/publications/identify.ts';
import {
  createFromPdf, type ImportDeps, importByIdentifier, planPublication, type PlannedPublication, publicationBuild, PublicationIndex, type PublicationInput, publicationOf,
} from '../src/renderer/publications/build.ts';

const DATA = join(fileURLToPath(new URL('.', import.meta.url)), 'data', 'publications');
const LI = 'An Introduction to Kolmogorov Complexity and Its Applications';
const PDF: FileRef = { name: '1706.03762.pdf', hash: 'b'.repeat(64), size: 842 };
type Found = Extract<PublicationResult, { ok: true }>;
/** A result of the IPC as the main process gives it, from the answers recorded at task 4. */
const recorded = (csl: string, bib: string, id: Found['id'], more: Partial<Found> = {}): Found => ({
  ok: true, id, csl: JSON.parse(readFileSync(join(DATA, csl), 'utf8')), bibtex: readFileSync(join(DATA, bib), 'utf8').trim(), ...more,
});
const ARXIV = (more: Partial<Found> = {}) => recorded('arxiv-1706.03762.csl.json', 'arxiv-1706.03762.bib', { arxiv: '1706.03762' }, { pdf: PDF, ...more });
const BOOK = () => recorded('li-vitanyi-2008.csl.json', 'li-vitanyi-2008.bib', { doi: '10.1007/978-0-387-49820-1' });
const VASWANI = ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin'];

let s: State, ids: FixtureIds, sc: PlanScene;
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-publications-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  sc = buildScene(s, ids.plans.lobby, measure, P);
});
const run = (a: Action) => { applyOps(s, a.ops); return a; };
const tag = (key: string, value: string): TagValue => ({ key, value });
const setTags = (node: string, more: TagValue[]) => run(editNode(s, node, { tags: [...s.nodes.get(node)!.tags, ...more] }));
const planned = (p: PlannedPublication | { refused: string }): PlannedPublication => {
  if ('refused' in p) throw new Error(p.refused);
  return p;
};
const inputOf = (r: Found, dropped: FileRef | null = null) => {
  const x = publicationOf(r, dropped);
  if ('failed' in x) throw new Error(x.failed);
  return x;
};
const SKY = { x: 9000, y: 9000 };
const newNode = (a: Action) => s.nodes.get((a.ops.find((o) => o.t === 'node' && o.before === null) as { after: { id: string } }).after.id)!;

test('l’article d’arXiv rejoué : titre, huit auteurs « Prénom Nom », 2017, son identifiant ; la clé de DataCite, une adresse, écartée pour vaswani2017, et le .bib réécrit avec elle', () => {
  const input = inputOf(ARXIV());
  expect(input.fields).toEqual({ title: 'Attention Is All You Need', authors: VASWANI, year: '2017' });
  expect(input).toMatchObject({ arxiv: '1706.03762', pdf: PDF });
  expect(input.doi).toBeUndefined();
  const plan = planned(planPublication(PublicationIndex.of(s), input, P.publicationMaxAuthors));
  expect(plan.title).toBe('Attention Is All You Need');
  expect(plan.key).toBe('vaswani2017');
  expect(plan.tags).toEqual([
    ...VASWANI.map((a) => tag('auteur', a)), tag('date_de_publication', '2017'), tag(CITE_KEY_TAG, 'vaswani2017'), tag('arxiv', '1706.03762'),
  ]);
  expect(plan.bib!.name).toBe('vaswani2017.bib');
  expect(plan.bib!.text.startsWith('@misc{vaswani2017,\n')).toBe(true);
  // The entry rewritten with its key: its fields are DataCite's, unchanged.
  expect(parseBibtex(plan.bib!.text).entries[0].fields).toEqual(parseBibtex(ARXIV().bibtex).entries[0].fields);
});

test('le livre de Crossref rejoué : un doublon de celui de la base de test, par le titre et l’année (sans DOI, une autre clé), nommé ; renommé, il ne l’est plus et garde la clé Li_2008', () => {
  const input = inputOf(BOOK());
  expect(input).toMatchObject({ fields: { title: LI, authors: ['Ming Li', 'Paul Vitányi'], year: '2008' }, doi: '10.1007/978-0-387-49820-1' });
  expect(planPublication(PublicationIndex.of(s), input, P.publicationMaxAuthors)).toEqual({ refused: `Déjà dans la base (même titre et même année) : « ${LI} ».` });
  // Another title, punctuation and case aside, is the same; another one is not.
  run(editNode(s, ids.nodes.publication, { title: 'an introduction to KOLMOGOROV complexity — and its applications.' }));
  expect('refused' in planPublication(PublicationIndex.of(s), input, P.publicationMaxAuthors)).toBe(true);
  run(editNode(s, ids.nodes.publication, { title: 'Le livre de Li et Vitányi' }));
  const plan = planned(planPublication(PublicationIndex.of(s), input, P.publicationMaxAuthors));
  expect(plan.key).toBe('Li_2008');
  expect(plan.tags).toEqual([tag('auteur', 'Ming Li'), tag('auteur', 'Paul Vitányi'), tag('date_de_publication', '2008'), tag(CITE_KEY_TAG, 'Li_2008'), tag('doi', '10.1007/978-0-387-49820-1')]);
  expect(plan.bib).toEqual({ name: 'Li_2008.bib', text: expect.stringMatching(/^@book\{Li_2008,\n {2}title = \{An Introduction/) });
});

test('doublons : par le DOI sans la casse, par l’identifiant arXiv sans version ou par le DOI d’arXiv, par la clé de l’entrée ; un nœud à la corbeille n’en est pas un', () => {
  const index = () => PublicationIndex.of(s);
  setTags(ids.nodes.publication, [tag('doi', '10.1007/978-0-387-49820-1')]);
  run(editNode(s, ids.nodes.publication, { title: 'Autre titre' }));
  const book = inputOf(BOOK());
  expect(planPublication(index(), { ...book, doi: '10.1007/978-0-387-49820-1'.toUpperCase() }, 50)).toEqual({ refused: 'Déjà dans la base (même DOI) : « Autre titre ».' });
  // arXiv: a tag with a version, or arXiv's DOI in DataCite's upper case.
  setTags(ids.nodes.mdl, [tag('arxiv', 'arXiv:1706.03762v5')]);
  expect(planPublication(index(), inputOf(ARXIV()), 50)).toEqual({ refused: `Déjà dans la base (même identifiant arXiv) : « ${s.nodes.get(ids.nodes.mdl)!.title} ».` });
  run(editNode(s, ids.nodes.mdl, { tags: s.nodes.get(ids.nodes.mdl)!.tags.filter((t) => t.key !== 'arxiv') }));
  setTags(ids.nodes.occam, [tag('doi', '10.48550/ARXIV.1706.03762')]);
  expect(planPublication(index(), inputOf(ARXIV()), 50)).toEqual({ refused: `Déjà dans la base (même identifiant arXiv) : « ${s.nodes.get(ids.nodes.occam)!.title} ».` });
  // The entry's own key (a .bib's, task 6): li2008 is the test base's book. The entry has no identifier, which could
  // contradict the match: a duplicate (the controller's ruling of the review, I2).
  const entry = parseBibtex('@book{li2008, title = {Un autre livre}, author = {Li, Ming}, year = 1999}').entries[0];
  expect(planPublication(index(), { fields: { title: 'Un autre livre', authors: ['Ming Li'], year: '1999' }, entry }, 50))
    .toEqual({ refused: 'Déjà dans la base (même clé BibTeX) : « Autre titre ».' });
  // A node with both identifiers (a preprint and its published version, a .bib's): each one is a duplicate.
  setTags(ids.nodes.monde, [tag('arxiv', '2401.01234'), tag('doi', '10.5555/publie')]);
  expect(planPublication(index(), { fields: { title: 'Y', authors: [], year: null }, entry: null, doi: '10.5555/PUBLIE' }, 50))
    .toEqual({ refused: `Déjà dans la base (même DOI) : « ${s.nodes.get(ids.nodes.monde)!.title} ».` });
  // In the trash: no duplicate.
  run(editNode(s, ids.nodes.trashed, { tags: [tag('doi', '10.1234/corbeille')] }));
  expect('refused' in planPublication(index(), { fields: { title: 'X', authors: [], year: null }, entry: null, doi: '10.1234/CORBEILLE' }, 50)).toBe(false);
});

test('doublons (revue I2, M2) : une même clé, ou un même titre et une même année, que les identifiants contredisent n’en est pas un ; la clé passe alors par citeKey', () => {
  const index = () => PublicationIndex.of(s);
  const RESNET = 'Deep Residual Learning for Image Recognition';
  run(editNode(s, ids.nodes.monde, { title: RESNET, tags: [tag('clé_bibtex', 'He_2016'), tag('doi', '10.1109/CVPR.2016.90'), tag('date_de_publication', '2016')] }));
  // Crossref's key He_2016 for another paper of He et al. the same year, another DOI: planned, under he2016.
  const identity = parseBibtex('@inproceedings{He_2016, title={Identity Mappings in Deep Residual Networks}, author={He, Kaiming}, year={2016}, DOI={10.1007/978-3-319-46493-0_38}}').entries[0];
  const p = planned(planPublication(index(), { fields: { title: 'Identity Mappings in Deep Residual Networks', authors: ['Kaiming He'], year: '2016' }, entry: identity, doi: '10.1007/978-3-319-46493-0_38' }, 50));
  expect(p.key).toBe('he2016');
  expect(p.bib!.name).toBe('he2016.bib');
  expect(p.bib!.text.startsWith('@inproceedings{he2016,\n')).toBe(true);
  // The same title and year with two different DOIs (an editorial, an erratum…): planned too.
  expect('refused' in planPublication(index(), { fields: { title: RESNET, authors: [], year: '2016' }, entry: null, doi: '10.9999/autre' }, 50)).toBe(false);
  // Two arXiv identifiers that differ contradict it as well; a DOI on one side and an arXiv identifier on the other do not.
  setTags(ids.nodes.mdl, [tag('clé_bibtex', 'preprint2020'), tag('arxiv', '2001.00001')]);
  const preprint = (more: Partial<PublicationInput>) => planPublication(index(), {
    fields: { title: 'Autre', authors: [], year: null }, entry: parseBibtex('@misc{preprint2020, year = 2020}').entries[0], ...more,
  }, 50);
  expect('refused' in preprint({ arxiv: '2002.00002' })).toBe(false);
  expect(preprint({ doi: '10.9999/publie' })).toEqual({ refused: `Déjà dans la base (même clé BibTeX) : « ${s.nodes.get(ids.nodes.mdl)!.title} ».` });
  // The same key, one side without an identifier: a duplicate, the node without one…
  setTags(ids.nodes.occam, [tag('clé_bibtex', 'Occam_1990')]);
  expect(planPublication(index(), {
    fields: { title: 'Autre', authors: [], year: null }, entry: parseBibtex('@misc{Occam_1990, year = 1990}').entries[0], doi: '10.9999/occam',
  }, 50)).toEqual({ refused: `Déjà dans la base (même clé BibTeX) : « ${s.nodes.get(ids.nodes.occam)!.title} ».` });
  // …or the input without one; the same title and year without any identifier too.
  expect(planPublication(index(), { fields: { title: RESNET, authors: [], year: '2016' }, entry: null }, 50)).toEqual({ refused: `Déjà dans la base (même titre et même année) : « ${RESNET} ».` });
  // The test base's book stays a duplicate of Crossref's (its node has no DOI).
  expect(planPublication(index(), inputOf(BOOK()), 50)).toEqual({ refused: `Déjà dans la base (même titre et même année) : « ${LI} ».` });
});

test('doublons (re-revue N2) : un DOI de la base écrit avec le point de la phrase est ce DOI, et non un veto', async () => {
  const RESNET = 'Deep Residual Learning for Image Recognition';
  for (const written of ['10.1109/CVPR.2016.90.', 'https://doi.org/10.1109/CVPR.2016.90.']) {
    run(editNode(s, ids.nodes.monde, { title: RESNET, tags: [tag('date_de_publication', '2016'), tag('doi', written)] }));
    expect(planPublication(PublicationIndex.of(s), { fields: { title: RESNET, authors: [], year: '2016' }, entry: null, doi: '10.1109/CVPR.2016.90' }, 50), written)
      .toEqual({ refused: `Déjà dans la base (même DOI) : « ${RESNET} ».` });
    // Typed with it too, refused before the network.
    const { d, calls } = deps();
    expect(await importByIdentifier('10.1109/CVPR.2016.90.', null, d), written).toEqual({ kind: 'notified', message: `Déjà dans la base (même DOI) : « ${RESNET} ».` });
    expect(calls.fetch).toEqual([]);
  }
});

test('doublons (revue M3) : toutes les valeurs d’un tag comptent, et une valeur écrite en lien est lue', () => {
  const index = () => PublicationIndex.of(s);
  setTags(ids.nodes.mdl, [tag('doi', '10.5555/preprint'), tag('doi', '10.5555/journal')]);
  const mdl = s.nodes.get(ids.nodes.mdl)!.title;
  for (const doi of ['10.5555/preprint', '10.5555/journal']) {
    expect(planPublication(index(), { fields: { title: 'X', authors: [], year: null }, entry: null, doi }, 50)).toEqual({ refused: `Déjà dans la base (même DOI) : « ${mdl} ».` });
  }
  setTags(ids.nodes.occam, [tag('arxiv', 'https://arxiv.org/abs/1706.03762'), tag('doi', 'https://doi.org/10.1000%2Fabc')]);
  const occam = s.nodes.get(ids.nodes.occam)!.title;
  expect(planPublication(index(), inputOf(ARXIV()), 50)).toEqual({ refused: `Déjà dans la base (même identifiant arXiv) : « ${occam} ».` });
  expect(planPublication(index(), { fields: { title: 'X', authors: [], year: null }, entry: null, doi: '10.1000/ABC' }, 50)).toEqual({ refused: `Déjà dans la base (même DOI) : « ${occam} ».` });
});

test('publicationBuild : une action posée au point, au cran lisible, avec ses tags, son PDF et son .bib ; dans l’enveloppe d’un groupe, elle y entre ; un seul Ctrl+Z la retire', () => {
  const plan = planned(planPublication(PublicationIndex.of(s), inputOf(ARXIV()), 50));
  const bib: FileRef = { name: 'vaswani2017.bib', hash: 'c'.repeat(64), size: 600 };
  const a = run(publicationBuild(plan, [PDF, bib], sc, SKY, 0.25, P)(s));
  expect(a.label).toBe('Importer « Attention Is All You Need »');
  const node = newNode(a);
  expect(node).toMatchObject({ title: 'Attention Is All You Need', tags: plan.tags, files: [PDF, bib] });
  expect(s.placements.get(placementKey(ids.plans.lobby, node.id))).toMatchObject({ x: 9000, y: 9000, k: 2 });
  expect(groupOf(s, ids.plans.lobby, node.id)).toBeUndefined();
  // One step: Ctrl+Z gives the base back as it was.
  run(invertAction(a));
  expect(s.nodes.has(node.id)).toBe(false);
  // Put down in an envelope: it enters that group.
  const g = sc.items[sc.byId.get(ids.nodes.groupeML)!] as SceneItem;
  const at = offsetPolygon(g.hull!, g.pad! * 0.4).reduce((b, q) => (q.y > b.y ? q : b));
  const inGroup = newNode(run(publicationBuild(plan, [bib], sc, at, 0.25, P)(s)));
  expect(groupOf(s, ids.plans.lobby, inGroup.id)).toBe(ids.nodes.groupeML);
  // Made again by then (another import meanwhile): refused, the node named.
  expect(() => publicationBuild(plan, [bib], sc, SKY, 1, P)(s)).toThrow(new CommandError('Déjà dans la base (même identifiant arXiv) : « Attention Is All You Need ».'));
});

test('planPublication : au plus publicationMaxAuthors tags « auteur » ; sans titre, la clé ; un PDF sans identifiant, son titre seul, sans clé ni .bib', () => {
  const many = { fields: { title: 'Collaboration', authors: Array.from({ length: 3000 }, (_, i) => `Auteur ${i}`), year: '2024' }, entry: null };
  const plan = planned(planPublication(PublicationIndex.of(s), many, 20));
  expect(plan.tags.filter((t) => t.key === 'auteur')).toHaveLength(20);
  const keyed = parseBibtex('@misc{sanstitre2020, year = 2020}').entries[0];
  expect(planned(planPublication(PublicationIndex.of(s), { fields: { title: '', authors: [], year: '2020' }, entry: keyed }, 20)).title).toBe('sanstitre2020');
  const pdf = planned(planPublication(PublicationIndex.of(s), { fields: { title: 'Li_Vitányi_extrait', authors: [], year: null }, entry: null, pdf: PDF }, 20));
  expect(pdf).toMatchObject({ title: 'Li_Vitányi_extrait', key: null, bib: null, tags: [] });
});

/** The dialog's deps over the test's state: the IPC faked, each call recorded; the node put down in the lobby's sky. */
function deps(over: Partial<ImportDeps> = {}) {
  const calls = { fetch: [] as [string, { pdf: boolean }][], stored: [] as { name: string; text: string }[], put: [] as FileRef[][] };
  const d: ImportDeps = {
    state: () => s,
    fetch: async (text, options) => { calls.fetch.push([text, options]); return ARXIV(); },
    storeText: async (name, text) => { calls.stored.push({ name, text }); return { name, hash: 'c'.repeat(64), size: text.length }; },
    put: async (plan, files) => {
      calls.put.push(files);
      try {
        const a = run(publicationBuild(plan, files, sc, SKY, 1, P)(s));
        return { ok: true, action: a, plans: [ids.plans.lobby] };
      } catch (e) {
        if (e instanceof CommandError) return { ok: false, message: e.message };
        throw e;
      }
    },
    maxAuthors: () => P.publicationMaxAuthors,
    open: () => true,
    log: () => {},
    ...over,
  };
  return { d, calls };
}
const titled = (title: string) => [...s.nodes.values()].filter((n) => n.title === title && n.trashedAt === undefined);

test('importByIdentifier : arXiv, son PDF demandé, son .bib enregistré avant l’action, une action ; de nouveau, un doublon dit sans réseau', async () => {
  const { d, calls } = deps();
  expect(await importByIdentifier('arXiv:1706.03762', null, d)).toEqual({ kind: 'done', title: 'Attention Is All You Need', notice: null });
  expect(calls.fetch).toEqual([['arXiv:1706.03762', { pdf: true }]]);
  expect(calls.stored.map((x) => x.name)).toEqual(['vaswani2017.bib']);
  expect(calls.put).toEqual([[PDF, { name: 'vaswani2017.bib', hash: 'c'.repeat(64), size: calls.stored[0].text.length }]]);
  expect(titled('Attention Is All You Need')).toHaveLength(1);
  const again = deps();
  expect(await importByIdentifier('https://arxiv.org/abs/1706.03762v3', null, again.d)).toEqual({
    kind: 'notified', message: 'Déjà dans la base (même identifiant arXiv) : « Attention Is All You Need ».',
  });
  expect(again.calls.fetch).toEqual([]);
});

test('importByIdentifier : avec un PDF déposé, celui d’arXiv n’est pas demandé et le nœud garde le déposé', async () => {
  const dropped: FileRef = { name: 'attention.pdf', hash: 'd'.repeat(64), size: 1000 };
  const { d, calls } = deps({ fetch: async (text, options) => { calls.fetch.push([text, options]); return ARXIV({ pdf: undefined }); } });
  expect((await importByIdentifier('arXiv:1706.03762', dropped, d)).kind).toBe('done');
  expect(calls.fetch).toEqual([['arXiv:1706.03762', { pdf: false }]]);
  expect(calls.put[0][0]).toEqual(dropped);
  expect(titled('Attention Is All You Need')[0].files.map((f) => f.name)).toEqual(['attention.pdf', 'vaswani2017.bib']);
});

test('importByIdentifier : non reconnu, hors ligne, introuvable — dit en français dans le dialogue, rien n’est stocké ni créé', async () => {
  const before = s.nodes.size;
  const unknown = deps();
  expect(await importByIdentifier('bonjour', null, unknown.d)).toEqual({ kind: 'failed', message: 'Identifiant non reconnu.' });
  expect(unknown.calls.fetch).toEqual([]);
  for (const message of ['Pas de connexion.', 'Publication introuvable.']) {
    const { d, calls } = deps({ fetch: async () => ({ ok: false, message }) });
    expect(await importByIdentifier('10.1234/x', null, d)).toEqual({ kind: 'failed', message });
    expect(calls.stored).toEqual([]);
    expect(calls.put).toEqual([]);
  }
  expect(s.nodes.size).toBe(before);
});

test('importByIdentifier : un rejet de l’IPC ou du magasin devient un message français ; un BibTeX illisible refuse l’import', async () => {
  const logged: unknown[] = [];
  const rejected = deps({ fetch: () => Promise.reject(new Error('Error invoking remote method \'cirrus:publications:fetch\': Error: An object could not be cloned.')), log: (_w, e) => logged.push(e) });
  const r = await importByIdentifier('arXiv:1706.03762', null, rejected.d);
  expect(r).toEqual({ kind: 'failed', message: 'L’import de la publication a échoué : le processus principal n’a pas répondu.' });
  expect(logged).toHaveLength(1);
  const store = deps({ storeText: () => Promise.reject(new Error('EACCES: permission denied')) });
  expect(await importByIdentifier('arXiv:1706.03762', null, store.d)).toEqual({ kind: 'failed', message: 'Le fichier .bib de la publication n’a pas pu être enregistré dans la base.' });
  expect(store.calls.put).toEqual([]);
  const garbled = deps({ fetch: async () => ARXIV({ bibtex: '@@@ pas du BibTeX' }) });
  expect(await importByIdentifier('arXiv:1706.03762', null, garbled.d)).toEqual({ kind: 'failed', message: 'Le BibTeX reçu est illisible : la publication n’est pas importée.' });
  expect(titled('Attention Is All You Need')).toEqual([]);
});

test('importByIdentifier : un dialogue fermé pendant la recherche, ou pendant l’enregistrement du .bib, laisse tomber le résultat', async () => {
  let open = true;
  const during = deps({ open: () => open, fetch: async () => { open = false; return ARXIV(); } });
  expect(await importByIdentifier('arXiv:1706.03762', null, during.d)).toEqual({ kind: 'dropped' });
  expect(during.calls.stored).toEqual([]);
  open = true;
  const storing = deps({ open: () => open });
  storing.d.storeText = async (name, text) => { open = false; return { name, hash: 'c'.repeat(64), size: text.length }; };
  expect(await importByIdentifier('arXiv:1706.03762', null, storing.d)).toEqual({ kind: 'dropped' });
  expect(storing.calls.put).toEqual([]);
  // A rejection after the dialog closed says nothing either.
  open = false;
  expect(await importByIdentifier('arXiv:1706.03762', null, deps({ open: () => open, fetch: () => Promise.reject(new Error('x')) }).d)).toEqual({ kind: 'dropped' });
  expect(titled('Attention Is All You Need')).toEqual([]);
});

test('importByIdentifier : le livre, doublon par le titre et l’année, notifié sans rien enregistrer ; le PDF d’arXiv absent, l’import se fait et le dit', async () => {
  const book = deps({ fetch: async () => BOOK() });
  expect(await importByIdentifier('10.1007/978-0-387-49820-1', null, book.d)).toEqual({ kind: 'notified', message: `Déjà dans la base (même titre et même année) : « ${LI} ».` });
  expect(book.calls.stored).toEqual([]);
  const noPdf = deps({ fetch: async () => ARXIV({ pdf: undefined, pdfMessage: 'Le fichier reçu d’arXiv n’est pas un PDF.' }) });
  expect(await importByIdentifier('arXiv:1706.03762', null, noPdf.d)).toEqual({
    kind: 'done', title: 'Attention Is All You Need', notice: 'Publication importée sans son PDF : Le fichier reçu d’arXiv n’est pas un PDF.',
  });
  expect(titled('Attention Is All You Need')[0].files.map((f) => f.name)).toEqual(['vaswani2017.bib']);
});

test('de bout en bout sur le rejeu : un DOI de Crossref (Shannon, 1948), du principal au nœud — sa clé, son mois en macro, son tiret', async () => {
  const main: PublicationDeps = {
    fetch: replayFetch(DATA), store: () => { throw new Error('aucun PDF attendu'); }, maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 2000,
  };
  const { d, calls } = deps({ fetch: (text, options) => importPublication(text, main, options) });
  expect(await importByIdentifier('https://doi.org/10.1002/j.1538-7305.1948.tb01338.x', null, d)).toEqual({ kind: 'done', title: 'A Mathematical Theory of Communication', notice: null });
  const node = titled('A Mathematical Theory of Communication')[0];
  expect(node.tags).toEqual([tag('auteur', 'C. E. Shannon'), tag('date_de_publication', '1948'), tag(CITE_KEY_TAG, 'Shannon_1948'), tag('doi', '10.1002/j.1538-7305.1948.tb01338.x')]);
  expect(calls.stored.map((x) => x.name)).toEqual(['Shannon_1948.bib']);
  const bib = calls.stored[0].text;
  expect(bib).toContain('  month = jul,\n');
  expect(bib).toContain('  pages = {379–423}\n');
  expect(parseBibtex(bib).entries[0].fields.get('month')).toBe('July');
});

test('createFromPdf : un PDF déposé sans identifiant fait un nœud de son titre, le PDF attaché, sans réseau ; une action', async () => {
  const pdf: FileRef = { name: 'Li_Vitányi_extrait.pdf', hash: 'e'.repeat(64), size: 647 };
  const { d, calls } = deps();
  expect(await createFromPdf(pdf, '  Li_Vitányi_extrait ', d)).toEqual({ kind: 'done', title: 'Li_Vitányi_extrait', notice: null });
  expect(calls.fetch).toEqual([]);
  expect(calls.stored).toEqual([]);
  expect(titled('Li_Vitányi_extrait')[0]).toMatchObject({ files: [pdf], tags: [] });
});

test('findIdentifier : l’estampille d’arXiv, le DOI d’un éditeur, les métadonnées, un lien ; rien, ou un texte hostile, vite', () => {
  // An arXiv PDF: its stamp in the margin, though a DOI is cited in its first page.
  const arxiv = 'Provided proper attribution is provided...\nAttention Is All You Need\nAshish Vaswani∗ Google Brain\n... as in [10.1162/neco.1997.9.8.1735] ...\narXiv:1706.03762v7  [cs.CL]  2 Aug 2023';
  expect(findIdentifier(arxiv, {})).toEqual({ arxiv: '1706.03762v7' });
  // A publisher's: its DOI in the header, its trailing punctuation dropped.
  const publisher = 'Journal of Computer and System Sciences 74 (2008) 1–10\nContents lists available at ScienceDirect\nhttps://doi.org/10.1016/j.jcss.2008.01.001.\nReceived 12 March 2007; see also arXiv:0704.0001';
  expect(findIdentifier(publisher, {})).toEqual({ doi: '10.1016/j.jcss.2008.01.001' });
  expect(findIdentifier('(DOI: 10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C).', {})).toEqual({ doi: '10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C' });
  // The metadata first: the document's own identifier, whatever its pages cite.
  expect(findIdentifier(publisher, { 'prism:doi': '10.1007/978-0-387-49820-1' })).toEqual({ doi: '10.1007/978-0-387-49820-1' });
  expect(findIdentifier('', { 'dc:identifier': 'doi:10.1007/s00453-001-0001-x' })).toEqual({ doi: '10.1007/s00453-001-0001-x' });
  expect(findIdentifier('', { Subject: 'arXiv:2401.01234v2' })).toEqual({ arxiv: '2401.01234v2' });
  // arXiv's DOI is its article; a link to its page too; an old identifier.
  expect(findIdentifier('doi 10.48550/arXiv.2401.01234 ici', {})).toEqual({ arxiv: '2401.01234' });
  expect(findIdentifier('Disponible : https://arxiv.org/abs/2401.01234v2.', {})).toEqual({ arxiv: '2401.01234v2' });
  expect(findIdentifier('arXiv:hep-th/9901001v1 [hep-th] 1 Jan 1999', {})).toEqual({ arxiv: 'hep-th/9901001v1' });
  expect(findIdentifier('PDF de remplacement des tests de Cirrus, pour arXiv:1706.03762', {})).toEqual({ arxiv: '1706.03762' });
  expect(findIdentifier('Fichier d’exemple de la base de test de Cirrus (publication fictive).', { Title: 'Sans identifiant' })).toBeNull();
  expect(findIdentifier('10.12/trop-court 10.1234 arXiv:bonjour', {})).toBeNull();
  const t0 = performance.now();
  expect(findIdentifier('10.'.repeat(2_000_000) + 'arXiv:'.repeat(500_000), { k: 'x'.repeat(1_000_000) })).toBeNull();
  expect(performance.now() - t0).toBeLessThan(1000);
});
