import type { Id } from '@cirrus/core';
import { dropTarget, fitItem, screenToWorld } from '@cirrus/view';
import { useRef } from 'react';
import { ALREADY_HERE, placeDroppedBuild } from '../../actions.ts';
import { NODE_MIME } from '../../files/annotations.ts';
import { backgroundNotice, carried, carriesFiles, droppedPaths, dropRoute, dropZone, type Refusal } from '../../files/nodeFiles.ts';
import { nodeOpenedBy } from '../panels/Panels.tsx';
import type { Graph } from './core.ts';
import { ignored } from './launch.ts';

/**
 * What is dropped on the graph (plan 4a, task 4; plan 4c, task 3 and D9; plan 5b, D5): files, routed by dropRoute
 * (dropFilesAt) to the node under the point, to a .bib's import, to the publication import dialog (a PDF), or to a
 * notice; a node dragged out of a list of annotations, put down (dropNodeAt). `handlers` go on the graph's element.
 */
export function useGraphDrop(graph: Graph, onDropFiles: (node: Id, paths: string[], refused?: Refusal[]) => Promise<void>) {
  const { root, engine, sceneRef, paramsRef, redraw, notify, edit, indexOf, hitAt, local, moveCamera, dragging, busy, busyReason } = graph;
  /**
   * Files dropped at (sx, sy) (plan 4a, task 4): the node or the group under the point receives them — the node whose
   * pop-up a double click there would open (nodeOpenedBy: a far node's phantom stands for it); a .bib alone on the background
   * is imported (plan 4c, D9), a PDF alone opens the import dialog at the point, with it (plan 5b, D5); elsewhere, a
   * notice (dropRoute).
   */
  const dropFilesAt = (sx: number, sy: number, paths: string[], refused: Refusal[] = []): Promise<void> => {
    const h = hitAt(sx, sy), i = h.kind === 'item' ? sceneRef.current?.byId.get(h.id) : undefined;
    const under = nodeOpenedBy(i === undefined ? undefined : sceneRef.current!.items[i], false);
    const route = dropRoute('graph', under, 'files', refused.length === 0 ? paths : undefined);
    if (route.to === 'node') return onDropFiles(route.node, paths, refused);
    if (route.to === 'bib') return graph.bib.dropBibFile(paths[0], { x: sx, y: sy });
    if (route.to === 'pdf') { graph.publication.dropPdfFile(paths[0], { x: sx, y: sy }); return Promise.resolve(); }
    notify(backgroundNotice([...paths, ...refused.map((r) => r.name)]));
    return Promise.resolve();
  };
  /** Files the graph takes: not on what floats over it and refuses them (dropZone). */
  const takesFiles = (ev: React.DragEvent) => carriesFiles(ev) && dropZone(ev.target) === 'graph';
  /** A node dragged out of a list of annotations that the graph takes (plan 4c, task 3): its own route, never files (dropRoute). */
  const takesNode = (ev: React.DragEvent) => carried(ev) === 'node' && dropRoute(dropZone(ev.target), null, 'node').to === 'place';
  /** What a node dragged over the graph would enter, lit (spec 10: the group under the cursor lights up); null: none. */
  const lit = useRef<number | null>(null);
  const lightHost = (pt: { sx: number; sy: number } | null) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc || dragging()) return;
    const cam = e.renderer.camera;
    const t = pt === null ? null : dropTarget(sc, screenToWorld(cam, pt.sx, pt.sy), [], cam.zoom, paramsRef.current, indexOf(sc));
    if (t === lit.current) return;
    lit.current = t;
    e.renderer.setDropTarget(t);
    redraw();
  };
  /**
   * A node dragged out of a list of annotations (NODE_MIME), let go at (sx, sy) (plan 4c, D4): placed in this plan where
   * it is let go, at the readable step, entering the group or the simple node under the point (placeDroppedBuild), with
   * the « partout ou ici seulement » question when that inclusion exists elsewhere or may (spec 10: askRepercussion).
   * Already here: said, and the view framed on it. Not while a gesture, a question or a repercussion is under way.
   */
  const dropNodeAt = (sx: number, sy: number, node: Id) => {
    const e = engine.current, sc = sceneRef.current;
    if (!e || !sc) return;
    if (busy()) { notify(busyReason('de poser ce nœud')); return; }
    const p = paramsRef.current, cam = e.renderer.camera, at = screenToWorld(cam, sx, sy), index = indexOf(sc);
    const here = sc.byId.get(node);
    if (here !== undefined) {
      notify(ALREADY_HERE);
      moveCamera(fitItem(sc, here, cam, p));
      return;
    }
    const build = placeDroppedBuild(sc, node, at, cam.zoom, p, index);
    const host = dropTarget(sc, at, [], cam.zoom, p, index);
    if (host === null) void edit(build);
    else graph.repercussion.askRepercussion(sc.plan.id, [{ node, from: null, to: sc.items[host].id }], build, () => {});
  };
  /**
   * Files dropped on the graph (not on a question over it: it refuses them); a node dragged
   * out of a list of annotations, by its own route (plan 4c, task 3), the node or group it would enter lit meanwhile.
   */
  const handlers = {
    onDragOver: (ev: React.DragEvent) => {
      const node = takesNode(ev);
      if (!node && !takesFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      if (node && !ignored(ev)) lightHost(local(ev));
    },
    onDragLeave: (ev: React.DragEvent) => { if (!root.current!.contains(ev.relatedTarget as Node | null)) lightHost(null); },
    onDrop: (ev: React.DragEvent) => {
      if (takesNode(ev)) {
        ev.preventDefault();
        lightHost(null);
        if (ignored(ev)) return;
        const node = ev.dataTransfer.getData(NODE_MIME), { sx, sy } = local(ev);
        root.current!.focus();
        if (node) dropNodeAt(sx, sy, node);
        return;
      }
      if (!takesFiles(ev)) return;
      ev.preventDefault();
      if (ignored(ev)) return;
      const { sx, sy } = local(ev), d = droppedPaths(ev.dataTransfer.files, (f) => window.cirrus.pathForFile(f));
      if (d.paths.length + d.refused.length > 0) void dropFilesAt(sx, sy, d.paths, d.refused);
    },
  };
  return { dropFilesAt, handlers };
}
