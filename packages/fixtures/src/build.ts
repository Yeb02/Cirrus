import { fileURLToPath } from 'node:url';
import {
  type Action, applyOps, connect, createNode, createPlan, editNode, type Id, include, type Member, movePhantom, placeNode, removeFromPlan, splitArm,
  type TagKeyDef, type TagValue, UndoStack, uuidv7,
} from '@cirrus/core';
import { importFile, type LocalStore } from '@cirrus/store';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));

/** The key objects, by name, for the tests of later plans. */
export interface FixtureIds {
  plans: { lobby: Id; these: Id; article: Id };
  nodes: Record<
    | 'mdl' | 'solomonoff' | 'universalite' | 'monde' | 'kolmogorov' | 'compression' | 'occam' | 'entropie' | 'biais' | 'generalisation'
    | 'groupeTheorie' | 'groupeComplexite' | 'groupeInduction' | 'groupeML' | 'theseOnly' | 'docRoot' | 'publication' | 'trashed',
    Id
  >;
  connections: Record<'mdlSolomonoff' | 'twoToOne' | 'twoToTwo' | 'associates' | 'split', Id>;
  phantoms: { node: Id; center: Id };
  undoneAction: Id;
}

const TAG_KEYS: TagKeyDef[] = [
  {
    key: 'statut_epistémique', type: 'enum', scope: 'node', multi: false, required: true, defaultValue: 'hypothèse',
    enumValues: [
      { name: 'spéculation', rank: 1 }, { name: 'hypothèse', rank: 2 }, { name: 'plausible', rank: 3 },
      { name: 'étayé', rank: 4 }, { name: 'consensus_scientifique', rank: 5 },
    ],
  },
  {
    key: 'pertinence', type: 'enum', scope: 'node', multi: false, required: true, defaultValue: 'utile',
    enumValues: [
      { name: 'anecdotique', rank: 1 }, { name: 'secondaire', rank: 2 }, { name: 'utile', rank: 3 },
      { name: 'important', rank: 4 }, { name: 'central', rank: 5 },
    ],
  },
  { key: 'nature', type: 'text', scope: 'node', multi: false, required: false },
  { key: 'provenance', type: 'text', scope: 'node', multi: false, required: false },
  { key: 'auteur', type: 'text', scope: 'node', multi: true, required: false },
  { key: 'date_de_publication', type: 'date', scope: 'node', multi: false, required: false },
  { key: 'parallèle', type: 'word', scope: 'connection', multi: false, required: false },
  { key: 'déduction', type: 'word', scope: 'connection', multi: false, required: false },
  { key: 'partie', type: 'number', scope: 'connection', multi: false, required: false },
  { key: 'suivant', type: 'word', scope: 'connection', multi: false, required: false },
];

const word = (key: string): TagValue => ({ key });
const kv = (key: string, value: string | number): TagValue => ({ key, value });
const src = (node: Id): Member => ({ node, role: 'source' });
const tgt = (node: Id): Member => ({ node, role: 'target' });
const asc = (node: Id): Member => ({ node, role: 'associate' });

/**
 * An artificial base that uses every feature of the model at least once (plan 2, task 9). The MDL, Solomonoff,
 * Universality and Algorithmic world nodes come from the user's example; everything else is invented. Each action is
 * computed on a working copy of the state, written, then applied to the copy (as the interface does: the store keeps
 * no state); read the result back with store.loadState().
 */
