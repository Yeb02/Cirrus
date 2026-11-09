import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOps, deleteConnection, editConnection, type Id, invertAction, removeFromPlan, type State, uuidv7 } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { buildScene, type Camera, DEFAULT_PARAMS as P, fitBounds, fitItem, type PlanScene } from '@cirrus/view';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { renameBuild, tagsBuild } from '../src/renderer/actions.ts';
import { foundItems } from '../src/renderer/render/found.ts';
import { DEFAULT_FILTERS, SearchBuild, SearchIndex, type SearchFilters, type SearchHit } from '../src/renderer/search/index.ts';
import { type RevealHost, Revealer, type RevealTarget } from '../src/renderer/ui/graph/reveal.ts';

// The search (plan 6a, D1) and the jump to what it finds (D2), on the test base: read once into a store, each test
// taking its state from it again.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-search-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let s: State;
beforeEach(() => { s = store.loadState(); });

const NO_TEXTS: ReadonlyMap<string, string> = new Map();
const ALL: SearchFilters = { title: true, tags: true, summary: true, content: true, planOnly: false };
const only = (f: Partial<SearchFilters>): SearchFilters => ({ title: false, tags: false, summary: false, content: false, planOnly: false, ...f });
const where = (plan: Id, tabs: Id[] = []) => ({ plan, lobby: ids.plans.lobby, tabs });
const titleOf = (id: Id) => s.nodes.get(id)?.title ?? s.connections.get(id)?.title;
const titles = (hits: SearchHit[]) => hits.map((h) => h.title);
const run = (build: ((st: State) => Action) | null): Action => { const a = build!(s); applyOps(s, a.ops); return a; };
const apply = (a: Action): Action => { applyOps(s, a.ops); return a; };

test('la requête : le début des mots, sans casse ni accents', () => {
  const index = SearchIndex.build(s, NO_TEXTS);
  const lobby = where(ids.plans.lobby);
  const kolmo = index.query('kolmo', DEFAULT_FILTERS, lobby, 50);
  expect(kolmo.map((h) => h.id)).toEqual([ids.nodes.publication, ids.nodes.kolmogorov, ids.nodes.annotationPage1, ids.nodes.annotationEarlier]);
  expect(kolmo.every((h) => h.kind === 'node' && h.field === 'title')).toBe(true);
  expect(kolmo[1]).toEqual({ id: ids.nodes.kolmogorov, kind: 'node', title: 'Complexité de Kolmogorov', plan: ids.plans.lobby, field: 'title' });
  // Neither case nor accents count, on either side; a word's middle is no start.
  expect(index.query('KÖLMO', DEFAULT_FILTERS, lobby, 50)).toEqual(kolmo);
  expect(titles(index.query('COMPLEXITE DE', DEFAULT_FILTERS, lobby, 50))).toContain('Complexité de Kolmogorov');
  expect(index.query('olmogorov', DEFAULT_FILTERS, lobby, 50)).toEqual([]);
  // « Énonce que… »: an accented capital, in a summary.
  expect(index.query('enonce', DEFAULT_FILTERS, lobby, 50).map((h) => [h.id, h.field])).toEqual([[ids.nodes.mdl, 'summary']]);
  // A ligature is its two letters (Ruling): « coeur » finds « Cœur », typed either way.
  run(renameBuild(ids.nodes.monde, 'Cœur du monde'));
  const renamed = SearchIndex.build(s, NO_TEXTS);
  expect(renamed.query('coeur', DEFAULT_FILTERS, lobby, 50).map((h) => h.id)).toEqual([ids.nodes.monde]);
  expect(renamed.query('CŒU', DEFAULT_FILTERS, lobby, 50).map((h) => h.id)).toEqual([ids.nodes.monde]);
  // Nothing typed, nothing found; the list stops at `max`.
  expect(index.query('  ', DEFAULT_FILTERS, lobby, 50)).toEqual([]);
  expect(index.query('kolmo', DEFAULT_FILTERS, lobby, 2)).toEqual(kolmo.slice(0, 2));
});

