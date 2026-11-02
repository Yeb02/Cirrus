import { expect, test } from 'vitest';
import type { TagKeyDef, TagValue } from '../src/model.ts';
import { effectiveTags, enumRank, normalizeTag, TagError } from '../src/registry.ts';

const defs = new Map<string, TagKeyDef>([
  ['statut_epistémique', {
    key: 'statut_epistémique', type: 'enum', scope: 'both', multi: false, required: true, defaultValue: 'sans_recul',
    enumValues: [{ name: 'douteux', rank: -1 }, { name: 'sans_recul', rank: 0 }, { name: 'consensus_scientifique', rank: 5 }],
  }],
]);

test('le rang et le nom désignent la même valeur', () => {
  expect(normalizeTag({ key: 'statut_epistémique', value: 5 }, defs)).toEqual({ key: 'statut_epistémique', value: 'consensus_scientifique' });
  expect(enumRank({ key: 'statut_epistémique', value: 'consensus_scientifique' }, defs)).toBe(5);
});

test('valeur hors énumération refusée', () => {
  expect(() => normalizeTag({ key: 'statut_epistémique', value: 'peut-être' }, defs)).toThrow(TagError);
});

test('défaut ajouté à la lecture, jamais stocké', () => {
  const tags: TagValue[] = [{ key: 'algorithmie' }];
  expect(effectiveTags(tags, 'node', defs)).toContainEqual({ key: 'statut_epistémique', value: 'sans_recul' });
  expect(tags).toHaveLength(1);
});
