import { MAX_ID_CHARS, normalizeTag, TagError, type TagKeyDef, type TagValue } from '@cirrus/core';

/** A number as typed, the French way too: « 1,5 », « -2.25 », « 1 000 ». */
const NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

/**
 * A tag typed in a node's pop-up (spec 5.4): « mot » is a word, « clé:valeur » a key and its value, split at the first
 * colon, both trimmed. A key of the registry is held to its type: a word takes no value, any other type needs one; a
 * number is read the French way too; an enumeration value, by its name or its rank, goes through normalizeTag. A key the
 * registry does not know is kept as typed (the registry grows over time), within MAX_ID_CHARS characters, as the
 * server's gate bounds a key a write adds (R32: refused when typed, never undone afterwards). Refusals throw TagError,
 * in French.
 */
export function parseTag(input: string, defs: ReadonlyMap<string, TagKeyDef>): TagValue {
  const text = input.trim();
  if (text === '') throw new TagError('Le tag est vide.');
  const colon = text.indexOf(':');
  const key = (colon < 0 ? text : text.slice(0, colon)).trim();
  if (key === '') throw new TagError('Il manque le nom du tag avant « : ».');
  if (key.length > MAX_ID_CHARS) throw new TagError(`Le nom d’un tag compte ${MAX_ID_CHARS} caractères au plus (ici ${key.length}).`);
  const value = colon < 0 ? undefined : text.slice(colon + 1).trim();
  const def = defs.get(key);
  if (def?.type === 'word') {
    if (value !== undefined && value !== '') throw new TagError(`Le tag « ${key} » ne prend pas de valeur.`);
    return { key };
  }
  if (def && !value) throw new TagError(`Le tag « ${key} » demande une valeur : « ${key}:… ».`);
  if (value === undefined) return { key };
  if (value === '') throw new TagError(`Il manque la valeur après « ${key}: ».`);
  if (def?.type === 'number') {
    // Spaces between digits are dropped, the no-break ones too (\s holds them).
    const compact = value.replace(/\s/g, '');
    if (!NUMBER.test(compact)) throw new TagError(`Le tag « ${key} » demande un nombre : « ${value} » n’en est pas un.`);
    return { key, value: Number(compact.replace(',', '.')) };
  }
  if (def?.type === 'enum') {
    // A rank is written in digits; a name that is also digits is taken as a name.
    const rank = /^\d+$/.test(value) && !def.enumValues?.some((e) => e.name === value) ? Number(value) : value;
    return normalizeTag({ key, value: rank }, defs);
  }
  return { key, value };
}

const same = (a: TagValue, b: TagValue) => a.key === b.key && a.value === b.value;

/**
 * The tags with `tag` added: a key declared multiple takes one more value; any other key, one the registry does not
 * know included, has its value replaced in its place. A tag already there gives back the same list (nothing to write).
 */
export function withTag(tags: TagValue[], tag: TagValue, defs: ReadonlyMap<string, TagKeyDef>): TagValue[] {
  if (tags.some((t) => same(t, tag))) return tags;
  const at = defs.get(tag.key)?.multi ? -1 : tags.findIndex((t) => t.key === tag.key);
  if (at < 0) return [...tags, tag];
  return [...tags.slice(0, at), tag, ...tags.slice(at + 1).filter((t) => t.key !== tag.key)];
}

/** The tags without `tag` (that value of its key); not there, the same list. */
export function withoutTag(tags: TagValue[], tag: TagValue): TagValue[] {
  return tags.some((t) => same(t, tag)) ? tags.filter((t) => !same(t, tag)) : tags;
}

/**
 * A suggestion while a tag is typed: a key of the registry (`value` absent), or a value of an enumeration once its key
 * and the colon are typed.
 */
export interface TagSuggestion { key: string; value?: string; rank?: number }

/** Compared without case or accents: « Epis » finds « statut_epistémique ». */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');

/**
 * What the registry suggests for `text`, at most `max`: before a colon, the keys of this scope that hold the text, those
 * that begin with it first, in the registry's order; after « clé: », the values of that enumeration that hold what follows
 * (or whose rank it is), by rank. Any other key suggests nothing after its colon.
 */
export function tagSuggestions(text: string, defs: ReadonlyMap<string, TagKeyDef>, scope: 'node' | 'connection', max: number): TagSuggestion[] {
  const colon = text.indexOf(':');
  if (colon < 0) {
    const q = fold(text.trim());
    const keys = [...defs.values()].filter((d) => (d.scope === 'both' || d.scope === scope) && fold(d.key).includes(q));
    const starts = (d: TagKeyDef) => (fold(d.key).startsWith(q) ? 0 : 1);
    return keys.sort((a, b) => starts(a) - starts(b)).slice(0, max).map((d) => ({ key: d.key }));
  }
  const key = text.slice(0, colon).trim(), q = fold(text.slice(colon + 1).trim()), def = defs.get(key);
  if (def?.type !== 'enum') return [];
  return [...(def.enumValues ?? [])]
    .sort((a, b) => a.rank - b.rank)
    .filter((e) => fold(e.name).includes(q) || String(e.rank) === q)
    .slice(0, max)
    .map((e) => ({ key, value: e.name, rank: e.rank }));
}
