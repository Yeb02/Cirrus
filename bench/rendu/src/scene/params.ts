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
  /** Bézier sampling: one segment per this many on-screen px... */
  curveSegmentPx: number;
  /** ...valid until the zoom grows by this factor, then ribbons are resampled. */
  curveZoomHeadroom: number;
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
  curveSegmentPx: 6,
  curveZoomHeadroom: 2,
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
