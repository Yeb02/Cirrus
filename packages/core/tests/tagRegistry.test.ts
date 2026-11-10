import { expect, test } from 'vitest';
import {
  type Action, CommandError, connect, connectionName, createNode, createPlan, defineTagKey, deleteConnection, deleteEverywhere, deleteTagKey,
  editConnection, editNode, renameEnumValue, renameTagKey,
} from '../src/commands.ts';
import { invertAction, UndoConflictError, UndoStack } from '../src/history.ts';
import { uuidv7 } from '../src/ids.ts';
import * as core from '../src/index.ts';
import { checkState } from '../src/invariants.ts';
import type { Id, TagKeyDef, TagValue } from '../src/model.ts';
import { MAX_ID_CHARS } from '../src/ops.ts';
import { PROTECTED_TAG_KEYS, readTagNumber } from '../src/registry.ts';
import { applyOp, applyOps, emptyState, type State, taggedKeys, taggedWith } from '../src/state.ts';
import { parseUnit, reconcile, type RemoteUnit, type Unit } from '../src/sync.ts';
import { created, view } from './helpers.ts';
import { accept, copy, crossed, image } from './twoPcs.ts';

// The tag registry's commands (plan 6a, task 3, D4): create or change a key, rename it everywhere, remove it from the
// registry, rename an enumeration's value; each one action, checked, that an undo gives back and the sync carries.

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const T0 = Date.UTC(2026, 10, 10, 9);
const unitOf = (a: Action, pc: string, at: number): Unit => ({ unit: uuidv7(), action: a.id, label: a.label, at, pc, ops: a.ops });
/** What the server checks first (POST /units): the write's shape and each operation's, as it comes off the network. */
const accepted = (a: Action) => parseUnit(wire(unitOf(a, 'pc-a', T0)));
const sortedIds = (ids: Iterable<Id>) => [...ids].sort();
const tagsOf = (s: State, id: Id): TagValue[] => (s.nodes.get(id) ?? s.connections.get(id))!.tags;

const TEXT: TagKeyDef = { key: 'statut', type: 'text', scope: 'both', multi: false, required: false };
const NIVEAU: TagKeyDef = {
  key: 'niveau', type: 'enum', scope: 'both', multi: false, required: true, defaultValue: 'moyen',
  enumValues: [{ name: 'bas', rank: 1 }, { name: 'moyen', rank: 2 }, { name: 'haut', rank: 3 }],
};

/** Plan P; the registry's keys written as raw operations (not the commands under test); `mk` a node, `link` a connection. */
function world(defs: TagKeyDef[] = []) {
  const s = emptyState();
  const P = created(run(s, createPlan(s, 'P', 'plan')), 'plan');
  for (const after of defs) applyOp(s, { t: 'tagKey', before: null, after });
  let x = 0;
  const mk = (title: string, tags: TagValue[] = []) => created(run(s, createNode(s, { plan: P, title, x: (x += 100), y: 0, k: 0, tags })), 'node');
  const link = (a: Id, b: Id, tags: TagValue[] = [], title = '', relation = '') =>
    created(run(s, connect(s, { plan: P, title, relation, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], tags })), 'connection');
  return { s, P, mk, link };
}