test('la requête : plusieurs mots, chacun le début d’un mot de l’objet', () => {
  const index = SearchIndex.build(s, NO_TEXTS);
  const hits = index.query('comp kolm', DEFAULT_FILTERS, where(ids.plans.lobby), 50);
  expect(hits.map((h) => h.id)).toEqual([ids.nodes.publication, ids.nodes.kolmogorov, ids.nodes.annotationPage1, ids.nodes.annotationEarlier]);
  // « Complexité et induction » has « comp » but no « kolm »; the words may be in two fields (D1).
  expect(index.query('kolmogorov definition', DEFAULT_FILTERS, where(ids.plans.lobby), 50)).toEqual([
    { id: ids.nodes.kolmogorov, kind: 'node', title: 'Complexité de Kolmogorov', plan: ids.plans.lobby, field: 'tags' },
  ]);
  // Its words in any order, a word typed twice counted once.
  expect(index.query('kolm comp kolm', DEFAULT_FILTERS, where(ids.plans.lobby), 50)).toEqual(hits);
});

test('la requête : chaque filtre, le contenu des .tex, et « Ce plan seulement »', () => {
  const tex = s.nodes.get(ids.nodes.kolmogorov)!.files.find((f) => f.name.endsWith('.tex'))!;
  const index = SearchIndex.build(s, new Map([[tex.hash, String.raw`\section{Un zygomorphe}`]]));
  const lobby = where(ids.plans.lobby);
  // Tags: a key or a value.
  const priore = [...s.nodes.values()].find((n) => n.title === 'Priore universelle')!.id;
  expect(index.query('definition', only({ tags: true }), lobby, 50).map((h) => [h.id, h.field])).toEqual([
    [ids.nodes.kolmogorov, 'tags'], [priore, 'tags'],
  ]);
  expect(index.query('definition', only({ title: true, summary: true, content: true }), lobby, 50)).toEqual([]);
  expect(index.query('statut', only({ tags: true }), lobby, 50).length).toBeGreaterThan(0);
  // Summary: a node's, a connection's relation.
  expect(index.query('compresse', only({ summary: true }), lobby, 50).map((h) => [h.id, h.field])).toEqual([[ids.nodes.mdl, 'summary']]);
  expect(index.query('compresse', only({ title: true, tags: true, content: true }), lobby, 50)).toEqual([]);
  expect(index.query('posteriore', only({ summary: true }), lobby, 50)).toEqual([
    { id: ids.connections.mdlSolomonoff, kind: 'connection', title: 'Analogue bayésien', plan: ids.plans.lobby, field: 'summary' },
  ]);
  expect(index.query('parallele', only({ tags: true }), lobby, 50).map((h) => h.id)).toEqual([ids.connections.mdlSolomonoff]);
  // Content: the text of its .tex, off by default (D1).
  expect(index.query('zygo', only({ content: true }), lobby, 50).map((h) => [h.id, h.field])).toEqual([[ids.nodes.kolmogorov, 'content']]);
  expect(index.query('zygo', DEFAULT_FILTERS, lobby, 50)).toEqual([]);
  // Title alone.
  expect(index.query('compression', only({ title: true }), where(ids.plans.these), 50).map((h) => h.id)).toEqual([ids.nodes.theseOnly, ids.nodes.compression]);
  // This plan only: what Thèse shows, nothing of the lobby, of another plan or of none.
  const these = index.query('comp', { ...DEFAULT_FILTERS, planOnly: true }, where(ids.plans.these), 50);
  expect(these.map((h) => h.id)).toEqual([ids.nodes.theseOnly, ids.nodes.kolmogorov, ids.nodes.compression, ids.nodes.mdl]);
  expect(these.every((h) => h.plan === ids.plans.these)).toBe(true);
});