export function buildFixture(store: LocalStore, storeDir: string): FixtureIds {
  const s = store.loadState();
  const run = (a: Action): Action => { store.commit(a); applyOps(s, a.ops); return a; };
  const created = (a: Action, t: 'node' | 'plan' | 'connection'): Id =>
    (run(a).ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

  // Plans and tag registry.
  const lobby = created(createPlan(s, 'Lobby', 'lobby'), 'plan');
  const these = created(createPlan(s, 'Thèse', 'plan'), 'plan');
  const article = created(createPlan(s, 'Article MDL', 'document'), 'plan');
  run({ id: uuidv7(), label: 'Définir le registre de tags', ops: TAG_KEYS.map((after) => ({ t: 'tagKey', before: null, after })) });

  const node = (plan: Id, title: string, x: number, y: number, extra: { k?: number; summary?: string; tags?: TagValue[] } = {}): Id =>
    created(createNode(s, { plan, title, x, y, k: extra.k ?? 0, summary: extra.summary, tags: extra.tags }), 'node');
  const attach = (id: Id, ...names: string[]) =>
    run(editNode(s, id, { files: [...s.nodes.get(id)!.files, ...names.map((n) => importFile(storeDir, ASSETS + n))] }));

  // Lobby: groups on three levels, then the leaves.
  const groupeTheorie = node(lobby, 'Théorie algorithmique de l’information', 0, 0, { k: 2 });
  const groupeComplexite = node(lobby, 'Complexité et induction', 0, 0, { k: 1 });
  const groupeInduction = node(lobby, 'Induction universelle', -180, 140, { k: 1 });
  const groupeML = node(lobby, 'Généralisation en apprentissage', 1100, 440, { k: 1 });

  const mdl = node(lobby, 'Minimum Description Length Principle (MDL)', 175, 140, {
    summary: 'Énonce que le meilleur modèle génératif d’un jeu de données est celui qui le compresse le plus',
    tags: [
      kv('statut_epistémique', 'consensus_scientifique'), kv('pertinence', 5), kv('nature', 'principe'),
      word('théorie de l’information'), word('algorithmie'), word('axiome'), kv('provenance', 'externe'),
    ],
  });
  attach(mdl, 'Enoncé_détaillé.tex', 'calcul_mdl_séquence_aléatoire.py');
  const solomonoff = node(lobby, 'Induction de Solomonoff', -175, 140, { tags: [kv('statut_epistémique', 5), kv('pertinence', 'important')] });
  const priore = node(lobby, 'Priore universelle', -175, 260, { tags: [kv('nature', 'définition')] });
  const kolmogorov = node(lobby, 'Complexité de Kolmogorov', -175, -140, { tags: [kv('nature', 'définition')] });
  const compression = node(lobby, 'Compression sans perte', 175, -140);
  attach(compression, 'schéma_compression.png');
  const invariance = node(lobby, 'Théorème d’invariance', 0, -260, { tags: [kv('nature', 'théorème')] });
  const kraft = node(lobby, 'Inégalité de Kraft', 300, -260, { tags: [kv('nature', 'théorème')] });
  const codePrefixe = node(lobby, 'Code préfixe', 420, -140);
  const entropie = node(lobby, 'Entropie de Shannon', -420, -140, { tags: [kv('statut_epistémique', 'consensus_scientifique')] });
  const biais = node(lobby, 'Biais de simplicité des réseaux', 1100, 290, { tags: [kv('statut_epistémique', 'étayé')] });
  const surparam = node(lobby, 'Surparamétrisation', 930, 560);
  const generalisation = node(lobby, 'Généralisation sans régularisation', 1270, 560, { tags: [kv('statut_epistémique', 'plausible')] });
  const doubleDescente = node(lobby, 'Double descente', 1100, 680);
  const occam = node(lobby, 'Rasoir d’Occam formalisé', 720, 110, { tags: [kv('provenance', 'personnelle')] });
  const universalite = node(lobby, 'Universalité algorithmique', 660, 650, { tags: [kv('statut_epistémique', 'spéculation'), kv('provenance', 'personnelle')] });
  const monde = node(lobby, 'Monde algorithmique', 190, 740, { tags: [kv('statut_epistémique', 'spéculation'), kv('pertinence', 'central')] });
  const publication = node(lobby, 'An Introduction to Kolmogorov Complexity and Its Applications', -420, -300, {
    tags: [kv('auteur', 'Ming Li'), kv('auteur', 'Paul Vitányi'), kv('date_de_publication', '2008')],
  });
  attach(publication, 'Li_Vitányi_extrait.pdf');

  for (const [n, g] of [
    [groupeComplexite, groupeTheorie], [groupeInduction, groupeComplexite],
    [mdl, groupeComplexite], [kolmogorov, groupeComplexite], [compression, groupeComplexite],
    [solomonoff, groupeInduction], [priore, groupeInduction],
    [biais, groupeML], [surparam, groupeML], [generalisation, groupeML], [doubleDescente, groupeML],
  ] as const) run(include(s, lobby, n, g));

  // Knowledge connections in the lobby.
  const mdlSolomonoff = created(connect(s, {
    plan: lobby, members: [asc(mdl), asc(solomonoff)], title: 'Analogue bayésien', tags: [word('parallèle')],
    relation: 'La priore universelle de l’induction de Solomonoff biaise la posteriore vers les algorithmes les plus courts, un analogue bayésien au MDL.',
  }), 'connection');
  const split = created(connect(s, { plan: lobby, members: [src(mdl), tgt(universalite)] }), 'connection');
  run(connect(s, { plan: lobby, members: [src(universalite), tgt(monde)] }));
  run(connect(s, {
    plan: lobby, members: [src(kolmogorov), src(solomonoff), src(mdl), tgt(occam)], title: 'Déduction jointe', tags: [word('déduction')],
    relation: 'Ces trois nœuds ensemble mènent au résultat, ce qui diffère de trois connexions séparées.',
  }));
  const twoToTwo = created(connect(s, {
    plan: lobby, members: [src(occam), src(universalite), tgt(biais), tgt(generalisation)], title: 'Deux résultats', tags: [word('déduction')],
  }), 'connection');
  run(connect(s, { plan: lobby, members: [src(surparam), tgt(generalisation)] }));
  run(connect(s, { plan: lobby, members: [src(biais), tgt(generalisation)] }));
  run(connect(s, { plan: lobby, members: [src(solomonoff), tgt(universalite)], title: 'Autre lien vers l’universalité' }));
  run(connect(s, { plan: lobby, members: [src(compression), tgt(biais), asc(occam)], title: 'Source, cible et associé' }));
  run(connect(s, { plan: lobby, members: [src(priore), tgt(solomonoff)] }));
  run(connect(s, { plan: lobby, members: [src(kraft), tgt(codePrefixe)] }));
  run(connect(s, { plan: lobby, members: [src(invariance), tgt(kolmogorov)] }));
  run(connect(s, { plan: lobby, members: [src(doubleDescente), tgt(surparam)] }));
  const associates = created(connect(s, { plan: lobby, members: [asc(entropie), asc(compression)], title: 'Même mesure' }), 'connection');
  run(connect(s, { plan: lobby, members: [src(publication), tgt(kolmogorov)], title: 'Référence' }));

  // Split arm: Universality's arm of MDL → Universality; the far node's phantom sits in MDL's group.
  run(splitArm(s, lobby, split, universalite, { x: 330, y: 220, k: 0 }, { x: 600, y: 560, k: 0 }));
  const phantomOf = (kind: 'node' | 'center') => [...s.phantoms.values()].find((p) => p.connection === split && p.of.kind === kind)!.id;
  run(movePhantom(s, phantomOf('node'), 320, 230, groupeComplexite));

  // "Thèse": another group for MDL, a node found only here, a stub.
  const theseOnly = node(these, 'Chapitre 2 : compression et généralisation', 0, 0, { k: 1 });
  for (const [n, x, y] of [[mdl, -150, 0], [compression, 150, 0], [kolmogorov, -150, -200], [generalisation, 400, 300]] as const) {
    run(placeNode(s, these, n, x, y, 0));
  }
  run(include(s, these, mdl, theseOnly));
  run(include(s, these, compression, theseOnly));
  const twoToOne = created(connect(s, {
    plan: these, members: [src(kolmogorov), src(entropie), tgt(compression)], title: 'Source hors plan', tags: [word('déduction')],
    relation: 'Entropie de Shannon n’est pas dans ce plan : sa branche y est une amorce.',
  }), 'connection');

  // "Article MDL": root, parts 1 to 3, a sub-part, a chain of "suivant".
  const docRoot = node(article, 'Le MDL comme principe d’induction', 0, 0, { k: 1 });
  const intro = node(article, 'Introduction', -300, 200);
  const motivation = node(article, 'Motivation', -300, 320);
  const planArticle = node(article, 'Plan de l’article', -300, 440);
  run(placeNode(s, article, mdl, 0, 200, 0));
  run(placeNode(s, article, solomonoff, 0, 400, 0));
  const conclusion = node(article, 'Conclusion', 300, 200);
  const part = (parent: Id, child: Id, x: number) =>
    run(connect(s, { plan: article, kind: 'structure', members: [src(parent), tgt(child)], tags: [kv('partie', x)] }));
  const next = (from: Id, to: Id) => run(connect(s, { plan: article, kind: 'structure', members: [src(from), tgt(to)], tags: [word('suivant')] }));
  part(docRoot, intro, 1);
  part(docRoot, mdl, 2);
  part(docRoot, conclusion, 3);
  part(mdl, solomonoff, 1);
  next(intro, motivation);
  next(motivation, planArticle);

  // Trash, and an undone action in the history.
  const trashed = node(lobby, 'Note brouillon à jeter', 900, -300);
  run(removeFromPlan(s, lobby, trashed));
  const stack = new UndoStack();
  const typo = run(editNode(s, occam, { title: 'Rasoir d’Ocam formalisé' }));
  stack.record(typo);
  run(stack.undo(s)!);

  return {
    plans: { lobby, these, article },
    nodes: {
      mdl, solomonoff, universalite, monde, kolmogorov, compression, occam, entropie, biais, generalisation,
      groupeTheorie, groupeComplexite, groupeInduction, groupeML, theseOnly, docRoot, publication, trashed,
    },
    connections: { mdlSolomonoff, twoToOne, twoToTwo, associates, split },
    phantoms: { node: phantomOf('node'), center: phantomOf('center') },
    undoneAction: typo.id,
  };
}
