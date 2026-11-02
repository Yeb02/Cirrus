import { hexToRgb } from './color.ts';

export type Rgb = [number, number, number];
export type Range = [number, number];

/**
 * Every rendering and interaction constant (spec 19: a default fixed by the design is a setting). Lengths without a
 * unit suffix are world units at scale step 0; *Px are on-screen pixels; arrow and dot sizes are in line widths.
 */
export interface RenderParams {
  // Scales (spec 8.1)
  factor: number;
  textScale: number;
  baseFontPx: number;
  // Levels of detail (spec 8.2)
  textFade: Range;
  groupFold: Range;
  titleFade: Range;
  minNodePx: number;
  zoomMin: number;
  zoomMax: number;
  // Node boxes (spec 8.3)
  boxWidth: number;
  boxPadX: number;
  boxPadY: number;
  lineHeight: number;
  boxRadius: number;
  boxBorderPx: number;
  // Groups (spec 8.4)
  groupOffsetSteps: number;
  envelopePad: number;
  featherOpenPx: number;
  featherClosedPx: number;
  envelopeOpacityOpen: number;
  envelopeResolution: number;
  groupLightness: number;
  groupLightnessStep: number;
  groupLightnessRange: Range;
  groupChroma: number;
  groupHues: number[];
  groupTitleOpenScale: number;
  groupTitleClosedScale: number;
  /** Fold range over which a group's title moves from the top of its envelope to its centre. */
  groupTitleSwap: Range;
  // Connections (spec 8.5)
  trunkTension: number;
  trunkLength: number;
  anchorGap: number;
  widthBasePx: number;
  widthMinPx: number;
  widthMaxPx: number;
  arrowLength: number;
  arrowHalfWidth: number;
  arrowNotch: number;
  dotRadius: number;
  hollowInset: number;
  markerRadiusPx: number;
  titleFontPx: number;
  titleGap: number;
  stubLength: number;
  stubAngle: number;
  dashPx: Range;
  curveTolerancePx: number;
  curveZoomHeadroom: number;
  connectionFadePx: number;
  ribbonCullAlpha: number;
  hoverBoostPx: number;
  // Phantoms and signs
  centerRadius: number;
  badgeRadiusPx: number;
  // View and navigation
  viewMarginPx: number;
  hitTolerancePx: number;
  clickSlopPx: number;
  wheelZoomSpeed: number;
  keyZoomStep: number;
  keyPanPx: number;
  fitMarginPx: number;
  settingsSaveDelayMs: number;
  toastMs: number;
  // Background (spec 8.6)
  background: 'stars' | 'grid';
  backgroundOpacity: number;
  starCellWorld: number;
  starSpacingPx: Range;
  starSizePx: number;
  starBrightness: number;
  gridSpacingPx: Range;
  gridAlpha: number;
  // Colours
  skyColor: Rgb;
  skyColor2: Rgb;
  nodeColor: Rgb;
  nodeEdgeColor: Rgb;
  inkColor: Rgb;
  connectionColor: Rgb;
  connectionAlpha: number;
  absentColor: Rgb;
  markerColor: Rgb;
  titleColor: Rgb;
  selectionColor: Rgb;
  selectionWidthPx: number;
  selectionGapPx: number;
  dropColor: Rgb;
  intruderColor: Rgb;
}

