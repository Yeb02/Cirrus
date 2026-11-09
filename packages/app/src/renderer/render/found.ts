import type { Id } from '@cirrus/core';
import { type Bounds, partEnds, partOf, type PlanScene } from '@cirrus/view';

/**
 * The items the ring of what was found circles in this scene, for these objects (plan 6a, D1, D2): a node or a phantom
 * by its item; a connection by the items its parts end at — its members drawn here, its phantoms — and a far part's
 * centre. What the scene does not show is left out; each item once.
 */
export function foundItems(scene: PlanScene, ids: readonly Id[]): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    const i = scene.byId.get(id);
    if (i !== undefined) { out.add(i); continue; }
    for (const part of partOf(scene, id)) {
      for (const e of partEnds(scene, part)) out.add(e.item);
      if (scene.center[part] >= 0) out.add(scene.center[part]);
    }
  }
  return [...out];
}

/** The world box around these items' boxes (a group's title box), null for none. */
export function itemsBounds(scene: PlanScene, items: readonly number[]): Bounds | null {
  if (items.length === 0) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const i of items) {
    const it = scene.items[i];
    b.minX = Math.min(b.minX, it.x - it.halfW);
    b.maxX = Math.max(b.maxX, it.x + it.halfW);
    b.minY = Math.min(b.minY, it.y - it.halfH);
    b.maxY = Math.max(b.maxY, it.y + it.halfH);
  }
  return b;
}
