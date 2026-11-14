import {
  type Action, type Anchor, applyOp, applyOps, CITE_KEY_TAG, connect, connKind, connRowCount, createAnnotation, createNode, createPlan, deleteEverywhere,
  editNode, emptyState, type FileRef, type Id, include, KNOWLEDGE, LABEL_TAG, moveNodes, placementOf, type State, type TagKeyDef,
} from '@cirrus/core';
import { buildLargeState } from '@cirrus/fixtures';
import { buildScene, DEFAULT_PARAMS as P, type PlanScene, updateScene } from '@cirrus/view';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createdAt, healthJump, type HealthRow, healthRows, type HealthSection, IntruderBook, latexRows, rowTitle, type SceneSource, SKIPPED_MAX, SkippedPlans, skippedOf, stateHealth,
  unseenNote,
} from '../src/renderer/health.ts';
import { OBJECT_GONE } from '../src/renderer/ui/graph/jumps.ts';
import { LatexRegistry } from '../src/renderer/latex/registry.ts';

// The graph's health (plan 6b, task 9, D8), without its panel: the rows of each section, on a small base built for each
// case; the intruders' scan by slices; the journal of the plans a repercussion skipped. The panel, and its jumps, are
// driven by the interface scenario « santé du graphe ».

afterEach(() => { vi.restoreAllMocks(); });

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 12);
const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const idOf = (a: Action, t: 'plan' | 'node' | 'connection'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));
/** The command run at time `t` (the identifiers it makes, uuidv7, read that time). */
const at = <T>(t: number, fn: () => T): T => {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(t);
  try { return fn(); } finally { spy.mockRestore(); }
};

/** Plan P and the lobby; `mk` a node placed in P (made at NOW unless told); `link` a knowledge connection. */
function world() {
  const s = emptyState();
  const lobby = idOf(run(s, createPlan(s, 'Lobby', 'lobby')), 'plan'), plan = idOf(run(s, createPlan(s, 'P', 'plan')), 'plan');
  let x = 0;
  const mk = (title: string, extra: { summary?: string; tags?: { key: string; value?: string | number }[]; made?: number; where?: Id; y?: number } = {}) =>
    at(extra.made ?? NOW, () => idOf(run(s, createNode(s, { plan: extra.where ?? plan, title, x: (x += 400), y: extra.y ?? 0, k: 0, summary: extra.summary, tags: extra.tags })), 'node'));
  const link = (a: Id, b: Id, extra: { relation?: string; tags?: { key: string; value?: string | number }[] } = {}) =>
    idOf(run(s, connect(s, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], relation: extra.relation, tags: extra.tags })), 'connection');
  return { s, lobby, plan, mk, link };
}

const registryOf = (s: State) => LatexRegistry.build(s, new Map());
/** Every row of the base, seen nowhere unless told. */
const rows = (s: State, o: { seen?: ReadonlyMap<Id, number> | null; skipped?: Parameters<typeof healthRows>[3]; now?: number } = {}) =>
  healthRows(s, registryOf(s), o.seen === undefined ? new Map() : o.seen, o.skipped ?? [], o.now ?? NOW, P);
const of = (all: HealthRow[], section: HealthSection) => all.filter((r) => r.section === section);
const ids = (all: HealthRow[]) => all.map((r) => r.id);

const anchor = (pdf: Id): Anchor => ({ pdf, file: 'chapitre.pdf', hash: '0123456789abcdef'.repeat(4), page: 1, rects: [[72, 581, 300, 594.8]], text: 'Un passage souligné' });
const file = (name: string, hash = 'ab'.repeat(32)): FileRef => ({ name, hash, size: 10 });

// ---------------------------------------------------------------------------------------------------------------------
// 1. Broken references

