import {
  canonical, CommandError, connRow, connTags, connTrashed, type Id, PROTECTED_TAG_KEYS, readTagNumber, type State, type TagKeyDef, taggedKeys, taggedWith,
} from '@cirrus/core';
import { foldedWords } from './search/index.ts';

// The tag registry's panel, without its screen (plan 6a, D4, task 3b): the list of keys it shows, and the draft its form
// edits. Pure, so that the rules are tested apart; the panel (ui/TagRegistryPanel.tsx) only draws them.

type TagType = TagKeyDef['type'];
type TagScope = TagKeyDef['scope'];

/** The types, in the order the form offers them, with their French names. */
export const TYPE_LABELS: Record<TagType, string> = { word: 'mot simple', number: 'nombre', enum: 'énumération ordonnée', date: 'date', text: 'texte' };
/** The scopes, in the order the form offers them. */
export const SCOPE_LABELS: Record<TagScope, string> = { node: 'nœud', connection: 'connexion', both: 'les deux' };

// ---------------------------------------------------------------------------------------------------------------------
// The list

/**
 * A key of the list: declared (`def`) or only carried (null: « non déclarée »). `count`: the nodes and connections that
 * carry it, those in the trash included, `trashed` of them; `folded`: its name as the filter and the order read it.
 */
export interface RegistryRow { key: string; def: TagKeyDef | null; count: number; trashed: number; folded: string }

