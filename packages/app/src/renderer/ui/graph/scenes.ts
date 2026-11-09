import type { Action, Id, State } from '@cirrus/core';
import {
  buildScene, type Measure, measureLines, mergeChanges, type PlanScene, type RenderParams, type SceneChanges, type SceneIndex, sceneParamsKey, updateIndex,
  updateScene,
} from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { mark } from '../../bench.ts';
import type { PlanRenderer } from '../../render/PlanRenderer.ts';
import type { Graph } from './core.ts';

/**
 * The scene of the plan shown (`scene`), made from the state once the engine is `ready`, among those of the last tabs
 * shown, which each action updates (plan 3c, tasks 5 and 6); `showScene` gives it to the renderer.
 */
export function useScenes(graph: Graph, props: { state: State; rev: number; action: Action | null; plan: Id; params: RenderParams }, ready: boolean) {
  const { engine, sceneRef, paramsRef } = graph;
  const [scene, setScene] = useState<PlanScene | null>(null);
  /**
   * The scenes of the last tabs shown (cachedPlans, the current one last), all at revision `rev` of the state: each
   * action updates them by its operations (plan 3c, task 5), so that going back to one of these tabs is immediate.
   * `key`: the parameters they were made with (sceneParamsKey), and their measure of titles. Each keeps its visibility
   * index too (plan 3c, task 6), kept up to date with it — except the scene the renderer holds, whose index is the
   * renderer's (null here) until another tab is shown.
   */
  const scenes = useRef<{ rev: number; key: string; measure: Measure | null; byPlan: Map<Id, { scene: PlanScene; index: SceneIndex | null }> }>({
    rev: 0, key: '', measure: null, byPlan: new Map(),
  });
  /**
   * The renderer's scene once updated by the actions since it was given (`prev`, `scene`) and their changes, merged: the
   * effect that shows the scene gives them to the renderer, which updates its index instead of building it again.
   */
  const sceneChanges = useRef<{ prev: PlanScene; scene: PlanScene; changes: SceneChanges } | null>(null);
  /**
   * Gives the renderer the scene to show (plan 3c, task 6): when it follows the renderer's own by the changes gathered
   * since (sceneChanges), those changes, so that its index is updated rather than built; else the scene with the index
   * its tab kept, if any — the index of the scene the renderer leaves going back to its tab's entry.
   */
  const showScene = (r: PlanRenderer, scene: PlanScene) => {
    const gathered = sceneChanges.current;
    sceneChanges.current = null;
    if (gathered && r.held && gathered.prev === r.held.scene) r.updateScene(gathered.scene, gathered.changes);
    const held = r.held;
    if (held?.scene === scene) return;
    const byPlan = scenes.current.byPlan;
    const own = held ? byPlan.get(held.scene.plan.id) : undefined;
    if (held && own?.scene === held.scene) own.index = held.index;
    const entry = byPlan.get(scene.plan.id), kept = entry?.scene === scene ? entry.index : null;
    r.setScene(scene, false, kept ?? undefined);
    if (entry && entry.scene === scene) entry.index = null;
  };
  /** The measure of titles for `p`: the scenes', when they were made with these parameters, else one made now. */
  const measureOf = (p: RenderParams): Measure => (scenes.current.measure && scenes.current.key === sceneParamsKey(p)
    ? scenes.current.measure : measureLines(engine.current!.font, p));

  // The scene depends on the state (its revision), the plan and the few parameters it reads (box sizes): a colour or a
  // threshold changed in the settings panel does not rebuild it. The measure needs the font loaded.
  const sceneKey = sceneParamsKey(props.params);
  useEffect(() => {
    if (!ready) return;
    const p = paramsRef.current, cache = scenes.current, s = props.state;
    if (cache.key !== sceneKey) { cache.byPlan.clear(); cache.key = sceneKey; cache.measure = measureLines(engine.current!.font, p); sceneChanges.current = null; }
    const measure = cache.measure!;
    if (props.rev !== cache.rev) {
      // One action since the scenes were made: its operations update every one (Review Focus 2). React may have
      // gathered several actions into this render, of which only the last is known: the scenes are made anew then.
      const ops = props.rev === cache.rev + 1 ? props.action?.ops : undefined;
      // The renderer's scene, or the one it will be given with the changes gathered so far.
      const held = sceneChanges.current?.scene ?? sceneRef.current;
      for (const [plan, entry] of [...cache.byPlan]) {
        if (!ops || !s.plans.has(plan)) { cache.byPlan.delete(plan); continue; }
        const { scene: next, changes } = updateScene(entry.scene, s, ops, measure, p);
        if (next === entry.scene) continue;
        if (entry.scene === held) {
          // Its index is the renderer's: the changes go to it with the scene ([scene] effect), merged if renders gather.
          const g = sceneChanges.current;
          sceneChanges.current = g && g.scene === entry.scene ? { prev: g.prev, scene: next, changes: mergeChanges(g.changes, changes) } : { prev: entry.scene, scene: next, changes };
        } else if (entry.index) entry.index = updateIndex(entry.index, next, changes, p);
        entry.scene = next;
      }
      if (!ops) sceneChanges.current = null;
      cache.rev = props.rev;
    }
    const entry = cache.byPlan.get(props.plan) ?? { scene: buildScene(s, props.plan, measure, p), index: null };
    // The tab shown last goes last; beyond cachedPlans, the one shown longest ago is forgotten.
    cache.byPlan.delete(props.plan);
    cache.byPlan.set(props.plan, entry);
    for (const plan of cache.byPlan.keys()) { if (cache.byPlan.size <= p.cachedPlans) break; cache.byPlan.delete(plan); }
    setScene(entry.scene);
    mark('sceneReady');
  }, [ready, props.state, props.rev, props.plan, sceneKey]);

  return { scene, cache: scenes, showScene, measureOf };
}

export type ScenesPart = ReturnType<typeof useScenes>;
