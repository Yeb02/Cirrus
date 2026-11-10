import {
  type Action, applyOps, CommandError, connect, createNode, createPlan, defineTagKey, deleteEverywhere, editConnection, editNode, emptyState, type Id, type State,
  TagError, type TagKeyDef, type TagValue, taggedWith,
} from '@cirrus/core';
import { expect, test } from 'vitest';
import {
  connectionTagsBuild, defineTagKeyBuild, deleteTagKeyBuild, renameEnumValueBuild, renameTagKeyBuild, saveTagKeyBuild, tagsBuild,
} from '../src/renderer/actions.ts';
import { parseTag, tagSuggestions, withoutTag, withTag } from '../src/renderer/files/tags.ts';
import { EditSession } from '../src/renderer/session.ts';
import {
  addValue, draftOf, type Draft, definitionOf, filterRows, inferDefinition, moveValue, newDraft, planRenames, registryRows, removeValue, renameValue, rowCount,
  setRank, sortValues, TYPE_LABELS,
} from '../src/renderer/tagRegistry.ts';

// The tag registry's panel (plan 6a, task 3b, D4): the builds that call the core's commands, the list the panel shows,
// the form's draft, and the tags of a connection. The panel itself is driven by the interface scenarios.

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const idOf = (a: Action, t: 'plan' | 'node' | 'connection'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
const tagsOf = (s: State, id: Id): TagValue[] => (s.nodes.get(id) ?? s.connections.get(id))!.tags;
/** A commit as the main process answers it: the journal number of the action's last line. */
const numbered = () => { let seq = 0; return async (a: Action) => ({ seq: (seq += a.ops.length), at: 0 }); };

const NIVEAU: TagKeyDef = {
  key: 'niveau', type: 'enum', scope: 'both', multi: false, required: true, defaultValue: 'moyen',
  enumValues: [{ name: 'bas', rank: 1 }, { name: 'moyen', rank: 2 }, { name: 'haut', rank: 3 }],
};
const TEXTE: TagKeyDef = { key: 'statut', type: 'text', scope: 'both', multi: false, required: false };

/** Plan P, the keys written as raw operations (not the commands under test); `mk` makes a node, `link` a connection. */
function world(defs: TagKeyDef[] = []) {
  const s = emptyState();
  const P = idOf(run(s, createPlan(s, 'P', 'plan')), 'plan');
  for (const after of defs) applyOps(s, [{ t: 'tagKey', before: null, after }]);
  let x = 0;
  const mk = (title: string, tags: TagValue[] = []) => idOf(run(s, createNode(s, { plan: P, title, x: (x += 100), y: 0, k: 0, tags })), 'node');
  const link = (a: Id, b: Id, tags: TagValue[] = [], title = '') =>
    idOf(run(s, connect(s, { plan: P, title, relation: '', members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], tags })), 'connection');
  const session = new EditSession(s, numbered(), () => {});
  return { s, P, mk, link, session };
}

async function refused(session: EditSession, build: Parameters<EditSession['run']>[0]): Promise<string> {
  const r = await session.run(build);
  if (r.ok) throw new Error('l’action n’a pas été refusée');
  return r.message;
}

// ---------------------------------------------------------------------------------------------------------------------
// The builds

test('defineTagKeyBuild : une clé créée puis modifiée, chaque fois une action qu’un Ctrl+Z défait', async () => {
  const { s, session } = world();
  expect((await session.run(defineTagKeyBuild(NIVEAU)!)).ok).toBe(true);
  expect(s.tagKeys.get('niveau')).toEqual(NIVEAU);
  const more = { ...NIVEAU, enumValues: [...NIVEAU.enumValues!, { name: 'très haut', rank: 4 }] };
  const r = await session.run(defineTagKeyBuild(more)!);
  expect(r.ok && r.action.label).toBe('Modifier le tag « niveau »');
  expect(s.tagKeys.get('niveau')?.enumValues).toHaveLength(4);
  expect((await session.undo()).ok).toBe(true);
  expect(s.tagKeys.get('niveau')).toEqual(NIVEAU);
  expect((await session.undo()).ok).toBe(true);
  expect(s.tagKeys.has('niveau')).toBe(false);
});