/** The error a command throws: its class and message. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    return (e as Error).message;
  }
  throw new Error('la commande n’a pas été refusée');
}

// ---------------------------------------------------------------------------------------------------------------------
// taggedWith and PROTECTED_TAG_KEYS

test('taggedWith : les nœuds et les connexions qui portent une clé, corbeille comprise, par l’index ; exporté du paquet', () => {
  const { s, mk, link } = world();
  const a = mk('A', [{ key: 'lu' }]), b = mk('B', [{ key: 'lu' }, { key: 'thème', value: 'MDL' }]), c = mk('C');
  const ab = link(a, b, [{ key: 'lu' }]);
  run(s, deleteEverywhere(s, a));
  expect(sortedIds(taggedWith(s, 'lu'))).toEqual(sortedIds([a, b, ab]));
  expect(sortedIds(taggedWith(s, 'thème'))).toEqual([b]);
  expect(taggedWith(s, 'absent').size).toBe(0);
  expect(taggedWith(s, 'lu').has(c)).toBe(false);
  expect(core.taggedWith).toBe(taggedWith);
  expect(core.PROTECTED_TAG_KEYS).toBe(PROTECTED_TAG_KEYS);
  for (const k of ['defineTagKey', 'renameTagKey', 'deleteTagKey', 'renameEnumValue'] as const) expect(typeof core[k]).toBe('function');
});

test('taggedKeys : les clés que portent des objets, déclarées ou non, corbeille comprise, une fois chacune ; une clé que plus rien ne porte s’en va', () => {
  const { s, mk, link } = world([TEXT]);
  const a = mk('A', [{ key: 'lu' }, { key: 'thème', value: 'MDL' }]), b = mk('B', [{ key: 'lu' }]);
  const ab = link(a, b, [{ key: 'lu' }, { key: 'connexe' }]);
  expect([...taggedKeys(s)].sort()).toEqual(['connexe', 'lu', 'thème']);
  // Declared and carried by no one: not carried. Carried by a node in the trash: carried.
  run(s, deleteEverywhere(s, a));
  expect([...taggedKeys(s)].sort()).toEqual(['connexe', 'lu', 'thème']);
  run(s, editConnection(s, ab, { tags: [] }));
  run(s, editNode(s, b, { tags: [] }));
  expect([...taggedKeys(s)].sort()).toEqual(['lu', 'thème']);
  expect(core.taggedKeys).toBe(taggedKeys);
});

test('PROTECTED_TAG_KEYS : les clés dont Cirrus se sert, chacune avec le type, la portée et la multiplicité qu’il lui donne', () => {
  expect([...PROTECTED_TAG_KEYS.keys()].sort()).toEqual(['arxiv', 'auteur', 'clé_bibtex', 'date_de_publication', 'doi', 'label', 'partie', 'suivant']);
  expect(PROTECTED_TAG_KEYS.get('auteur')).toEqual({ type: 'text', scope: 'node', multi: true });
  expect(PROTECTED_TAG_KEYS.get('date_de_publication')).toEqual({ type: 'date', scope: 'node', multi: false });
  expect(PROTECTED_TAG_KEYS.get('partie')).toEqual({ type: 'number', scope: 'connection', multi: false });
  expect(PROTECTED_TAG_KEYS.get('suivant')).toEqual({ type: 'word', scope: 'connection', multi: false });
  expect(PROTECTED_TAG_KEYS.get('label')).toEqual({ type: 'text', scope: 'node', multi: false });
});

test('readTagNumber : un nombre tapé, à la française aussi, ses espaces ôtées (insécables comprises) ; sinon null, et null pour un nombre infini', () => {
  const read = (text: string) => readTagNumber(text);
  expect([read('1,5'), read(' 1 000 '), read('1 000'), read('-2.25'), read('+3'), read(',5'), read('5,'), read('0')]).toEqual([1.5, 1000, 1000, -2.25, 3, 0.5, 5, 0]);
  for (const text of ['', ' ', 'abc', '1,5,2', '1e3', '1.2.3', '−3', '9'.repeat(400)]) expect(read(text), text).toBeNull();
  expect(core.readTagNumber).toBe(readTagNumber);
});

// ---------------------------------------------------------------------------------------------------------------------
// defineTagKey

test('defineTagKey : crée une clé, une opération, défaite par l’annulation ; le serveur accepte l’action', () => {
  const { s } = world();
  const a = run(s, defineTagKey(s, NIVEAU));
  expect(a.label).toBe('Créer le tag « niveau »');
  expect(a.ops).toEqual([{ t: 'tagKey', before: null, after: NIVEAU }]);
  expect(s.tagKeys.get('niveau')).toEqual(NIVEAU);
  expect(() => accepted(a)).not.toThrow();
  run(s, invertAction(a));
  expect(s.tagKeys.has('niveau')).toBe(false);
});

test('defineTagKey : modifie une définition ; seuls ses champs sont écrits (pas d’énumération hors d’une énumération)', () => {
  const { s, mk } = world([TEXT]);
  mk('A', [{ key: 'statut', value: 'relu' }]);
  const a = run(s, defineTagKey(s, { ...TEXT, required: true, defaultValue: 'brouillon', enumValues: [{ name: 'x', rank: 1 }], extra: 1 } as TagKeyDef));
  expect(a.label).toBe('Modifier le tag « statut »');
  expect(a.ops).toEqual([{ t: 'tagKey', before: TEXT, after: { ...TEXT, required: true, defaultValue: 'brouillon' } }]);
  expect(() => accepted(a)).not.toThrow();
});

test('defineTagKey : la même définition est refusée ; une valeur par défaut qui ne convient pas aussi', () => {
  const { s } = world([TEXT, NIVEAU]);
  expect(refusal(() => defineTagKey(s, { ...TEXT }))).toBe('La définition du tag « statut » est déjà celle-ci.');
  expect(refusal(() => defineTagKey(s, { ...NIVEAU, defaultValue: 'extrême' }))).toBe('La valeur par défaut « extrême » ne convient pas au tag « niveau ».');
  expect(refusal(() => defineTagKey(s, { key: 'année', type: 'number', scope: 'node', multi: false, required: true, defaultValue: 'deux mille' })))
    .toBe('La valeur par défaut « deux mille » ne convient pas au tag « année ».');
  expect(refusal(() => defineTagKey(s, { key: 'lu', type: 'word', scope: 'node', multi: false, required: true, defaultValue: 'oui' })))
    .toBe('La valeur par défaut « oui » ne convient pas au tag « lu ».');
  // A rank designates its value, as for a tag.
  expect(() => defineTagKey(s, { ...NIVEAU, defaultValue: 3 })).not.toThrow();
});

test('defineTagKey : un nom vide, trop long, avec « : » ou une espace autour est refusé ; MAX_ID_CHARS caractères passent', () => {
  const { s } = world();
  const named = (key: string) => () => defineTagKey(s, { ...TEXT, key });
  expect(refusal(named(''))).toBe('Le nom du tag est vide.');
  expect(refusal(named('   '))).toBe('Le nom du tag est vide.');
  expect(refusal(named('x'.repeat(MAX_ID_CHARS + 1)))).toBe(`Le nom d’un tag compte ${MAX_ID_CHARS} caractères au plus (ici ${MAX_ID_CHARS + 1}).`);
  for (const key of ['a:b', ' statut', 'statut ']) expect(refusal(named(key)), key).toBe('Un nom de tag ne contient pas « : », et ne commence ni ne finit par une espace.');
  expect(() => accepted(defineTagKey(s, { ...TEXT, key: 'é'.repeat(MAX_ID_CHARS) }))).not.toThrow();
});

test('defineTagKey : une énumération sans nom, à deux noms ou deux rangs égaux est refusée', () => {
  const { s } = world();
  const values = (enumValues: { name: string; rank: number }[]) => () => defineTagKey(s, { ...NIVEAU, defaultValue: undefined, enumValues });
  expect(refusal(values([{ name: '', rank: 1 }]))).toBe('Une valeur de l’énumération n’a pas de nom.');
  expect(refusal(values([{ name: 'bas', rank: 1 }, { name: 'bas', rank: 2 }]))).toBe('Deux valeurs de l’énumération s’appellent « bas ».');
  expect(refusal(values([{ name: 'bas', rank: 1 }, { name: 'haut', rank: 1 }]))).toBe('Deux valeurs de l’énumération ont le rang 1.');
  // parseTag trims a typed value: a name with a space around it could never be typed.
  for (const name of [' bas', 'bas ']) expect(refusal(values([{ name, rank: 1 }])), name).toBe(`Le nom de valeur « ${name} » commence ou finit par une espace.`);
});

test('defineTagKey : une valeur par défaut numérique non finie est refusée, quel que soit le type (le serveur la refuserait)', () => {
  const { s } = world();
  for (const type of ['text', 'number', 'date'] as const) {
    for (const defaultValue of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal(() => defineTagKey(s, { key: 'k', type, scope: 'node', multi: false, required: true, defaultValue })), `${type} ${defaultValue}`)
        .toBe('La valeur par défaut du tag « k » n’est pas un nombre fini.');
    }
  }
  expect(() => accepted(defineTagKey(s, { key: 'k', type: 'text', scope: 'node', multi: false, required: true, defaultValue: 2 }))).not.toThrow();
});

test('defineTagKey : un type qu’une valeur portée ne respecterait plus est refusé ; le message compte les objets et nomme le premier par son titre', () => {
  const { s, mk } = world([TEXT]);
  mk('Zêta', [{ key: 'statut', value: 'relu' }]);
  mk('Éta', [{ key: 'statut', value: 'brouillon' }]);
  mk('alpha', [{ key: 'statut', value: '12' }]);
  mk('bêta', [{ key: 'statut', value: 'publié' }]);
  // In French order: alpha, bêta, Éta, Zêta — and alpha's « 12 » is a number: bêta comes first among the three.
  expect(refusal(() => defineTagKey(s, { ...TEXT, type: 'number' }))).toBe('3 nœuds portent une valeur que ce changement rendrait invalide, dont « bêta ».');
  expect(refusal(() => defineTagKey(s, { ...TEXT, type: 'word' }))).toBe('4 nœuds portent une valeur que ce changement rendrait invalide, dont « alpha ».');
  expect(s.tagKeys.get('statut')).toEqual(TEXT);
});

test('defineTagKey : un nombre se lit comme le pop-up le lit (« 1,5 », « 1 000 », un nombre) ; une date et un texte prennent toute valeur, mais en demandent une', () => {
  const { s, mk } = world();
  mk('A', [{ key: 'poids', value: '1,5' }]);
  mk('B', [{ key: 'poids', value: '1 000' }]);
  mk('C', [{ key: 'poids', value: 12 }]);
  mk('D', [{ key: 'quand', value: 'mai 2008' }]);
  expect(() => run(s, defineTagKey(s, { key: 'poids', type: 'number', scope: 'node', multi: false, required: false }))).not.toThrow();
  expect(() => run(s, defineTagKey(s, { key: 'quand', type: 'date', scope: 'node', multi: false, required: false }))).not.toThrow();
  mk('E', [{ key: 'vu' }]);
  expect(refusal(() => defineTagKey(s, { key: 'vu', type: 'date', scope: 'node', multi: false, required: false })))
    .toBe('1 nœud porte une valeur que ce changement rendrait invalide : « E ».');
  expect(() => defineTagKey(s, { key: 'vu', type: 'word', scope: 'node', multi: false, required: false })).not.toThrow();
});

test('defineTagKey : la portée se juge par le genre de chaque porteur ; nœuds et connexions ensemble font des « objets »', () => {
  const { s, mk, link } = world([TEXT]);
  const a = mk('A', [{ key: 'statut', value: 'x' }]), b = mk('B');
  link(a, b, [{ key: 'statut', value: 'y' }], 'Relie');
  expect(refusal(() => defineTagKey(s, { ...TEXT, scope: 'node' }))).toBe('1 connexion porte une valeur que ce changement rendrait invalide : « Relie ».');
  expect(refusal(() => defineTagKey(s, { ...TEXT, scope: 'connection' }))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « A ».');
  expect(refusal(() => defineTagKey(s, { ...TEXT, type: 'word' }))).toBe('2 objets portent une valeur que ce changement rendrait invalide, dont « A ».');
  const c = link(b, a, [{ key: 'statut', value: 'z' }]);
  expect(refusal(() => defineTagKey(s, { ...TEXT, scope: 'node' }))).toBe('2 connexions portent une valeur que ce changement rendrait invalide, dont « Relie ».');
  expect(c).toBeDefined();
});

test('defineTagKey : une clé multiple ne redevient simple que si aucun objet n’en porte plusieurs valeurs', () => {
  const { s, mk } = world([{ ...TEXT, key: 'thème', multi: true }]);
  mk('A', [{ key: 'thème', value: 'MDL' }]);
  const b = mk('B', [{ key: 'thème', value: 'MDL' }, { key: 'thème', value: 'Bayes' }]);
  expect(refusal(() => defineTagKey(s, { ...TEXT, key: 'thème' }))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « B ».');
  run(s, editNode(s, b, { tags: [{ key: 'thème', value: 'Bayes' }] }));
  expect(() => defineTagKey(s, { ...TEXT, key: 'thème' })).not.toThrow();
});

test('defineTagKey : une énumération ne perd ni ne renomme une valeur portée ; elle en gagne, change un rang, et se déclare sur des valeurs déjà portées', () => {
  const { s, mk } = world([NIVEAU]);
  mk('A', [{ key: 'niveau', value: 'bas' }]);
  const without = NIVEAU.enumValues!.filter((e) => e.name !== 'bas');
  expect(refusal(() => defineTagKey(s, { ...NIVEAU, enumValues: without }))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « A ».');
  expect(refusal(() => defineTagKey(s, { ...NIVEAU, enumValues: [{ name: 'faible', rank: 1 }, ...without] }))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « A ».');
  expect(() => run(s, defineTagKey(s, { ...NIVEAU, enumValues: [...NIVEAU.enumValues!, { name: 'extrême', rank: 4 }] }))).not.toThrow();
  expect(() => run(s, defineTagKey(s, { ...NIVEAU, enumValues: [{ name: 'bas', rank: 0 }, ...without] }))).not.toThrow();
  // Values typed before the key was declared: a name, or a rank (which designates its value).
  mk('B', [{ key: 'force', value: 'forte' }]);
  mk('C', [{ key: 'force', value: 1 }]);
  const force: TagKeyDef = { key: 'force', type: 'enum', scope: 'node', multi: false, required: false, enumValues: [{ name: 'faible', rank: 1 }, { name: 'forte', rank: 2 }] };
  expect(() => run(s, defineTagKey(s, force))).not.toThrow();
  expect(checkState(s)).toEqual([]);
});

test('defineTagKey : la corbeille compte ; un objet vivant est nommé d’abord, un objet jeté seul est dit à la corbeille', () => {
  const { s, mk } = world([TEXT]);
  const a = mk('A', [{ key: 'statut', value: 'x' }]);
  mk('B', [{ key: 'statut', value: 'y' }]);
  run(s, deleteEverywhere(s, a));
  expect(refusal(() => defineTagKey(s, { ...TEXT, type: 'number' }))).toBe('2 nœuds portent une valeur que ce changement rendrait invalide, dont « B ».');
  const { s: t, mk: mk2 } = world([TEXT]);
  const c = mk2('C', [{ key: 'statut', value: 'x' }]);
  run(t, deleteEverywhere(t, c));
  expect(refusal(() => defineTagKey(t, { ...TEXT, type: 'number' }))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « C » (à la corbeille).');
});

test('defineTagKey : une clé dont Cirrus se sert ne change que son caractère obligatoire et sa valeur par défaut ; créée, elle a la forme que Cirrus lui donne', () => {
  const auteur: TagKeyDef = { key: 'auteur', type: 'text', scope: 'node', multi: true, required: false };
  const { s } = world([auteur]);
  const shape = 'Cirrus se sert du tag « auteur » : seuls son caractère obligatoire et sa valeur par défaut se changent.';
  expect(refusal(() => defineTagKey(s, { ...auteur, type: 'word' }))).toBe(shape);
  expect(refusal(() => defineTagKey(s, { ...auteur, scope: 'both' }))).toBe(shape);
  expect(refusal(() => defineTagKey(s, { ...auteur, multi: false }))).toBe(shape);
  expect(() => run(s, defineTagKey(s, { ...auteur, required: true, defaultValue: 'Anon' }))).not.toThrow();
  // Not declared yet (a real base starts with an empty registry): created with Cirrus's form only.
  expect(refusal(() => defineTagKey(s, { key: 'doi', type: 'text', scope: 'both', multi: false, required: false })))
    .toBe('Cirrus se sert du tag « doi » : seuls son caractère obligatoire et sa valeur par défaut se changent.');
  expect(() => run(s, defineTagKey(s, { key: 'doi', type: 'text', scope: 'node', multi: false, required: false }))).not.toThrow();
  // Declared otherwise before this rule (an older base): kept as it is, or brought to Cirrus's form.
  const { s: t } = world([{ ...auteur, multi: false }]);
  expect(() => defineTagKey(t, { ...auteur, multi: false, required: true })).not.toThrow();
  expect(() => defineTagKey(t, auteur)).not.toThrow();
  expect(refusal(() => defineTagKey(t, { ...auteur, multi: false, scope: 'both' }))).toBe(shape);
});

// ---------------------------------------------------------------------------------------------------------------------
// renameTagKey

test('renameTagKey : la définition et chaque porteur, nœuds et connexions, corbeille comprise, en une action ; l’ordre des tags reste', () => {
  const { s, mk, link } = world([TEXT]);
  const a = mk('A', [{ key: 'lu' }, { key: 'statut', value: 'relu' }, { key: 'thème', value: 'MDL' }]);
  const b = mk('B', [{ key: 'statut', value: 'brouillon' }]);
  const c = mk('C', [{ key: 'statut', value: 'publié' }]);
  const ab = link(a, b, [{ key: 'statut', value: 'lien' }]);
  const bc = link(b, c, [{ key: 'statut', value: 'jeté' }]);
  run(s, deleteEverywhere(s, c));
  run(s, deleteConnection(s, ab));
  expect(s.connections.get(bc)!.trashedAt).toBeDefined();
  const r = run(s, renameTagKey(s, 'statut', 'état'));
  expect(r.label).toBe('Renommer le tag « statut » en « état »');
  expect(s.tagKeys.has('statut')).toBe(false);
  expect(s.tagKeys.get('état')).toEqual({ ...TEXT, key: 'état' });
  expect(tagsOf(s, a)).toEqual([{ key: 'lu' }, { key: 'état', value: 'relu' }, { key: 'thème', value: 'MDL' }]);
  expect(tagsOf(s, b)).toEqual([{ key: 'état', value: 'brouillon' }]);
  expect(tagsOf(s, c)).toEqual([{ key: 'état', value: 'publié' }]);
  expect(tagsOf(s, ab)).toEqual([{ key: 'état', value: 'lien' }]);
  expect(tagsOf(s, bc)).toEqual([{ key: 'état', value: 'jeté' }]);
  expect(s.nodes.get(c)!.trashedAt).toBeDefined();
  expect(taggedWith(s, 'statut').size).toBe(0);
  expect(sortedIds(taggedWith(s, 'état'))).toEqual(sortedIds([a, b, c, ab, bc]));
  // One operation per record: the two definitions, five carriers.
  expect(r.ops.map((o) => o.t).sort()).toEqual(['connection', 'connection', 'node', 'node', 'node', 'tagKey', 'tagKey']);
  expect(() => accepted(r)).not.toThrow();
  expect(checkState(s)).toEqual([]);
});

test('renameTagKey : une clé à une valeur déjà portée sous le nouveau nom garde la valeur de l’ancienne', () => {
  const { s, mk } = world([TEXT]);
  const a = mk('A', [{ key: 'état', value: 'vieux' }, { key: 'lu' }, { key: 'statut', value: 'relu' }]);
  const b = mk('B', [{ key: 'état', value: 'seul' }]);
  const r = run(s, renameTagKey(s, 'statut', 'état'));
  expect(tagsOf(s, a)).toEqual([{ key: 'lu' }, { key: 'état', value: 'relu' }]);
  // Not a carrier of the old key: untouched, its value now under the definition.
  expect(tagsOf(s, b)).toEqual([{ key: 'état', value: 'seul' }]);
  expect(r.ops.some((o) => o.t === 'node' && o.after?.id === b)).toBe(false);
  expect(() => accepted(r)).not.toThrow();
});

test('renameTagKey : une clé multiple réunit ses valeurs et celles déjà portées sous le nouveau nom, sans doublon', () => {
  const { s, mk } = world([{ ...TEXT, key: 'sujet', multi: true }]);
  const a = mk('A', [{ key: 'sujet', value: 'x' }, { key: 'lu' }, { key: 'thème', value: 'y' }, { key: 'sujet', value: 'y' }, { key: 'thème', value: 'z' }]);
  // The number 3 and the text « 3 » are two values.
  const b = mk('B', [{ key: 'sujet', value: 3 }, { key: 'thème', value: '3' }, { key: 'thème', value: 3 }]);
  run(s, renameTagKey(s, 'sujet', 'thème'));
  expect(tagsOf(s, a)).toEqual([{ key: 'thème', value: 'x' }, { key: 'lu' }, { key: 'thème', value: 'y' }, { key: 'thème', value: 'z' }]);
  expect(tagsOf(s, b)).toEqual([{ key: 'thème', value: 3 }, { key: 'thème', value: '3' }]);
});

test('renameTagKey : une clé non déclarée, seulement portée, se renomme sans écrire de définition ; les valeurs se réunissent', () => {
  const { s, mk } = world();
  const a = mk('A', [{ key: 'lu' }, { key: 'vu' }]), b = mk('B', [{ key: 'lu' }]);
  const r = run(s, renameTagKey(s, 'lu', 'vu'));
  expect(r.ops.some((o) => o.t === 'tagKey')).toBe(false);
  expect([tagsOf(s, a), tagsOf(s, b)]).toEqual([[{ key: 'vu' }], [{ key: 'vu' }]]);
  expect(s.tagKeys.size).toBe(0);
  expect(() => accepted(r)).not.toThrow();
});

test('renameTagKey : une clé non déclarée se range sous une clé déclarée (D4, « un second renommage la range ») : sa définition juge les valeurs, et une clé à une valeur garde celle de l’ancienne', () => {
  const { s, mk, link } = world([TEXT, NIVEAU]);
  const a = mk('A', [{ key: 'statut', value: 'vieux' }, { key: 'état', value: 'neuf' }]);
  const b = mk('B', [{ key: 'état', value: 'seul' }]);
  const r = run(s, renameTagKey(s, 'état', 'statut'));
  expect(r.ops.map((o) => o.t)).toEqual(['node', 'node']);
  expect([tagsOf(s, a), tagsOf(s, b)]).toEqual([[{ key: 'statut', value: 'neuf' }], [{ key: 'statut', value: 'seul' }]]);
  expect(s.tagKeys.get('statut')).toEqual(TEXT);
  expect(() => accepted(r)).not.toThrow();
  // Judged by the definition they come under: values, scope, number of values.
  mk('C', [{ key: 'grade', value: 'extrême' }]);
  expect(refusal(() => renameTagKey(s, 'grade', 'niveau'))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « C ».');
  const d = mk('D', [{ key: 'rang', value: 'haut' }]);
  link(a, d, [{ key: 'rang', value: 'bas' }], 'Lien');
  run(s, defineTagKey(s, { ...NIVEAU, key: 'niveau', scope: 'node' }));
  expect(refusal(() => renameTagKey(s, 'rang', 'niveau'))).toBe('1 connexion porte une valeur que ce changement rendrait invalide : « Lien ».');
  mk('E', [{ key: 'lvl', value: 'bas' }, { key: 'lvl', value: 'haut' }]);
  expect(refusal(() => renameTagKey(s, 'lvl', 'niveau'))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « E ».');
});

test('renameTagKey : refusé vers le même nom, depuis une clé inconnue, vers une autre définition, vers un mauvais nom', () => {
  const { s, mk } = world([TEXT, NIVEAU]);
  mk('A', [{ key: 'statut', value: 'x' }]);
  expect(refusal(() => renameTagKey(s, 'statut', 'statut'))).toBe('Le tag s’appelle déjà « statut ».');
  expect(refusal(() => renameTagKey(s, 'inconnu', 'autre'))).toBe('Aucun tag ne s’appelle « inconnu ».');
  expect(refusal(() => renameTagKey(s, 'statut', 'niveau'))).toBe('Le tag « niveau » existe déjà dans le registre.');
  expect(refusal(() => renameTagKey(s, 'statut', ''))).toBe('Le nom du tag est vide.');
  expect(refusal(() => renameTagKey(s, 'statut', 'x'.repeat(MAX_ID_CHARS + 1)))).toBe(`Le nom d’un tag compte ${MAX_ID_CHARS} caractères au plus (ici ${MAX_ID_CHARS + 1}).`);
  expect(refusal(() => renameTagKey(s, 'statut', 'a:b'))).toBe('Un nom de tag ne contient pas « : », et ne commence ni ne finit par une espace.');
});

test('renameTagKey : les valeurs déjà portées sous le nouveau nom passent sous la définition, qui les juge', () => {
  const { s, mk, link } = world([NIVEAU]);
  const a = mk('A', [{ key: 'niveau', value: 'bas' }]);
  mk('Seul', [{ key: 'grade', value: 'extrême' }]);
  expect(refusal(() => renameTagKey(s, 'niveau', 'grade'))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « Seul ».');
  // A key of one value: the old key's value is kept, the other one dropped, so nothing new to judge.
  const { s: t, mk: mk2 } = world([NIVEAU]);
  const b = mk2('B', [{ key: 'grade', value: 'extrême' }, { key: 'niveau', value: 'haut' }]);
  expect(() => run(t, renameTagKey(t, 'niveau', 'grade'))).not.toThrow();
  expect(tagsOf(t, b)).toEqual([{ key: 'grade', value: 'haut' }]);
  // Multiple: the values brought together are judged.
  const { s: u, mk: mk3 } = world([{ ...NIVEAU, key: 'niveaux', multi: true, defaultValue: undefined, required: false }]);
  mk3('C', [{ key: 'grades', value: 'extrême' }, { key: 'niveaux', value: 'haut' }]);
  expect(refusal(() => renameTagKey(u, 'niveaux', 'grades'))).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « C ».');
  // Scope, too: a connection now under a definition of nodes.
  link(a, mk('D'), [{ key: 'genre', value: 'x' }], 'Lien');
  run(s, defineTagKey(s, { ...TEXT, key: 'type', scope: 'node' }));
  expect(refusal(() => renameTagKey(s, 'type', 'genre'))).toBe('1 connexion porte une valeur que ce changement rendrait invalide : « Lien ».');
});

test('renameTagKey : une clé dont Cirrus se sert ne se renomme pas ; un tag n’y prend son nom qu’avec sa forme', () => {
  const { s, mk } = world([{ key: 'auteur', type: 'text', scope: 'node', multi: true, required: false }, { ...TEXT, key: 'author' }]);
  mk('A', [{ key: 'label', value: 'thm:mdl' }, { key: 'author', value: 'Li' }, { key: 'writer', value: 'Vitányi' }]);
  expect(refusal(() => renameTagKey(s, 'auteur', 'autrice'))).toBe('Cirrus se sert du tag « auteur » : il ne se renomme pas.');
  // Carried, not declared: protected all the same.
  expect(refusal(() => renameTagKey(s, 'label', 'étiquette'))).toBe('Cirrus se sert du tag « label » : il ne se renomme pas.');
  expect(refusal(() => renameTagKey(s, 'author', 'doi'))).toBe('Cirrus se sert du tag « doi » : « author » n’a pas le type, la portée ou la multiplicité qu’il lui donne.');
  // Not declared: no definition comes with it.
  expect(() => run(s, renameTagKey(s, 'writer', 'arxiv'))).not.toThrow();
});

test('renameTagKey : un Ctrl+Z rend tout, définition, porteurs, corbeille et index ; un Ctrl+Y refait tout', () => {
  const { s, mk, link } = world([{ ...TEXT, key: 'sujet', multi: true }]);
  const a = mk('A', [{ key: 'sujet', value: 'x' }, { key: 'thème', value: 'x' }, { key: 'thème', value: 'w' }]);
  const b = mk('B', [{ key: 'sujet', value: 'y' }]);
  const ab = link(a, b, [{ key: 'sujet', value: 'z' }]);
  run(s, deleteEverywhere(s, b));
  const before = view(s), index = [sortedIds(taggedWith(s, 'sujet')), sortedIds(taggedWith(s, 'thème'))];
  const stack = new UndoStack();
  const r = run(s, renameTagKey(s, 'sujet', 'thème'));
  stack.record(r);
  const after = view(s);
  expect(after).not.toEqual(before);
  run(s, stack.undo(s)!);
  expect(view(s)).toEqual(before);
  expect([sortedIds(taggedWith(s, 'sujet')), sortedIds(taggedWith(s, 'thème'))]).toEqual(index);
  run(s, stack.redo(s)!);
  expect(view(s)).toEqual(after);
  expect(() => accepted(invertAction(r))).not.toThrow();
  expect(checkState(s)).toEqual([]);
  expect(ab).toBeDefined();
});

// ---------------------------------------------------------------------------------------------------------------------
// deleteTagKey

test('deleteTagKey : retire la définition seule ; les tags restent sur les objets, comme une clé non déclarée ; annulable', () => {
  const { s, mk } = world([NIVEAU]);
  const a = mk('A', [{ key: 'niveau', value: 'haut' }]);
  const before = view(s);
  const r = run(s, deleteTagKey(s, 'niveau'));
  expect(r.label).toBe('Retirer le tag « niveau » du registre');
  expect(r.ops).toEqual([{ t: 'tagKey', before: NIVEAU, after: null }]);
  expect(s.tagKeys.has('niveau')).toBe(false);
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'haut' }]);
  expect(sortedIds(taggedWith(s, 'niveau'))).toEqual([a]);
  expect(() => accepted(r)).not.toThrow();
  run(s, invertAction(r));
  expect(view(s)).toEqual(before);
});

test('deleteTagKey : refusé pour une clé hors du registre, et pour une clé dont Cirrus se sert', () => {
  const { s, mk } = world([{ key: 'suivant', type: 'word', scope: 'connection', multi: false, required: false }]);
  mk('A', [{ key: 'lu' }]);
  expect(refusal(() => deleteTagKey(s, 'lu'))).toBe('Le tag « lu » n’est pas dans le registre.');
  expect(refusal(() => deleteTagKey(s, 'suivant'))).toBe('Cirrus se sert du tag « suivant » : il ne se supprime pas.');
});

// ---------------------------------------------------------------------------------------------------------------------
// renameEnumValue

test('renameEnumValue : la valeur de la définition (son rang gardé, la valeur par défaut suivie) et chaque porteur, corbeille comprise ; un Ctrl+Z rend tout', () => {
  const { s, mk, link } = world([{ ...NIVEAU, defaultValue: 'bas' }]);
  const a = mk('A', [{ key: 'niveau', value: 'bas' }, { key: 'lu' }]);
  const b = mk('B', [{ key: 'niveau', value: 'haut' }]);
  const c = mk('C', [{ key: 'niveau', value: 'bas' }]);
  const ab = link(a, b, [{ key: 'niveau', value: 'bas' }]);
  run(s, deleteEverywhere(s, c));
  // A rank stored by hand designates the value whatever its name: untouched.
  applyOp(s, { t: 'node', before: s.nodes.get(b)!, after: { ...s.nodes.get(b)!, tags: [{ key: 'niveau', value: 1 }] } });
  const before = view(s);
  const stack = new UndoStack();
  const r = run(s, renameEnumValue(s, 'niveau', 'bas', 'faible'));
  stack.record(r);
  expect(r.label).toBe('Renommer la valeur « bas » du tag « niveau » en « faible »');
  expect(s.tagKeys.get('niveau')).toEqual({ ...NIVEAU, defaultValue: 'faible', enumValues: [{ name: 'faible', rank: 1 }, { name: 'moyen', rank: 2 }, { name: 'haut', rank: 3 }] });
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'faible' }, { key: 'lu' }]);
  expect(tagsOf(s, b)).toEqual([{ key: 'niveau', value: 1 }]);
  expect(tagsOf(s, c)).toEqual([{ key: 'niveau', value: 'faible' }]);
  expect(tagsOf(s, ab)).toEqual([{ key: 'niveau', value: 'faible' }]);
  expect(r.ops.some((o) => o.t === 'node' && o.after?.id === b)).toBe(false);
  expect(() => accepted(r)).not.toThrow();
  expect(checkState(s)).toEqual([]);
  run(s, stack.undo(s)!);
  expect(view(s)).toEqual(before);
});

test('renameEnumValue : refusé hors d’une énumération du registre, pour une valeur inconnue, déjà prise, vide ou la même', () => {
  const { s } = world([TEXT, NIVEAU]);
  expect(refusal(() => renameEnumValue(s, 'statut', 'a', 'b'))).toBe('Le tag « statut » n’est pas une énumération du registre.');
  expect(refusal(() => renameEnumValue(s, 'absent', 'a', 'b'))).toBe('Le tag « absent » n’est pas une énumération du registre.');
  expect(refusal(() => renameEnumValue(s, 'niveau', 'extrême', 'b'))).toBe('Le tag « niveau » n’a pas de valeur « extrême ».');
  expect(refusal(() => renameEnumValue(s, 'niveau', 'bas', 'haut'))).toBe('Le tag « niveau » a déjà une valeur « haut ».');
  expect(refusal(() => renameEnumValue(s, 'niveau', 'bas', ' '))).toBe('Le nom de la valeur est vide.');
  expect(refusal(() => renameEnumValue(s, 'niveau', 'bas', 'bas'))).toBe('La valeur s’appelle déjà « bas ».');
  for (const to of [' faible', 'faible ']) expect(refusal(() => renameEnumValue(s, 'niveau', 'bas', to)), to).toBe(`Le nom de valeur « ${to} » commence ou finit par une espace.`);
});

// ---------------------------------------------------------------------------------------------------------------------
// How a refusal names a connection (review of task 3a, Minor 5)

test('connectionName : une connexion se nomme par son titre, sinon la première ligne de sa relation, raccourcie, sinon par ses membres', () => {
  const { s, mk, link, P } = world([TEXT]);
  const a = mk('A'), b = mk('B'), c = mk('C'), u = mk('');
  const name = (id: Id) => connectionName(s, s.connections.get(id)!);
  expect(name(link(a, b, [], 'Relie', 'est un cas de'))).toBe('« Relie »');
  expect(name(link(a, b, [], '', '\n  est un cas\tparticulier de \\(x\\)\nsuite'))).toBe('« est un cas particulier de \\(x\\) »');
  expect(name(link(a, b, [], '', 'x'.repeat(100)))).toBe(`« ${'x'.repeat(80)}… »`);
  expect(name(link(a, b, [], '', ' \n\t'))).toBe('la connexion entre « A » et « B »');
  expect(name(link(b, u))).toBe('la connexion entre « B » et « Sans titre »');
  const three = created(run(s, connect(s, { plan: P, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }, { node: c, role: 'associate' }] })), 'connection');
  expect(name(three)).toBe('la connexion entre « A », « B » et « C »');
  // A connection to the trash with its node keeps the members it had left: one.
  const ac = link(a, c);
  run(s, deleteEverywhere(s, c));
  expect(s.connections.get(ac)!.members).toHaveLength(1);
  expect(name(ac)).toBe('la connexion de « A »');
  expect(core.connectionName).toBe(connectionName);
});

test('les refus nomment une connexion comme connectionName ; une connexion nommée par sa relation passe avant une nommée par ses membres', () => {
  const { s, mk, link } = world([TEXT]);
  const a = mk('A'), b = mk('B');
  link(a, b, [{ key: 'statut', value: 'x' }]);
  expect(refusal(() => defineTagKey(s, { ...TEXT, scope: 'node' }))).toBe('1 connexion porte une valeur que ce changement rendrait invalide : la connexion entre « A » et « B ».');
  link(b, a, [{ key: 'statut', value: 'y' }], '', 'précède');
  expect(refusal(() => defineTagKey(s, { ...TEXT, scope: 'node' }))).toBe('2 connexions portent une valeur que ce changement rendrait invalide, dont « précède ».');
});

// ---------------------------------------------------------------------------------------------------------------------
// The sync (Review Focus 2): a rename crossed with an edit made elsewhere of an object that carried the key. A server
// as reconcile.test.ts's sequencer (shape, "befores", rules), two PCs (twoPcs.ts).

/** Node N carries statut:a (a key of one value); M carries nothing. */
function base() {
  const { s, mk } = world([TEXT]);
  return { s, N: mk('N', [{ key: 'statut', value: 'a' }]), M: mk('M') };
}