test('l’ordre : ce plan, le lobby, les autres plans, aucun ; le titre, puis les tags, puis le résumé', () => {
  const index = SearchIndex.build(s, NO_TEXTS);
  const hits = index.query('comp', DEFAULT_FILTERS, where(ids.plans.these), 50);
  expect(hits.map((h) => [titleOf(h.id), h.field, h.plan])).toEqual([
    ['Chapitre 2 : compression et généralisation', 'title', ids.plans.these],
    ['Complexité de Kolmogorov', 'title', ids.plans.these],
    ['Compression sans perte', 'title', ids.plans.these],
    ['Minimum Description Length Principle (MDL)', 'summary', ids.plans.these],
    ['An Introduction to Kolmogorov Complexity and Its Applications', 'title', ids.plans.lobby],
    ['Complexité et induction', 'title', ids.plans.lobby],
    [titleOf(ids.nodes.annotationPage1), 'title', ids.plans.lecture],
    [titleOf(ids.nodes.annotationEarlier), 'title', null],
  ]);
  // Title before tags, title before summary.
  expect(index.query('theorie', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => [h.id, h.field])).toEqual([
    [ids.nodes.groupeTheorie, 'title'], [ids.nodes.mdl, 'tags'],
  ]);
  expect(index.query('induction', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => [titleOf(h.id), h.field, h.plan])).toEqual([
    ['Complexité et induction', 'title', ids.plans.lobby],
    ['Induction de Solomonoff', 'title', ids.plans.lobby],
    ['Induction universelle', 'title', ids.plans.lobby],
    ['Analogue bayésien', 'summary', ids.plans.lobby],
    ['Le MDL comme principe d’induction', 'title', ids.plans.article],
  ]);
});

test('le plan d’un résultat : le lobby avant les autres, puis l’ordre des onglets, puis les noms', () => {
  const index = SearchIndex.build(s, NO_TEXTS);
  // MDL is in the lobby, Thèse and the article: from Lecture, the lobby.
  expect(index.query('minimum', DEFAULT_FILTERS, where(ids.plans.lecture), 50)[0].plan).toBe(ids.plans.lobby);
  // Out of the lobby: the first of its plans among the tabs, else by name (« Article MDL » before « Thèse »).
  apply(removeFromPlan(s, ids.plans.lobby, ids.nodes.mdl));
  const after = SearchIndex.build(s, NO_TEXTS);
  expect(after.query('minimum', DEFAULT_FILTERS, where(ids.plans.lecture), 50)[0].plan).toBe(ids.plans.article);
  expect(after.query('minimum', DEFAULT_FILTERS, where(ids.plans.lecture, [ids.plans.lecture, ids.plans.these, ids.plans.article]), 50)[0].plan).toBe(ids.plans.these);
  // A connection: where it has branches, and where its phantoms are.
  expect(after.query('analogue', DEFAULT_FILTERS, where(ids.plans.these), 50)[0].plan).toBe(ids.plans.lobby);
});

test('une connexion de structure et un objet jeté ne sont pas dans l’index', () => {
  const index = SearchIndex.build(s, NO_TEXTS);
  // The article's structure: tags « partie » and « suivant ».
  expect(index.query('suivant', ALL, where(ids.plans.article), 50)).toEqual([]);
  expect(index.query('partie', ALL, where(ids.plans.article), 50)).toEqual([]);
  // A knowledge connection with such a tag is found.
  expect(index.query('deduction', ALL, where(ids.plans.lobby), 50).map((h) => h.kind)).toEqual(['connection', 'connection', 'connection']);
  // « Note brouillon à jeter », in the trash.
  expect(index.query('brouillon', ALL, where(ids.plans.lobby), 50)).toEqual([]);
  // A connection put in the trash goes too, built anew or by its action.
  expect(index.query('analogue', ALL, where(ids.plans.lobby), 50).map((h) => h.id)).toEqual([ids.connections.mdlSolomonoff]);
  const a = apply(deleteConnection(s, ids.connections.mdlSolomonoff));
  expect(SearchIndex.build(s, NO_TEXTS).query('analogue', ALL, where(ids.plans.lobby), 50)).toEqual([]);
  expect(SearchIndex.build(s, NO_TEXTS, index, a).query('analogue', ALL, where(ids.plans.lobby), 50)).toEqual([]);
});