test('les refus du cœur arrivent en message français, sans écriture : un nom vide, une clé protégée, une valeur que le changement invaliderait', async () => {
  const { s, mk, session } = world([NIVEAU]);
  mk('A', [{ key: 'niveau', value: 'bas' }]);
  const before = session.rev;
  expect(await refused(session, defineTagKeyBuild({ ...TEXTE, key: '  ' })!)).toBe('Le nom du tag est vide.');
  expect(await refused(session, renameTagKeyBuild('label', 'étiquette')!)).toBe('Cirrus se sert du tag « label » : il ne se renomme pas.');
  expect(await refused(session, deleteTagKeyBuild('label')!)).toBe('Le tag « label » n’est pas dans le registre.');
  expect(await refused(session, deleteTagKeyBuild('inconnu')!)).toBe('Le tag « inconnu » n’est pas dans le registre.');
  expect(await refused(session, defineTagKeyBuild({ ...NIVEAU, enumValues: [{ name: 'moyen', rank: 2 }, { name: 'haut', rank: 3 }] })!))
    .toBe('1 nœud porte une valeur que ce changement rendrait invalide : « A ».');
  expect(await refused(session, renameEnumValueBuild('niveau', 'absent', 'x')!)).toBe('Le tag « niveau » n’a pas de valeur « absent ».');
  expect(session.rev).toBe(before);
  expect(s.tagKeys.get('niveau')).toEqual(NIVEAU);
});

test('renameTagKeyBuild : la définition, les nœuds et les connexions, la corbeille comprise, en une action qu’un Ctrl+Z rend entière', async () => {
  const { s, mk, link, session } = world([TEXTE]);
  const a = mk('A', [{ key: 'statut', value: 'lu' }]), b = mk('B', [{ key: 'statut', value: 'à lire' }, { key: 'x' }]);
  const c = mk('C', [{ key: 'statut', value: 'jeté' }]);
  const ab = link(a, b, [{ key: 'statut', value: 'relu' }]);
  run(s, deleteEverywhere(s, c));
  const r = await session.run(renameTagKeyBuild('statut', 'état')!);
  expect(r.ok && r.action.label).toBe('Renommer le tag « statut » en « état »');
  expect(s.tagKeys.has('statut')).toBe(false);
  expect(s.tagKeys.get('état')).toEqual({ ...TEXTE, key: 'état' });
  expect(tagsOf(s, a)).toEqual([{ key: 'état', value: 'lu' }]);
  expect(tagsOf(s, b)).toEqual([{ key: 'état', value: 'à lire' }, { key: 'x' }]);
  expect(tagsOf(s, ab)).toEqual([{ key: 'état', value: 'relu' }]);
  expect(tagsOf(s, c)).toEqual([{ key: 'état', value: 'jeté' }]);
  expect(taggedWith(s, 'statut').size).toBe(0);
  expect((await session.undo()).ok).toBe(true);
  expect(tagsOf(s, a)).toEqual([{ key: 'statut', value: 'lu' }]);
  expect(tagsOf(s, c)).toEqual([{ key: 'statut', value: 'jeté' }]);
  expect(s.tagKeys.get('statut')).toEqual(TEXTE);
  expect(s.tagKeys.has('état')).toBe(false);
  expect(taggedWith(s, 'état').size).toBe(0);
  expect(await refused(session, renameTagKeyBuild('statut', 'statut')!)).toBe('Le tag s’appelle déjà « statut ».');
});

test('deleteTagKeyBuild : la définition part, les tags restent ; renameEnumValueBuild : la valeur change partout, le rang reste', async () => {
  const { s, mk, session } = world([NIVEAU, TEXTE]);
  const a = mk('A', [{ key: 'niveau', value: 'haut' }, { key: 'statut', value: 'lu' }]);
  const renamed = await session.run(renameEnumValueBuild('niveau', 'haut', 'élevé')!);
  expect(renamed.ok && renamed.action.label).toBe('Renommer la valeur « haut » du tag « niveau » en « élevé »');
  expect(tagsOf(s, a)[0]).toEqual({ key: 'niveau', value: 'élevé' });
  expect(s.tagKeys.get('niveau')?.enumValues).toContainEqual({ name: 'élevé', rank: 3 });
  expect((await session.run(deleteTagKeyBuild('statut')!)).ok).toBe(true);
  expect(s.tagKeys.has('statut')).toBe(false);
  expect(tagsOf(s, a)[1]).toEqual({ key: 'statut', value: 'lu' });
  expect((await session.undo()).ok).toBe(true);
  expect(s.tagKeys.get('statut')).toEqual(TEXTE);
  expect((await session.undo()).ok).toBe(true);
  expect(tagsOf(s, a)[0]).toEqual({ key: 'niveau', value: 'haut' });
});