const COLLATOR = new Intl.Collator('fr');
/** The French order of the names: folded first (as the search orders titles), then as written, then by code. */
const byName = (a: RegistryRow, b: RegistryRow): number =>
  COLLATOR.compare(a.folded, b.folded) || COLLATOR.compare(a.key, b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** How many of `ids` are in the trash (a node's record, or a connection's row). */
function trashedAmong(s: State, ids: ReadonlySet<Id>): number {
  let n = 0;
  for (const id of ids) {
    const node = s.nodes.get(id);
    if (node) {
      if (node.trashedAt !== undefined) n++;
    } else {
      const row = connRow(s, id);
      if (row >= 0 && connTrashed(s, row)) n++;
    }
  }
  return n;
}

/**
 * The keys of the registry, then the keys objects carry with no definition, each group in the French order, each with
 * its counts. One pass over the objects that carry a key — the index lists them (taggedWith, taggedKeys) — never the base.
 */
export function registryRows(s: State): RegistryRow[] {
  const row = (key: string, def: TagKeyDef | null): RegistryRow => {
    const ids = taggedWith(s, key);
    return { key, def, count: ids.size, trashed: trashedAmong(s, ids), folded: foldedWords(key) };
  };
  const declared = Array.from(s.tagKeys, ([key, def]) => row(key, def)).sort(byName);
  const undeclared = Array.from(taggedKeys(s)).filter((key) => !s.tagKeys.has(key)).map((key) => row(key, null)).sort(byName);
  return [...declared, ...undeclared];
}

/** The rows whose name holds what is typed, without case or accents; nothing typed, the same list. */
export function filterRows(rows: RegistryRow[], text: string): RegistryRow[] {
  const q = foldedWords(text);
  return q === '' ? rows : rows.filter((r) => r.folded.includes(q));
}

/** « 3 objets, dont 1 à la corbeille »: how many objects carry a key. */
export function rowCount(r: { count: number; trashed: number }): string {
  if (r.count === 0) return 'aucun objet';
  const all = `${r.count.toLocaleString('fr-FR')} ${r.count === 1 ? 'objet' : 'objets'}`;
  return r.trashed > 0 ? `${all}, dont ${r.trashed.toLocaleString('fr-FR')} à la corbeille` : all;
}

// ---------------------------------------------------------------------------------------------------------------------
// The form's draft

/**
 * One value of an enumeration in the form: `was`, its name in the definition (null for one added), so that a new name
 * is a rename (renameEnumValue), which rewrites the objects; `rank` as typed.
 */
export interface EnumRow { id: number; was: string | null; name: string; rank: string }

/** What the form edits: a definition with its numbers as typed. The values keep their order until a rank is committed. */
export interface Draft {
  key: string; type: TagType; scope: TagScope; multi: boolean; required: boolean;
  /** As typed; an enumeration's is the name of one of its values; '' is none. */
  defaultValue: string;
  values: EnumRow[];
}

/** A key to create: a word on nodes, one value, optional, with no default. */
export const newDraft = (key = ''): Draft => ({ key, type: 'word', scope: 'node', multi: false, required: false, defaultValue: '', values: [] });

/** The draft of a definition, its values in the order it keeps them. */
export function draftOf(def: TagKeyDef): Draft {
  return {
    key: def.key, type: def.type, scope: def.scope, multi: def.multi, required: def.required,
    defaultValue: def.defaultValue === undefined ? '' : String(def.defaultValue),
    values: (def.enumValues ?? []).map((e, i) => ({ id: i + 1, was: e.name, name: e.name, rank: String(e.rank) })),
  };
}

/**
 * The definition a draft stands for. Refused in French (CommandError, as the core's commands are) when a rank or a
 * number default is no number — read the French way too. A word has no default; only an enumeration has values.
 */
export function definitionOf(d: Draft): TagKeyDef {
  const def: TagKeyDef = { key: d.key.trim(), type: d.type, scope: d.scope, multi: d.multi, required: d.required };
  const text = d.defaultValue.trim();
  if (d.type === 'number') {
    const n = text === '' ? undefined : readTagNumber(text);
    if (n === null) throw new CommandError(`La valeur par défaut « ${text} » n’est pas un nombre.`);
    if (n !== undefined) def.defaultValue = n;
  } else if (d.type === 'enum') {
    // The name of one of the values, as the form's list offers it.
    if (d.defaultValue !== '') def.defaultValue = d.defaultValue;
  } else if (d.type !== 'word' && text !== '') {
    def.defaultValue = text;
  }
  if (d.type === 'enum') {
    def.enumValues = d.values.map((v) => {
      const rank = readTagNumber(v.rank);
      if (rank === null) throw new CommandError(`Le rang de la valeur « ${v.name} » n’est pas un nombre.`);
      return { name: v.name, rank };
    });
  }
  return def;
}

/** Whether two drafts say the same: the values' names and ranks in order, not the bookkeeping that tells a rename. */
export const sameDraft = (a: Draft, b: Draft): boolean =>
  canonical({ ...a, values: a.values.map((v) => [v.name, v.rank]) }) === canonical({ ...b, values: b.values.map((v) => [v.name, v.rank]) });

/** Whether two definitions are the same one (the values in the same order). */
export const sameDefinition = (a: TagKeyDef, b: TagKeyDef): boolean => canonical(a) === canonical(b);

const withValues = (d: Draft, values: EnumRow[]): Draft => ({ ...d, values });
const nextId = (d: Draft): number => d.values.reduce((m, v) => Math.max(m, v.id), 0) + 1;

/** A value added at the end, its rank one past the highest, no name yet. */
export function addValue(d: Draft): Draft {
  const top = d.values.reduce((m, v) => Math.max(m, readTagNumber(v.rank) ?? m), 0);
  return withValues(d, [...d.values, { id: nextId(d), was: null, name: '', rank: String(d.values.length === 0 ? 1 : top + 1) }]);
}

/** A value taken out; the default goes with it if it was that value. */
export function removeValue(d: Draft, id: number): Draft {
  const gone = d.values.find((v) => v.id === id);
  const next = withValues(d, d.values.filter((v) => v.id !== id));
  return gone && d.defaultValue !== '' && gone.name === d.defaultValue ? { ...next, defaultValue: '' } : next;
}

/**
 * A value renamed in the form; the default follows it (when there is one: a value added has no name yet, as no default is
 * ''). The objects are rewritten when the form is saved (planRenames).
 */
export function renameValue(d: Draft, id: number, name: string): Draft {
  const was = d.values.find((v) => v.id === id);
  if (!was) return d;
  const next = withValues(d, d.values.map((v) => (v.id === id ? { ...v, name } : v)));
  return d.defaultValue !== '' && was.name === d.defaultValue ? { ...next, defaultValue: name } : next;
}

/** The type changed: its default goes (a text is no number, nor a value of an enumeration); the same type, the same draft. */
export const setType = (d: Draft, type: TagType): Draft => (type === d.type ? d : { ...d, type, defaultValue: '' });

/** A rank as typed. */
export const setRank = (d: Draft, id: number, rank: string): Draft => withValues(d, d.values.map((v) => (v.id === id ? { ...v, rank } : v)));

/** The values by rank, a rank that is no number last; the order of equals kept. */
export function sortValues(d: Draft): Draft {
  const rank = (v: EnumRow) => readTagNumber(v.rank) ?? Infinity;
  return withValues(d, d.values.map((v, i) => ({ v, i })).sort((a, b) => (rank(a.v) === rank(b.v) ? a.i - b.i : rank(a.v) < rank(b.v) ? -1 : 1)).map(({ v }) => v));
}

/** A value one place up (-1) or down (1): it and its neighbour exchange their places and their ranks. At an end, nothing. */
export function moveValue(d: Draft, id: number, by: -1 | 1): Draft {
  const i = d.values.findIndex((v) => v.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= d.values.length) return d;
  const values = [...d.values];
  values[i] = { ...d.values[j], rank: d.values[i].rank };
  values[j] = { ...d.values[i], rank: d.values[j].rank };
  return withValues(d, values);
}

/** A value renamed in the definition. */
export interface EnumRename { from: string; to: string }

/** The names of the values the draft keeps (a row found under that name), renamed or not. */
const keptNames = (d: Draft): Set<string> => new Set(d.values.flatMap((v) => (v.was === null ? [] : [v.was])));

/**
 * The renames a saved draft makes (its values whose name is no longer the one they were found with), in an order in
 * which none takes a name another still has (renameEnumValue refuses a name that exists): one that frees a name goes
 * first. A value the draft removes keeps no name (freedNames takes it out first). Two values that exchange their names
 * cannot be put in such an order: refused.
 */
export function planRenames(base: TagKeyDef, d: Draft): EnumRename[] {
  const pending = d.values.filter((v) => v.was !== null && v.was !== v.name).map((v) => ({ from: v.was!, to: v.name }));
  const kept = keptNames(d);
  const names = new Set((base.enumValues ?? []).map((e) => e.name).filter((n) => kept.has(n)));
  const out: EnumRename[] = [];
  while (pending.length > 0) {
    const i = pending.findIndex((r) => !names.has(r.to));
    if (i < 0) throw new CommandError('Deux valeurs échangent leur nom : renomme-les une à une.');
    const [r] = pending.splice(i, 1);
    names.delete(r.from);
    names.add(r.to);
    out.push(r);
  }
  return out;
}

/**
 * The values the draft removes whose name another value takes over (`renames`): they go before the rename, which the core
 * refuses while the name exists. A removed value that objects carry is refused with the definition's change, as any is.
 */
export function freedNames(base: TagKeyDef, d: Draft, renames: readonly EnumRename[]): string[] {
  const kept = keptNames(d), taken = new Set(renames.map((r) => r.to));
  return (base.enumValues ?? []).map((e) => e.name).filter((n) => !kept.has(n) && taken.has(n));
}

/** A definition once `renames` are made, in their order: the values' names, and the default that follows its value. */
export function withRenames(def: TagKeyDef, renames: readonly EnumRename[]): TagKeyDef {
  let next = def;
  for (const r of renames) {
    next = {
      ...next,
      ...(next.defaultValue === r.from ? { defaultValue: r.to } : {}),
      enumValues: (next.enumValues ?? []).map((e) => (e.name === r.from ? { name: r.to, rank: e.rank } : e)),
    };
  }
  return next;
}

/** What a form does when the registry's definition is not the one it was made on (`base`). */
export type FormUpdate =
  /** Nothing: the same definition, or none on both sides (a key to create, a key only carried). */
  | { do: 'nothing' }
  /** The definition is the form's: `base` and the draft become it, the notice goes. */
  | { do: 'adopt' }
  /** The definition is gone and the form untouched: `base` goes, the draft is what the objects that carry the key say. */
  | { do: 'infer' }
  /** The definition is gone, the form touched: `base` goes, the draft is kept (a key to declare). */
  | { do: 'unbase' }
  /** The definition changed under a touched form: the draft is kept, the form says so. */
  | { do: 'stale' };

/**
 * The decision of a form whose registry definition (`def`, null if none) is not its `base` (null for a key only carried or
 * being created). `touched`: something was typed in it, apart from whether it differs from `base` — a key only carried has
 * no base to differ from, and an untouched form of one adopts the definition declared elsewhere (an undo, a sync). A form
 * whose draft is the definition (its own save) adopts it, touched or not.
 */
export function formUpdate(f: { base: TagKeyDef | null; def: TagKeyDef | null; draft: Draft; touched: boolean }): FormUpdate {
  if (!f.def) return f.base === null ? { do: 'nothing' } : f.touched ? { do: 'unbase' } : { do: 'infer' };
  if (f.base && sameDefinition(f.base, f.def)) return { do: 'nothing' };
  let mine = false;
  try { mine = sameDefinition(definitionOf(f.draft), f.def); } catch { /* not a definition: not the registry's */ }
  return mine || !f.touched ? { do: 'adopt' } : { do: 'stale' };
}

/**
 * Whether an Escape closes the panel: it is Escape, nothing took it (the graph's gesture, a field, a menu prevented its
 * default), and nothing that yields it first was on screen when the key arrived (`yielding`, read in the capture phase: a
 * floating panel's own Escape removes it before the panel's listener runs, and one key must not close both).
 */
export const registryEscapeCloses = (e: { key: string; defaultPrevented: boolean }, yielding: boolean): boolean => e.key === 'Escape' && !e.defaultPrevented && !yielding;

/**
 * What the objects that carry an undeclared key say of it, as the definition to declare: Cirrus's own shape for a key
 * it reads; else a word when no one gives it a value, a number when every value reads as one, a text otherwise; on nodes,
 * on connections or on both as they carry it; several values if one object has more than one. Costs the carriers once.
 */
export function inferDefinition(s: State, key: string): TagKeyDef {
  const shape = PROTECTED_TAG_KEYS.get(key);
  if (shape) return { key, ...shape, required: false };
  let nodes = false, connections = false, multi = false, valued = false, numbers = true;
  for (const id of taggedWith(s, key)) {
    const node = s.nodes.get(id);
    if (node) nodes = true; else connections = true;
    const tags = node ? node.tags : connTags(s, connRow(s, id));
    let n = 0;
    for (const t of tags) {
      if (t.key !== key) continue;
      n++;
      if (t.value === undefined) continue;
      valued = true;
      if (typeof t.value === 'number' ? !Number.isFinite(t.value) : readTagNumber(t.value) === null) numbers = false;
    }
    if (n > 1) multi = true;
  }
  return { key, type: !valued ? 'word' : numbers ? 'number' : 'text', scope: nodes && connections ? 'both' : connections ? 'connection' : 'node', multi, required: false };
}
