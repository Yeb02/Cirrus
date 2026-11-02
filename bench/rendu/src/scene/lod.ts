import type { RenderParams } from './params';
import type { Scene } from './types';

/** On-screen text size of an element at scale step k (spec 8.1). */
export function textPx(k: number, zoom: number, p: RenderParams): number {
  return p.baseFontPx * p.textScale * p.factor ** k * zoom;
}

/** A group opens when the text of its largest member reaches groupFold[0] (spec 8.2). */
export function isGroupOpen(scene: Scene, g: number, zoom: number, p: RenderParams): boolean {
  const kids = scene.children[g];
  if (kids.length === 0) return false;
  let maxK = -Infinity;
  for (const c of kids) maxK = Math.max(maxK, scene.nodes[c].k);
  return textPx(maxK, zoom, p) >= p.groupFold[0];
}