test('le scénario de la tâche : une énumération créée, deux nœuds tagués, une valeur renommée, la clé renommée, puis Ctrl+Z un à un', async () => {
  const { s, mk, session } = world();
  const a = mk('A'), b = mk('B');
  expect((await session.run(defineTagKeyBuild(NIVEAU)!)).ok).toBe(true);
  expect((await session.run(tagsBuild(a, (t, d) => withTag(t, parseTag('niveau:2', d), d))!)).ok).toBe(true);
  expect((await session.run(tagsBuild(b, (t, d) => withTag(t, parseTag('niveau:haut', d), d))!)).ok).toBe(true);
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'moyen' }]);
  expect((await session.run(renameEnumValueBuild('niveau', 'moyen', 'médian')!)).ok).toBe(true);
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'médian' }]);
  expect(s.tagKeys.get('niveau')?.defaultValue).toBe('médian');
  expect((await session.run(renameTagKeyBuild('niveau', 'importance')!)).ok).toBe(true);
  expect(tagsOf(s, a)).toEqual([{ key: 'importance', value: 'médian' }]);
  expect(tagsOf(s, b)).toEqual([{ key: 'importance', value: 'haut' }]);
  expect([...s.tagKeys.keys()]).toEqual(['importance']);
  expect((await session.undo()).ok).toBe(true);
  expect(tagsOf(s, b)).toEqual([{ key: 'niveau', value: 'haut' }]);
  expect([...s.tagKeys.keys()]).toEqual(['niveau']);
  expect((await session.undo()).ok).toBe(true);
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'moyen' }]);
  expect(s.tagKeys.get('niveau')).toEqual(NIVEAU);
  expect(taggedWith(s, 'importance').size).toBe(0);
});

test('saveTagKeyBuild : des valeurs renommées et la définition changée d’un bloc, une seule action ; sans renommage, defineTagKey seule', async () => {
  const { s, mk, session } = world([NIVEAU]);
  const a = mk('A', [{ key: 'niveau', value: 'bas' }]), b = mk('B', [{ key: 'niveau', value: 'haut' }]);
  const draft = (d: Draft) => d.values.map((v) => v.name);
  let d = draftOf(NIVEAU);
  d = renameValue(d, d.values[1].id, 'médian');
  d = renameValue(d, d.values[0].id, 'faible');
  d = setRank(d, d.values[2].id, '10');
  expect(draft(d)).toEqual(['faible', 'médian', 'haut']);
  expect(d.defaultValue).toBe('médian');
  const r = await session.run(saveTagKeyBuild(definitionOf(d), planRenames(NIVEAU, d))!);
  expect(r.ok && r.action.label).toBe('Modifier le tag « niveau »');
  expect(s.tagKeys.get('niveau')).toEqual({
    ...NIVEAU, defaultValue: 'médian', enumValues: [{ name: 'faible', rank: 1 }, { name: 'médian', rank: 2 }, { name: 'haut', rank: 10 }],
  });
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'faible' }]);
  expect(tagsOf(s, b)).toEqual([{ key: 'niveau', value: 'haut' }]);
  // One step back: the renames and the new rank together.
  expect((await session.undo()).ok).toBe(true);
  expect(s.tagKeys.get('niveau')).toEqual(NIVEAU);
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'bas' }]);
  // Only renames: the definition is not written again (it would be refused as « déjà celle-ci »).
  let e = draftOf(NIVEAU);
  e = renameValue(e, e.values[0].id, 'faible');
  const only = await session.run(saveTagKeyBuild(definitionOf(e), planRenames(NIVEAU, e))!);
  expect(only.ok && only.action.ops.filter((o) => o.t === 'tagKey')).toHaveLength(1);
  expect(tagsOf(s, a)).toEqual([{ key: 'niveau', value: 'faible' }]);
  // No renames and nothing changed: the core's refusal.
  expect(await refused(session, saveTagKeyBuild(definitionOf(draftOf(s.tagKeys.get('niveau')!)), [])!))
    .toBe('La définition du tag « niveau » est déjà celle-ci.');
  // A refusal inside the block writes nothing of the block.
  const rev = session.rev, f = draftOf(s.tagKeys.get('niveau')!);
  f.values.splice(0, 1);
  const message = await refused(session, saveTagKeyBuild(definitionOf(f), planRenames(s.tagKeys.get('niveau')!, f))!);
  expect(message).toBe('1 nœud porte une valeur que ce changement rendrait invalide : « A ».');
  expect(session.rev).toBe(rev);
});

