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

test('taille maximale d’un fichier importé : 200 Mo, de 1 à 4096, réglage avancé du groupe « Fichiers » (plan 4a)', () => {
  expect(DEFAULT_PARAMS.maxImportMb).toBe(200);
  expect(PARAM_SPECS.find((s) => s.key === 'maxImportMb')).toEqual({
    key: 'maxImportMb', label: 'Taille maximale d’un fichier importé (Mo)', section: 'avancé', group: 'Fichiers', kind: 'number', min: 1, max: 4096, step: 1,
  });
  expect(withOverrides({ maxImportMb: 1e6 }).maxImportMb).toBe(4096);
  expect(withOverrides({ maxImportMb: 0 }).maxImportMb).toBe(1);
});

test('pop-ups : taille d’ouverture, taille minimale, écart au clic et suggestions de tags, réglages avancés du groupe « Pop-ups » (plan 4a)', () => {
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number][] = [
    ['popupWidthPx', 380, 'Largeur d’un pop-up à son ouverture (px)', 200, 1600],
    ['popupHeightPx', 460, 'Hauteur d’un pop-up à son ouverture (px)', 160, 1400],
    ['panelMinPx', 200, 'Côté minimal d’un panneau flottant (px)', 120, 600],
    ['panelGapPx', 12, 'Écart entre le clic et le pop-up qu’il ouvre (px)', 0, 60],
    ['tagSuggestions', 8, 'Suggestions montrées pendant la saisie d’un tag', 1, 50],
  ];
  for (const [key, value, label, min, max] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group: 'Pop-ups', kind: 'number', min, max, step: 1 });
  }
});

test('vues des fichiers : plafonds de lecture, tableaux, images, vignettes, vues gardées, réglages avancés du groupe « Fichiers » (plan 4a, tâche 5)', () => {
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number][] = [
    ['textViewMaxMb', 32, 'Taille lue d’un fichier texte ou de code (Mo)', 1, 512, 1],
    ['tableViewMaxMb', 16, 'Taille lue d’un tableau CSV ou TSV (Mo)', 1, 512, 1],
    ['tableMaxRows', 100_000, 'Lignes lues d’un tableau', 1000, 2_000_000, 1000],
    ['tableRowPx', 24, 'Hauteur d’une ligne de tableau (px)', 16, 48, 1],
    ['tableColumnMaxPx', 320, 'Largeur maximale d’une colonne de tableau (px)', 60, 2000, 10],
    ['tableMarginPx', 240, 'Marge préparée autour de la vue d’un tableau (px)', 0, 2000, 10],
    ['imageZoomSpeed', 0.0015, 'Vitesse du zoom d’une image à la molette', 0.0002, 0.01, 0.0001],
    ['imageMaxZoom', 32, 'Zoom maximal d’une image (× sa taille réelle)', 1, 256, 1],
    ['imageFitMaxZoom', 4, 'Agrandissement maximal d’une image ajustée à la vue (× sa taille réelle)', 1, 32, 0.5],
    ['thumbPx', 64, 'Taille des vignettes d’images et de PDF (px)', 24, 256, 1],
    ['thumbMaxMb', 4, 'Lecture maximale pour la vignette d’une image ou d’un PDF (Mo)', 0, 64, 1],
    ['viewStatesKept', 200, 'Fichiers dont la vue est gardée (au même endroit)', 10, 5000, 10],
  ];
  for (const [key, value, label, min, max, step] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group: 'Fichiers', kind: 'number', min, max, step });
  }
  // A file's preview opens beside its node's pop-up, at its own size (group « Pop-ups », with the pop-up's).
  expect(PARAM_SPECS.find((s) => s.key === 'previewWidthPx')).toEqual({
    key: 'previewWidthPx', label: 'Largeur d’un aperçu de fichier à son ouverture (px)', section: 'avancé', group: 'Pop-ups', kind: 'number', min: 200, max: 1600, step: 1,
  });
  expect(PARAM_SPECS.find((s) => s.key === 'previewHeightPx')).toEqual({
    key: 'previewHeightPx', label: 'Hauteur d’un aperçu de fichier à son ouverture (px)', section: 'avancé', group: 'Pop-ups', kind: 'number', min: 160, max: 1400, step: 1,
  });
  expect([DEFAULT_PARAMS.previewWidthPx, DEFAULT_PARAMS.previewHeightPx]).toEqual([560, 460]);
});

test('lecteur PDF : pages d’avance, pas et bornes du zoom, documents gardés, écart, taille d’un dessin, réglages avancés du groupe « Fichiers » (plan 4a, tâche 6)', () => {
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number][] = [
    ['pdfPagesAhead', 1, 'Pages d’un PDF dessinées d’avance au-dessus et au-dessous de la vue', 0, 5, 1],
    ['pdfZoomStep', 1.15, 'Pas du zoom d’un PDF (Ctrl+molette, + et −)', 1.02, 2, 0.01],
    ['pdfMaxZoom', 5, 'Zoom maximal d’un PDF (× sa taille réelle)', 1, 10, 0.25],
    ['pdfMinZoom', 0.25, 'Zoom minimal d’un PDF (× sa taille réelle)', 0.05, 1, 0.05],
    ['pdfDocsKept', 4, 'PDF gardés ouverts en mémoire', 1, 32, 1],
    ['pdfGapPx', 12, 'Écart entre les pages d’un PDF et autour d’elles (px)', 0, 64, 1],
    ['pdfCanvasMaxMp', 16, 'Taille maximale du dessin d’une page de PDF (mégapixels)', 1, 64, 1],
  ];
  for (const [key, value, label, min, max, step] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group: 'Fichiers', kind: 'number', min, max, step });
  }
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
