import { expect, test } from 'vitest';
import { DEFAULT_PARAMS, diffFromDefaults, PARAM_SPECS, withOverrides } from '../src/params.ts';
import { sceneParamsKey } from '../src/scene.ts';

test('seuls les écarts aux défauts sont écrits, et l’aller-retour est exact', () => {
  expect(diffFromDefaults(DEFAULT_PARAMS)).toEqual({});
  const p = { ...DEFAULT_PARAMS, factor: 3, textFade: [5, 9] as [number, number], skyColor: [0, 0, 0] as [number, number, number] };
  expect(diffFromDefaults(p)).toEqual({ factor: 3, textFade: [5, 9], skyColor: [0, 0, 0] });
  expect(withOverrides(diffFromDefaults(p))).toEqual(p);
  expect(diffFromDefaults({ ...DEFAULT_PARAMS, groupHues: [...DEFAULT_PARAMS.groupHues] })).toEqual({});
});

test('la scène ne se reconstruit que pour les paramètres qu’elle lit', () => {
  const key = sceneParamsKey(DEFAULT_PARAMS);
  expect(sceneParamsKey({ ...DEFAULT_PARAMS, connectionColor: [1, 0, 0], trunkTension: 0.3 })).toBe(key);
  for (const change of [{ boxWidth: 300 }, { factor: 3 }, { textScale: 1.5 }, { envelopePad: 10 }, { centerRadius: 4 }]) {
    expect(sceneParamsKey({ ...DEFAULT_PARAMS, ...change })).not.toBe(key);
  }
});

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
  // A setting removed since it was written (envelopeResolution, plan 3c task 7) is ignored like an unknown one.
  expect(withOverrides({ envelopeResolution: 0.5 })).toEqual(DEFAULT_PARAMS);
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

test('un réglage hors bornes est ramené dans les bornes de sa fiche (C1 de la relecture)', () => {
  const p = withOverrides({ factor: 1, widthMaxPx: 1e9, textFade: [9, 3], starSpacingPx: [0, 160], gridSpacingPx: [-5, 4] });
  const spec = (k: string) => PARAM_SPECS.find((s) => s.key === k)!;
  expect(p.factor).toBe(spec('factor').min);
  expect(p.widthMaxPx).toBe(spec('widthMaxPx').max);
  expect(p.textFade[0]).toBeLessThan(p.textFade[1]); // an interval stays ordered
  expect(p.starSpacingPx[0]).toBeGreaterThan(0);
  expect(p.gridSpacingPx[0]).toBeLessThan(p.gridSpacingPx[1]);
});