test.each([
  { order: 'mine first', at: { mine: 1, theirs: 2 } },
  { order: 'theirs first', at: { mine: 1, theirs: 2 } },
  { order: 'theirs first', at: { mine: 2, theirs: 1 } },
] as const)('synchro : un renommage croisé avec un titre changé ailleurs ($order) converge, sans violation, et l’ancienne clé ne revient pas', ({ order, at }) => {
  const { s, N } = base();
  const { server, dropped } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => editNode(x, N, { title: 'N2' }), order, at);
  expect(dropped).toEqual([]);
  expect(server.nodes.get(N)).toMatchObject({ title: 'N2', tags: [{ key: 'état', value: 'a' }] });
  expect([server.tagKeys.has('statut'), server.tagKeys.has('état')]).toEqual([false, true]);
});

test.each([
  { order: 'mine first', at: { mine: 1, theirs: 2 }, tags: [{ key: 'état', value: 'a' }, { key: 'statut', value: 'b' }] },
  { order: 'theirs first', at: { mine: 1, theirs: 2 }, tags: [{ key: 'statut', value: 'b' }, { key: 'état', value: 'a' }] },
  // The rename is the more recent change of statut: the value changed elsewhere goes with it.
  { order: 'theirs first', at: { mine: 2, theirs: 1 }, tags: [{ key: 'état', value: 'a' }] },
] as const)('synchro : un renommage croisé avec la valeur changée ailleurs ($order, le mien à $at.mine) converge ; l’ancienne clé, si elle revient, se voit non déclarée', ({ order, at, tags }) => {
  const { s, N } = base();
  const { server, dropped } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => editNode(x, N, { tags: [{ key: 'statut', value: 'b' }] }), order, at);
  expect(dropped).toEqual([]);
  expect(server.nodes.get(N)!.tags).toEqual(tags);
  expect(server.tagKeys.get('état')).toEqual({ ...TEXT, key: 'état' });
  if (tags.some((t) => t.key === 'statut')) {
    // Back on N, the old key has no definition: the panel lists it as « non déclarée », and a second rename puts it away.
    expect(server.tagKeys.has('statut')).toBe(false);
    expect(sortedIds(taggedWith(server, 'statut'))).toEqual([N]);
    // A key of one value: the old key's value is kept (it is the one renamed into place), here the more recent one.
    const again = run(server, renameTagKey(server, 'statut', 'état'));
    expect(server.nodes.get(N)!.tags).toEqual([{ key: 'état', value: 'b' }]);
    expect(again.ops.every((o) => o.t === 'node')).toBe(true);
  }
});

