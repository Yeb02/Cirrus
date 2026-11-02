import { BOX_WORLD_WIDTH, DEFAULT_PARAMS } from '../scene/params';
import type { Camera, Scene } from '../scene/types';

export type KeyCam = Omit<Camera, 'widthPx' | 'heightPx'>;
export interface Keyframe { t: number; cam: KeyCam }

/** Frames every top-level item with a 5 % margin. */
export function overviewCamera(s: Scene, widthPx: number, heightPx: number): Camera {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of s.nodes) {
    if (n.parent >= 0) continue;
    const r = Math.max(n.r, (BOX_WORLD_WIDTH / 2) * DEFAULT_PARAMS.factor ** n.k);
    minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
    minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
  }
  const zoom = 0.95 * Math.min(widthPx / (maxX - minX), heightPx / (maxY - minY));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, widthPx, heightPx };
}

/**
 * 40 s: overview, a descent through every group level down to a step-0 node (each level framed when its members'
 * text reaches 8 px), a sideways pan of three screens, then back out to the overview.
 */
export function benchScenario(scene: Scene, widthPx = 1707, heightPx = 1067): Keyframe[] {
  const p = DEFAULT_PARAMS;
  const over = overviewCamera(scene, widthPx, heightPx);
  const overview: KeyCam = { x: over.x, y: over.y, zoom: over.zoom };
  const target = scene.nodes.find((n) => n.k === 0 && n.parent >= 0) ?? scene.nodes[0];
  const chain: number[] = [];
  for (let a = target.parent; a >= 0; a = scene.nodes[a].parent) chain.unshift(a);
  const zoomFor = (memberK: number) => 8 / (p.baseFontPx * p.textScale * p.factor ** memberK);

  const kf: Keyframe[] = [{ t: 0, cam: overview }, { t: 4, cam: overview }];
  const descent = [...chain.map((g) => ({ id: g, zoom: zoomFor(scene.nodes[g].k - p.groupOffsetSteps) })), { id: target.id, zoom: 1.2 }];
  descent.forEach((d, i) => {
    const n = scene.nodes[d.id];
    kf.push({ t: 4 + (16 * (i + 1)) / descent.length, cam: { x: n.x, y: n.y, zoom: Math.max(d.zoom, overview.zoom) } });
  });
  const deep = kf[kf.length - 1].cam;
  kf.push({ t: 28, cam: { ...deep, x: deep.x + (3 * widthPx) / deep.zoom } });
  kf.push({ t: 32, cam: deep });
  kf.push({ t: 40, cam: overview });
  return kf;
}

/** Linear in position, geometric in zoom; clamps outside the keyframes. */
export function cameraAt(kf: Keyframe[], t: number): KeyCam {
  if (t <= kf[0].t) return kf[0].cam;
  for (let i = 1; i < kf.length; i++) {
    if (t <= kf[i].t) {
      const a = kf[i - 1], b = kf[i];
      if (t === b.t) return b.cam;
      const u = (t - a.t) / (b.t - a.t);
      return { x: a.cam.x + (b.cam.x - a.cam.x) * u, y: a.cam.y + (b.cam.y - a.cam.y) * u, zoom: a.cam.zoom ** (1 - u) * b.cam.zoom ** u };
    }
  }
  return kf[kf.length - 1].cam;
}
