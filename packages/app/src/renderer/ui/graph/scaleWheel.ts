import { type PlanScene, previewSplit, scaleMoves, stepWheel, type WheelSteps, withMoves } from '@cirrus/view';
import { useRef } from 'react';
import { scaleBuild } from '../../actions.ts';
import { type Graph, NOTHING_SHOWN } from './core.ts';

/** The scale gesture of Ctrl+wheel (spec 8.1): `wheelScale` takes a notch, `settleWheel` writes the gesture at once. */
export function useScaleWheel(graph: Graph) {
  const { engine, sceneRef, paramsRef, selectionRef, edit, hitAt, restoreScene, redraw } = graph;
  /**
   * Ctrl+wheel (spec 8.1): the step of the selection or of the element under the cursor. The notches of one gesture
   * are previewed at once and written as one action when the wheel pauses (stepWheel).
   */
  const wheelGesture = useRef<{ steps: WheelSteps; base: PlanScene; preview: PlanScene; items: number[]; timer: number } | null>(null);
  const commitScale = (g: { steps: WheelSteps; base: PlanScene; items: number[] }) => {
    if (g.steps.delta === 0) { restoreScene(); return; }
    edit(scaleBuild(g.base, g.items, g.steps.delta, paramsRef.current), restoreScene);
  };
  /** Writes now the Ctrl+wheel gesture waiting for its pause (before an undo, a change of plan). */
  const settleWheel = () => {
    const g = wheelGesture.current;
    if (!g) return;
    window.clearTimeout(g.timer);
    wheelGesture.current = null;
    commitScale(g);
  };
  const wheelScale = (sx: number, sy: number, deltaY: number) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    const h = hitAt(sx, sy);
    const prev = wheelGesture.current;
    if (h.kind !== 'item') return;
    const id = sc.items[h.item].id, sel = selectionRef.current;
    const ids = sel.items.has(id) ? [...sel.items] : [id];
    const steps = stepWheel(prev?.steps ?? null, [...ids].sort().join(','), deltaY, performance.now(), paramsRef.current);
    if (prev) window.clearTimeout(prev.timer);
    if (steps.flush && prev) commitScale(prev);
    // A new gesture starts from what the screen shows: after the one just written, its preview (I6 of the review).
    const base = !prev ? sc : steps.flush ? prev.preview : prev.base;
    const items = ids.flatMap((x) => { const i = base.byId.get(x); return i === undefined ? [] : [i]; });
    // Preview: the placements as the action would leave them, without rebuilding the scene (I15 of the review), the
    // gesture's previous preview's storage taken again (plan 3c task 9).
    const reuse = prev && !steps.flush ? prev.preview : undefined;
    const preview = steps.delta === 0 ? base : withMoves(base, scaleMoves(base, items, steps.delta, paramsRef.current), paramsRef.current, reuse);
    e.renderer.preview(preview, previewSplit(base, e.renderer.visible ?? NOTHING_SHOWN, items));
    const gesture = { steps, base, preview, items, timer: 0 };
    gesture.timer = window.setTimeout(() => { wheelGesture.current = null; commitScale(gesture); }, paramsRef.current.scaleGesturePauseMs);
    wheelGesture.current = gesture;
    redraw();
  };
  return { settleWheel, wheelScale };
}
