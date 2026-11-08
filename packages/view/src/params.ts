import { ANNOTATION_TITLE_CHARS, MAX_UNITS_PER_REQUEST } from '@cirrus/core';
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
  groupLightness: number;
  groupLightnessStep: number;
  groupLightnessRange: Range;
  groupChroma: number;
  groupHues: number[];
  groupTitleOpenScale: number;
  groupTitleClosedScale: number;
  /** Fold range over which a group's title moves from the top of its envelope to its centre. */
  groupTitleSwap: Range;
  /** Gap between an open group's title and the top of its envelope, in title heights. */
  groupTitleOffset: number;
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
  /** Width of a connection title per character, and its box height, in font sizes (title placement estimate). */
  titleCharWidth: number;
  titleBoxHeight: number;
  markerRingPx: number;
  stubLength: number;
  stubAngle: number;
  dashPx: Range;
  curveTolerancePx: number;
  curveZoomHeadroom: number;
  /** Segments of every cubic the GPU draws (plan 3c task 8: the curves are evaluated in the vertex shaders). */
  curveSegments: number;
  connectionFadePx: number;
  ribbonCullAlpha: number;
  hoverBoostPx: number;
  /** Handles of a selected connection's layout (spec 8.5): radius, and the rotation handle's distance beyond the trunk. */
  handleRadiusPx: number;
  rotationHandlePx: number;
  // Phantoms and signs
  centerRadius: number;
  badgeRadiusPx: number;
  phantomFillAlpha: number;
  phantomTitleDim: number;
  // View and navigation
  viewMarginPx: number;
  hitTolerancePx: number;
  clickSlopPx: number;
  scaleGesturePauseMs: number;
  /** Scroll that makes one scale step with Ctrl+wheel; a wheel notch is one whatever its size (I13 of the plan 3b review). */
  scaleWheelStepPx: number;
  /** Fold from which a group's members are no longer clickable: the group is taken whole (spec 9.3). */
  foldClickable: number;
  stubHitFactor: number;
  wheelZoomSpeed: number;
  keyZoomStep: number;
  keyPanPx: number;
  fitMarginPx: number;
  settingsSaveDelayMs: number;
  toastMs: number;
  /** The answer a « partout ou ici seulement » dialog proposes first (spec 19). */
  defaultAnswer: 'here' | 'everywhere';
  /** When drawing stops: window hidden only, or also without the focus (battery). */
  backgroundPause: 'unfocused' | 'hidden';
  // Scenes (plan 3c, task 5)
  /** The scenes of the last tabs shown, kept and updated by each action: going back to one is immediate. */
  cachedPlans: number;
  /** Share of free slots beyond which an updated scene is built anew. */
  sceneCompactShare: number;
  /** Roots changed since the visibility index's tree was built beyond which it is built again (plan 3c, task 6). */
  indexDirtyMax: number;
  // Rendering by the GPU (plan 3c, task 8)
  /** Time a frame gives to the complex bundles of a rebuild; the others are built at the next frames. */
  rebuildBudgetMs: number;
  /** Camera distance from the local origin, on screen, beyond which the origin moves and the item texture is written again. */
  originShiftPx: number;
  // Snapshot of the base (plan 3c, decision 4): the interface sends its state to be kept as the base's snapshot
  /** after this many actions, */
  snapshotAfterActions: number;
  /** once nothing has happened for this long, */
  snapshotIdleMs: number;
  /** and at closing, which waits for it this long at most. */
  snapshotQuitMs: number;
  // Files (plan 4a)
  /** A larger file is refused at import (the main process reads it through withOverrides, as snapshotQuitMs). */
  maxImportMb: number;
  // Views of the files (plan 4a, task 5): what a view reads at most (HTTP ranges), and how it is drawn
  /** The head of a text or code file shown; past it, a banner says so. */
  textViewMaxMb: number;
  /** The head of a CSV or TSV table read, */
  tableViewMaxMb: number;
  /** and at most this many of its rows. */
  tableMaxRows: number;
  /** A table's rows (virtualised: only those in view, and its margin, are drawn), */
  tableRowPx: number;
  /** its columns, as wide as their longest value up to this, */
  tableColumnMaxPx: number;
  /** and the margin drawn around the view, so that a scroll does not show blank rows first. */
  tableMarginPx: number;
  /** An image's zoom by the wheel, as wheelZoomSpeed, */
  imageZoomSpeed: number;
  /**
   * up to this many times its size (or its fit, when that is larger); never under the smaller of its fit and its own
   * size, so that an image the fit enlarges can still be seen at 1:1,
   */
  imageMaxZoom: number;
  /** which enlarges an image smaller than the view at most this many times (1: shown at its own size). */
  imageFitMaxZoom: number;
  /** An image's thumbnail, or a PDF's first page, in its node's pop-up, */
  thumbPx: number;
  /**
   * read only for an image this large at most, a larger one showing its kind's icon; a PDF's is read by ranges, at most
   * this much of it (past it, its icon).
   */
  thumbMaxMb: number;
  /** The files whose view is kept (« au même endroit »), the one left longest ago forgotten first. */
  viewStatesKept: number;
  // The PDF reader (plan 4a, task 6)
  /** Pages drawn above and below those in view (the others are boxes at their size), */
  pdfPagesAhead: number;
  /** the zoom's step (Ctrl+wheel, + and −), between these bounds (1: the page's real size), */
  pdfZoomStep: number;
  pdfMaxZoom: number;
  pdfMinZoom: number;
  /** the documents kept open once their view is left (the one used longest ago closed first), */
  pdfDocsKept: number;
  /** the gap between the pages and around them, */
  pdfGapPx: number;
  /** and the largest drawing of a page, in megapixels: past it, the page is drawn less dense and stretched. */
  pdfCanvasMaxMp: number;
  // PDF annotations (plan 4c, D1 to D4)
  /** A passage annotated is drawn over its page in this colour, at this opacity, */
  annotationColor: Rgb;
  annotationOpacity: number;
  /** and blinks this long when it is opened from a list (0: not at all). */
  annotationFlashMs: number;
  /** An annotation's title: the start of its passage, this many characters, then « … » (D1). */
  annotationTitleChars: number;
  /** The reader's margin, which lists the PDF's annotations (D4), this wide when it is open. */
  annotationMarginPx: number;
  // Publications (plan 4c, D5, D6): what the main process takes from the network, at the user's request only
  /** A publication's metadata (its CSL-JSON, its BibTeX) larger than this is refused, read no further; */
  publicationMaxKb: number;
  /**
   * a server is waited for this long: a metadata request's whole exchange (its redirects and its body), and at most this
   * long without data during an arXiv PDF's download, whose size is maxImportMb's.
   */
  publicationTimeoutMs: number;
  /** An imported publication keeps this many of its authors as tags `auteur` (D7), its .bib all of them; */
  publicationMaxAuthors: number;
  /** a PDF dropped in the import dialog is searched for its DOI or arXiv identifier in this many first pages (D8). */
  publicationPdfPages: number;
  /**
   * A .bib's publications are put down in a block (D9, task 6) whose boxes stand this far apart, in pixels at the
   * readable step (bibBlock); its notification names at most this many duplicates, and as many problems, then counts
   * the others, and stays this long, unless a click on it or Escape closes it sooner (review of task 6, I1).
   */
  bibBlockGapPx: number;
  bibNoticeLines: number;
  bibNoticeMs: number;
  // Pop-ups (plan 4a): floating panels in window pixels
  /** A node's pop-up as it opens, */
  popupWidthPx: number;
  popupHeightPx: number;
  /** a file's preview as it opens, beside it, */
  previewWidthPx: number;
  previewHeightPx: number;
  /** the smallest side a panel is resized to, */
  panelMinPx: number;
  /** and how far from the click it opens. */
  panelGapPx: number;
  /** The registry's keys or values offered while a tag is typed. */
  tagSuggestions: number;
  // LaTeX (plan 4b)
  /** The packages installed on demand, which every PC installs at its start (D1). */
  latexPackages: string[];
  /** The pdfLaTeX waiting with the preamble loaded (D2): a compilation takes one, another is prepared at once. */
  latexWarmProcesses: number;
  /** A compilation running longer is stopped (an infinite loop, Review Focus 3). */
  latexTimeoutMs: number;
  /** A run of tlmgr (or of TinyTeX's installer) longer than this is stopped with what it started (task 7): never a queue held. */
  latexTlmgrTimeoutMs: number;
  /** TinyTeX's download receiving nothing for this long is stopped, and fails (final review): « Réessayer » then shows. */
  latexDownloadStallMs: number;
  /** A missing file's package that tlmgr could not look up (offline, too slow) is looked up again after this long (final review). */
  latexLookupRetryMs: number;
  /** A summary or a relation is compiled this wide, its height following its content (D3), */
  latexSnippetWidthCm: number;
  /** and drawn at its pop-up's width, enlarged no more than this (plan 4b, task 6). */
  latexSnippetMaxZoom: number;
  /** The local cache of the compiled PDFs (D2), the one used longest ago removed first, */
  latexCacheMb: number;
  /** down to this share of it once over it (final review, I3), so that the next ones find room without trimming again, */
  latexCacheTrimPercent: number;
  /** each with the end of its log, this long at most. */
  latexLogMaxKb: number;
  /** A source changed is compiled once typing has paused this long; the labels' registry is rebuilt at most this often. */
  latexTypingPauseMs: number;
  /** A .tex typed in its full screen is saved once typing has paused this long (D6), and at Ctrl+S and closing. */
  texSaveIdleMs: number;
  /** The LaTeX editor's suggestions of labels and keys: how many are drawn at most, and how long after a key they are asked. */
  latexSuggestionsMax: number;
  latexSuggestionDelayMs: number;
  // Synchronisation (plan 5a): the main process's client of the server (task 3), and the interface's veil (task 4)
  /**
   * At startup and on waking, the veil « Synchronisation… » holds the actions until caught up, this long at most (D8);
   * each request of a pairing waits this long at most for the server's answer (task 4);
   */
  syncConnectTimeoutMs: number;
  /** The pending writes sent in one request at most (the server takes MAX_UNITS_PER_REQUEST); */
  syncBatchUnits: number;
  /** the files of received records downloaded at once (not the PDFs, read on demand); */
  syncDownloads: number;
  /** a lost server tried again after this long, then twice as long each time, up to syncRetryMaxMs; */
  syncRetryMinMs: number;
  syncRetryMaxMs: number;
  /** a PC whose clock differs from the server's by more than this is told to set it (D4); */
  syncClockSkewWarnMs: number;
  /** the writes received are reconciled in batches gathered for this long at most (R3); */
  syncReceiveBatchMs: number;
  /** before sleep, what is pending is sent for this long at most (D8). */
  syncSuspendFlushMs: number;
  // Background (spec 8.6)
  background: 'stars' | 'grid';
  backgroundOpacity: number;
  starCellWorld: number;
  starSpacingPx: Range;
  starSizePx: number;
  starBrightness: number;
  starPresence: number;
  starSeed: number;
  starColor: Rgb;
  gridColor: Rgb;
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
  groupLightness: 0.45,
  groupLightnessStep: 0.06,
  groupLightnessRange: [0.25, 0.85],
  groupChroma: 0.09,
  // The maquette's blue (#34568f) and violet (#5a4690) first, then other cool hues.
  groupHues: [262, 295, 230, 320, 200, 275],
  groupTitleOpenScale: 0.95,
  groupTitleClosedScale: 1.2,
  groupTitleSwap: [0.45, 0.95],
  groupTitleOffset: 0.45,
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
  titleCharWidth: 0.52,
  titleBoxHeight: 1.3,
  markerRingPx: 1.5,
  stubLength: 150,
  stubAngle: 0.6,
  dashPx: [4, 5],
  curveTolerancePx: 0.2,
  curveZoomHeadroom: 2,
  curveSegments: 32,
  connectionFadePx: 150,
  ribbonCullAlpha: 0.03,
  hoverBoostPx: 1,
  handleRadiusPx: 5.5,
  rotationHandlePx: 34,
  centerRadius: 9,
  badgeRadiusPx: 3,
  phantomFillAlpha: 0.45,
  phantomTitleDim: 0.65,
  viewMarginPx: 200,
  hitTolerancePx: 6,
  clickSlopPx: 4,
  scaleGesturePauseMs: 400,
  scaleWheelStepPx: 100,
  foldClickable: 0.5,
  stubHitFactor: 1.5,
  wheelZoomSpeed: 0.0015,
  keyZoomStep: 1.25,
  keyPanPx: 80,
  fitMarginPx: 60,
  settingsSaveDelayMs: 300,
  toastMs: 4000,
  defaultAnswer: 'here',
  backgroundPause: 'unfocused',
  cachedPlans: 4,
  sceneCompactShare: 0.25,
  indexDirtyMax: 256,
  rebuildBudgetMs: 4,
  originShiftPx: 100_000,
  snapshotAfterActions: 200,
  snapshotIdleMs: 2000,
  snapshotQuitMs: 2000,
  maxImportMb: 200,
  textViewMaxMb: 32,
  tableViewMaxMb: 16,
  tableMaxRows: 100_000,
  tableRowPx: 24,
  tableColumnMaxPx: 320,
  tableMarginPx: 240,
  imageZoomSpeed: 0.0015,
  imageMaxZoom: 32,
  imageFitMaxZoom: 4,
  thumbPx: 64,
  thumbMaxMb: 4,
  viewStatesKept: 200,
  pdfPagesAhead: 1,
  pdfZoomStep: 1.15,
  pdfMaxZoom: 5,
  pdfMinZoom: 0.25,
  pdfDocsKept: 4,
  pdfGapPx: 12,
  pdfCanvasMaxMp: 16,
  annotationColor: hexToRgb('#ffd23f'),
  annotationOpacity: 0.35,
  annotationFlashMs: 1200,
  annotationTitleChars: ANNOTATION_TITLE_CHARS,
  annotationMarginPx: 240,
  publicationMaxKb: 2048,
  publicationTimeoutMs: 20_000,
  publicationMaxAuthors: 50,
  publicationPdfPages: 2,
  bibBlockGapPx: 24,
  bibNoticeLines: 5,
  bibNoticeMs: 20_000,
  popupWidthPx: 380,
  popupHeightPx: 460,
  previewWidthPx: 560,
  previewHeightPx: 460,
  panelMinPx: 200,
  panelGapPx: 12,
  tagSuggestions: 8,
  latexPackages: [],
  latexWarmProcesses: 2,
  latexTimeoutMs: 10_000,
  latexTlmgrTimeoutMs: 600_000,
  latexDownloadStallMs: 60_000,
  latexLookupRetryMs: 60_000,
  latexSnippetWidthCm: 9,
  latexSnippetMaxZoom: 1.6,
  latexCacheMb: 500,
  latexCacheTrimPercent: 90,
  latexLogMaxKb: 256,
  latexTypingPauseMs: 300,
  texSaveIdleMs: 10_000,
  latexSuggestionsMax: 100,
  latexSuggestionDelayMs: 100,
  syncConnectTimeoutMs: 4000,
  syncBatchUnits: 50,
  syncDownloads: 4,
  syncRetryMinMs: 1000,
  syncRetryMaxMs: 30_000,
  syncClockSkewWarnMs: 120_000,
  syncReceiveBatchMs: 50,
  syncSuspendFlushMs: 1500,
  background: 'stars',
  backgroundOpacity: 1,
  starCellWorld: 40,
  starSpacingPx: [40, 160],
  starSizePx: 1,
  starBrightness: 0.7,
  starPresence: 0.7,
  starSeed: 7,
  starColor: hexToRgb('#d9e6ff'),
  gridColor: hexToRgb('#d9e6ff'),
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

