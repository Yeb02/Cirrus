import type { Id, Vec2 } from '@cirrus/core';
import { type Camera, screenToWorld } from '@cirrus/view';
import { useEffect, useState } from 'react';
import { type ImportDeps, publicationBuild } from '../../publications/build.ts';
import type { Graph } from './core.ts';

/**
 * « Importer une publication… » (plan 4c, task 5): the dialog (`dialog`, PublicationDialog in GraphView), opened at a
 * point of the plan shown (`shownPlan`), and what it asks of the graph to put the publication's node there.
 */
export function usePublicationImport(graph: Graph, shownPlan: Id) {
  const { root, sceneRef, paramsRef, stateRef, sessionRef, onResultRef, indexOf } = graph;
  /**
   * « Importer une publication… » (plan 4c, task 5): the dialog, and where its node goes — the world point and the zoom
   * of the right click that opened it, in its plan. Another plan shown closes it (a result still to come dropped).
   */
  const [dialog, setDialog] = useState<{ key: number; plan: Id; at: Vec2; zoom: number } | null>(null);
  useEffect(() => { setDialog((d) => (d !== null && d.plan !== shownPlan ? null : d)); }, [shownPlan]);
  /** The dialog opened for the screen point `at` of `plan`, seen through `cam`: its node goes there, at that zoom. */
  const openPublication = (plan: Id, cam: Camera, at: { x: number; y: number }) => {
    setDialog({ key: performance.now(), plan, at: screenToWorld(cam, at.x, at.y), zoom: cam.zoom });
  };
  /**
   * What the import dialog asks of the graph (plan 4c, D5 to D8): the IPC, and the node put down where the menu was
   * opened (publicationBuild), at the zoom of then, through the session — one action. Its plan no longer shown, nothing.
   */
  const publicationDeps = (d: { plan: Id; at: Vec2; zoom: number }): Omit<ImportDeps, 'open'> => ({
    state: () => stateRef.current,
    fetch: (text, options) => window.cirrus.publicationFetch(text, options),
    storeText: (name, text) => window.cirrus.storeText(name, text),
    maxAuthors: () => paramsRef.current.publicationMaxAuthors,
    put: async (plan, files) => {
      const sc = sceneRef.current, session = sessionRef.current;
      if (!sc || !session || sc.plan.id !== d.plan) return { ok: false, message: 'Le plan de l’import n’est plus affiché : rien n’est importé.' };
      const r = await session.run(publicationBuild(plan, files, sc, d.at, d.zoom, paramsRef.current, indexOf(sc)));
      if (r.ok) onResultRef.current(r);
      return r;
    },
    log: (what, e) => console.error(what, e),
  });
  /** The dialog closed: the focus goes back to the graph. */
  const closePublication = () => { setDialog(null); root.current?.focus({ preventScroll: true }); };
  return { dialog, openPublication, publicationDeps, closePublication };
}

export type PublicationPart = ReturnType<typeof usePublicationImport>;
