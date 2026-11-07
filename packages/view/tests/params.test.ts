import { ANNOTATION_TITLE_CHARS } from '@cirrus/core';
import { expect, test } from 'vitest';
import { DEFAULT_PARAMS, diffFromDefaults, PARAM_RUBRICS, PARAM_SPECS, withOverrides } from '../src/params.ts';
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

test('chaque groupe de réglages est dans une rubrique, et une seule ; aucune rubrique n’est vide', () => {
  const groups = [...new Set(PARAM_SPECS.map((s) => s.group))].sort();
  expect(PARAM_RUBRICS.flatMap((r) => r.groups).sort()).toEqual(groups);
  expect(PARAM_RUBRICS.map((r) => r.title)).toEqual(['Apparence', 'Navigation', 'Fenêtres', 'Fichiers', 'LaTeX', 'Performances et base']);
  for (const r of PARAM_RUBRICS) expect(r.groups.length, r.title).toBeGreaterThan(0);
});

test('les groupes trop longs sont partagés par sujet', () => {
  const groupOf = (k: string) => PARAM_SPECS.find((s) => s.key === k)!.group;
  expect(['zoomMin', 'wheelZoomSpeed', 'keyPanPx', 'fitMarginPx'].map(groupOf)).toEqual(Array(4).fill('Zoom et déplacement'));
  expect(['hitTolerancePx', 'clickSlopPx', 'foldClickable', 'stubHitFactor'].map(groupOf)).toEqual(Array(4).fill('Pointeur'));
  expect(['backgroundPause', 'cachedPlans', 'rebuildBudgetMs', 'curveSegments', 'ribbonCullAlpha'].map(groupOf)).toEqual(Array(5).fill('Rendu'));
  expect(['arrowLength', 'markerRingPx'].map(groupOf)).toEqual(['Flèches et marqueurs', 'Flèches et marqueurs']);
  expect(['stubLength', 'dashPx'].map(groupOf)).toEqual(['Amorces', 'Amorces']);
  expect(['defaultAnswer', 'toastMs'].map(groupOf)).toEqual(['Dialogues et notifications', 'Dialogues et notifications']);
  expect(['snapshotIdleMs', 'settingsSaveDelayMs'].map(groupOf)).toEqual(['Base', 'Base']);
  expect(['starColor', 'gridColor'].map(groupOf)).toEqual(['Fond', 'Fond']);
  expect(['selectionColor', 'selectionGapPx', 'dropColor'].map(groupOf)).toEqual(Array(3).fill('Sélection et dépôt'));
  for (const s of PARAM_SPECS) expect(PARAM_SPECS.filter((x) => x.group === s.group).length, s.group).toBeLessThanOrEqual(16);
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

test('vues des fichiers : plafonds de lecture, tableaux, images, vignettes, vues gardées, réglages avancés de la rubrique « Fichiers » (plan 4a, tâche 5)', () => {
  const T = 'Textes et tableaux', I = 'Images et vignettes';
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number, string][] = [
    ['textViewMaxMb', 32, 'Taille lue d’un fichier texte ou de code (Mo)', 1, 512, 1, T],
    ['tableViewMaxMb', 16, 'Taille lue d’un tableau CSV ou TSV (Mo)', 1, 512, 1, T],
    ['tableMaxRows', 100_000, 'Lignes lues d’un tableau', 1000, 2_000_000, 1000, T],
    ['tableRowPx', 24, 'Hauteur d’une ligne de tableau (px)', 16, 48, 1, T],
    ['tableColumnMaxPx', 320, 'Largeur maximale d’une colonne de tableau (px)', 60, 2000, 10, T],
    ['tableMarginPx', 240, 'Marge préparée autour de la vue d’un tableau (px)', 0, 2000, 10, T],
    ['imageZoomSpeed', 0.0015, 'Vitesse du zoom d’une image à la molette', 0.0002, 0.01, 0.0001, I],
    ['imageMaxZoom', 32, 'Zoom maximal d’une image (× sa taille réelle)', 1, 256, 1, I],
    ['imageFitMaxZoom', 4, 'Agrandissement maximal d’une image ajustée à la vue (× sa taille réelle)', 1, 32, 0.5, I],
    ['thumbPx', 64, 'Taille des vignettes d’images et de PDF (px)', 24, 256, 1, I],
    ['thumbMaxMb', 4, 'Lecture maximale pour la vignette d’une image ou d’un PDF (Mo)', 0, 64, 1, I],
    ['viewStatesKept', 200, 'Fichiers dont la vue est gardée (au même endroit)', 10, 5000, 10, 'Fichiers'],
  ];
  for (const [key, value, label, min, max, step, group] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group, kind: 'number', min, max, step });
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

test('lecteur PDF : pages d’avance, pas et bornes du zoom, documents gardés, écart, taille d’un dessin, réglages avancés du groupe « PDF » (plan 4a, tâche 6)', () => {
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
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group: 'PDF', kind: 'number', min, max, step });
  }
});

