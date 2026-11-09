import { screenToWorld } from '@cirrus/view';
import { useState } from 'react';
import type { Graph } from './core.ts';

type Tip = { x: number; y: number; text: string } | null;
type Chain = { item: number; title: string }[];

/**
 * What lies under the resting pointer (spec 8): the connection or stub lit, the tooltip of a stub, a phantom or an
 * intruder (`tip`), and the open groups around it, outermost first (`chain`, the hierarchy reminder).
 */
export function useHover(graph: Graph) {
  const { engine, sceneRef, redraw } = graph;
  const [tip, setTip] = useState<Tip>(null);
  const [chain, setChain] = useState<Chain>([]);
  /** What is under the screen point (sx, sy): hover light, tooltip, hierarchy reminder. */
  const hover = (sx: number, sy: number) => {
    const e = engine.current, sc = sceneRef.current, hits = e?.renderer.hitIndex;
    if (!e || !sc || !hits) return;
    const cam = e.renderer.camera;
    const w = screenToWorld(cam, sx, sy);
    const h = hits.hit(w.x, w.y, cam.zoom);
    e.renderer.setHover(h.kind === 'connection' || h.kind === 'stub' ? h.conn : null);
    redraw();
    let text: string | null = null;
    // The intruders found among what is drawn, with the same visible set as the hit index (spec 10, plan 3c task 6).
    const intruder = h.kind === 'item' ? e.renderer.intruders.get(h.item) : undefined;
    if (h.kind === 'stub') text = `absent : ${h.title}`;
    else if (intruder !== undefined) text = `intrus dans le groupe « ${sc.items[intruder].title} »`;
    else if (h.kind === 'item' && sc.items[h.item].kind === 'phantom') {
      const it = sc.items[h.item];
      text = `${it.phantom === 'node' ? 'fantôme' : it.phantom === 'center' ? 'centre' : 'absent'} : ${it.title}`;
    }
    setTip((old) => (text === null ? null : old && old.text === text && old.x === sx && old.y === sy ? old : { x: sx, y: sy, text }));
    const next = hits.openGroupsAt(w.x, w.y, cam.zoom).reverse().map((item) => ({ item, title: sc.items[item].title }));
    setChain((old) => (old.length === next.length && old.every((g, i) => g.item === next[i].item) ? old : next));
  };
  const clearHover = () => {
    engine.current?.renderer.setHover(null);
    redraw();
    setTip(null);
    setChain([]);
  };
  return { tip, chain, hover, clearHover };
}