test('une écriture que la porte refuse (un renommage trop gros pour une action) arrive en message, l’état et la pile intacts', async () => {
  const { s, mk } = world([TEXTE]);
  const a = mk('A', [{ key: 'statut', value: 'lu' }]);
  let tooBig = false;
  const gate = 'Action refusée : elle fait plus de 64 Mio, ce que le serveur ne prend pas.';
  const session = new EditSession(s, async (act) => {
    // The message as ipcRenderer.invoke gives it back.
    if (tooBig) throw new Error(`Error invoking remote method 'cirrus:commit': Error: ${gate}`);
    return { seq: act.ops.length, at: 0 };
  }, () => {});
  expect((await session.run(defineTagKeyBuild({ ...TEXTE, required: true })!)).ok).toBe(true);
  tooBig = true;
  expect(await refused(session, renameTagKeyBuild('statut', 'état')!)).toBe(gate);
  expect(s.tagKeys.has('statut')).toBe(true);
  expect(tagsOf(s, a)).toEqual([{ key: 'statut', value: 'lu' }]);
  tooBig = false;
  expect((await session.undo()).ok).toBe(true);
  expect(s.tagKeys.get('statut')).toEqual(TEXTE);
});

// ---------------------------------------------------------------------------------------------------------------------
// The list

test('registryRows : les clés déclarées d’abord, puis les clés portées sans déclaration, chaque groupe dans l’ordre français', () => {
  const { s, mk, link } = world([
    { ...TEXTE, key: 'zèbre' }, { ...TEXTE, key: 'étiquette' }, { ...TEXTE, key: 'Abc' }, NIVEAU,
  ]);
  const a = mk('A', [{ key: 'zèbre', value: '1' }, { key: 'thème', value: 'MDL' }, { key: 'Été' }]);
  const b = mk('B', [{ key: 'thème', value: 'info' }, { key: 'lu' }, { key: 'etoile' }]);
  link(a, b, [{ key: 'lu' }]);
  const rows = registryRows(s);
  expect(rows.map((r) => [r.key, r.def !== null])).toEqual([
    ['Abc', true], ['étiquette', true], ['niveau', true], ['zèbre', true],
    ['Été', false], ['etoile', false], ['lu', false], ['thème', false],
  ]);
  expect(rows.map((r) => r.count)).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
  expect(rows.find((r) => r.key === 'niveau')?.def).toEqual(NIVEAU);
  expect(rows.every((r) => r.trashed === 0)).toBe(true);
});

test('registryRows : les objets à la corbeille comptent, nœuds et connexions, et le disent', () => {
  const { s, mk, link } = world([TEXTE]);
  const a = mk('A', [{ key: 'statut', value: 'lu' }, { key: 'lu' }]), b = mk('B', [{ key: 'statut', value: 'lu' }]), c = mk('C', [{ key: 'lu' }]);
  link(a, b, [{ key: 'lu' }]);
  link(b, c, [{ key: 'statut', value: 'x' }]);
  run(s, deleteEverywhere(s, a));
  // A is in the trash, and with it the first connection (fewer than two members left); B and C are alive.
  const by = Object.fromEntries(registryRows(s).map((r) => [r.key, [r.count, r.trashed]]));
  expect(by).toEqual({ statut: [3, 1], lu: [3, 2] });
  expect(rowCount({ count: 0, trashed: 0 })).toBe('aucun objet');
  expect(rowCount({ count: 1, trashed: 0 })).toBe('1 objet');
  expect(rowCount({ count: 12, trashed: 0 })).toBe('12 objets');
  expect(rowCount({ count: 3, trashed: 1 })).toBe('3 objets, dont 1 à la corbeille');
  expect(rowCount({ count: 2, trashed: 2 })).toBe('2 objets, dont 2 à la corbeille');
  // Taking the tag away from the trashed ones empties the key of them.
  run(s, editNode(s, a, { tags: [] }));
  expect(registryRows(s).find((r) => r.key === 'lu')).toMatchObject({ count: 2, trashed: 1 });
});