test.each(['mine first', 'theirs first'] as const)('synchro : un renommage croisé avec la clé ajoutée ailleurs à un autre objet ($order) converge ; l’objet garde l’ancienne clé, non déclarée', (order) => {
  const { s, N, M } = base();
  const { server } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => editNode(x, M, { tags: [{ key: 'statut', value: 'c' }] }), order, { mine: 1, theirs: 2 });
  expect(server.nodes.get(N)!.tags).toEqual([{ key: 'état', value: 'a' }]);
  expect(server.nodes.get(M)!.tags).toEqual([{ key: 'statut', value: 'c' }]);
  expect(server.tagKeys.has('statut')).toBe(false);
});

test.each(['mine first', 'theirs first'] as const)('synchro : deux renommages de la même clé sur deux PC ($order) convergent, sans violation', (order) => {
  const { s, N } = base();
  const { server } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => renameTagKey(x, 'statut', 'stade'), order, { mine: 1, theirs: 2 });
  expect(server.tagKeys.has('statut')).toBe(false);
  expect(server.nodes.get(N)!.tags.every((t) => t.key !== 'statut')).toBe(true);
});

test.each(['mine first', 'theirs first'] as const)('synchro : une valeur d’énumération renommée pendant qu’ailleurs on la donne à un objet ($order) : l’une des deux écritures est écartée, tout converge sans violation', (order) => {
  const { s, mk } = world([NIVEAU]);
  const N = mk('N', [{ key: 'niveau', value: 'bas' }]), M = mk('M', [{ key: 'niveau', value: 'haut' }]);
  const { server, dropped } = crossed(s, (x) => renameEnumValue(x, 'niveau', 'bas', 'faible'), (x) => editNode(x, M, { tags: [{ key: 'niveau', value: 'bas' }] }), order, { mine: 1, theirs: 2 });
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toContain('Valeur « bas » inconnue pour le tag « niveau »');
  expect(server.nodes.get(N)!.tags).toEqual([{ key: 'niveau', value: order === 'mine first' ? 'faible' : 'bas' }]);
});