// The incremental index (Global Constraints, « La performance »): each action reads again only what it touches; the
// result is always the one of an index built anew.
const QUERIES = ['kolmo', 'comp', 'algorithmique', 'zephyr', 'monde', 'definition', 'induction', 'analogue', 'distant', 'complex kolm', 'note', 'local'];
const FILTERS: SearchFilters[] = [DEFAULT_FILTERS, ALL, only({ tags: true }), { ...ALL, planOnly: true }];
const PLACES = () => [where(ids.plans.lobby), where(ids.plans.these, [ids.plans.these]), where(ids.plans.lecture)];
function expectSame(incremental: SearchIndex, texts: ReadonlyMap<string, string> = NO_TEXTS) {
  const full = SearchIndex.build(s, texts);
  for (const q of QUERIES) {
    for (const f of FILTERS) for (const w of PLACES()) expect(incremental.query(q, f, w, 500), `${q} ${JSON.stringify(f)}`).toEqual(full.query(q, f, w, 500));
  }
}

test('l’incrémental : un renommage, un tag ajouté', () => {
  let index = SearchIndex.build(s, NO_TEXTS);
  let a = run(renameBuild(ids.nodes.kolmogorov, 'Complexité algorithmique'));
  index = SearchIndex.build(s, NO_TEXTS, index, a);
  expect(index.query('kolmo', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => h.id)).not.toContain(ids.nodes.kolmogorov);
  expectSame(index);
  a = run(tagsBuild(ids.nodes.compression, (tags) => [...tags, { key: 'zéphyr' }]));
  index = SearchIndex.build(s, NO_TEXTS, index, a);
  expect(index.query('zephyr', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => h.id)).toEqual([ids.nodes.compression]);
  expectSame(index);
  // A connection renamed.
  a = apply(editConnection(s, ids.connections.mdlSolomonoff, { title: 'Analogue distant' }));
  index = SearchIndex.build(s, NO_TEXTS, index, a);
  expect(index.query('distant', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => h.id)).toEqual([ids.connections.mdlSolomonoff]);
  expectSame(index);
});

test('l’incrémental : un nœud jeté puis rendu', () => {
  let index = SearchIndex.build(s, NO_TEXTS);
  // « Monde algorithmique » is in the lobby only: removed from it, it goes to the trash.
  const a = apply(removeFromPlan(s, ids.plans.lobby, ids.nodes.monde));
  expect(s.nodes.get(ids.nodes.monde)!.trashedAt).toBeDefined();
  index = SearchIndex.build(s, NO_TEXTS, index, a);
  expect(index.query('monde', ALL, where(ids.plans.lobby), 50)).toEqual([]);
  expectSame(index);
  index = SearchIndex.build(s, NO_TEXTS, index, apply(invertAction(a)));
  expect(index.query('monde', ALL, where(ids.plans.lobby), 50).map((h) => h.id)).toEqual([ids.nodes.monde]);
  expectSame(index);
});

test('l’incrémental : une action de synchronisation, ses inverses, ce qu’elle reçoit et ce qu’elle rejoue', () => {
  let index = SearchIndex.build(s, NO_TEXTS);
  // A write of this PC's, pending: Occam renamed.
  const local = run(renameBuild(ids.nodes.occam, 'Rasoir local'));
  index = SearchIndex.build(s, NO_TEXTS, index, local);
  // The reconciliation: the pending write rewound, another PC's writes (Kolmogorov renamed, « Monde algorithmique »
  // trashed, a connection renamed), then the pending write replayed — one action, as the session tells it.
  const rewind = invertAction(local).ops;
  applyOps(s, rewind);
  const remote: Action[] = [];
  remote.push(run(renameBuild(ids.nodes.kolmogorov, 'Complexité reçue')));
  remote.push(apply(removeFromPlan(s, ids.plans.lobby, ids.nodes.monde)));
  remote.push(apply(editConnection(s, ids.connections.associates, { title: 'Mesure reçue' })));
  applyOps(s, local.ops);
  const synced = { id: uuidv7(), label: 'Synchronisation', ops: [...rewind, ...remote.flatMap((r) => r.ops), ...local.ops], synced: true };
  index = SearchIndex.build(s, NO_TEXTS, index, synced);
  expect(index.query('recue', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => h.id).sort()).toEqual([ids.nodes.kolmogorov, ids.connections.associates].sort());
  expect(index.query('local', DEFAULT_FILTERS, where(ids.plans.lobby), 50).map((h) => h.id)).toEqual([ids.nodes.occam]);
  expectSame(index);
});