/**
 * `words`: a list of words of WORD, such as package names. They reach tlmgr's command line: a word starts with a
 * letter or a digit, so that none reads as an option (`--repository=…`), the setting being synced (plan 5).
 */
export type ParamKind = 'number' | 'range' | 'color' | 'choice' | 'list' | 'words';
export const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
const color = (key: keyof RenderParams, label: string, group = 'Couleurs'): ParamSpec => ({ key, label, section: G, group, kind: 'color' });

/** One entry per field of RenderParams, with its French label (the settings panel is generated from this list). */
export const PARAM_SPECS: ParamSpec[] = [
  num('factor', 'Facteur entre deux crans d’échelle', G, 'Échelles', 1.2, 4, 0.05),
  num('textScale', 'Échelle de texte', G, 'Échelles', 0.5, 3, 0.05),
  num('baseFontPx', 'Taille de base du texte (px)', A, 'Échelles', 8, 32, 1),
  range('textFade', 'Disparition du texte des nœuds (px)', G, 'Niveaux de détail', 1, 20, 0.5),
  range('groupFold', 'Transition d’un groupe vers son contenu (px)', G, 'Niveaux de détail', 1, 20, 0.5),
  range('titleFade', 'Disparition des titres de connexion (px)', G, 'Niveaux de détail', 1, 20, 0.5),
  num('minNodePx', 'Taille minimale des nœuds à l’écran (px)', A, 'Niveaux de détail', 0, 20, 0.5),
  num('zoomMin', 'Zoom minimal', A, 'Zoom et déplacement', 1e-5, 1, 1e-5),
  num('zoomMax', 'Zoom maximal', A, 'Zoom et déplacement', 1, 1e5, 1),
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
  num('groupLightness', 'Luminosité des groupes (OKLCH)', A, 'Groupes', 0.1, 0.9, 0.01),
  num('groupLightnessStep', 'Écart de luminosité entre niveaux', A, 'Groupes', 0, 0.2, 0.005),
  range('groupLightnessRange', 'Bornes de luminosité des groupes', A, 'Groupes', 0, 1, 0.01),
  num('groupChroma', 'Saturation des groupes (OKLCH)', A, 'Groupes', 0, 0.3, 0.005),
  { key: 'groupHues', label: 'Teintes des groupes de premier niveau (degrés)', section: A, group: 'Groupes', kind: 'list', min: 0, max: 360, step: 1 },
  num('groupTitleOpenScale', 'Taille du titre d’un groupe ouvert', A, 'Groupes', 0.3, 3, 0.05),
  num('groupTitleClosedScale', 'Taille du titre d’un groupe replié', A, 'Groupes', 0.3, 3, 0.05),
  range('groupTitleSwap', 'Passage du titre d’un groupe du haut au centre (repli de 0 à 1)', A, 'Groupes', 0, 1, 0.01),
  num('groupTitleOffset', 'Écart entre le titre d’un groupe ouvert et son enveloppe (en hauteurs de titre)', A, 'Groupes', 0, 2, 0.05),
  num('trunkTension', 'Tension des courbes', G, 'Connexions', 0.1, 0.95, 0.01),
  num('trunkLength', 'Longueur du tronc', G, 'Connexions', 0, 180, 1),
  num('anchorGap', 'Écart entre une boîte et sa connexion', A, 'Connexions', 0, 20, 0.5),
  num('widthBasePx', 'Largeur de base des connexions (px)', G, 'Connexions', 0.2, 6, 0.1),
  num('widthMinPx', 'Largeur minimale des connexions (px)', G, 'Connexions', 0.2, 4, 0.1),
  num('widthMaxPx', 'Largeur maximale des connexions (px)', G, 'Connexions', 1, 20, 0.1),
  num('arrowLength', 'Longueur des flèches (en largeurs de trait)', A, 'Flèches et marqueurs', 2, 20, 0.5),
  num('arrowHalfWidth', 'Demi-largeur des flèches (en largeurs de trait)', A, 'Flèches et marqueurs', 1, 10, 0.25),
  num('arrowNotch', 'Échancrure des flèches', A, 'Flèches et marqueurs', 0, 1, 0.01),
  num('dotRadius', 'Rayon du point d’un associé (en largeurs de trait)', A, 'Flèches et marqueurs', 1, 8, 0.1),
  num('hollowInset', 'Intérieur d’une flèche évidée', A, 'Flèches et marqueurs', 0.2, 0.9, 0.01),
  num('markerRadiusPx', 'Rayon du marqueur d’un faisceau (px)', A, 'Flèches et marqueurs', 2, 20, 0.5),
  num('titleFontPx', 'Taille des titres de connexion', A, 'Connexions', 6, 30, 0.5),
  num('titleGap', 'Distance du titre des connexions', G, 'Connexions', 0, 60, 1),
  num('titleCharWidth', 'Largeur estimée d’un caractère de titre (en tailles de police)', A, 'Connexions', 0.3, 1, 0.01),
  num('titleBoxHeight', 'Hauteur réservée à un titre de connexion (en tailles de police)', A, 'Connexions', 1, 2.5, 0.05),
  num('markerRingPx', 'Épaisseur du cercle des marqueurs (px)', A, 'Flèches et marqueurs', 0.5, 5, 0.25),
  num('stubLength', 'Longueur des amorces', A, 'Amorces', 20, 600, 5),
  num('stubAngle', 'Écart angulaire des amorces (radians)', A, 'Amorces', 0, 1.5, 0.05),
  range('dashPx', 'Pointillés des amorces : trait et espace (px)', A, 'Amorces', 1, 20, 0.5),
  num('curveTolerancePx', 'Précision des courbes pour placer les titres de connexion (px)', A, 'Rendu', 0.05, 2, 0.05),
  num('curveZoomHeadroom', 'Marge de zoom d’avance des titres et des connexions fines', A, 'Rendu', 1.1, 8, 0.1),
  num('curveSegments', 'Segments par courbe de connexion', A, 'Rendu', 4, 128, 1),
  num('connectionFadePx', 'Marge de fondu d’une connexion hors écran (px)', A, 'Rendu', 0, 600, 5),
  num('ribbonCullAlpha', 'Opacité sous laquelle une connexion n’est pas dessinée', A, 'Rendu', 0, 0.5, 0.005),
  num('hoverBoostPx', 'Élargissement d’une connexion survolée (px)', A, 'Connexions', 0, 4, 0.1),
  num('handleRadiusPx', 'Rayon des poignées de disposition (px)', A, 'Connexions', 2, 15, 0.5),
  num('rotationHandlePx', 'Distance de la poignée de rotation au tronc (px)', A, 'Connexions', 10, 120, 1),
  num('centerRadius', 'Rayon d’un fantôme de centre', A, 'Fantômes et signes', 2, 40, 0.5),
  num('badgeRadiusPx', 'Rayon du badge des connexions absentes (px)', A, 'Fantômes et signes', 1, 8, 0.5),
  num('phantomFillAlpha', 'Opacité du fond d’un fantôme', A, 'Fantômes et signes', 0, 1, 0.01),
  num('phantomTitleDim', 'Atténuation du titre d’un fantôme', A, 'Fantômes et signes', 0.1, 1, 0.01),
  num('viewMarginPx', 'Marge préparée autour de l’écran (px)', A, 'Rendu', 0, 1000, 10),
  num('hitTolerancePx', 'Tolérance de survol d’une connexion (px)', A, 'Pointeur', 1, 20, 0.5),
  num('clickSlopPx', 'Mouvement en deçà duquel un appui reste un clic (px)', A, 'Pointeur', 0, 20, 1),
  num('scaleGesturePauseMs', 'Pause qui termine un geste d’échelle à Ctrl+molette (ms)', A, 'Zoom et déplacement', 100, 3000, 50),
  num('scaleWheelStepPx', 'Défilement qui fait un cran d’échelle à Ctrl+molette (px)', A, 'Zoom et déplacement', 10, 500, 5),
  num('foldClickable', 'Repli à partir duquel les membres d’un groupe ne sont plus cliquables', A, 'Pointeur', 0.05, 0.95, 0.05),
  num('stubHitFactor', 'Tolérance de survol du bout d’une amorce (× tolérance)', A, 'Pointeur', 1, 5, 0.1),
  num('wheelZoomSpeed', 'Vitesse du zoom à la molette', A, 'Zoom et déplacement', 0.0002, 0.01, 0.0001),
  num('keyZoomStep', 'Pas du zoom au clavier', A, 'Zoom et déplacement', 1.05, 3, 0.05),
  num('keyPanPx', 'Pas du déplacement aux flèches (px)', A, 'Zoom et déplacement', 10, 400, 5),
  num('fitMarginPx', 'Marge du cadrage (px)', A, 'Zoom et déplacement', 0, 300, 5),
  num('settingsSaveDelayMs', 'Délai avant d’enregistrer les réglages (ms)', A, 'Base', 0, 5000, 50),
  num('toastMs', 'Durée d’affichage des notifications (ms)', A, 'Dialogues et notifications', 500, 20000, 100),
  {
    key: 'defaultAnswer', label: 'Réponse proposée par les dialogues « partout ou ici seulement »', section: A, group: 'Dialogues et notifications', kind: 'choice',
    choices: [{ value: 'here', label: 'Ici seulement' }, { value: 'everywhere', label: 'Partout' }],
  },
  {
    key: 'backgroundPause', label: 'Mise en pause du rendu', section: A, group: 'Rendu', kind: 'choice',
    choices: [{ value: 'unfocused', label: 'Fenêtre cachée ou sans le focus' }, { value: 'hidden', label: 'Fenêtre cachée seulement' }],
  },
  num('cachedPlans', 'Plans dont la scène reste prête (derniers onglets affichés)', A, 'Rendu', 1, 32, 1),
  num('sceneCompactShare', 'Part d’emplacements libres au-delà de laquelle une scène est reconstruite', A, 'Rendu', 0.05, 1, 0.05),
  num('indexDirtyMax', 'Éléments de premier niveau changés au-delà desquels l’index de la vue refait son arbre', A, 'Rendu', 1, 100000, 1),
  num('rebuildBudgetMs', 'Temps par image pour construire les faisceaux, le reste aux images suivantes (ms)', A, 'Rendu', 0.5, 50, 0.5),
  num('originShiftPx', 'Éloignement de la caméra à l’écran avant de déplacer l’origine locale (px)', A, 'Rendu', 1000, 1000000, 1000),
  num('snapshotAfterActions', 'Actions après lesquelles l’instantané de la base est refait', A, 'Base', 10, 10000, 10),
  num('snapshotIdleMs', 'Repos avant de refaire l’instantané de la base (ms)', A, 'Base', 200, 60000, 100),
  num('snapshotQuitMs', 'Attente de l’instantané à la fermeture (ms)', A, 'Base', 0, 30000, 100),
  num('maxImportMb', 'Taille maximale d’un fichier importé (Mo)', A, 'Fichiers', 1, 4096, 1),
  num('textViewMaxMb', 'Taille lue d’un fichier texte ou de code (Mo)', A, 'Textes et tableaux', 1, 512, 1),
  num('tableViewMaxMb', 'Taille lue d’un tableau CSV ou TSV (Mo)', A, 'Textes et tableaux', 1, 512, 1),
  num('tableMaxRows', 'Lignes lues d’un tableau', A, 'Textes et tableaux', 1000, 2_000_000, 1000),
  num('tableRowPx', 'Hauteur d’une ligne de tableau (px)', A, 'Textes et tableaux', 16, 48, 1),
  num('tableColumnMaxPx', 'Largeur maximale d’une colonne de tableau (px)', A, 'Textes et tableaux', 60, 2000, 10),
  num('tableMarginPx', 'Marge préparée autour de la vue d’un tableau (px)', A, 'Textes et tableaux', 0, 2000, 10),
  num('imageZoomSpeed', 'Vitesse du zoom d’une image à la molette', A, 'Images et vignettes', 0.0002, 0.01, 0.0001),
  num('imageMaxZoom', 'Zoom maximal d’une image (× sa taille réelle)', A, 'Images et vignettes', 1, 256, 1),
  num('imageFitMaxZoom', 'Agrandissement maximal d’une image ajustée à la vue (× sa taille réelle)', A, 'Images et vignettes', 1, 32, 0.5),
  num('thumbPx', 'Taille des vignettes d’images et de PDF (px)', A, 'Images et vignettes', 24, 256, 1),
  num('thumbMaxMb', 'Lecture maximale pour la vignette d’une image ou d’un PDF (Mo)', A, 'Images et vignettes', 0, 64, 1),
  num('viewStatesKept', 'Fichiers dont la vue est gardée (au même endroit)', A, 'Fichiers', 10, 5000, 10),
  num('pdfPagesAhead', 'Pages d’un PDF dessinées d’avance au-dessus et au-dessous de la vue', A, 'PDF', 0, 5, 1),
  num('pdfZoomStep', 'Pas du zoom d’un PDF (Ctrl+molette, + et −)', A, 'PDF', 1.02, 2, 0.01),
  num('pdfMaxZoom', 'Zoom maximal d’un PDF (× sa taille réelle)', A, 'PDF', 1, 10, 0.25),
  num('pdfMinZoom', 'Zoom minimal d’un PDF (× sa taille réelle)', A, 'PDF', 0.05, 1, 0.05),
  num('pdfDocsKept', 'PDF gardés ouverts en mémoire', A, 'PDF', 1, 32, 1),
  num('pdfGapPx', 'Écart entre les pages d’un PDF et autour d’elles (px)', A, 'PDF', 0, 64, 1),
  num('pdfCanvasMaxMp', 'Taille maximale du dessin d’une page de PDF (mégapixels)', A, 'PDF', 1, 64, 1),
  color('annotationColor', 'Surlignage des annotations', 'Annotations'),
  num('annotationOpacity', 'Opacité du surlignage des annotations', A, 'Annotations', 0.05, 1, 0.01),
  num('annotationFlashMs', 'Durée du clignotement d’un passage ouvert depuis la liste (ms)', A, 'Annotations', 0, 10_000, 50),
  num('annotationTitleChars', 'Caractères du passage repris dans le titre d’une annotation', A, 'Annotations', 1, 500, 1),
  num('annotationMarginPx', 'Largeur de la marge des annotations du lecteur PDF (px)', A, 'Annotations', 120, 800, 10),
  num('publicationMaxKb', 'Taille maximale des métadonnées d’une publication reçues du réseau (Ko)', A, 'Publications', 16, 65_536, 16),
  num('publicationTimeoutMs', 'Attente maximale d’un serveur de publications (ms)', A, 'Publications', 1000, 600_000, 500),
  num('publicationMaxAuthors', 'Auteurs d’une publication importée gardés en tags « auteur »', A, 'Publications', 1, 10_000, 1),
  num('publicationPdfPages', 'Pages d’un PDF déposé où chercher son DOI ou son identifiant arXiv', A, 'Publications', 1, 20, 1),
  num('bibBlockGapPx', 'Écart entre les boîtes du bloc d’un .bib importé (px au cran lisible)', A, 'Publications', 0, 400, 1),
  num('bibNoticeLines', 'Lignes de chaque liste de la notification d’un .bib importé (doublons, problèmes)', A, 'Publications', 1, 100, 1),
  num('bibNoticeMs', 'Durée d’affichage de la notification d’un .bib importé, qu’un clic ou Échap ferme (ms)', A, 'Publications', 2000, 600_000, 500),
  num('popupWidthPx', 'Largeur d’un pop-up à son ouverture (px)', A, 'Pop-ups', 200, 1600, 1),
  num('popupHeightPx', 'Hauteur d’un pop-up à son ouverture (px)', A, 'Pop-ups', 160, 1400, 1),
  num('previewWidthPx', 'Largeur d’un aperçu de fichier à son ouverture (px)', A, 'Pop-ups', 200, 1600, 1),
  num('previewHeightPx', 'Hauteur d’un aperçu de fichier à son ouverture (px)', A, 'Pop-ups', 160, 1400, 1),
  num('panelMinPx', 'Côté minimal d’un panneau flottant (px)', A, 'Pop-ups', 120, 600, 1),
  num('panelGapPx', 'Écart entre le clic et le pop-up qu’il ouvre (px)', A, 'Pop-ups', 0, 60, 1),
  num('tagSuggestions', 'Suggestions montrées pendant la saisie d’un tag', A, 'Pop-ups', 1, 50, 1),
  { key: 'latexPackages', label: 'Paquets LaTeX ajoutés (installés sur chaque PC)', section: G, group: 'Paquets et installation', kind: 'words' },
  num('latexWarmProcesses', 'pdfLaTeX préparés d’avance', A, 'Compilation', 1, 4, 1),
  num('latexTimeoutMs', 'Durée maximale d’une compilation (ms)', A, 'Compilation', 1000, 120_000, 100),
  num('latexTlmgrTimeoutMs', 'Durée maximale d’un appel à tlmgr ou à l’installateur de TinyTeX (ms)', A, 'Paquets et installation', 10_000, 3_600_000, 1000),
  num('latexDownloadStallMs', 'Attente maximale de données pendant le téléchargement de TinyTeX (ms)', A, 'Paquets et installation', 5000, 600_000, 1000),
  num('latexLookupRetryMs', 'Délai avant de chercher à nouveau un paquet manquant après un échec de tlmgr (ms)', A, 'Paquets et installation', 10_000, 3_600_000, 1000),
  num('latexSnippetWidthCm', 'Largeur du résumé et de la relation compilés (cm)', G, 'Résumé compilé', 4, 20, 0.5),
  num('latexSnippetMaxZoom', 'Agrandissement maximal du résumé compilé', A, 'Résumé compilé', 0.5, 4, 0.1),
  num('latexCacheMb', 'Taille du cache des PDF compilés (Mo)', A, 'Compilation', 20, 20_000, 10),
  num('latexCacheTrimPercent', 'Taille du cache des PDF compilés après un nettoyage (% de son plafond)', A, 'Compilation', 50, 100, 1),
  num('latexLogMaxKb', 'Taille gardée d’un journal de compilation (Ko)', A, 'Compilation', 16, 4096, 16),
  num('latexTypingPauseMs', 'Pause de frappe avant de compiler (ms)', A, 'Compilation', 50, 3000, 10),
  num('texSaveIdleMs', 'Pause de frappe avant l’enregistrement d’un .tex (ms)', A, 'Éditeur LaTeX', 1000, 600_000, 500),
  num('latexSuggestionsMax', 'Suggestions de labels et de clés montrées dans l’éditeur LaTeX', A, 'Éditeur LaTeX', 10, 1000, 10),
  num('latexSuggestionDelayMs', 'Délai avant les suggestions de l’éditeur LaTeX (ms)', A, 'Éditeur LaTeX', 0, 1000, 10),
  num('syncConnectTimeoutMs', 'Attente maximale du serveur, sous le voile « Synchronisation… » (démarrage, réveil) et au jumelage (ms)', A, 'Synchronisation', 500, 60_000, 100),
  num('syncBatchUnits', 'Écritures envoyées au serveur par requête', A, 'Synchronisation', 1, MAX_UNITS_PER_REQUEST, 1),
  num('syncDownloads', 'Fichiers téléchargés du serveur à la fois', A, 'Synchronisation', 1, 16, 1),
  num('syncRetryMinMs', 'Premier délai avant de réessayer de joindre le serveur (ms)', A, 'Synchronisation', 100, 60_000, 100),
  num('syncRetryMaxMs', 'Délai maximal entre deux essais de joindre le serveur (ms)', A, 'Synchronisation', 1000, 600_000, 1000),
  num('syncClockSkewWarnMs', 'Écart d’horloge avec le serveur au-delà duquel avertir (ms)', A, 'Synchronisation', 10_000, 3_600_000, 1000),
  num('syncReceiveBatchMs', 'Durée maximale d’un lot d’actions reçues avant de l’appliquer (ms)', A, 'Synchronisation', 0, 1000, 5),
  num('syncSuspendFlushMs', 'Temps laissé à l’envoi des actions en attente avant la mise en veille (ms)', A, 'Synchronisation', 0, 10_000, 100),
  {
    key: 'background', label: 'Fond', section: G, group: 'Fond', kind: 'choice',
    choices: [{ value: 'stars', label: 'Ciel étoilé' }, { value: 'grid', label: 'Grille fractale' }],
  },
  num('backgroundOpacity', 'Opacité du fond', G, 'Fond', 0, 1, 0.01),
  num('starCellWorld', 'Maille des étoiles', A, 'Fond', 5, 200, 1),
  range('starSpacingPx', 'Espacement des étoiles à l’écran (px)', A, 'Fond', 5, 600, 5),
  num('starSizePx', 'Taille des étoiles (px)', A, 'Fond', 0.5, 4, 0.1),
  num('starBrightness', 'Éclat des étoiles', A, 'Fond', 0, 1, 0.01),
  num('starPresence', 'Densité des étoiles (part des cases occupées)', A, 'Fond', 0.05, 1, 0.01),
  num('starSeed', 'Graine du ciel étoilé', A, 'Fond', 0, 9999, 1),
  color('starColor', 'Étoiles', 'Fond'),
  color('gridColor', 'Grille', 'Fond'),
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
  color('selectionColor', 'Sélection', 'Sélection et dépôt'),
  num('selectionWidthPx', 'Épaisseur du contour de sélection (px)', A, 'Sélection et dépôt', 0.5, 8, 0.5),
  num('selectionGapPx', 'Écart du contour de sélection (px)', A, 'Sélection et dépôt', 0, 12, 0.5),
  color('dropColor', 'Groupe qui recevra un dépôt', 'Sélection et dépôt'),
  color('intruderColor', 'Intrus dans une enveloppe', 'Sélection et dépôt'),
];

