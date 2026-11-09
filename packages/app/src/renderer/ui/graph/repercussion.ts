import type { Id, Vec2 } from '@cirrus/core';
import { dropScenes, dropTarget, type PlanScene, repercussion, sceneParamsKey } from '@cirrus/view';
import { useRef } from 'react';
import { type Build, dropBuild, dropMemberships, withRepercussion } from '../../actions.ts';
import type { Graph } from './core.ts';

/**
 * A change of group repercussed in the other plans (spec 10): « partout ou ici seulement » asked, with its cost, when
 * other plans would change; then the plans to place by hand, opened one after the other.
 */
export function useRepercussion(graph: Graph) {
  const { root, engine, sceneRef, paramsRef, stateRef, sessionRef, onOpenPlan, notify, edit, indexOf } = graph;
  /** The plans a repercussion still has to place by hand, one after the other (spec 10), then the plan to come back to. */
  const repQueue = useRef<{ extend: Id; home: Id; items: { plan: Id; node: Id; to: Id | null }[]; expected: Id } | null>(null);
  /** Whether plans are still to be placed by hand. */
  const queued = () => repQueue.current !== null;
  /**
   * A drop that changes groups (spec 10): « partout ou ici seulement » when other plans would change, with its cost
   * announced; « partout » writes the drop and the plans needing no hand, then opens the others one after the other.
   */
  const dropAsking = (base: PlanScene, items: number[], dx: number, dy: number, at: Vec2, alt: boolean, restore: () => void) => {
    const p = paramsRef.current, zoom = engine.current?.renderer.camera.zoom ?? 1;
    // Where the drop enters, found once for the action and the question (I2 of the final review).
    const target = dropTarget(base, at, items, zoom, p, indexOf(base));
    const build = dropBuild(base, items, dx, dy, target, alt, p);
    if (!build) { restore(); return; }
    askRepercussion(base.plan.id, dropMemberships(stateRef.current, base, items, target, alt), build, restore);
  };
  /**
   * The drop `build` in `plan`, whose nodes change group (`moves`), written (spec 10): at once when no other plan would
   * change; else after the « partout ou ici seulement » question, its cost announced — « partout » writes the drop and
   * the plans needing no hand, then opens the others one after the other. `restore`: what a refusal or no answer undoes.
   */
  const askRepercussion = (plan: Id, moves: { node: Id; from: Id | null; to: Id | null }[], build: Build, restore: () => void) => {
    const p = paramsRef.current, s = stateRef.current;
    // The other plans' scenes, for the whole drop: the cached ones when they are at the state's revision, else built
    // once, measured as the cached ones, with their measure's titles already laid out (I1 of the final review).
    const cache = graph.scenes.cache.current, key = sceneParamsKey(p), current = cache.key === key && cache.rev === sessionRef.current?.rev;
    const measure = graph.scenes.measureOf(p);
    const sceneOf = dropScenes(s, measure, p, (q) => (current ? cache.byPlan.get(q)?.scene : undefined));
    const reps = moves.map((m) => ({ ...m, r: repercussion(s, plan, m.node, m.from, m.to, sceneOf) }));
    const changed = reps.flatMap((x) => x.r.changed.map((c) => ({ ...c, node: x.node })));
    if (changed.length === 0) { void edit(build, restore); return; }
    const names = (ids: Id[]) => [...new Set(ids)].map((id) => `« ${s.plans.get(id)?.name ?? '?'} »`).join(', ');
    const plans = new Set(changed.map((c) => c.plan)), manual = changed.filter((c) => c.manual);
    const third = reps.flatMap((x) => x.r.third), loops = reps.flatMap((x) => x.r.loops);
    const n = plans.size, m = new Set(manual.map((c) => c.plan)).size;
    const detail = [
      `Partout : ${n} plan${n > 1 ? 's' : ''}${m > 0 ? `, dont ${m} à placer à la main` : ''} (${names([...plans])}).`,
      third.length > 0 ? `Laissé${third.length > 1 ? 's' : ''} tel${third.length > 1 ? 's' : ''} quel${third.length > 1 ? 's' : ''}, un autre groupe y contient le nœud : ${names(third)}.` : '',
      loops.length > 0 ? `Ignoré${loops.length > 1 ? 's' : ''}, la répercussion y ferait une boucle : ${names(loops)}.` : '',
    ].filter(Boolean).join(' ');
    const here = { value: 'here', label: 'Ici seulement' }, all = { value: 'everywhere', label: 'Partout' };
    graph.questions.setQuestion({
      text: 'Répercuter ce changement de groupe dans les autres plans ?', detail,
      choices: p.defaultAnswer === 'everywhere' ? [all, here] : [here, all],
      answer: (v) => {
        if (v === null) { restore(); return; }
        if (v === 'here') { void edit(build, restore); return; }
        void edit(withRepercussion(build, changed.filter((c) => !c.manual)), restore).then((r) => {
          if (r?.ok && manual.length > 0) {
            repQueue.current = { extend: r.action.id, home: plan, items: manual.map((c) => ({ plan: c.plan, node: c.node, to: c.to })), expected: plan };
            nextRepercussion();
          }
        });
      },
    });
  };
  /** The next plan to place by hand (spec 10): opened, framed on the group joined, the node at the cursor; at the end, back home. */
  const nextRepercussion = () => {
    const q = repQueue.current;
    if (!q) return;
    const item = q.items.shift();
    if (!item) {
      repQueue.current = null;
      if (sceneRef.current?.plan.id !== q.home) onOpenPlan(q.home);
      return;
    }
    q.expected = item.plan;
    const s = stateRef.current, title = s.nodes.get(item.node)?.title ?? '?';
    const r = root.current?.getBoundingClientRect();
    graph.placement.pendingPlace.current = {
      plan: item.plan, what: { kind: 'repercussion', node: item.node, to: item.to, extend: q.extend },
      text: item.to ? `${title} → « ${s.nodes.get(item.to)?.title ?? '?'} »` : `${title} → hors du groupe`,
      at: { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 }, frame: item.to ?? item.node,
    };
    if (sceneRef.current?.plan.id === item.plan) graph.placement.startPending(); else onOpenPlan(item.plan);
  };
  /** Another plan shown: unless it is the one expected, the repercussion stops there (I8 of the review). */
  const planShown = (plan: Id) => {
    const q = repQueue.current;
    if (q && plan !== q.expected) {
      // The user went elsewhere: the repercussion stops there (I8 of the review); what was placed stays.
      repQueue.current = null;
      const left = q.items.length + (graph.placement.placing.current?.kind === 'repercussion' ? 1 : 0);
      notify(`Répercussion interrompue : ${left} plan${left > 1 ? 's' : ''} non placé${left > 1 ? 's' : ''} à la main.`);
    }
  };
  return { queued, dropAsking, askRepercussion, nextRepercussion, planShown };
}

export type RepercussionPart = ReturnType<typeof useRepercussion>;