test('l’incrémental : des .tex lus après coup, et une action nulle (une relecture) qui refait tout', () => {
  const tex = s.nodes.get(ids.nodes.kolmogorov)!.files.find((f) => f.name.endsWith('.tex'))!;
  let index = SearchIndex.build(s, NO_TEXTS);
  const texts = new Map([[tex.hash, 'Un texte zéphyr']]);
  // The texts read since: only they are taken again (no action).
  index = SearchIndex.build(s, texts, index);
  expect(index.query('zephyr', ALL, where(ids.plans.lobby), 50).map((h) => [h.id, h.field])).toEqual([[ids.nodes.kolmogorov, 'content']]);
  expectSame(index, texts);
  // Changed in place without an action told (a reload, renders gathered): built anew.
  run(renameBuild(ids.nodes.monde, 'Monde local'));
  index = SearchIndex.build(s, texts, index, null);
  expectSame(index, texts);
});

test('la construction par tranches : des actions entre deux tranches, données ensuite, et le même index qu’entier', () => {
  const job = new SearchBuild(s, NO_TEXTS);
  // A deadline already past: five objects a slice.
  expect(job.step(0, 5)).toBeNull();
  const actions: Action[] = [];
  actions.push(run(renameBuild(ids.nodes.kolmogorov, 'Complexité algorithmique')));
  actions.push(run(renameBuild(ids.nodes.occam, 'Rasoir local')));
  actions.push(apply(removeFromPlan(s, ids.plans.lobby, ids.nodes.monde)));
  actions.push(apply(deleteConnection(s, ids.connections.twoToTwo)));
  let index: SearchIndex | null = null, slices = 1;
  for (; slices < 1000 && !index; slices++) index = job.step(0, 5);
  expect(index).not.toBeNull();
  expect(slices).toBeGreaterThan(5);
  index = SearchIndex.build(s, NO_TEXTS, index!, { id: uuidv7(), label: '', ops: actions.flatMap((a) => a.ops) });
  expectSame(index);
});

test('une frappe de plus ne relit que ce que la précédente a trouvé, et le résultat est celui d’un index neuf', () => {
  const index = SearchIndex.build(s, NO_TEXTS);
  for (const [f, w] of [[DEFAULT_FILTERS, where(ids.plans.lobby)], [{ ...ALL, planOnly: true }, where(ids.plans.these)]] as const) {
    for (const q of ['c', 'co', 'com', 'comp', 'comp k', 'comp ko', 'com', 'compl', 'z', 'za', 'zz', 'm', 'mi', 'min']) {
      expect(index.query(q, f, w, 500), q).toEqual(SearchIndex.build(s, NO_TEXTS).query(q, f, w, 500));
    }
  }
});

// The jump (D2): the plan opened if needed, the object framed, then ringed a moment.
function host(shown: () => PlanScene | null) {
  const opened: Id[] = [], moved: Camera[] = [], flashed: Id[][] = [];
  let asked: Id = shown()?.plan.id ?? ids.plans.lobby;
  const cam: Camera = { x: 0, y: 0, zoom: 1, widthPx: 1600, heightPx: 900 };
  const h: RevealHost = {
    state: () => s, scene: shown, plan: () => asked, camera: () => cam, params: () => P,
    openPlan: (plan) => { opened.push(plan); asked = plan; }, moveCamera: (c) => moved.push(c), flash: (x) => flashed.push(x),
  };
  return { h, opened, moved, flashed, cam };
}
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));