export const DEFAULT_PARAMS: RenderParams = {
  factor: 2,
  textScale: 1,
  baseFontPx: 16,
  textFade: [6, 8],
  groupFold: [4.5, 6.5],
  titleFade: [6.5, 9],
  minNodePx: 4,
  zoomMin: 1e-3,
  zoomMax: 1e3,
  boxWidth: 210,
  boxPadX: 12,
  boxPadY: 13,
  lineHeight: 1.25,
  boxRadius: 11,
  boxBorderPx: 1.2,
  groupOffsetSteps: 2,
  envelopePad: 44,
  featherOpenPx: 10,
  featherClosedPx: 1.5,
  envelopeOpacityOpen: 0.32,
  envelopeResolution: 1,
  groupLightness: 0.45,
  groupLightnessStep: 0.06,
  groupLightnessRange: [0.25, 0.85],
  groupChroma: 0.09,
  // The maquette's blue (#34568f) and violet (#5a4690) first, then other cool hues.
  groupHues: [262, 295, 230, 320, 200, 275],
  groupTitleOpenScale: 0.95,
  groupTitleClosedScale: 1.2,
  groupTitleSwap: [0.45, 0.95],
  trunkTension: 0.55,
  trunkLength: 50,
  anchorGap: 3,
  widthBasePx: 1.5,
  widthMinPx: 1,
  widthMaxPx: 5,
  arrowLength: 8,
  arrowHalfWidth: 3,
  arrowNotch: 0.66,
  dotRadius: 2.2,
  hollowInset: 0.55,
  markerRadiusPx: 6.5,
  titleFontPx: 13,
  titleGap: 11,
  stubLength: 150,
  stubAngle: 0.6,
  dashPx: [4, 5],
  curveTolerancePx: 0.2,
  curveZoomHeadroom: 2,
  connectionFadePx: 150,
  ribbonCullAlpha: 0.03,
  hoverBoostPx: 1,
  centerRadius: 9,
  badgeRadiusPx: 3,
  viewMarginPx: 200,
  hitTolerancePx: 6,
  clickSlopPx: 4,
  wheelZoomSpeed: 0.0015,
  keyZoomStep: 1.25,
  keyPanPx: 80,
  fitMarginPx: 60,
  settingsSaveDelayMs: 300,
  toastMs: 4000,
  background: 'stars',
  backgroundOpacity: 1,
  starCellWorld: 40,
  starSpacingPx: [40, 160],
  starSizePx: 1,
  starBrightness: 0.7,
  gridSpacingPx: [24, 96],
  gridAlpha: 0.06,
  skyColor: hexToRgb('#0a1120'),
  skyColor2: hexToRgb('#14213a'),
  nodeColor: hexToRgb('#1b2b49'),
  nodeEdgeColor: hexToRgb('#4d6a9a'),
  inkColor: hexToRgb('#e9effb'),
  connectionColor: hexToRgb('#8fb8ff'),
  connectionAlpha: 0.75,
  absentColor: hexToRgb('#8494ae'),
  markerColor: hexToRgb('#14213a'),
  titleColor: hexToRgb('#cfdcf5'),
  selectionColor: hexToRgb('#ffd9a0'),
  selectionWidthPx: 2,
  selectionGapPx: 3,
  dropColor: hexToRgb('#8fb8ff'),
  intruderColor: hexToRgb('#ff9a3c'),
};

export type ParamKind = 'number' | 'range' | 'color' | 'choice' | 'list';

export interface ParamSpec {
  key: keyof RenderParams;
  label: string;
  section: 'graphique' | 'avancé';
  group: string;
  kind: ParamKind;
  min?: number;
  max?: number;
  step?: number;
  choices?: { value: string; label: string }[];
}

const G = 'graphique', A = 'avancé';
const num = (key: keyof RenderParams, label: string, section: ParamSpec['section'], group: string, min: number, max: number, step: number): ParamSpec =>
  ({ key, label, section, group, kind: 'number', min, max, step });
const range = (key: keyof RenderParams, label: string, section: ParamSpec['section'], group: string, min: number, max: number, step: number): ParamSpec =>
  ({ key, label, section, group, kind: 'range', min, max, step });
const color = (key: keyof RenderParams, label: string): ParamSpec => ({ key, label, section: G, group: 'Couleurs', kind: 'color' });

