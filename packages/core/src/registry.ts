import type { TagKeyDef, TagValue } from './model.ts';

export class TagError extends Error {}

/**
 * Stores an enumeration value by its name: a rank is converted, an unknown value is refused.
 * Keys absent from the registry are accepted as they are (the registry grows over time).
 */
export function normalizeTag(tag: TagValue, defs: Map<string, TagKeyDef>): TagValue {
  const def = defs.get(tag.key);
  if (!def || def.type !== 'enum' || tag.value === undefined) return tag;
  const match = def.enumValues?.find((e) => e.name === tag.value || e.rank === tag.value);
  if (!match) throw new TagError(`Valeur « ${tag.value} » inconnue pour le tag « ${tag.key} ».`);
  return { key: tag.key, value: match.name };
}

/** Rank of an enumeration value, for filters such as "≥ 3". */
export function enumRank(tag: TagValue, defs: Map<string, TagKeyDef>): number | undefined {
  const def = defs.get(tag.key);
  return def?.enumValues?.find((e) => e.name === tag.value || e.rank === tag.value)?.rank;
}

/** Tags as read: required keys that are absent get their default value, which is never stored (spec 5.4). */
export function effectiveTags(tags: TagValue[], scope: 'node' | 'connection', defs: Map<string, TagKeyDef>): TagValue[] {
  const out = [...tags];
  for (const def of defs.values()) {
    if (!def.required || def.defaultValue === undefined) continue;
    if (def.scope !== 'both' && def.scope !== scope) continue;
    if (!tags.some((t) => t.key === def.key)) out.push({ key: def.key, value: def.defaultValue });
  }
  return out;
}
