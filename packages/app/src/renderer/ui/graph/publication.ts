import type { Id, Vec2 } from '@cirrus/core';
import { type Camera, screenToWorld } from '@cirrus/view';
import { useEffect, useState } from 'react';
import { type ImportDeps, publicationBuild } from '../../publications/build.ts';
import type { Graph } from './core.ts';

/**
 * « Importer une publication… » (plan 4c, task 5): the dialog (`dialog`, PublicationDialog in GraphView), opened at a
 * point of the plan shown (`shownPlan`) — by the background's menu, or by a PDF dropped there (plan 5b, D5: dropPdfFile)
 * — and what it asks of the graph to put the publication's node there.
 */
export function usePublicationImport(graph: Graph, shownPlan: Id) {
  const { engine, root, sceneRef, paramsRef, stateRef, sessionRef, onResultRef, indexOf, notify, busy, busyReason } = graph;
  /**
   * « Importer une publication… » (plan 4c, task 5): the dialog, and where its node goes — the world point and the zoom
   * of the right click that opened it, in its plan. `pdf`: the path of a PDF dropped on the background, which the dialog
   * takes as a PDF dropped on it (plan 5b, D5). Another plan shown closes it (a result still to come dropped).
   */
  const [dialog, setDialog] = useState<{ key: number; plan: Id; at: Vec2; zoom: number; pdf?: string } | null>(null);
  useEffect(() => { setDialog((d) => (d !== null && d.plan !== shownPlan ? null : d)); }, [shownPlan]);
  /**
   * The dialog opened for the screen point `at` of `plan`, seen through `cam`: its node goes there, at that zoom, with
   * the PDF at `pdf` to take at once, if one is given.
   */
  const openPublication = (plan: Id, cam: Camera, at: { x: number; y: number }, pdf?: string) => {
    setDialog({ key: performance.now(), plan, at: screenToWorld(cam, at.x, at.y), zoom: cam.zoom, ...(pdf === undefined ? {} : { pdf }) });
  };
  /**
   * A PDF dropped alone on the graph's background at the screen point `at` (plan 5b, D5): the dialog opens there with
   * it, as if it had been dropped on the dialog. Not while a gesture, a question or a .bib waiting for its place is under
   * way, as for a .bib dropped.
   */
  const dropPdfFile = (path: string, at: { x: number; y: number }) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    if (busy()) { notify(busyReason('d’importer une publication')); return; }
    openPublication(sc.plan.id, e.renderer.camera, at, path);
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
  return { dialog, openPublication, dropPdfFile, publicationDeps, closePublication };
}

export type PublicationPart = ReturnType<typeof usePublicationImport>;
