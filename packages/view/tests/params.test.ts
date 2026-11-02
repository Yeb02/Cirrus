import { expect, test } from 'vitest';
import { DEFAULT_PARAMS, PARAM_SPECS, withOverrides } from '../src/params.ts';

test('chaque paramètre a sa fiche, et une seule (spec 19)', () => {
  const keys = Object.keys(DEFAULT_PARAMS).sort();
  expect(PARAM_SPECS.map((s) => s.key).sort()).toEqual(keys);
});

test('les fiches ont un libellé français et une section', () => {
  for (const s of PARAM_SPECS) {
    expect(s.label.length).toBeGreaterThan(2);
    expect(['graphique', 'avancé']).toContain(s.section);
  }
});

test('les réglages corrompus sont ignorés clé par clé', () => {
  const p = withOverrides({ factor: 3, textFade: [1], skyColor: 'rouge', inconnu: 4, trunkLength: '50' });
  expect(p.factor).toBe(3);
  expect(p.textFade).toEqual(DEFAULT_PARAMS.textFade);
  expect(p.skyColor).toEqual(DEFAULT_PARAMS.skyColor);
  expect(p.trunkLength).toBe(DEFAULT_PARAMS.trunkLength);
  expect(withOverrides(null)).toEqual(DEFAULT_PARAMS);
  expect(withOverrides('pas un objet')).toEqual(DEFAULT_PARAMS);
});

test('un choix hors liste et un nombre non fini sont ignorés', () => {
  const p = withOverrides({ background: 'nuages', widthMaxPx: Number.NaN, groupHues: [1, 'x'] });
  expect(p.background).toBe(DEFAULT_PARAMS.background);
  expect(p.widthMaxPx).toBe(DEFAULT_PARAMS.widthMaxPx);
  expect(p.groupHues).toEqual(DEFAULT_PARAMS.groupHues);
  expect(withOverrides({ background: 'grid', groupHues: [10, 20] })).toMatchObject({ background: 'grid', groupHues: [10, 20] });
});
