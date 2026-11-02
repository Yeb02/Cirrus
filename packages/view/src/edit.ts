import type { Id } from '@cirrus/core';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';

/** Placement changes for moveNodes and movePhantom, gathered by `combine` into one action. */
export interface Moves {
  nodes: { node: Id; x?: number; y?: number; k?: number }[];
  phantoms: { id: Id; x: number; y: number }[];
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
    if (it.kind === 'phantom') out.phantoms.push({ id: it.id, ...at(it.x, it.y) });
    // A group's stored position is not drawn (derived from its members): only its title's step changes.
    else if (it.kind === 'group') out.nodes.push({ node: it.id, ...(own ? { k: it.k + delta } : {}) });
    else out.nodes.push({ node: it.id, ...at(it.x, it.y), ...(own ? { k: it.k + delta } : {}) });
    for (const child of it.children) visit(child, false);
  };
  for (const i of top) visit(i, true);
  // A group member that is not scaled itself has nothing to write.
  out.nodes = out.nodes.filter((m) => m.x !== undefined || m.k !== undefined);
  return out;
}
