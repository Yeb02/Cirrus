import { CITE_KEY_TAG, LABEL_TAG } from './latex.ts';
import type { TagKeyDef, TagValue } from './model.ts';

export class TagError extends Error {}

/** What a definition decides of the values it accepts beyond them: its type, its scope, one value or several. */
export type TagKeyShape = Pick<TagKeyDef, 'type' | 'scope' | 'multi'>;

/**
 * The keys Cirrus itself reads (plan 6a, D4), with the shape it gives them: LaTeX's (label, clé_bibtex), a
 * publication's (auteur, date_de_publication, doi, arxiv), a document's structure (partie, suivant). The registry shows
 * them, but never renames nor removes them; their definition keeps that shape (required and defaultValue change).
 */
export const PROTECTED_TAG_KEYS: ReadonlyMap<string, TagKeyShape> = new Map<string, TagKeyShape>([
  [LABEL_TAG, { type: 'text', scope: 'node', multi: false }],
  [CITE_KEY_TAG, { type: 'text', scope: 'node', multi: false }],
  ['auteur', { type: 'text', scope: 'node', multi: true }],
  ['date_de_publication', { type: 'date', scope: 'node', multi: false }],
  ['doi', { type: 'text', scope: 'node', multi: false }],
  ['arxiv', { type: 'text', scope: 'node', multi: false }],
  ['partie', { type: 'number', scope: 'connection', multi: false }],
  ['suivant', { type: 'word', scope: 'connection', multi: false }],
]);

/** A number as typed, the French way too (« 1,5 », « -2.25 », « 1 000 » once its spaces are dropped): the app's parseTag reads the same. */
const NUMBER = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

/**
 * Whether a definition accepts `value` (a carried tag's, or its default), as the app's parseTag reads a typed one: a
 * word takes none; any other type needs one; a number is a number, or text that reads as one; an enumeration's is a
 * name or a rank of its values (normalizeTag); a date and a text take any (no rule reads a date yet).
 */
export function tagValueFits(def: TagKeyDef, value: string | number | undefined): boolean {
  if (def.type === 'word') return value === undefined;
  if (value === undefined || value === '') return false;
  if (def.type === 'number') return typeof value === 'number' ? Number.isFinite(value) : NUMBER.test(value.replace(/\s/g, ''));
  if (def.type === 'enum') return def.enumValues?.some((e) => e.name === value || e.rank === value) ?? false;
  return true;
}

/** Whether a node's or a connection's values of a key (`values`, in their order) fit its definition: scope, number, each value. */
export function tagValuesFit(def: TagKeyDef, kind: 'node' | 'connection', values: readonly (string | number | undefined)[]): boolean {
  if (def.scope !== 'both' && def.scope !== kind) return false;
  if (!def.multi && values.length > 1) return false;
  return values.every((v) => tagValueFits(def, v));
}

/**
 * Stores an enumeration value by its name: a rank is converted, an unknown value is refused.
 * Keys absent from the registry are accepted as they are (the registry grows over time).
 */
export function normalizeTag(tag: TagValue, defs: ReadonlyMap<string, TagKeyDef>): TagValue {
  const def = defs.get(tag.key);
  if (!def || def.type !== 'enum' || tag.value === undefined) return tag;
  const match = def.enumValues?.find((e) => e.name === tag.value || e.rank === tag.value);
  if (!match) throw new TagError(`Valeur « ${tag.value} » inconnue pour le tag « ${tag.key} ».`);
  return { key: tag.key, value: match.name };
}

/** Rank of an enumeration value, for filters such as "≥ 3". */
export function enumRank(tag: TagValue, defs: ReadonlyMap<string, TagKeyDef>): number | undefined {
  const def = defs.get(tag.key);
  return def?.enumValues?.find((e) => e.name === tag.value || e.rank === tag.value)?.rank;
}

/** Tags as read: required keys that are absent get their default value, which is never stored (spec 5.4). */
export function effectiveTags(tags: TagValue[], scope: 'node' | 'connection', defs: ReadonlyMap<string, TagKeyDef>): TagValue[] {
  const out = [...tags];
  for (const def of defs.values()) {
    if (!def.required || def.defaultValue === undefined) continue;
    if (def.scope !== 'both' && def.scope !== scope) continue;
    if (!tags.some((t) => t.key === def.key)) out.push({ key: def.key, value: def.defaultValue });
  }
  return out;
}