/**
 * The settings panel's headings (the user, 2026-11-07: « une hiérarchie des options qui les range par type »): every
 * group of PARAM_SPECS under one of them, in the order shown.
 */
export const PARAM_RUBRICS: { title: string; groups: string[] }[] = [
  { title: 'Apparence', groups: ['Couleurs', 'Fond', 'Nœuds', 'Groupes', 'Connexions', 'Flèches et marqueurs', 'Amorces', 'Fantômes et signes', 'Sélection et dépôt'] },
  { title: 'Navigation', groups: ['Échelles', 'Niveaux de détail', 'Zoom et déplacement', 'Pointeur'] },
  { title: 'Fenêtres', groups: ['Pop-ups', 'Dialogues et notifications'] },
  { title: 'Fichiers', groups: ['Fichiers', 'Textes et tableaux', 'Images et vignettes', 'PDF', 'Annotations', 'Publications'] },
  { title: 'LaTeX', groups: ['Résumé compilé', 'Compilation', 'Éditeur LaTeX', 'Paquets et installation'] },
  { title: 'Performances et base', groups: ['Rendu', 'Base'] },
  { title: 'Serveur', groups: ['Synchronisation'] },
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
    case 'words': return Array.isArray(v) && v.every((w) => typeof w === 'string' && WORD.test(w));
  }
}