test('annotations : couleur (réglage principal), opacité, clignotement, titre et marge, groupe « Annotations » de la rubrique « Fichiers » (plan 4c, tâche 2)', () => {
  expect(PARAM_SPECS.find((s) => s.key === 'annotationColor')).toEqual({
    key: 'annotationColor', label: 'Surlignage des annotations', section: 'graphique', group: 'Annotations', kind: 'color',
  });
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number][] = [
    ['annotationOpacity', 0.35, 'Opacité du surlignage des annotations', 0.05, 1, 0.01],
    ['annotationFlashMs', 1200, 'Durée du clignotement d’un passage ouvert depuis la liste (ms)', 0, 10_000, 50],
    ['annotationTitleChars', ANNOTATION_TITLE_CHARS, 'Caractères du passage repris dans le titre d’une annotation', 1, 500, 1],
    ['annotationMarginPx', 240, 'Largeur de la marge des annotations du lecteur PDF (px)', 120, 800, 10],
  ];
  for (const [key, value, label, min, max, step] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group: 'Annotations', kind: 'number', min, max, step });
  }
  expect(DEFAULT_PARAMS.annotationTitleChars).toBe(80);
  // Never 0 nor negative: a title keeps at least a character of its passage.
  expect(withOverrides({ annotationTitleChars: 0, annotationOpacity: 3 })).toMatchObject({ annotationTitleChars: 1, annotationOpacity: 1 });
  expect(PARAM_RUBRICS.find((r) => r.title === 'Fichiers')!.groups).toEqual(['Fichiers', 'Textes et tableaux', 'Images et vignettes', 'PDF', 'Annotations']);
});

test('paquets LaTeX ajoutés : une liste de mots, vide par défaut, réglage principal du groupe « Paquets et installation » (plan 4b, tâche 2)', () => {
  expect(DEFAULT_PARAMS.latexPackages).toEqual([]);
  expect(PARAM_SPECS.find((s) => s.key === 'latexPackages')).toEqual({
    key: 'latexPackages', label: 'Paquets LaTeX ajoutés (installés sur chaque PC)', section: 'graphique', group: 'Paquets et installation', kind: 'words',
  });
  expect(withOverrides({ latexPackages: ['tikz-cd'] }).latexPackages).toEqual(['tikz-cd']);
  expect(withOverrides({ latexPackages: ['siunitx', 'l3kernel', 'babel-french', 'ms.x_y'] }).latexPackages).toEqual(['siunitx', 'l3kernel', 'babel-french', 'ms.x_y']);
  // Only words of [A-Za-z0-9._-], starting with a letter or a digit: they reach tlmgr's command line, where a word
  // starting with « - » would be an option (the setting will be synced, plan 5).
  for (const bad of [['a b'], [3], ['tikz-cd', 3], [''], ['a&b'], ['é'], ['--repository=x'], ['-a'], ['tikz-cd', '--reinstall'], ['.x'], 'tikz-cd', null]) {
    expect(withOverrides({ latexPackages: bad }).latexPackages, JSON.stringify(bad)).toEqual([]);
  }
  const p = { ...DEFAULT_PARAMS, latexPackages: ['tikz-cd', 'siunitx'] };
  expect(diffFromDefaults(p)).toEqual({ latexPackages: ['tikz-cd', 'siunitx'] });
  expect(withOverrides(diffFromDefaults(p))).toEqual(p);
});

test('compilation LaTeX : processus préparés, délai, largeur du résumé, cache, journal, rubrique « LaTeX » (plan 4b, tâche 3)', () => {
  const C = 'Compilation';
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number, string, string][] = [
    ['latexWarmProcesses', 2, 'pdfLaTeX préparés d’avance', 1, 4, 1, 'avancé', C],
    ['latexTimeoutMs', 10_000, 'Durée maximale d’une compilation (ms)', 1000, 120_000, 100, 'avancé', C],
    // A main setting (the user, 2026-11-07: « rends-le accessible dans le menu des options »).
    ['latexSnippetWidthCm', 9, 'Largeur du résumé et de la relation compilés (cm)', 4, 20, 0.5, 'graphique', 'Résumé compilé'],
    ['latexCacheMb', 500, 'Taille du cache des PDF compilés (Mo)', 20, 20_000, 10, 'avancé', C],
    ['latexLogMaxKb', 256, 'Taille gardée d’un journal de compilation (Ko)', 16, 4096, 16, 'avancé', C],
  ];
  for (const [key, value, label, min, max, step, section, group] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section, group, kind: 'number', min, max, step });
  }
  expect(withOverrides({ latexWarmProcesses: 9, latexSnippetWidthCm: 1 })).toMatchObject({ latexWarmProcesses: 4, latexSnippetWidthCm: 4 });
});

