import type { Vec2 } from '@cirrus/core';
import { type Clip, copyClip, type PlanScene, type RenderParams } from '@cirrus/view';
import { useRef } from 'react';
import { pasteBuild } from '../../actions.ts';
import { type Graph, plural } from './core.ts';

/** Copy and paste (spec 7): the clip, Ctrl+C, Ctrl+V and the paste a click puts down (a placement of kind « paste »). */
export function useCopyPaste(graph: Graph) {
  const { engine, stateRef, setSelection, notify, edit, indexOf } = graph;
  /** What Ctrl+C copied (spec 7): it survives a change of plan, to be pasted elsewhere. */
  const clip = useRef<Clip | null>(null);
  /** Ctrl+C (spec 7): the selection, or what was clicked, with this plan and zoom. */
  const copy = (sc: PlanScene, items: number[]) => {
    const c = copyClip(stateRef.current, sc, items, engine.current?.renderer.camera.zoom ?? 1);
    if (!c) return;
    clip.current = c;
    notify(`${c.nodes.length} ${plural(c.nodes.length, 'nœud copié', 'nœuds copiés')}.`);
  };
  /** Ctrl+V (spec 7): the clip follows the cursor until a click puts it down. */
  const startPaste = (at: { x: number; y: number }) => {
    const c = clip.current;
    if (!c) { notify('Rien à coller : copiez d’abord une sélection (Ctrl+C).'); return; }
    graph.placement.startPlacing({ kind: 'paste' }, `Coller ${c.nodes.length} ${plural(c.nodes.length, 'nœud', 'nœuds')}`, at);
  };
  /** The clip put down at `at` in the scene `sc`, at this zoom (spec 7); no clip, nothing. */
  const pasteAt = (sc: PlanScene, at: Vec2, zoom: number, p: RenderParams) => {
    if (!clip.current) return;
    const r = pasteBuild(stateRef.current, clip.current, sc, at, zoom, p, indexOf(sc));
    edit(r.build);
    // Nodes already here keep their place and group; selected, they are ready to be moved (spec 7).
    if (r.present.length > 0) {
      const n = r.present.length;
      notify(`${graph.questions.titles(r.present)} ${plural(n, 'était déjà', 'étaient déjà')} dans ce plan : ${plural(n, 'il garde sa', 'ils gardent leur')} place (${plural(n, 'sélectionné', 'sélectionnés')}, à déplacer au besoin).`);
      setSelection({ items: new Set(r.present), connections: new Set() });
    }
  };
  return { clip, copy, startPaste, pasteAt };
}

export type CopyPastePart = ReturnType<typeof useCopyPaste>;
