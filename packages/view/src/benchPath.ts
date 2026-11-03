import { type Camera, fitBounds } from './camera.ts';
import type { RenderParams } from './params.ts';
import { isLive, type PlanScene } from './scene.ts';

/** A key of the bench's camera path: at `t` seconds, this centre and zoom (the screen's size comes from the window). */
export interface PathKey { t: number; cam: Omit<Camera, 'widthPx' | 'heightPx'> }

/**
 * The camera path of the plan 1 bench, which the app's bench drives (spec 21) and the view's timed tests follow: the
 * overview, a descent through every group level above the first of the deepest leaves, a sideways pan, back out.
 * `deep`: its deepest camera (null for a plan without nodes: the overview only, five seconds).
 */
export function benchPath(scene: PlanScene, w: number, h: number, p: RenderParams): { keys: PathKey[]; deep: PathKey['cam'] | null } {
  const over = fitBounds(scene.bounds, w, h, p);
  const overview = { x: over.x, y: over.y, zoom: over.zoom };
  let target = -1;
  scene.items.forEach((it, i) => { if (isLive(scene, i) && it.kind !== 'group' && (target < 0 || it.depth > scene.items[target].depth)) target = i; });
  if (target < 0) return { keys: [{ t: 0, cam: overview }, { t: 5, cam: overview }], deep: null };
  const chain: number[] = [];
  for (let a = scene.items[target].parent; a >= 0; a = scene.items[a].parent) chain.unshift(a);
  const zoomFor = (memberK: number) => 8 / (p.baseFontPx * p.textScale * p.factor ** memberK);
  const keys: PathKey[] = [{ t: 0, cam: overview }, { t: 4, cam: overview }];
  const descent = [...chain.map((g) => ({ i: g, zoom: zoomFor(scene.items[g].maxChildK!) })), { i: target, zoom: 1.2 }];
  descent.forEach((d, j) => {
    const it = scene.items[d.i];
    keys.push({ t: 4 + (16 * (j + 1)) / descent.length, cam: { x: it.x, y: it.y, zoom: Math.max(d.zoom, overview.zoom) } });
  });
  const deep = keys[keys.length - 1].cam;
  keys.push({ t: 28, cam: { ...deep, x: deep.x + (3 * w) / deep.zoom } }, { t: 32, cam: deep }, { t: 40, cam: overview });
  return { keys, deep };
}

/** The path's camera at `t` seconds: centres interpolated linearly, zooms geometrically. */
export function cameraAt(keys: PathKey[], t: number): PathKey['cam'] {
  if (t <= keys[0].t) return keys[0].cam;
  for (let i = 1; i < keys.length; i++) {
    if (t > keys[i].t) continue;
    const a = keys[i - 1], b = keys[i], u = (t - a.t) / (b.t - a.t);
    return { x: a.cam.x + (b.cam.x - a.cam.x) * u, y: a.cam.y + (b.cam.y - a.cam.y) * u, zoom: a.cam.zoom ** (1 - u) * b.cam.zoom ** u };
  }
  return keys[keys.length - 1].cam;
}
