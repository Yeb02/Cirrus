/** Every rendering constant lives here (spec 19: advanced graphic settings). */
export interface RenderParams {
  factor: number;
  baseFontPx: number;
  textScale: number;
  textFade: [number, number];
  groupFold: [number, number];
  titleFade: [number, number];
  minNodePx: number;
  widthBasePx: number;
  widthMinPx: number;
  widthMaxPx: number;
  groupOffsetSteps: number;
  viewMarginPx: number;
  starCellWorld: number;
  starSpacingPx: [number, number];
  starSizePx: number;
  /** Bézier flattening tolerance in on-screen px (segments follow curvature: a straight curve gets one)... */
  curveTolerancePx: number;
  /** ...valid until the zoom grows by this factor, then ribbons are resampled. */
  curveZoomHeadroom: number;
  /** A connection fades out over this many px once its nearest endpoint leaves the screen. */
  connectionFadePx: number;
  /** Connections fainter than this at their widest point are not drawn (they would be invisible). */
  ribbonCullAlpha: number;
  /** On-screen length of a stub (connections displayed as stubs). */
  stubPx: number;
}

export const DEFAULT_PARAMS: RenderParams = {
  factor: 2,
  baseFontPx: 16,
  textScale: 1,
  textFade: [6, 8],
  groupFold: [4.5, 6.5],
  titleFade: [6.5, 9],
  minNodePx: 4,
  widthBasePx: 1.5,
  widthMinPx: 1,
  widthMaxPx: 5,
  groupOffsetSteps: 2,
  viewMarginPx: 200,
  starCellWorld: 40,
  starSpacingPx: [40, 160],
  starSizePx: 1,
  curveTolerancePx: 0.2,
  curveZoomHeadroom: 2,
  connectionFadePx: 150,
  ribbonCullAlpha: 0.03,
  stubPx: 40,
};

export interface SceneSpec {
  seed: number;
  nodeCount: number;
  connectionCount: number;
  minChildren: number;
  maxChildren: number;
  groupShare: number;
  multiMemberShare: number;
  locality: [number, number, number];
  /** Deepest level a group may sit at (top level = 0). Default DEFAULT_MAX_DEPTH. */
  maxDepth?: number;
}

/** Real knowledge bases are shallow; unbounded depth also pushes factor^k past float precision. */
export const DEFAULT_MAX_DEPTH = 5;

export const BENCH_SCENE: SceneSpec = {
  seed: 1,
  nodeCount: 50_000,
  connectionCount: 500_000,
  minChildren: 4,
  maxChildren: 12,
  groupShare: 0.15,
  multiMemberShare: 0.1,
  locality: [0.8, 0.15, 0.05],
};

/** World width of a node box at scale step k. */
export const BOX_WORLD_WIDTH = 210;