test('un \\ref vers un label inconnu est une référence cassée : une ligne par source, avec le nom', () => {
  const { s, mk, link } = world();
  const A = mk('Énoncé', { summary: String.raw`Voir \ref{eq:inconnu} et \eqref{eq:connu}.` });
  const B = mk('Preuve', { summary: String.raw`\begin{equation}\label{eq:connu}x\end{equation}` });
  const c = link(A, B, { relation: String.raw`Par \ref{eq:autre}.` });
  const broken = of(rows(s), 'broken');
  expect(broken.map((r) => [r.kind, r.id, r.title])).toEqual([['node', A, 'Énoncé'], ['connection', c, '']]);
  expect(broken[0].detail).toBe(String.raw`\ref{eq:inconnu}, dans le résumé`);
  expect(broken[1].detail).toBe(String.raw`\ref{eq:autre}, dans la relation`);
  // A connection without a title is named as the trash names it, for the rows shown.
  expect(rowTitle(s, broken[1])).toBe('« Par \\ref{eq:autre}. »');
  expect(new Set(broken.map((r) => r.key)).size).toBe(2);
});

test('un \\cite vers une clé portée seulement par un nœud jeté est une référence cassée aussi', () => {
  const { s, mk } = world();
  const A = mk('Lecture', { summary: String.raw`Selon \cite{li2008} et \cite{absent}.` });
  const B = mk('Li et Vitányi', { tags: [{ key: CITE_KEY_TAG, value: 'li2008' }] });
  expect(of(rows(s), 'broken').map((r) => [r.id, r.detail])).toEqual([[A, String.raw`\cite{absent}, dans le résumé`]]);
  run(s, deleteEverywhere(s, B));
  expect(of(rows(s), 'broken').map((r) => [r.id, r.detail])).toEqual([[A, String.raw`\cite{absent}, \cite{li2008}, dans le résumé`]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Doubles

test('deux \\label égaux sont un doublon : une ligne par définition', () => {
  const { s, mk } = world();
  const A = mk('Un', { summary: String.raw`\label{thm:a}` });
  const B = mk('Deux', { tags: [{ key: LABEL_TAG, value: 'thm:a' }] });
  mk('Trois', { summary: String.raw`\label{thm:b}` });
  const doubles = of(rows(s), 'doubles');
  expect(ids(doubles).sort()).toEqual([A, B].sort());
  expect(doubles.every((r) => r.kind === 'node' && r.detail.startsWith('label « thm:a »'))).toBe(true);
});

test('deux nœuds de même clé_bibtex sont un doublon aussi', () => {
  const { s, mk } = world();
  const A = mk('Livre', { tags: [{ key: CITE_KEY_TAG, value: 'li2008' }] });
  const B = mk('Livre, encore', { tags: [{ key: CITE_KEY_TAG, value: 'li2008' }] });
  mk('Autre', { tags: [{ key: CITE_KEY_TAG, value: 'autre' }] });
  const doubles = of(rows(s), 'doubles');
  expect(ids(doubles).sort()).toEqual([A, B].sort());
  expect(doubles[0].detail).toBe('clé BibTeX « li2008 », sur 2 nœuds');
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Conflicts of .tex

test('une copie « (conflit du …) » avec son original est un conflit ; la ligne garde le nom de la copie', () => {
  const { s, mk } = world();
  const A = mk('Article');
  const copy = 'article (conflit du 2026-11-10 09h05).tex';
  run(s, editNode(s, A, { files: [file('article.tex'), file(copy, 'cd'.repeat(32))] }));
  const conflicts = of(rows(s), 'conflicts');
  expect(conflicts.map((r) => [r.kind, r.id, r.file])).toEqual([['node', A, copy]]);
  expect(conflicts[0].detail).toBe(`« ${copy} », copie de « article.tex »`);
});

test('une copie sans son original n’est pas un conflit', () => {
  const { s, mk } = world();
  const A = mk('Article');
  run(s, editNode(s, A, { files: [file('article (conflit du 2026-11-10 09h05).tex')] }));
  expect(of(rows(s), 'conflicts')).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Required tags

const required = (key: string, scope: TagKeyDef['scope'], defaultValue?: string): TagKeyDef =>
  ({ key, type: 'text', scope, multi: false, required: true, ...(defaultValue === undefined ? {} : { defaultValue }) });

test('une clé obligatoire avec valeur par défaut, absente d’un nœud, le liste, sous sa clé', () => {
  const { s, mk } = world();
  applyOp(s, { t: 'tagKey', before: null, after: required('statut', 'node', 'hypothèse') });
  applyOp(s, { t: 'tagKey', before: null, after: { ...required('libre', 'node'), required: false } });
  const A = mk('Sans statut');
  mk('Avec statut', { tags: [{ key: 'statut', value: 'étayé' }] });
  const tags = of(rows(s), 'tags');
  expect(tags.map((r) => [r.kind, r.id, r.group])).toEqual([['node', A, 'statut']]);
});

test('une clé de portée connexion ne liste pas les nœuds, mais les connexions de connaissance qui ne la portent pas', () => {
  const { s, mk, link } = world();
  applyOp(s, { t: 'tagKey', before: null, after: required('force', 'connection') });
  const A = mk('A'), B = mk('B'), C = mk('C');
  const ab = link(A, B), bc = link(B, C, { tags: [{ key: 'force', value: 'forte' }] });
  const tags = of(rows(s), 'tags');
  expect(tags.map((r) => [r.kind, r.id])).toEqual([['connection', ab]]);
  expect(ids(tags)).not.toContain(bc);
});

test('stateHealth : chaque clé obligatoire comptée, ses lignes faites seulement quand on les demande ; orphelins et jamais revus faits pour la tranche montrée', () => {
  const { s, mk, link } = world();
  applyOp(s, { t: 'tagKey', before: null, after: required('statut', 'node', 'hypothèse') });
  applyOp(s, { t: 'tagKey', before: null, after: required('force', 'connection') });
  const A = mk('A'), B = mk('B'), C = mk('C', { made: NOW - 40 * DAY }), D = mk('D', { made: NOW - 50 * DAY });
  link(A, B);
  const h = stateHealth(s, new Map(), [], NOW, P);
  expect(h.tags.map((g) => [g.key, g.count])).toEqual([['force', 1], ['statut', 4]]);
  expect(h.tags[1].rows().map((r) => r.id)).toEqual([A, B, C, D]);
  expect(h.tags[1].rows().every((r) => r.group === 'statut' && r.section === 'tags')).toBe(true);
  expect(h.orphans.length).toBe(2);
  expect(h.orphans.slice(1, 2).map((r) => [r.section, r.id])).toEqual([['orphans', D]]);
  expect(h.unseen.length).toBe(2);
  expect(h.unseen.slice(0, 1).map((r) => [r.id, r.detail])).toEqual([[C, 'créé il y a 40 jours']]);
  // Sections 1 and 2 apart, from the registry alone.
  mk('E', { summary: String.raw`\ref{nulle}` });
  expect(latexRows(s, registryOf(s)).map((r) => r.section)).toEqual(['broken']);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Orphans

test('un nœud sans connexion de connaissance est orphelin ; une inclusion seule ne compte pas ; une annotation n’est jamais orpheline', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A'), B = mk('B'), alone = mk('Seul'), G = mk('Groupe'), member = mk('Membre');
  link(A, B);
  run(s, include(s, plan, member, G));
  const note = idOf(run(s, createAnnotation(s, anchor(A), 'Un passage souligné')), 'node');
  const thrown = mk('Jeté');
  run(s, deleteEverywhere(s, thrown));
  const orphans = of(rows(s), 'orphans');
  expect(ids(orphans).sort()).toEqual([alone, G, member].sort());
  expect(ids(orphans)).not.toContain(note);
});

test('une connexion de connaissance à la corbeille ne compte pas', () => {
  const { s, mk, link } = world();
  const A = mk('A'), B = mk('B');
  link(A, B);
  expect(of(rows(s), 'orphans')).toEqual([]);
  run(s, deleteEverywhere(s, B));
  expect(ids(of(rows(s), 'orphans'))).toEqual([A]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Never seen

test('createdAt : l’instant lu dans un identifiant uuidv7 ; NaN pour un autre', () => {
  const { s, mk } = world();
  expect(createdAt(mk('A', { made: NOW - 5 * DAY }))).toBe(NOW - 5 * DAY);
  expect(createdAt('n1')).toBeNaN();
  expect(s.nodes.size).toBe(1);
});

test('jamais revus : un nœud créé il y a 31 jours sans consultation y est ; un de 29 jours, non ; un consulté, non ; une annotation, non', () => {
  const { s, mk, link } = world();
  const old = mk('Ancien', { made: NOW - 31 * DAY }), young = mk('Récent', { made: NOW - 29 * DAY }), seen = mk('Consulté', { made: NOW - 40 * DAY });
  link(old, young);
  at(NOW - 60 * DAY, () => run(s, createAnnotation(s, anchor(old), 'Un passage souligné')));
  const unseen = of(rows(s, { seen: new Map([[seen, NOW - 2 * DAY], ['inconnu', NOW]]) }), 'unseen');
  expect(unseen.map((r) => [r.id, r.detail])).toEqual([[old, 'créé il y a 31 jours']]);
  // Its threshold is the setting healthUnseenDays.
  expect(ids(of(healthRows(s, registryOf(s), new Map(), [], NOW, { ...P, healthUnseenDays: 20 }), 'unseen')).sort()).toEqual([old, young, seen].sort());
});

test('jamais revus : sans les consultations (seen null), la section est vide, et le dit', () => {
  const { s, mk } = world();
  mk('Ancien', { made: NOW - 31 * DAY });
  expect(of(rows(s, { seen: null }), 'unseen')).toEqual([]);
  expect(unseenNote(null, 'yes')).toBe('Les consultations n’ont pas pu être lues : cette section reste vide.');
  expect(unseenNote(new Map(), 'no')).toBe('L’enregistrement des consultations est éteint sur ce PC : ce que vous y consultez n’est pas compté.');
  expect(unseenNote(new Map(), 'yes')).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Intruders

/** Plan P with a group of two members, 800 apart, and a third node between them, in its envelope, not a member. */
function intruderWorld() {
  const w = world(), { s, plan, mk } = w;
  const G = mk('Groupe'), a = mk('Membre a'), b = mk('Membre b');
  applyOp(s, { t: 'placement', before: placementOf(s, plan, a) ?? null, after: { plan, node: a, x: 0, y: 0, k: 0 } });
  applyOp(s, { t: 'placement', before: placementOf(s, plan, b) ?? null, after: { plan, node: b, x: 800, y: 0, k: 0 } });
  run(s, include(s, plan, a, G));
  run(s, include(s, plan, b, G));
  const X = mk('Intrus');
  applyOp(s, { t: 'placement', before: placementOf(s, plan, X) ?? null, after: { plan, node: X, x: 400, y: 0, k: 0 } });
  return { ...w, G, X };
}
/** The scenes of a book: none cached by the graph unless told; each built and updated counted. */
function source(s: State, cached: (plan: Id) => PlanScene | undefined = () => undefined) {
  const built: Id[] = [];
  const src: SceneSource = {
    key: 'k', cached,
    build: (q) => { built.push(q); return buildScene(s, q, measure, P); },
    update: (scene, ops) => updateScene(scene, s, ops, measure, P).scene,
  };
  return { built, src };
}
/** The book's work done as the panel does it: a build alone, the scans by steps of a thousandth of a millisecond. */
function drain(book: IntruderBook): number {
  let steps = 0;
  for (let w = book.next(); w !== null; w = book.next(), steps++) if (w === 'build') book.build(); else book.step(0.001);
  return steps;
}

test('IntruderBook trouve l’intrus d’un plan : une scène bâtie à part, un plan à la fois, puis les enveloppes par tranches', () => {
  const { s, lobby, plan, X } = intruderWorld();
  const { built, src } = source(s);
  const book = new IntruderBook();
  book.follow(s, 0, null, src);
  // Nothing built while it follows the state: a build is a step of its own, one plan.
  expect(built).toEqual([]);
  expect(book.started()).toBe(false);
  expect(book.next()).toBe('build');
  book.build();
  expect(built).toEqual([lobby]);
  // A step of a thousandth of a millisecond takes one envelope: false until the plan's scan is over.
  expect(book.next()).toBe('scan');
  expect(drain(book)).toBeGreaterThanOrEqual(3);
  expect(built).toEqual([lobby, plan]);
  expect(book.done()).toBe(true);
  const found = book.rows();
  expect(found.map((r) => [r.section, r.kind, r.id, r.plan])).toEqual([['intruders', 'node', X, plan]]);
  expect(found[0].detail).toBe('dans l’enveloppe de « Groupe »');
});

test('IntruderBook : une action qui ne touche pas un plan ne le rebâtit ni ne le relit ; une qui le touche le met à jour sans le rebâtir ; un rendu groupé rebâtit ; une scène du graphe sert telle quelle', () => {
  const { s, lobby, plan, X } = intruderWorld();
  const other = idOf(run(s, createPlan(s, 'Q', 'plan')), 'plan');
  const Y = idOf(run(s, createNode(s, { plan: other, title: 'Y', x: 0, y: 0, k: 0 })), 'node');
  const { built, src } = source(s);
  const book = new IntruderBook();
  book.follow(s, 0, null, src);
  drain(book);
  expect([built.length, book.scans]).toEqual([3, 3]);
  // Y renamed, in Q only: Q's scene updated and read again; the lobby and P neither built nor read.
  let rev = 0;
  const act = (a: Action) => { run(s, a); book.follow(s, ++rev, a.ops, src); expect(book.done()).toBe(false); drain(book); };
  act(editNode(s, Y, { title: 'Y bis' }));
  expect([built.length, book.scans]).toEqual([3, 4]);
  act(editNode(s, Y, { title: 'Y ter' }));
  expect([built.length, book.scans]).toEqual([3, 5]);
  expect(book.rows().map((r) => r.id)).toEqual([X]);
  // X moved out of the envelope, in P: P read again, and its intruder gone.
  act(moveNodes(s, plan, [{ node: X, x: 400, y: 3000 }]));
  expect([built.length, book.scans]).toEqual([3, 6]);
  expect(book.rows()).toEqual([]);
  // Renders gathered (a revision skipped): its own scenes are built again, one per step.
  book.follow(s, rev += 2, null, src);
  expect(book.next()).toBe('build');
  drain(book);
  expect([built.length, book.scans]).toEqual([6, 9]);
  // A scene the graph keeps serves as it is: read once, then not again while it is the same object.
  const kept = buildScene(s, lobby, measure, P);
  const graph = source(s, (q) => (q === lobby ? kept : undefined));
  book.follow(s, ++rev, run(s, editNode(s, Y, { title: 'Y quater' })).ops, graph.src);
  drain(book);
  expect(graph.built).toEqual([]);
  expect(book.scans).toBe(11);
  book.follow(s, ++rev, run(s, editNode(s, Y, { title: 'Y quinquies' })).ops, graph.src);
  drain(book);
  expect(book.scans).toBe(12);
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. Plans skipped

test('les plans ignorés d’une répercussion sont retenus, 200 au plus, les derniers d’abord', () => {
  const journal = new SkippedPlans();
  let told = 0;
  journal.subscribe(() => told++);
  expect(SKIPPED_MAX).toBe(200);
  for (let i = 0; i < 250; i++) journal.add([{ node: `n${i}`, plan: 'p', why: 'escape' }]);
  expect(journal.list().length).toBe(200);
  expect(journal.list()[0].node).toBe('n249');
  expect(journal.list()[199].node).toBe('n50');
  expect(told).toBe(250);
  // Nothing added, nothing told.
  journal.add([]);
  expect(told).toBe(250);
  // What a repercussion left alone: the third group's plans and the loops', for each node moved.
  expect(skippedOf([{ node: 'a', r: { third: ['p1'], loops: ['p2'] } }, { node: 'b', r: { third: [], loops: ['p3'] } }])).toEqual([
    { node: 'a', plan: 'p1', why: 'third' }, { node: 'a', plan: 'p2', why: 'loop' }, { node: 'b', plan: 'p3', why: 'loop' },
  ]);
});

test('un plan ignoré est une ligne : le nœud, le plan et pourquoi ; un nœud ou un plan disparu n’en fait pas', () => {
  const { s, lobby, plan, mk } = world();
  const A = mk('Nœud déplacé');
  const skipped = [
    { node: A, plan, why: 'third' as const }, { node: A, plan: lobby, why: 'loop' as const }, { node: A, plan, why: 'escape' as const },
    { node: A, plan, why: 'interrupted' as const }, { node: 'disparu', plan, why: 'escape' as const }, { node: A, plan: 'disparu', why: 'escape' as const },
  ];
  const found = of(rows(s, { skipped }), 'skipped');
  expect(found.map((r) => [r.kind, r.id, r.plan, r.title, r.detail])).toEqual([
    ['node', A, plan, 'Nœud déplacé', 'plan « P » : troisième groupe'],
    ['node', A, lobby, 'Nœud déplacé', 'plan « Lobby » : boucle'],
    ['node', A, plan, 'Nœud déplacé', 'plan « P » : Échap'],
    ['node', A, plan, 'Nœud déplacé', 'plan « P » : répercussion interrompue'],
  ]);
  expect(new Set(found.map((r) => r.key)).size).toBe(4);
});

test('les sections viennent dans leur ordre, et une base saine n’en remplit aucune', () => {
  const { s, mk, link } = world();
  const A = mk('A', { summary: String.raw`\ref{x}` }), B = mk('B'), C = mk('C', { summary: String.raw`\label{x}` });
  link(A, B);
  link(B, C);
  expect(rows(s)).toEqual([]);
  const D = mk('D', { summary: String.raw`\ref{y}`, made: NOW - 90 * DAY });
  expect(rows(s).map((r) => [r.section, r.id])).toEqual([['broken', D], ['orphans', D], ['unseen', D]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// A row clicked

test('healthJump : au plan de la ligne s’il le montre encore, sinon comme un saut ; une annotation, son pop-up ; un objet jeté, le dit', () => {
  const { s, lobby, plan, mk } = world();
  const A = mk('A'), B = mk('B', { where: lobby });
  const row = (id: Id, extra: Partial<HealthRow> = {}): HealthRow => ({ section: 'orphans', kind: 'node', id, title: '', detail: '', key: id, ...extra });
  expect(healthJump(s, row(A), lobby, [])).toEqual({ reveal: { plan, id: A, kind: 'node' } });
  expect(healthJump(s, row(B), plan, [])).toEqual({ reveal: { plan: lobby, id: B, kind: 'node' } });
  // An intruder's row goes to its plan, wherever the view is; a plan that no longer shows it, as any jump.
  expect(healthJump(s, row(A, { plan }), lobby, [])).toEqual({ reveal: { plan, id: A, kind: 'node' } });
  expect(healthJump(s, row(B, { plan }), plan, [])).toEqual({ reveal: { plan: lobby, id: B, kind: 'node' } });
  const note = idOf(run(s, createAnnotation(s, anchor(A), 'Un passage souligné')), 'node');
  expect(healthJump(s, row(note), plan, [])).toEqual({ popup: note });
  run(s, deleteEverywhere(s, B));
  expect(healthJump(s, row(B), plan, [])).toEqual({ say: OBJECT_GONE });
});

test('healthJump : un conflit ouvre la comparaison de la copie avec son original ; la copie partie, il le dit', () => {
  const { s, plan, mk } = world();
  const A = mk('Article');
  const copy = 'article (conflit du 2026-11-10 09h05).tex';
  run(s, editNode(s, A, { files: [file('article.tex'), file(copy, 'cd'.repeat(32))] }));
  const [conflict] = of(rows(s), 'conflicts');
  expect(healthJump(s, conflict, plan, [])).toEqual({ compare: { node: A, original: 'article.tex', copy } });
  run(s, editNode(s, A, { files: [file('article.tex')] }));
  expect(healthJump(s, conflict, plan, [])).toEqual({ say: 'Cette copie de conflit n’est plus là.' });
});

// ---------------------------------------------------------------------------------------------------------------------
// The measure (plan 6b, task 9, step 4): sections 1 to 6 on the reference base, under 150 ms (median of three passes).
// Slow (the base takes seconds to build) and timed: run alone, CIRRUS_LENT=1 npx vitest run health — under the whole
// suite's load the machine is shared, and the time measured says so rather than the code.

test.runIf(process.env.CIRRUS_LENT === '1')('base de référence (lent) : sections 1 à 6 et 8 comme le panneau les calcule à chaque action, en moins de 150 ms, médiane de trois passes ; les intrus par tranches', () => {
  const { state: s } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
  // The test base's two required keys on nodes, which no node of the bench carries: every node lacks each.
  applyOp(s, { t: 'tagKey', before: null, after: required('statut_epistémique', 'node', 'hypothèse') });
  applyOp(s, { t: 'tagKey', before: null, after: required('pertinence', 'node', 'utile') });
  const registry = LatexRegistry.build(s, new Map());
  // Half the nodes seen; the bench's nodes were all made on 2026-01-01: the other half never seen.
  const seen = new Map<Id, number>();
  for (const n of s.nodes.values()) if (seen.size < s.nodes.size / 2) seen.set(n.id, NOW);
  // What the panel computes at each action (its sections folded or showing healthRowsShown rows each): sections 3 to 6
  // and 8, and the first rows of the long ones; sections 1 and 2 only when the registry is built again.
  const median = (label: string, fn: () => unknown) => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      fn();
      times.push(performance.now() - t);
    }
    const m = [...times].sort((a, b) => a - b)[1];
    console.log(`${label} : ${times.map((t) => t.toFixed(1)).join(', ')} ms (médiane ${m.toFixed(1)} ms)`);
    return m;
  };
  const action = () => {
    const h = stateHealth(s, seen, [], NOW, P);
    h.orphans.slice(0, P.healthRowsShown);
    h.unseen.slice(0, P.healthRowsShown);
    return h;
  };
  const h = action();
  expect(h.tags.map((g) => g.count)).toEqual([s.nodes.size, s.nodes.size]);
  expect(h.unseen.length).toBe(s.nodes.size - seen.size);
  expect(median('stateHealth, base de référence, deux clés obligatoires de nœud', action)).toBeLessThan(150);
  median('latexRows, base de référence', () => latexRows(s, registry));
  median('une clé dépliée (ses 50 000 lignes faites)', () => h.tags[0].rows());
  // The worst case, for the registry only: a required key on connections that none carries.
  applyOp(s, { t: 'tagKey', before: null, after: required('force', 'connection') });
  let knowledge = 0;
  for (let r = 0; r < connRowCount(s); r++) if (connKind(s, r) === KNOWLEDGE) knowledge++;
  expect(action().tags.find((g) => g.key === 'force')!.count).toBe(knowledge);
  median('stateHealth, pire cas, une clé obligatoire de connexion en plus', action);
  // The intruders of the lobby, for the registry: its scene built (a step alone), then its envelopes by slices.
  const book = new IntruderBook();
  const { src } = source(s);
  book.follow(s, 0, null, src);
  let t = performance.now();
  book.build();
  const built = performance.now() - t;
  t = performance.now();
  let slices = 0, longest = 0;
  for (let done = false; !done; slices++) {
    const u = performance.now();
    done = book.step(P.searchBuildSliceMs);
    longest = Math.max(longest, performance.now() - u);
  }
  console.log(`Intrus du lobby : scène ${built.toFixed(0)} ms, puis ${(performance.now() - t).toFixed(0)} ms en ${slices} tranches (la plus longue ${longest.toFixed(1)} ms) ; ${book.rows().length} intrus`);
  // An action that leaves the lobby's scene as it is: nothing read again.
  book.follow(s, 1, [], src);
  expect(book.next()).toBeNull();
}, 300_000);