/** One entry per field of RenderParams, with its French label (the settings panel is generated from this list). */
export const PARAM_SPECS: ParamSpec[] = [
  num('factor', 'Facteur entre deux crans d’échelle', G, 'Échelles', 1.2, 4, 0.05),
  num('textScale', 'Échelle de texte', G, 'Échelles', 0.5, 3, 0.05),
  num('baseFontPx', 'Taille de base du texte (px)', A, 'Échelles', 8, 32, 1),
  range('textFade', 'Disparition du texte des nœuds (px)', G, 'Niveaux de détail', 1, 20, 0.5),
  range('groupFold', 'Transition d’un groupe vers son contenu (px)', G, 'Niveaux de détail', 1, 20, 0.5),
  range('titleFade', 'Disparition des titres de connexion (px)', G, 'Niveaux de détail', 1, 20, 0.5),
  num('minNodePx', 'Taille minimale des nœuds à l’écran (px)', A, 'Niveaux de détail', 0, 20, 0.5),
  num('zoomMin', 'Zoom minimal', A, 'Vue', 1e-5, 1, 1e-5),
  num('zoomMax', 'Zoom maximal', A, 'Vue', 1, 1e5, 1),
  num('boxWidth', 'Largeur des boîtes', A, 'Nœuds', 80, 400, 1),
  num('boxPadX', 'Marge horizontale des boîtes', A, 'Nœuds', 0, 40, 1),
  num('boxPadY', 'Marge verticale des boîtes', A, 'Nœuds', 0, 40, 1),
  num('lineHeight', 'Interligne des titres', A, 'Nœuds', 1, 2, 0.05),
  num('boxRadius', 'Arrondi des boîtes', A, 'Nœuds', 0, 40, 1),
  num('boxBorderPx', 'Épaisseur du bord des boîtes (px)', A, 'Nœuds', 0, 4, 0.1),
  num('groupOffsetSteps', 'Crans d’un nouveau groupe au-dessus de son plus grand membre', A, 'Groupes', 0, 6, 1),
  num('envelopePad', 'Marge des enveloppes', A, 'Groupes', 0, 150, 1),
  num('featherOpenPx', 'Flou du bord d’un groupe ouvert (px)', A, 'Groupes', 0, 40, 0.5),
  num('featherClosedPx', 'Flou du bord d’un groupe replié (px)', A, 'Groupes', 0, 20, 0.5),
  num('envelopeOpacityOpen', 'Opacité apparente d’un groupe ouvert', A, 'Groupes', 0.05, 1, 0.01),
  num('envelopeResolution', 'Résolution des enveloppes (1 : dessinées directement ; moins : texture réduite)', A, 'Groupes', 0.25, 1, 0.05),
  num('groupLightness', 'Luminosité des groupes (OKLCH)', A, 'Groupes', 0.1, 0.9, 0.01),
  num('groupLightnessStep', 'Écart de luminosité entre niveaux', A, 'Groupes', 0, 0.2, 0.005),
  range('groupLightnessRange', 'Bornes de luminosité des groupes', A, 'Groupes', 0, 1, 0.01),
  num('groupChroma', 'Saturation des groupes (OKLCH)', A, 'Groupes', 0, 0.3, 0.005),
  { key: 'groupHues', label: 'Teintes des groupes de premier niveau (degrés)', section: A, group: 'Groupes', kind: 'list', min: 0, max: 360, step: 1 },
  num('groupTitleOpenScale', 'Taille du titre d’un groupe ouvert', A, 'Groupes', 0.3, 3, 0.05),
  num('groupTitleClosedScale', 'Taille du titre d’un groupe replié', A, 'Groupes', 0.3, 3, 0.05),
  range('groupTitleSwap', 'Passage du titre d’un groupe du haut au centre (repli de 0 à 1)', A, 'Groupes', 0, 1, 0.01),
  num('trunkTension', 'Tension des courbes', G, 'Connexions', 0.1, 0.95, 0.01),
  num('trunkLength', 'Longueur du tronc', G, 'Connexions', 0, 180, 1),
  num('anchorGap', 'Écart entre une boîte et sa connexion', A, 'Connexions', 0, 20, 0.5),
  num('widthBasePx', 'Largeur de base des connexions (px)', G, 'Connexions', 0.2, 6, 0.1),
  num('widthMinPx', 'Largeur minimale des connexions (px)', G, 'Connexions', 0.2, 4, 0.1),
  num('widthMaxPx', 'Largeur maximale des connexions (px)', G, 'Connexions', 1, 20, 0.1),
  num('arrowLength', 'Longueur des flèches (en largeurs de trait)', A, 'Connexions', 2, 20, 0.5),
  num('arrowHalfWidth', 'Demi-largeur des flèches (en largeurs de trait)', A, 'Connexions', 1, 10, 0.25),
  num('arrowNotch', 'Échancrure des flèches', A, 'Connexions', 0, 1, 0.01),
  num('dotRadius', 'Rayon du point d’un associé (en largeurs de trait)', A, 'Connexions', 1, 8, 0.1),
  num('hollowInset', 'Intérieur d’une flèche évidée', A, 'Connexions', 0.2, 0.9, 0.01),
  num('markerRadiusPx', 'Rayon du marqueur d’un faisceau (px)', A, 'Connexions', 2, 20, 0.5),
  num('titleFontPx', 'Taille des titres de connexion', A, 'Connexions', 6, 30, 0.5),
  num('titleGap', 'Distance du titre des connexions', G, 'Connexions', 0, 60, 1),
  num('stubLength', 'Longueur des amorces', A, 'Connexions', 20, 600, 5),
  num('stubAngle', 'Écart angulaire des amorces (radians)', A, 'Connexions', 0, 1.5, 0.05),
  range('dashPx', 'Pointillés des amorces : trait et espace (px)', A, 'Connexions', 1, 20, 0.5),
  num('curveTolerancePx', 'Précision des courbes (px)', A, 'Connexions', 0.05, 2, 0.05),
  num('curveZoomHeadroom', 'Marge de zoom avant de recalculer les courbes', A, 'Connexions', 1.1, 8, 0.1),
  num('connectionFadePx', 'Marge de fondu d’une connexion hors écran (px)', A, 'Connexions', 0, 600, 5),
  num('ribbonCullAlpha', 'Opacité sous laquelle une connexion n’est pas dessinée', A, 'Connexions', 0, 0.5, 0.005),
  num('hoverBoostPx', 'Élargissement d’une connexion survolée (px)', A, 'Connexions', 0, 4, 0.1),
  num('centerRadius', 'Rayon d’un fantôme de centre', A, 'Fantômes et signes', 2, 40, 0.5),
  num('badgeRadiusPx', 'Rayon du badge des connexions absentes (px)', A, 'Fantômes et signes', 1, 8, 0.5),
  num('viewMarginPx', 'Marge préparée autour de l’écran (px)', A, 'Vue', 0, 1000, 10),
  num('hitTolerancePx', 'Tolérance de survol d’une connexion (px)', A, 'Vue', 1, 20, 0.5),
  num('clickSlopPx', 'Mouvement en deçà duquel un appui reste un clic (px)', A, 'Vue', 0, 20, 1),
  num('wheelZoomSpeed', 'Vitesse du zoom à la molette', A, 'Vue', 0.0002, 0.01, 0.0001),
  num('keyZoomStep', 'Pas du zoom au clavier', A, 'Vue', 1.05, 3, 0.05),
  num('keyPanPx', 'Pas du déplacement aux flèches (px)', A, 'Vue', 10, 400, 5),
  num('fitMarginPx', 'Marge du cadrage (px)', A, 'Vue', 0, 300, 5),
  num('settingsSaveDelayMs', 'Délai avant d’enregistrer les réglages (ms)', A, 'Vue', 0, 5000, 50),
  num('toastMs', 'Durée d’affichage des notifications (ms)', A, 'Vue', 500, 20000, 100),
  {
    key: 'background', label: 'Fond', section: G, group: 'Fond', kind: 'choice',
    choices: [{ value: 'stars', label: 'Ciel étoilé' }, { value: 'grid', label: 'Grille fractale' }],
  },
  num('backgroundOpacity', 'Opacité du fond', G, 'Fond', 0, 1, 0.01),
  num('starCellWorld', 'Maille des étoiles', A, 'Fond', 5, 200, 1),
  range('starSpacingPx', 'Espacement des étoiles à l’écran (px)', A, 'Fond', 5, 600, 5),
  num('starSizePx', 'Taille des étoiles (px)', A, 'Fond', 0.5, 4, 0.1),
  num('starBrightness', 'Éclat des étoiles', A, 'Fond', 0, 1, 0.01),
  range('gridSpacingPx', 'Espacement de la grille à l’écran (px)', A, 'Fond', 5, 600, 1),
  num('gridAlpha', 'Opacité de la grille', A, 'Fond', 0, 0.5, 0.005),
  color('skyColor', 'Ciel'),
  color('skyColor2', 'Ciel, second ton'),
  color('nodeColor', 'Nœuds'),
  color('nodeEdgeColor', 'Bord des nœuds'),
  color('inkColor', 'Texte'),
  color('connectionColor', 'Connexions'),
  num('connectionAlpha', 'Opacité des connexions', G, 'Couleurs', 0.1, 1, 0.01),
  color('absentColor', 'Amorces'),
  color('markerColor', 'Intérieur des marqueurs'),
  color('titleColor', 'Titres des connexions'),
  color('selectionColor', 'Sélection'),
  num('selectionWidthPx', 'Épaisseur du contour de sélection (px)', A, 'Couleurs', 0.5, 8, 0.5),
  num('selectionGapPx', 'Écart du contour de sélection (px)', A, 'Couleurs', 0, 12, 0.5),
  color('dropColor', 'Groupe qui recevra un dépôt'),
  color('intruderColor', 'Intrus dans une enveloppe'),
];

