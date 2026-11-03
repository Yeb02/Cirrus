import type { Id, Vec2 } from '@cirrus/core';
import Flatbush from 'flatbush';
import { insidePolygon, offsetPolygon } from './geometry/hull.ts';
import { foldT } from './lod.ts';
import type { RenderParams } from './params.ts';
import { isLive, type PlanScene } from './scene.ts';
import type { VisibleSet } from './visibility.ts';

/** Placement changes for moveNodes and movePhantom, gathered by `combine` into one action. */
export interface Moves {
  nodes: { node: Id; x?: number; y?: number; k?: number }[];
  phantoms: { id: Id; x: number; y: number; k?: number }[];
  /** The dilation: around `center`, by `factor` (what moves with it, a connection's layout, follows). */
  center: Vec2;
  factor: number;
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
  if (top.length === 0) return { nodes: [], phantoms: [], center: { x: 0, y: 0 }, factor: 1 };
  const f = p.factor ** delta;
  const c = { x: top.reduce((s, i) => s + scene.items[i].x, 0) / top.length, y: top.reduce((s, i) => s + scene.items[i].y, 0) / top.length };
  const out: Moves = { nodes: [], phantoms: [], center: c, factor: f };
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
    if (excluded.has(i) || !isLive(scene, i) || it.kind === 'phantom' || !reachable(scene, i, zoom, p)) return;
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
  const live = items.flatMap((_it, i) => (isLive(scene, i) ? [i] : []));
  if (live.length === 0) return out;
  const isDescendant = (i: number, g: number) => { for (let a = items[i].parent; a >= 0; a = items[a].parent) if (a === g) return true; return false; };
  // Centres indexed once: each envelope only looks at the items under its bounding box (C1 of the plan 3b review).
  const centres = new Flatbush(live.length);
  for (const i of live) centres.add(items[i].x, items[i].y, items[i].x, items[i].y);
  centres.finish();
  live.forEach((gi) => {
    const g = items[gi];
    if (g.kind !== 'group') return;
    const poly = offsetPolygon(g.hull!, g.pad!);
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    for (const j of centres.search(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
      const i = live[j], it = items[i];
      if (i === gi || isDescendant(i, gi) || isDescendant(gi, i) || !insidePolygon(poly, it.x, it.y)) continue;
      const known = out.get(i);
      if (known === undefined || items[known].depth < g.depth) out.set(i, gi);
    }
  });
  return out;
}

/**
 * The intruders among what is drawn (spec 10, plan 3c task 6): each item drawn — box, phantom or envelope — whose centre
 * a drawn envelope covers without it being one of its members, with the deepest such group (the first by slot among
 * equals, as `intruders`). What the ring and the tooltip show, at the cost of the visible set: the drawn centres
 * indexed once, each drawn envelope searched by its box; its polygon is only made for a centre that is not its own.
 */
export function visibleIntruders(scene: PlanScene, visible: VisibleSet): Map<number, number> {
  const out = new Map<number, number>();
  if (visible.groups.length === 0) return out;
  const items = scene.items, drawn = visible.items.length === 0 ? visible.groups : [...visible.items, ...visible.groups];
  const centres = new Flatbush(drawn.length);
  for (const i of drawn) centres.add(items[i].x, items[i].y, items[i].x, items[i].y);
  centres.finish();
  const below = (i: number, g: number) => { for (let a = items[i].parent; a >= 0; a = items[a].parent) if (a === g) return true; return false; };
  for (const gi of visible.groups) {
    const g = items[gi], hull = g.hull!, pad = g.pad!;
    // The envelope's box: its hull's, widened by the padding (a hull of fewer than three points is made a polygon first).
    let poly = hull.length < 3 ? offsetPolygon(hull, pad) : null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of poly ?? hull) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const d = poly ? 0 : pad;
    for (const j of centres.search(x0 - d, y0 - d, x1 + d, y1 + d)) {
      const i = drawn[j];
      if (i === gi || below(i, gi) || below(gi, i)) continue;
      poly ??= offsetPolygon(hull, pad);
      if (!insidePolygon(poly, items[i].x, items[i].y)) continue;
      const known = out.get(i);
      if (known === undefined || items[known].depth < g.depth || (items[known].depth === g.depth && gi < known)) out.set(i, gi);
    }
  }
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