/**
 * A valid value brought inside its card's bounds (C1 of the plan 3 review): a keystroke on the way to a value, or a
 * hand-edited file, never reaches the renderer out of range (a factor of 1 froze it). An interval stays ordered.
 */
function bounded(spec: ParamSpec, v: unknown): unknown {
  const clamp = (x: number) => Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, x));
  if (spec.kind === 'number') return clamp(v as number);
  if (spec.kind === 'list') return (v as number[]).map(clamp);
  if (spec.kind === 'range') {
    const [a, b] = (v as number[]).map(clamp).sort((x, y) => x - y);
    return [a, b > a ? b : Math.min(spec.max ?? Infinity, a + (spec.step ?? 1))];
  }
  return Array.isArray(v) ? [...v] : v;
}

/** Whether two values of a setting are the same (a list, an interval or a colour compared by its content). */
export const sameSetting = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The fields that differ from the defaults: only those are written, so a later default reaches everyone else (spec 5.4 spirit). */
export function diffFromDefaults(p: RenderParams): Partial<RenderParams> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(p)) {
    if (!sameSetting(v, DEFAULT_PARAMS[key as keyof RenderParams])) out[key] = v;
  }
  return out as Partial<RenderParams>;
}

/**
 * One setting's value as a settings file is read: brought inside its bounds; undefined for a key that is no setting, or
 * a value of another kind (a shared setting received from another PC, plan 5a task 6, goes through it too).
 */
export function settingValue(key: string, v: unknown): unknown {
  const spec = SPEC_BY_KEY.get(key as keyof RenderParams);
  return spec && valid(spec, v) ? bounded(spec, v) : undefined;
}

/** The defaults with every known, well-typed override applied: a corrupt settings file degrades key by key. */
export function withOverrides(overrides: unknown): RenderParams {
  const out: Record<string, unknown> = { ...DEFAULT_PARAMS };
  if (overrides === null || typeof overrides !== 'object') return out as unknown as RenderParams;
  for (const [key, v] of Object.entries(overrides)) {
    const value = settingValue(key, v);
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as RenderParams;
}