test('registryRows suit l’état : une clé créée, renommée, retirée ou dont plus rien ne porte l’étiquette', () => {
  const { s, mk } = world();
  const a = mk('A', [{ key: 'lu' }]);
  expect(registryRows(s).map((r) => r.key)).toEqual(['lu']);
  run(s, defineTagKey(s, TEXTE));
  expect(registryRows(s).map((r) => [r.key, r.def !== null])).toEqual([['statut', true], ['lu', false]]);
  run(s, editNode(s, a, { tags: [] }));
  expect(registryRows(s).map((r) => r.key)).toEqual(['statut']);
});

test('filterRows : sans casse ni accents, les mots séparés par un blanc ou un souligné ; rien de tapé, tout', () => {
  const { s, mk } = world([{ ...TEXTE, key: 'statut_epistémique' }, { ...TEXTE, key: 'nature' }]);
  mk('A', [{ key: 'thème' }]);
  const rows = registryRows(s);
  expect(filterRows(rows, '')).toBe(rows);
  expect(filterRows(rows, '  ')).toBe(rows);
  expect(filterRows(rows, 'EPIST').map((r) => r.key)).toEqual(['statut_epistémique']);
  expect(filterRows(rows, 'statut epi').map((r) => r.key)).toEqual(['statut_epistémique']);
  expect(filterRows(rows, 'theme').map((r) => r.key)).toEqual(['thème']);
  expect(filterRows(rows, 'u').map((r) => r.key)).toEqual(['nature', 'statut_epistémique']);
  expect(filterRows(rows, 'zzz')).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The form's draft

test('draftOf et definitionOf : une définition revient telle quelle, une énumération avec son ordre et son défaut', () => {
  expect(definitionOf(draftOf(NIVEAU))).toEqual(NIVEAU);
  expect(definitionOf(draftOf(TEXTE))).toEqual(TEXTE);
  const num: TagKeyDef = { key: 'poids', type: 'number', scope: 'node', multi: true, required: true, defaultValue: 2.5 };
  expect(draftOf(num).defaultValue).toBe('2.5');
  expect(definitionOf(draftOf(num))).toEqual(num);
  // Stored in an order that is not the ranks': the draft keeps it, it is not a change.
  const odd: TagKeyDef = { ...NIVEAU, enumValues: [{ name: 'haut', rank: 3 }, { name: 'bas', rank: 1 }] };
  expect(definitionOf(draftOf(odd)).enumValues).toEqual(odd.enumValues);
  expect(TYPE_LABELS).toEqual({ word: 'mot simple', number: 'nombre', enum: 'énumération ordonnée', date: 'date', text: 'texte' });
});

test('definitionOf : un rang ou une valeur par défaut qui n’est pas un nombre est refusé en français ; un mot ne garde pas de défaut', () => {
  const refusal = (d: Draft): string => {
    try {
      definitionOf(d);
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      return (e as Error).message;
    }
    throw new Error('accepté');
  };
  let d = draftOf(NIVEAU);
  d = setRank(d, d.values[1].id, 'deux');
  expect(refusal(d)).toBe('Le rang de la valeur « moyen » n’est pas un nombre.');
  expect(definitionOf(setRank(d, d.values[1].id, '2,5')).enumValues?.[1]).toEqual({ name: 'moyen', rank: 2.5 });
  expect(refusal(setRank(d, d.values[1].id, ''))).toBe('Le rang de la valeur « moyen » n’est pas un nombre.');
  const num: Draft = { ...newDraft(), key: 'poids', type: 'number', defaultValue: 'beaucoup' };
  expect(refusal(num)).toBe('La valeur par défaut « beaucoup » n’est pas un nombre.');
  expect(definitionOf({ ...num, defaultValue: '1 000,5' }).defaultValue).toBe(1000.5);
  expect(definitionOf({ ...num, type: 'word', defaultValue: 'x' }).defaultValue).toBeUndefined();
  expect(definitionOf({ ...num, type: 'text', defaultValue: '  clair ' }).defaultValue).toBe('clair');
  expect(definitionOf({ ...num, type: 'text', defaultValue: '' })).not.toHaveProperty('defaultValue');
});

test('les valeurs d’une énumération : ajoutée, retirée, renommée (le défaut suit), déplacée (les rangs s’échangent), classée par rang', () => {
  let d = draftOf(NIVEAU);
  d = addValue(d);
  expect(d.values.at(-1)).toMatchObject({ was: null, name: '', rank: '4' });
  d = renameValue(d, d.values[3].id, 'critique');
  d = moveValue(d, d.values[3].id, -1);
  expect(d.values.map((v) => [v.name, v.rank])).toEqual([['bas', '1'], ['moyen', '2'], ['critique', '3'], ['haut', '4']]);
  d = moveValue(d, d.values[0].id, -1);
  expect(d.values.map((v) => v.name)).toEqual(['bas', 'moyen', 'critique', 'haut']);
  d = moveValue(d, d.values[3].id, 1);
  expect(d.values.map((v) => v.name)).toEqual(['bas', 'moyen', 'critique', 'haut']);
  // The default follows a renamed value, and is dropped with a removed one.
  d = renameValue(d, d.values[1].id, 'médian');
  expect(d.defaultValue).toBe('médian');
  d = removeValue(d, d.values[1].id);
  expect(d.defaultValue).toBe('');
  expect(d.values.map((v) => v.name)).toEqual(['bas', 'critique', 'haut']);
  // No default: a value added and named is not taken for it (its name was empty, as the default is).
  let fresh: Draft = { ...newDraft('niveau'), type: 'enum' };
  fresh = addValue(addValue(fresh));
  fresh = renameValue(fresh, fresh.values[0].id, 'basse');
  expect(fresh.defaultValue).toBe('');
  expect(definitionOf(fresh).defaultValue).toBeUndefined();
  expect(definitionOf(removeValue(fresh, fresh.values[1].id)).enumValues).toEqual([{ name: 'basse', rank: 1 }]);
  // Sorted by rank, a rank that is no number last.
  let e = draftOf(NIVEAU);
  e = setRank(e, e.values[0].id, '9');
  e = setRank(e, e.values[2].id, 'x');
  expect(sortValues(e).values.map((v) => v.name)).toEqual(['moyen', 'bas', 'haut']);
  // Ids stay distinct after a removal.
  const ids = new Set(addValue(addValue(removeValue(draftOf(NIVEAU), draftOf(NIVEAU).values[0].id))).values.map((v) => v.id));
  expect(ids.size).toBe(4);
});

test('planRenames : les valeurs dont le nom a changé, dans un ordre où aucune ne prend le nom d’une autre ; un échange est refusé', () => {
  expect(planRenames(NIVEAU, draftOf(NIVEAU))).toEqual([]);
  let d = draftOf(NIVEAU);
  d = renameValue(d, d.values[0].id, 'très bas');
  expect(planRenames(NIVEAU, d)).toEqual([{ from: 'bas', to: 'très bas' }]);
  // A chain: moyen becomes bas once bas has become très bas.
  d = renameValue(d, d.values[1].id, 'bas');
  expect(planRenames(NIVEAU, d)).toEqual([{ from: 'bas', to: 'très bas' }, { from: 'moyen', to: 'bas' }]);
  // Listed the other way round, the order is the same.
  const swapped = { ...d, values: [d.values[1], d.values[0], d.values[2]] };
  expect(planRenames(NIVEAU, swapped)).toEqual([{ from: 'bas', to: 'très bas' }, { from: 'moyen', to: 'bas' }]);
  // An exchange cannot be done one rename at a time.
  let c = draftOf(NIVEAU);
  c = renameValue(c, c.values[0].id, 'moyen');
  c = renameValue(c, c.values[1].id, 'bas');
  expect(() => planRenames(NIVEAU, c)).toThrow(new CommandError('Deux valeurs échangent leur nom : renomme-les une à une.'));
  // A new value is not a rename.
  expect(planRenames(NIVEAU, addValue(draftOf(NIVEAU)))).toEqual([]);
});

test('inferDefinition : ce que les objets portent dit le type, la portée et la multiplicité d’une clé à déclarer ; une clé de Cirrus, sa forme', () => {
  const { s, mk, link } = world();
  const a = mk('A', [{ key: 'lu' }, { key: 'poids', value: 3 }, { key: 'note', value: 'bien' }, { key: 'taille', value: '1,5' }]);
  const b = mk('B', [{ key: 'lu' }, { key: 'poids', value: 4 }, { key: 'poids', value: 5 }, { key: 'taille', value: 2 }, { key: 'label', value: 'lbl' }]);
  link(a, b, [{ key: 'poids', value: 1 }, { key: 'rôle' }]);
  expect(inferDefinition(s, 'lu')).toEqual({ key: 'lu', type: 'word', scope: 'node', multi: false, required: false });
  expect(inferDefinition(s, 'poids')).toEqual({ key: 'poids', type: 'number', scope: 'both', multi: true, required: false });
  expect(inferDefinition(s, 'note')).toEqual({ key: 'note', type: 'text', scope: 'node', multi: false, required: false });
  expect(inferDefinition(s, 'taille')).toEqual({ key: 'taille', type: 'number', scope: 'node', multi: false, required: false });
  expect(inferDefinition(s, 'rôle')).toEqual({ key: 'rôle', type: 'word', scope: 'connection', multi: false, required: false });
  expect(inferDefinition(s, 'label')).toEqual({ key: 'label', type: 'text', scope: 'node', multi: false, required: false });
  // Declared with that definition, nothing the objects carry is refused.
  for (const key of ['lu', 'poids', 'note', 'taille', 'rôle', 'label']) expect(() => defineTagKey(s, inferDefinition(s, key))).not.toThrow();
  // Cirrus's own shape, even for a key carried as a word.
  expect(inferDefinition(s, 'partie')).toEqual({ key: 'partie', type: 'number', scope: 'connection', multi: false, required: false });
});

// ---------------------------------------------------------------------------------------------------------------------
// The tags of a connection

test('connectionTagsBuild : un tag s’ajoute à une connexion et se retire, chaque fois une action qu’un Ctrl+Z défait', async () => {
  const { s, mk, link, session } = world([NIVEAU, { ...TEXTE, key: 'rôle', scope: 'connection' }, { ...TEXTE, key: 'seul', scope: 'node' }]);
  const a = mk('A'), b = mk('B');
  const ab = link(a, b);
  const add = (input: string) => session.run(connectionTagsBuild(ab, (t, d) => withTag(t, parseTag(input, d), d))!);
  expect((await add('lu')).ok).toBe(true);
  expect((await add('niveau:3')).ok).toBe(true);
  expect(tagsOf(s, ab)).toEqual([{ key: 'lu' }, { key: 'niveau', value: 'haut' }]);
  const done = await add('rôle : pont');
  expect(done.ok && done.action.label).toBe('Modifier une connexion');
  expect(tagsOf(s, ab)).toEqual([{ key: 'lu' }, { key: 'niveau', value: 'haut' }, { key: 'rôle', value: 'pont' }]);
  // A single key takes the new value in its place.
  await add('niveau:bas');
  expect(tagsOf(s, ab)).toEqual([{ key: 'lu' }, { key: 'niveau', value: 'bas' }, { key: 'rôle', value: 'pont' }]);
  expect((await session.run(connectionTagsBuild(ab, (t) => withoutTag(t, { key: 'lu' }))!)).ok).toBe(true);
  expect(tagsOf(s, ab)).toEqual([{ key: 'niveau', value: 'bas' }, { key: 'rôle', value: 'pont' }]);
  expect((await session.undo()).ok).toBe(true);
  expect(tagsOf(s, ab)).toEqual([{ key: 'lu' }, { key: 'niveau', value: 'bas' }, { key: 'rôle', value: 'pont' }]);
  // The nodes are not touched.
  expect(tagsOf(s, a)).toEqual([]);
  expect(taggedWith(s, 'lu').has(ab)).toBe(true);
});

test('connectionTagsBuild : ce qui n’y change rien, une valeur d’énumération inconnue et une connexion disparue sont refusés', async () => {
  const { s, mk, link, session } = world([NIVEAU]);
  const ab = link(mk('A'), mk('B'), [{ key: 'lu' }]);
  expect(await refused(session, connectionTagsBuild(ab, (t, d) => withTag(t, { key: 'lu' }, d))!)).toBe('Ces tags sont déjà à jour.');
  expect(await refused(session, connectionTagsBuild(ab, (t) => withoutTag(t, { key: 'autre' }))!)).toBe('Ces tags sont déjà à jour.');
  expect(await refused(session, connectionTagsBuild(ab, (t, d) => withTag(t, { key: 'niveau', value: 'capital' }, d))!))
    .toBe('Valeur « capital » inconnue pour le tag « niveau ».');
  expect(await refused(session, connectionTagsBuild('jamais-vue', (t) => t)!)).toBe('Connexion introuvable.');
  expect(tagsOf(s, ab)).toEqual([{ key: 'lu' }]);
  // Edited since the pop-up showed it: computed on the state at the time, so that two quick changes both count.
  run(s, editConnection(s, ab, { tags: [{ key: 'lu' }, { key: 'vu' }] }));
  expect((await session.run(connectionTagsBuild(ab, (t) => withoutTag(t, { key: 'lu' }))!)).ok).toBe(true);
  expect(tagsOf(s, ab)).toEqual([{ key: 'vu' }]);
});

test('les suggestions d’une connexion : les clés de portée connexion ou les deux, jamais celles des nœuds seuls', () => {
  const { s } = world([
    { ...TEXTE, key: 'rôle', scope: 'connection' }, { ...TEXTE, key: 'seul', scope: 'node' }, { ...TEXTE, key: 'mixte', scope: 'both' }, NIVEAU,
  ]);
  const keys = (text: string, scope: 'node' | 'connection') => tagSuggestions(text, s.tagKeys, scope, 10).map((t) => t.key);
  expect(keys('', 'connection')).toEqual(['rôle', 'mixte', 'niveau']);
  expect(keys('', 'node')).toEqual(['seul', 'mixte', 'niveau']);
  expect(keys('s', 'connection')).toEqual([]);
  expect(tagSuggestions('niveau:', s.tagKeys, 'connection', 2)).toEqual([{ key: 'niveau', value: 'bas', rank: 1 }, { key: 'niveau', value: 'moyen', rank: 2 }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// parseTag reads a number as the core does

test('parseTag lit un nombre comme le cœur (readTagNumber) : à la française, et un nombre qui ne tient pas dans un flottant est refusé', () => {
  const { s } = world([{ key: 'poids', type: 'number', scope: 'both', multi: false, required: false }, TEXTE, NIVEAU]);
  const defs = s.tagKeys;
  const refusal = (input: string): string => {
    try {
      parseTag(input, defs);
    } catch (e) {
      expect(e).toBeInstanceOf(TagError);
      return (e as Error).message;
    }
    throw new Error(`« ${input} » accepté`);
  };
  expect(parseTag('poids:1 000,5', defs)).toEqual({ key: 'poids', value: 1000.5 });
  expect(parseTag('poids : -2.25', defs)).toEqual({ key: 'poids', value: -2.25 });
  expect(parseTag('poids:+3', defs)).toEqual({ key: 'poids', value: 3 });
  expect(parseTag('poids: .5', defs)).toEqual({ key: 'poids', value: 0.5 });
  expect(refusal('poids:deux')).toBe('Le tag « poids » demande un nombre : « deux » n’en est pas un.');
  expect(refusal('poids:1,2,3')).toBe('Le tag « poids » demande un nombre : « 1,2,3 » n’en est pas un.');
  const huge = '9'.repeat(400);
  expect(Number(huge)).toBe(Infinity);
  expect(refusal(`poids:${huge}`)).toBe(`Le tag « poids » demande un nombre : « ${huge} » n’en est pas un.`);
  // A value typed under a text key, or an undeclared one, stays the text typed — a « 3 » is text, not a number nor a rank.
  expect(parseTag('statut:3', defs)).toEqual({ key: 'statut', value: '3' });
  expect(parseTag('inconnu:3', defs)).toEqual({ key: 'inconnu', value: '3' });
  // An enumeration reads a name or a rank in digits, as before; a value named in digits is a name.
  expect(parseTag('niveau:3', defs)).toEqual({ key: 'niveau', value: 'haut' });
  const digits: TagKeyDef = { ...NIVEAU, key: 'rang', enumValues: [{ name: '3', rank: 1 }, { name: 'trois', rank: 3 }] };
  expect(parseTag('rang:3', new Map([['rang', digits]]))).toEqual({ key: 'rang', value: '3' });
});
