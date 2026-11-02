import type { Id } from '@cirrus/core';
import {
  buildFrame, buildIndex, type Camera, computeVisible, type FrameGeometry, type PlanScene, type RenderParams, type SceneIndex, type TitleSide,
} from '@cirrus/view';
import { packFrame, transferables } from './frameData.ts';

/**
 * Builds frames off the main thread (bench lesson: building them froze the view): what is visible from the camera,
 * then the meshes. The scene is sent once, with its index built here.
 */
export type FrameRequest =
  | { t: 'scene'; scene: PlanScene; params: RenderParams }
  | { t: 'frame'; seq: number; cam: Camera; origin: { x: number; y: number }; params: RenderParams; sides: [Id, TitleSide][] };

const scope = self as unknown as { onmessage: ((e: MessageEvent<FrameRequest>) => void) | null; postMessage(m: unknown, transfer: Transferable[]): void };
let scene: PlanScene | null = null;
let index: SceneIndex | null = null;
let reuse: FrameGeometry | undefined;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'scene') {
    scene = m.scene;
    index = buildIndex(m.scene, m.params);
    reuse = undefined;
    return;
  }
  if (!scene || !index) return;
  const visible = computeVisible(scene, index, m.cam, m.params);
  const frame = buildFrame(scene, visible, m.cam, m.origin, m.params, new Map(m.sides), reuse);
  reuse = frame;
  const packed = packFrame(frame, true);
  scope.postMessage({ seq: m.seq, visible, frame: packed }, transferables(packed));
};