test.each([
  { change: 'de type', def: { ...TEXT, type: 'date' } },
  { change: 'de multiplicité', def: { ...TEXT, multi: true } },
] as const)('synchro : un renommage croisé avec un changement $change ailleurs converge, sans violation ; la définition changée revient sous l’ancien nom, sans porteur', ({ def }) => {
  for (const order of ['mine first', 'theirs first'] as const) {
    for (const at of [{ mine: 1, theirs: 2 }, { mine: 2, theirs: 1 }]) {
      const { s, N } = base();
      const { server } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => defineTagKey(x, def), order, at);
      expect(server.nodes.get(N)!.tags, `${order} ${at.mine}`).toEqual([{ key: 'état', value: 'a' }]);
      expect(server.tagKeys.get('statut'), `${order} ${at.mine}`).toEqual(def);
      expect(taggedWith(server, 'statut').size).toBe(0);
    }
  }
});

test.each([
  { order: 'mine first', at: { mine: 1, theirs: 2 } },
  { order: 'mine first', at: { mine: 2, theirs: 1 } },
  { order: 'theirs first', at: { mine: 1, theirs: 2 } },
  { order: 'theirs first', at: { mine: 2, theirs: 1 } },
] as const)('synchro : un renommage croisé avec le retrait de la clé du registre ailleurs ($order, le mien à $at.mine) : le retrait se perd, la définition reste sous le nouveau nom', ({ order, at }) => {
  const { s, N } = base();
  const { server, dropped } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => deleteTagKey(x, 'statut'), order, at);
  expect(dropped).toEqual([]);
  expect([...server.tagKeys.keys()]).toEqual(['état']);
  expect(server.tagKeys.get('état')).toEqual({ ...TEXT, key: 'état' });
  expect(server.nodes.get(N)!.tags).toEqual([{ key: 'état', value: 'a' }]);
});