const SPEC_BY_KEY = new Map(PARAM_SPECS.map((s) => [s.key, s]));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function valid(spec: ParamSpec, v: unknown): boolean {
  switch (spec.kind) {
    case 'number': return finite(v);
    case 'range': return Array.isArray(v) && v.length === 2 && v.every(finite);
    case 'color': return Array.isArray(v) && v.length === 3 && v.every((c) => finite(c) && c >= 0 && c <= 1);
    case 'list': return Array.isArray(v) && v.length > 0 && v.every(finite);
    case 'choice': return typeof v === 'string' && spec.choices!.some((c) => c.value === v);
  }
}

/** The fields that differ from the defaults: only those are written, so a later default reaches everyone else (spec 5.4 spirit). */
export function diffFromDefaults(p: RenderParams): Partial<RenderParams> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(p)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_PARAMS[key as keyof RenderParams])) out[key] = v;
  }
  return out as Partial<RenderParams>;
}

/** The defaults with every known, well-typed override applied: a corrupt settings file degrades key by key. */
export function withOverrides(overrides: unknown): RenderParams {
  const out: Record<string, unknown> = { ...DEFAULT_PARAMS };
  if (overrides === null || typeof overrides !== 'object') return out as unknown as RenderParams;
  for (const [key, v] of Object.entries(overrides)) {
    const spec = SPEC_BY_KEY.get(key as keyof RenderParams);
    if (spec && valid(spec, v)) out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out as unknown as RenderParams;
}