test('reveal : un nœud de ce plan est cadré et cerclé, sans changer de plan', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const { h, opened, moved, flashed, cam } = host(() => lobby);
  const target: RevealTarget = { plan: ids.plans.lobby, id: ids.nodes.kolmogorov, kind: 'node' };
  expect(new Revealer(h).reveal(target)).toBe(true);
  expect(opened).toEqual([]);
  expect(moved).toEqual([fitItem(lobby, lobby.byId.get(ids.nodes.kolmogorov)!, cam, P)]);
  expect(flashed).toEqual([[ids.nodes.kolmogorov]]);
});

test('reveal : un nœud d’un autre plan ouvre ce plan, puis le cadre une fois sa scène montrée', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P), these = buildScene(s, ids.plans.these, measure, P);
  let shown = lobby;
  const { h, opened, moved, flashed, cam } = host(() => shown);
  const r = new Revealer(h);
  expect(r.reveal({ plan: ids.plans.these, id: ids.nodes.mdl, kind: 'node' })).toBe(true);
  expect(opened).toEqual([ids.plans.these]);
  expect(moved).toEqual([]);
  // A scene of another plan shown meanwhile does not take it.
  r.sceneShown();
  expect(moved).toEqual([]);
  shown = these;
  r.sceneShown();
  expect(moved).toEqual([fitItem(these, these.byId.get(ids.nodes.mdl)!, cam, P)]);
  expect(flashed).toEqual([[ids.nodes.mdl]]);
  // Taken once: the next scene of that plan (an action) leaves the camera alone.
  r.sceneShown();
  expect(moved.length).toBe(1);
});

test('reveal : une connexion est cadrée par ses parties, ses nœuds cerclés', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const { h, moved, flashed, cam } = host(() => lobby);
  expect(new Revealer(h).reveal({ plan: ids.plans.lobby, id: ids.connections.mdlSolomonoff, kind: 'connection' })).toBe(true);
  const ends = [ids.nodes.mdl, ids.nodes.solomonoff].map((n) => lobby.byId.get(n)!);
  expect(foundItems(lobby, [ids.connections.mdlSolomonoff]).sort()).toEqual(ends.sort());
  const boxes = ends.map((i) => lobby.items[i]);
  const b = {
    minX: Math.min(...boxes.map((it) => it.x - it.halfW)), maxX: Math.max(...boxes.map((it) => it.x + it.halfW)),
    minY: Math.min(...boxes.map((it) => it.y - it.halfH)), maxY: Math.max(...boxes.map((it) => it.y + it.halfH)),
  };
  expect(moved).toEqual([fitBounds(b, cam.widthPx, cam.heightPx, P)]);
  expect(flashed).toEqual([[ids.connections.mdlSolomonoff]]);
  // The split arm's: its far parts too (the phantoms of Universality and of the centre).
  expect(foundItems(lobby, [ids.connections.split]).length).toBeGreaterThanOrEqual(3);
});

test('reveal : un objet jeté, ou absent de ce plan, rend faux sans rien ouvrir', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const { h, opened, moved, flashed } = host(() => lobby);
  const r = new Revealer(h);
  expect(r.reveal({ plan: ids.plans.lobby, id: ids.nodes.trashed, kind: 'node' })).toBe(false);
  expect(r.reveal({ plan: ids.plans.these, id: ids.nodes.monde, kind: 'node' })).toBe(false);
  expect(r.reveal({ plan: ids.plans.lobby, id: 'absent', kind: 'node' })).toBe(false);
  apply(removeFromPlan(s, ids.plans.lobby, ids.nodes.monde));
  expect(r.reveal({ plan: ids.plans.lobby, id: ids.nodes.monde, kind: 'node' })).toBe(false);
  // A connection in the trash, or not in that plan.
  expect(r.reveal({ plan: ids.plans.these, id: ids.connections.mdlSolomonoff, kind: 'connection' })).toBe(false);
  expect(opened).toEqual([]);
  expect(moved).toEqual([]);
  expect(flashed).toEqual([]);
});