test.each([
  { order: 'mine first', at: { mine: 1, theirs: 2 } },
  { order: 'mine first', at: { mine: 2, theirs: 1 } },
  { order: 'theirs first', at: { mine: 1, theirs: 2 } },
  { order: 'theirs first', at: { mine: 2, theirs: 1 } },
] as const)('synchro : un renommage croisé avec la mise à la corbeille ailleurs d’un nœud qui portait la clé ($order, le mien à $at.mine) : la modification gagne (spec 6.2), le nœud revient, avec la nouvelle clé, partout pareil', ({ order, at }) => {
  const { s, N } = base();
  const P = [...s.plans.keys()][0];
  const { server, dropped } = crossed(s, (x) => renameTagKey(x, 'statut', 'état'), (x) => deleteEverywhere(x, N), order, at);
  expect(dropped).toEqual([]);
  const n = server.nodes.get(N)!;
  expect(n.trashedAt).toBeUndefined();
  expect(n.tags).toEqual([{ key: 'état', value: 'a' }]);
  // Back where its deletion took it from.
  expect(server.placements.has(`${P}|${N}`)).toBe(true);
});

// An undo checked as a command (review of task 3a, Important 1): a write received from another PC since may make it
// add a violation — it is then refused, like an undo whose objects changed since, before anything is written.

