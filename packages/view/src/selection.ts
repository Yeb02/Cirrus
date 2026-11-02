import type { Id, Vec2 } from '@cirrus/core';
import type { Bounds } from './camera.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';

/** A temporary group without a title (spec 9.2): items (nodes, groups, phantoms) and connections, by id. */
export interface Selection { items: Set<Id>; connections: Set<Id> }

export const emptySelection = (): Selection => ({ items: new Set(), connections: new Set() });

/** Ctrl+click: adds, or removes what is already selected (spec 9.1). */
export function toggle(sel: Selection, target: { kind: 'item' | 'connection'; id: Id }): Selection {
  const items = new Set(sel.items), connections = new Set(sel.connections);
  const set = target.kind === 'item' ? items : connections;
  if (set.has(target.id)) set.delete(target.id);
  else set.add(target.id);
  return { items, connections };
}

/**
 * What a selection rectangle takes (spec 9.3): an element whose centre is inside; a closed group (its members no
 * longer clickable) whole or not at all; an open group if and only if all its members are taken, at any scale.
 */
export function inRectangle(scene: PlanScene, rect: Bounds, zoom: number, p: RenderParams): Id[] {
  const out: Id[] = [];
  const inside = (i: number) => {
    const it = scene.items[i];
    return it.x >= rect.minX && it.x <= rect.maxX && it.y >= rect.minY && it.y <= rect.maxY;
  };
  const visit = (i: number): boolean => {
    const it = scene.items[i];
    if (it.kind !== 'group' || foldT(it.maxChildK!, zoom, p) >= p.foldClickable) {
      const taken = inside(i);
      if (taken) out.push(it.id);
      return taken;
    }
    let all = true;
    for (const c of it.children) if (!visit(c)) all = false;
    if (all) out.push(it.id);
    return all;
  };
  for (const r of scene.roots) visit(r);
  return out;
}

/** The selection's pivot: the barycentre of its items in this plan (spec 9.2). */
export function selectionCenter(scene: PlanScene, sel: Selection): Vec2 | null {
  const pts = [...sel.items].flatMap((id) => {
    const i = scene.byId.get(id);
    return i === undefined ? [] : [scene.items[i]];
  });
  if (pts.length === 0) return null;
  return { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
}
