import {
  type Action, ancestors, branchKey, groupIndex, type Id, include, placeNode, placementKey, setBranches, type State, type Vec2,
} from '@cirrus/core';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';

/** What Ctrl+C keeps (spec 7): the nodes with their place in the plan of origin, and the connections that follow. */
export interface Clip {
  plan: Id;
  zoom: number;
  /** The selection's barycentre: it lands under the cursor. */
  center: Vec2;
  /** parents: the node's groups in the plan of origin, nearest first. */
  nodes: { id: Id; x: number; y: number; k: number; parents: Id[] }[];
  /** Connections with at least two nodes copied, with every member they show in the plan of origin. */
  connections: { id: Id; nodes: Id[] }[];
}

/**
 * Copies these items (scene indices), groups with all they contain (spec 7, 9.3); phantoms stay behind, being the
 * plan's own layout. Null when there is no node to copy.
 */
export function copyClip(s: State, scene: PlanScene, items: number[], zoom: number): Clip | null {
  const plan = scene.plan.id;
  const ids = new Set<Id>();
  const take = (i: number) => {
    const it = scene.items[i];
    if (it.kind === 'phantom') return;
    ids.add(it.id);
    for (const c of it.children) take(c);
  };
  for (const i of items) take(i);
  if (ids.size === 0) return null;
  const top = items.filter((i) => scene.items[i].kind !== 'phantom');
  const center = { x: top.reduce((a, i) => a + scene.items[i].x, 0) / top.length, y: top.reduce((a, i) => a + scene.items[i].y, 0) / top.length };
  const index = groupIndex(s);
  const nodes = [...ids].map((id) => {
    const pl = s.placements.get(placementKey(plan, id))!;
    return { id, x: pl.x, y: pl.y, k: pl.k, parents: ancestors(s, plan, id, index) };
  });
  const connections: Clip['connections'] = [];
  for (const c of s.connections.values()) {
    if (c.kind !== 'knowledge' || c.trashedAt !== undefined) continue;
    const shown = c.members.map((m) => m.node).filter((n) => s.branches.has(branchKey({ plan, connection: c.id, node: n })));
    if (shown.filter((n) => ids.has(n)).length >= 2) connections.push({ id: c.id, nodes: shown });
  }
  return { plan, zoom, center, nodes, connections };
}

/**
 * Pasting a clip at `at` (spec 7), as the steps of one action. Every pasted node moves by the same Δk = round of
 * log_f(zoom at copy ÷ zoom at paste) and distances by f^Δk. Nodes already in the plan keep their place and group
 * (`present`). A pasted node joins its nearest group of origin present here; with none, the group `dropGroup` under the
 * point, if any (spec 10). The connections follow, their other branches becoming stubs; not into a document plan.
 */
export function pasteSteps(
  s: State, clip: Clip, plan: Id, at: Vec2, zoom: number, dropGroup: Id | null, p: RenderParams,
): { steps: ((s: State) => Action)[]; present: Id[]; placed: Id[] } {
  const dk = Math.round(Math.log(clip.zoom / zoom) / Math.log(p.factor));
  const scale = p.factor ** dk;
  const present = clip.nodes.filter((n) => s.placements.has(placementKey(plan, n.id))).map((n) => n.id);
  const fresh = clip.nodes.filter((n) => !present.includes(n.id) && s.nodes.has(n.id) && s.nodes.get(n.id)!.trashedAt === undefined);
  const here = new Set([...present, ...fresh.map((n) => n.id)]);
  const steps: ((s: State) => Action)[] = fresh.map((n) => (x: State) =>
    placeNode(x, plan, n.id, at.x + (n.x - clip.center.x) * scale, at.y + (n.y - clip.center.y) * scale, n.k + dk));
  for (const n of fresh) {
    const group = n.parents.find((g) => here.has(g)) ?? dropGroup;
    if (group !== null) steps.push((x) => include(x, plan, n.id, group));
  }
  if (s.plans.get(plan)?.type !== 'document') {
    for (const c of clip.connections) {
      const conn = s.connections.get(c.id);
      if (!conn || conn.trashedAt !== undefined) continue;
      const nodes = c.nodes.filter((n) => conn.members.some((m) => m.node === n));
      steps.push((x) => setBranches(x, c.id, nodes.map((node) => ({ plan, node })), true));
    }
  }
  return { steps, present, placed: fresh.map((n) => n.id) };
}

/** Before a deletion (spec 7): how many placements the nodes have in all, and those whose plan is the last one. */
export function deleteSummary(s: State, ids: Id[]): { instances: number; last: Id[] } {
  const count = new Map<Id, number>(ids.map((id) => [id, 0]));
  for (const pl of s.placements.values()) if (count.has(pl.node)) count.set(pl.node, count.get(pl.node)! + 1);
  return { instances: [...count.values()].reduce((a, b) => a + b, 0), last: ids.filter((id) => count.get(id)! <= 1) };
}