test('Ctrl+Z d’un renommage de valeur, après qu’un autre PC a donné le nouveau nom à un objet : refusé, « a été modifié depuis », l’état et la pile intacts', () => {
  const { s, mk } = world([NIVEAU]);
  mk('N', [{ key: 'niveau', value: 'bas' }]);
  const M = mk('M');
  const server = copy(s), journal: RemoteUnit[] = [];
  // PC A renames the value and sends it; PC B, up to date, gives the new name to M; A receives B's write.
  const stack = new UndoStack();
  const mine = run(s, renameEnumValue(s, 'niveau', 'bas', 'faible'));
  stack.record(mine);
  const u = unitOf(mine, 'pc-a', T0 + 1);
  expect(accept(server, journal, u)).toBe('accepted');
  const b = copy(server);
  expect(accept(server, journal, unitOf(run(b, editNode(b, M, { tags: [{ key: 'niveau', value: 'faible' }] })), 'pc-b', T0 + 2))).toBe('accepted');
  const r = reconcile(s, [u], journal.map(wire), []);
  expect([r.acked, r.dropped]).toEqual([[u.unit], []]);
  expect(image(s)).toBe(image(server));
  const before = image(s);
  expect(() => stack.prepareUndo(s)).toThrow(new UndoConflictError('Impossible d’annuler : « Renommer la valeur « bas » du tag « niveau » en « faible » » a été modifié depuis.'));
  expect(image(s)).toBe(before);
  expect(stack.canUndo).toBe(true);
  expect(checkState(s)).toEqual([]);
});

