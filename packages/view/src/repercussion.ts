import { ancestors, groupOf, type Id, placementKey, type State, type Vec2 } from '@cirrus/core';
import { convexHull, insidePolygon, offsetPolygon } from './geometry/hull.ts';
import type { RenderParams } from './params.ts';
import { buildScene, type Measure, type PlanScene, type SceneItem } from './scene.ts';

/** What « partout » would do to the other plans after a node changed group in one plan (spec 10). */
export interface Repercussion {
  /** Plans where the node changes group: `to` its group there (null: it only leaves); `manual` when its place contradicts it. */
  changed: { plan: Id; to: Id | null; manual: boolean }[];
  /** Plans left alone and reported: the node is in a third group there, unrelated. */
  third: Id[];
  /** Plans left alone and reported: the change would put a group inside itself. */
  loops: Id[];
}

const boxOf = (it: SceneItem): Vec2[] => [
  { x: it.x - it.halfW, y: it.y - it.halfH }, { x: it.x + it.halfW, y: it.y - it.halfH },
  { x: it.x + it.halfW, y: it.y + it.halfH }, { x: it.x - it.halfW, y: it.y + it.halfH },
];
/** The padded envelope a group would have with only these members (scene indices). */
const envelopeOf = (sc: PlanScene, kids: number[], pad: number): Vec2[] => {
  const corners = kids.flatMap((c) => { const k = sc.items[c]; return k.kind === 'group' ? offsetPolygon(k.hull!, k.pad!) : boxOf(k); });
  return offsetPolygon(convexHull(corners), pad);
};

/**
 * The node `node` left `from` and entered `to` in `plan` (either may be null). « Partout » (spec 10) changes only the
 * other plans, documents aside, where it was in `from` or in no group: it joins `to` there, or the lowest group of its
 * new chain of ancestors present there, or with none it only leaves `from`. A plan where it is in a third group is
 * reported and left alone, as is one where the change would make a loop. A plan is to be placed by hand when the node
 * would sit outside the group it joins, or still inside the envelope of the group it leaves.
 */
export function repercussion(s: State, plan: Id, node: Id, from: Id | null, to: Id | null, measure: Measure, p: RenderParams): Repercussion {
  const chain = to === null ? [] : [to, ...ancestors(s, plan, to)];
  const out: Repercussion = { changed: [], third: [], loops: [] };
  for (const q of s.plans.values()) {
    if (q.id === plan || q.type === 'document' || !s.placements.has(placementKey(q.id, node))) continue;
    const current = groupOf(s, q.id, node) ?? null;
    if (current !== null && current !== from) {
      if (current !== to) out.third.push(q.id);
      continue;
    }
    const target = chain.find((g) => s.placements.has(placementKey(q.id, g))) ?? null;
    if (target === current) continue;
    const above = target === null ? [] : ancestors(s, q.id, target);
    if (target === node || above.includes(node)) { out.loops.push(q.id); continue; }
    out.changed.push({ plan: q.id, to: target, manual: misplaced(buildScene(s, q.id, measure, p), node, target, current, above) });
  }
  return out;
}

function misplaced(sc: PlanScene, node: Id, target: Id | null, current: Id | null, aboveTarget: Id[]): boolean {
  const i = sc.byId.get(node);
  if (i === undefined) return false;
  const at = sc.items[i];
  const t = target === null ? undefined : sc.byId.get(target);
  if (t !== undefined) {
    const g = sc.items[t];
    if (!insidePolygon(g.kind === 'group' ? offsetPolygon(g.hull!, g.pad!) : boxOf(g), at.x, at.y)) return true;
  }
  // Moving down into a subgroup of the group left: staying inside its envelope is expected.
  const c = current === null || aboveTarget.includes(current) ? undefined : sc.byId.get(current);
  if (c !== undefined) {
    const others = sc.items[c].children.filter((k) => k !== i);
    if (others.length > 0 && insidePolygon(envelopeOf(sc, others, sc.items[c].pad!), at.x, at.y)) return true;
  }
  return false;
}