test('pause de frappe avant de compiler : 300 ms, de 50 à 3000, réglage avancé du groupe « Compilation » (plan 4b, tâche 4)', () => {
  expect(DEFAULT_PARAMS.latexTypingPauseMs).toBe(300);
  expect(PARAM_SPECS.find((s) => s.key === 'latexTypingPauseMs')).toEqual({
    key: 'latexTypingPauseMs', label: 'Pause de frappe avant de compiler (ms)', section: 'avancé', group: 'Compilation', kind: 'number', min: 50, max: 3000, step: 10,
  });
  expect(withOverrides({ latexTypingPauseMs: 10 }).latexTypingPauseMs).toBe(50);
  expect(withOverrides({ latexTypingPauseMs: 9000 }).latexTypingPauseMs).toBe(3000);
});

test('pause de frappe avant l’enregistrement d’un .tex : 10 s, de 1 s à 10 min, réglage avancé du groupe « Éditeur LaTeX » (plan 4b, tâche 5)', () => {
  expect(DEFAULT_PARAMS.texSaveIdleMs).toBe(10_000);
  expect(PARAM_SPECS.find((s) => s.key === 'texSaveIdleMs')).toEqual({
    key: 'texSaveIdleMs', label: 'Pause de frappe avant l’enregistrement d’un .tex (ms)', section: 'avancé', group: 'Éditeur LaTeX', kind: 'number', min: 1000, max: 600_000, step: 500,
  });
  expect(withOverrides({ texSaveIdleMs: 10 }).texSaveIdleMs).toBe(1000);
  expect(withOverrides({ texSaveIdleMs: 9e9 }).texSaveIdleMs).toBe(600_000);
});

test('résumé compilé et suggestions de l’éditeur LaTeX : réglages avancés de la rubrique « LaTeX » (plan 4b, tâche 6)', () => {
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number, string][] = [
    ['latexSnippetMaxZoom', 1.6, 'Agrandissement maximal du résumé compilé', 0.5, 4, 0.1, 'Résumé compilé'],
    // CodeMirror's own values (maxRenderedOptions, activateOnTypingDelay), now settings.
    ['latexSuggestionsMax', 100, 'Suggestions de labels et de clés montrées dans l’éditeur LaTeX', 10, 1000, 10, 'Éditeur LaTeX'],
    ['latexSuggestionDelayMs', 100, 'Délai avant les suggestions de l’éditeur LaTeX (ms)', 0, 1000, 10, 'Éditeur LaTeX'],
  ];
  for (const [key, value, label, min, max, step, group] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group, kind: 'number', min, max, step });
  }
  expect(withOverrides({ latexSnippetMaxZoom: 9, latexSuggestionsMax: 1, latexSuggestionDelayMs: -5 })).toMatchObject({
    latexSnippetMaxZoom: 4, latexSuggestionsMax: 10, latexSuggestionDelayMs: 0,
  });
});

test('délai de tlmgr : un réglage avancé du groupe « Paquets et installation » (plan 4b, tâche 7)', () => {
  // About three times the slowest call measured (203 s, a slow CTAN mirror: tlmgr's base packages, registry).
  expect(DEFAULT_PARAMS.latexTlmgrTimeoutMs).toBe(600_000);
  expect(PARAM_SPECS.find((s) => s.key === 'latexTlmgrTimeoutMs')).toEqual({
    key: 'latexTlmgrTimeoutMs', label: 'Durée maximale d’un appel à tlmgr ou à l’installateur de TinyTeX (ms)', section: 'avancé', group: 'Paquets et installation',
    kind: 'number', min: 10_000, max: 3_600_000, step: 1000,
  });
  expect(withOverrides({ latexTlmgrTimeoutMs: 1 }).latexTlmgrTimeoutMs).toBe(10_000);
});

test('cache des PDF ramené sous son plafond, téléchargement de TinyTeX bloqué, recherche d’un paquet après un échec de tlmgr : réglages avancés de la rubrique « LaTeX » (plan 4b, revue finale)', () => {
  const specs: [keyof typeof DEFAULT_PARAMS, number, string, number, number, number, string][] = [
    ['latexCacheTrimPercent', 90, 'Taille du cache des PDF compilés après un nettoyage (% de son plafond)', 50, 100, 1, 'Compilation'],
    ['latexDownloadStallMs', 60_000, 'Attente maximale de données pendant le téléchargement de TinyTeX (ms)', 5000, 600_000, 1000, 'Paquets et installation'],
    ['latexLookupRetryMs', 60_000, 'Délai avant de chercher à nouveau un paquet manquant après un échec de tlmgr (ms)', 10_000, 3_600_000, 1000, 'Paquets et installation'],
  ];
  for (const [key, value, label, min, max, step, group] of specs) {
    expect(DEFAULT_PARAMS[key], key).toBe(value);
    expect(PARAM_SPECS.find((s) => s.key === key)).toEqual({ key, label, section: 'avancé', group, kind: 'number', min, max, step });
  }
  expect(withOverrides({ latexCacheTrimPercent: 10, latexDownloadStallMs: 1, latexLookupRetryMs: 1 })).toMatchObject({
    latexCacheTrimPercent: 50, latexDownloadStallMs: 5000, latexLookupRetryMs: 10_000,
  });
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
