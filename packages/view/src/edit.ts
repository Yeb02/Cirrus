import type { Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import { insidePolygon, offsetPolygon } from './geometry/hull.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';

/** Placement changes for moveNodes and movePhantom, gathered by `combine` into one action. */
export interface Moves {
  nodes: { node: Id; x?: number; y?: number; k?: number }[];
  phantoms: { id: Id; x: number; y: number; k?: number }[];
}

/**
 * One scale step up or down (spec 8.1). A simple node changes its step; a group changes its title's step and dilates
 * its members around its centre, recursively, their own steps unchanged; several items scale as one around their
 * barycentre (spec 8.1, « Sélection »). Nothing else moves. An item whose ancestor is selected goes with it.
 */
export function scaleMoves(scene: PlanScene, items: number[], delta: number, p: RenderParams): Moves {
  const selected = new Set(items);
  const top = [...selected].filter((i) => {
    for (let a = scene.items[i].parent; a >= 0; a = scene.items[a].parent) if (selected.has(a)) return false;
    return true;
  });
  const out: Moves = { nodes: [], phantoms: [] };
  if (top.length === 0) return out;
  const f = p.factor ** delta;
  const c = { x: top.reduce((s, i) => s + scene.items[i].x, 0) / top.length, y: top.reduce((s, i) => s + scene.items[i].y, 0) / top.length };
  const at = (x: number, y: number) => ({ x: c.x + (x - c.x) * f, y: c.y + (y - c.y) * f });
  const visit = (i: number, own: boolean) => {
    const it = scene.items[i];
    if (it.kind === 'phantom') out.phantoms.push({ id: it.id, ...at(it.x, it.y), ...(own ? { k: it.k + delta } : {}) });
    // A group is drawn where its members are; its own position follows, for the day it is emptied (I2 of the review).
    else out.nodes.push({ node: it.id, ...at(it.x, it.y), ...(own ? { k: it.k + delta } : {}) });
    for (const child of it.children) visit(child, false);
  };
  for (const i of top) visit(i, true);
  return out;
}

/** Not inside a group more than half folded at this zoom: what can be dropped onto. */
const reachable = (scene: PlanScene, i: number, zoom: number, p: RenderParams) => {
  for (let a = scene.items[i].parent; a >= 0; a = scene.items[a].parent) if (foldT(scene.items[a].maxChildK!, zoom, p) >= p.foldClickable) return false;
  return true;
};

/**
 * Where dropped items would enter (spec 10): the deepest group under the point (its padded envelope), or a simple
 * node whose box is under it (it becomes a group). Never a dragged item nor one of its descendants.
 */
export function dropTarget(scene: PlanScene, at: Vec2, dragged: number[], zoom: number, p: RenderParams): number | null {
  const excluded = new Set<number>();
  const mark = (i: number) => { excluded.add(i); for (const c of scene.items[i].children) mark(c); };
  for (const i of dragged) mark(i);
  let best = -1, bestDepth = -1, bestIsBox = false;
  scene.items.forEach((it, i) => {
    if (excluded.has(i) || it.kind === 'phantom' || !reachable(scene, i, zoom, p)) return;
    const isBox = it.kind === 'node';
    const under = isBox
      ? Math.abs(at.x - it.x) <= it.halfW && Math.abs(at.y - it.y) <= it.halfH
      : insidePolygon(offsetPolygon(it.hull!, it.pad!), at.x, at.y);
    if (!under) return;
    if (it.depth > bestDepth || (it.depth === bestDepth && isBox && !bestIsBox)) { best = i; bestDepth = it.depth; bestIsBox = isBox; }
  });
  return best >= 0 ? best : null;
}

/**
 * Items an envelope covers without being its members (spec 10, « intrus »): each with the deepest such group. They
 * are never pushed away; they get a sign and appear in the graph's health.
 */
export function intruders(scene: PlanScene): Map<number, number> {
  const out = new Map<number, number>();
  const items = scene.items;
  if (items.length === 0) return out;
  const isDescendant = (i: number, g: number) => { for (let a = items[i].parent; a >= 0; a = items[a].parent) if (a === g) return true; return false; };
  // Centres indexed once: each envelope only looks at the items under its bounding box (C1 of the plan 3b review).
  const centres = new Flatbush(items.length);
  for (const it of items) centres.add(it.x, it.y, it.x, it.y);
  centres.finish();
  items.forEach((g, gi) => {
    if (g.kind !== 'group') return;
    const poly = offsetPolygon(g.hull!, g.pad!);
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    for (const i of centres.search(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
      const it = items[i];
      if (i === gi || isDescendant(i, gi) || isDescendant(gi, i) || !insidePolygon(poly, it.x, it.y)) continue;
      const known = out.get(i);
      if (known === undefined || items[known].depth < g.depth) out.set(i, gi);
    }
  });
  return out;
}

export interface DropEffect { item: number; leave: boolean; enter: number | null }

/**
 * What a drop does to each moved item's group (spec 10): a free item enters the group it is dropped in; a member only
 * goes down into a subgroup of its group (else it just moves: changing groups goes through « exclure »); with Alt it
 * leaves its group, and enters the one under the cursor if that is another one; put back in its own group, it moves.
 */
export function dropEffects(scene: PlanScene, items: number[], target: number | null, alt: boolean): DropEffect[] {
  const below = (t: number, g: number) => { for (let a = scene.items[t].parent; a >= 0; a = scene.items[a].parent) if (a === g) return true; return false; };
  return items.map((item) => {
    const g = scene.items[item].parent;
    // Put back in its own group, even with Alt or after « exclure »: it only moves (spec 10).
    if (alt) return target !== null && target === g ? { item, leave: false, enter: null } : { item, leave: g >= 0, enter: target };
    if (target === null || target === g) return { item, leave: false, enter: null };
    return { item, leave: false, enter: g < 0 || below(target, g) ? target : null };
  });
}