test.each([
  { name: 'un renommage de clé, l’ancienne clé reçue avec une valeur hors de l’énumération', command: (s: State) => renameTagKey(s, 'niveau', 'grade'), value: 'zzz' },
  { name: 'un retrait du registre, la clé reçue avec une valeur hors de l’énumération', command: (s: State) => deleteTagKey(s, 'niveau'), value: 'zzz' },
  {
    name: 'une valeur ajoutée à l’énumération, reçue sur un objet', value: 'extrême',
    command: (s: State) => defineTagKey(s, { ...NIVEAU, enumValues: [...NIVEAU.enumValues!, { name: 'extrême', rank: 4 }] }),
  },
])('Ctrl+Z refusé quand il ajouterait une violation : $name', ({ command, value }) => {
  const { s, mk } = world([NIVEAU]);
  mk('N', [{ key: 'niveau', value: 'bas' }]);
  const M = mk('M');
  const stack = new UndoStack();
  const a = run(s, command(s));
  stack.record(a);
  // Received from another PC (not on this PC's stack).
  run(s, editNode(s, M, { tags: [{ key: 'niveau', value } as TagValue] }));
  expect(() => stack.undo(s)).toThrow(new UndoConflictError(`Impossible d’annuler : « ${a.label} » a été modifié depuis.`));
  expect(checkState(s)).toEqual([]);
});

test('Ctrl+Y refusé quand il ajouterait une violation : une valeur renommée, annulée, puis donnée ailleurs sous son ancien nom', () => {
  const { s, mk } = world([NIVEAU]);
  const M = mk('M');
  const stack = new UndoStack();
  stack.record(run(s, renameEnumValue(s, 'niveau', 'bas', 'faible')));
  run(s, stack.undo(s)!);
  run(s, editNode(s, M, { tags: [{ key: 'niveau', value: 'bas' }] }));
  expect(() => stack.redo(s)).toThrow(new UndoConflictError('Impossible de rétablir : « Renommer la valeur « bas » du tag « niveau » en « faible » » a été modifié depuis.'));
  expect(stack.canRedo).toBe(true);
});

test('synchro : les actions du registre et leurs annulations passent les contrôles du serveur (parseUnit), une connexion taguée comprise', () => {
  const { s, mk, link } = world();
  const a = mk('A'), b = mk('B');
  const ab = link(a, b);
  const actions: Action[] = [];
  const go = (a: Action) => actions.push(run(s, a));
  go(defineTagKey(s, NIVEAU));
  go(editNode(s, a, { tags: [{ key: 'niveau', value: 'bas' }] }));
  go(editConnection(s, ab, { tags: [{ key: 'niveau', value: 3 }] }));
  go(renameEnumValue(s, 'niveau', 'bas', 'faible'));
  go(renameTagKey(s, 'niveau', 'grade'));
  go(defineTagKey(s, { ...s.tagKeys.get('grade')!, required: false, defaultValue: undefined }));
  go(deleteTagKey(s, 'grade'));
  go(renameTagKey(s, 'grade', 'note'));
  for (const x of [...actions]) expect(() => accepted(x), x.label).not.toThrow();
  for (const x of [...actions].reverse()) { const u = invertAction(x); expect(() => accepted(u), u.label).not.toThrow(); run(s, u); }
  expect(s.tagKeys.size).toBe(0);
  expect(tagsOf(s, ab)).toEqual([]);
  expect(checkState(s)).toEqual([]);
});
