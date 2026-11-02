import {
  type Action, combine, createNode, editNode, exclude, type Id, include, moveNodes, movePhantom, removeFromPlan, type State, type Vec2,
} from '@cirrus/core';
import { dropEffects, dropTarget, type PlanScene, type RenderParams, scaleMoves } from '@cirrus/view';

/** An edit to run through the session: a pure command over the state, or null when there is nothing to do. */
export type Build = ((s: State) => Action) | null;

/**
 * Moving items by (dx, dy) and dropping them at `at` (spec 10): one action for the moves, then the groups left and
 * entered (with Alt, leaving the group); a simple node receiving its first members becomes a group, groupOffsetSteps
 * above its largest member (spec 8.1).
 */
export function dropBuild(base: PlanScene, items: number[], dx: number, dy: number, at: Vec2, alt: boolean, zoom: number, p: RenderParams): Build {
  const target = dropTarget(base, at, items, zoom, p);
  const effects = dropEffects(base, items, target, alt);
  if (dx === 0 && dy === 0 && effects.every((f) => !f.leave && f.enter === null)) return null;
  const effectOf = new Map(effects.map((f) => [f.item, f]));
  const nodes: { node: Id; x: number; y: number }[] = [], phantoms: { id: Id; x: number; y: number; group?: Id | null }[] = [];
  const memberships: ((s: State) => Action)[] = [];
  const plan = base.plan.id, targetId = target === null ? null : base.items[target].id;
  const collect = (i: number) => {
    const it = base.items[i], f = effectOf.get(i);
    const group = f?.enter != null ? targetId : f?.leave ? null : undefined;
    if (it.kind === 'phantom') phantoms.push({ id: it.id, x: it.x + dx, y: it.y + dy, ...(group !== undefined ? { group } : {}) });
    else {
      if (it.kind === 'node') nodes.push({ node: it.id, x: it.x + dx, y: it.y + dy });
      if (f?.enter != null) memberships.push((x) => include(x, plan, it.id, targetId!));
      else if (f?.leave) memberships.push((x) => exclude(x, plan, it.id));
    }
    for (const c of it.children) collect(c);
  };
  for (const i of items) collect(i);
  const entering = effects.filter((f) => f.enter !== null).map((f) => base.items[f.item].k);
  if (target !== null && base.items[target].kind === 'node' && entering.length > 0) {
    const k = Math.max(...entering) + p.groupOffsetSteps;
    if (base.items[target].k < k) memberships.push((x) => moveNodes(x, plan, [{ node: targetId!, k }]));
  }
  const count = nodes.length + phantoms.length;
  const label = targetId !== null && effects.some((f) => f.enter !== null) ? `Mettre dans « ${base.items[target!].title} »`
    : effects.some((f) => f.leave) ? 'Sortir du groupe' : count === 1 ? 'Déplacer un élément' : `Déplacer ${count} éléments`;
  return (st) => combine(st, label, [
    ...(nodes.length > 0 ? [(x: State) => moveNodes(x, plan, nodes)] : []),
    ...phantoms.map((ph) => (x: State) => movePhantom(x, ph.id, ph.x, ph.y, ph.group)),
    ...memberships,
  ]);
}

/** One scale step up or down for these items (spec 8.1): steps, and positions of the groups' contents. */
export function scaleBuild(scene: PlanScene, items: number[], delta: number, p: RenderParams): Build {
  const m = scaleMoves(scene, items, delta, p);
  if (m.nodes.length === 0 && m.phantoms.length === 0) return null;
  const plan = scene.plan.id;
  return (st) => combine(st, delta > 0 ? 'Agrandir d’un cran' : 'Réduire d’un cran', [
    ...(m.nodes.length > 0 ? [(x: State) => moveNodes(x, plan, m.nodes)] : []),
    ...m.phantoms.map((ph) => (x: State) => movePhantom(x, ph.id, ph.x, ph.y)),
  ]);
}

/** « Cacher » (spec 7): out of this plan only; a node leaving its last plan goes to the trash. */
export function hideBuild(scene: PlanScene, ids: Id[]): Build {
  const nodes = ids.filter((id) => { const i = scene.byId.get(id); return i !== undefined && scene.items[i].kind !== 'phantom'; });
  if (nodes.length === 0) return null;
  const plan = scene.plan.id;
  return (st) => combine(st, nodes.length === 1 ? 'Cacher dans ce plan' : `Cacher ${nodes.length} éléments dans ce plan`, nodes.map((n) => (x: State) => removeFromPlan(x, plan, n)));
}

/**
 * A new node placed at `at` (spec 12), at the step whose text reads at the base size at this zoom; dropped inside an
 * envelope, it enters that group like any free node (spec 10).
 */
export function createBuild(scene: PlanScene, title: string, at: Vec2, zoom: number, p: RenderParams): Build {
  const name = title.trim();
  if (!name) return null;
  const k = Math.round(Math.log(1 / (zoom * p.textScale)) / Math.log(p.factor));
  const target = dropTarget(scene, at, [], zoom, p);
  const plan = scene.plan.id;
  return (st) => {
    let id = '';
    return combine(st, `Créer « ${name} »`, [
      (x) => { const a = createNode(x, { plan, title: name, x: at.x, y: at.y, k }); id = (a.ops[0] as { after: { id: Id } }).after.id; return a; },
      ...(target !== null && scene.items[target].kind === 'group' ? [(x: State) => include(x, plan, id, scene.items[target].id)] : []),
    ]);
  };
}

export function renameBuild(id: Id, title: string): Build {
  const name = title.trim();
  return name ? (st) => editNode(st, id, { title: name }) : null;
}
