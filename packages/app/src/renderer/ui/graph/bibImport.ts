import type { FileRef, Id, Vec2 } from '@cirrus/core';
import { bibBlock, blockHalves, worldToScreen } from '@cirrus/view';
import { useRef } from 'react';
import type { BibFile } from '../../../main/bib.ts';
import { readableStep } from '../../actions.ts';
import { loading } from '../../files/read.ts';
import { bibImportBuild, bibNotice, bibStoreFailure, bibText, planBib, type PlannedBib, storeBibs } from '../../publications/bib.ts';
import type { Graph } from './core.ts';

const fr = (n: number) => n.toLocaleString('fr-FR');

/**
 * A .bib being imported (plan 4c, D9, task 6), from the ghost of its block to the action: what it plans, in its plan;
 * each title's lines (the block's rows); its entries' .bib stored meanwhile — `stored` so far, `refs` once all are,
 * `failed` why not —, which `stop` (Escape, another plan, a lost focus) ends; `settled` resolves once storing is over.
 * `put`: where a click put it down and at what zoom, the action waiting for every .bib stored — Escape no longer gives
 * it up, another plan does, and no gesture that puts something down begins meanwhile (review of task 6, M4). The
 * block's half sizes at step 0, for its outline (they scale with the step).
 */
interface BibImport {
  planned: PlannedBib; plan: Id; lines: number[]; halves: { halfW: number; halfH: number };
  stored: number; refs: FileRef[] | null; failed: string | null; stop: boolean; settled: Promise<void>; put: { at: Vec2; zoom: number } | null;
}
/** What a gesture begun while a .bib's import waits for its .bib is told (review of task 6, M4). */
export const BIB_WAITING = 'Import du .bib en cours : attends que ses publications soient posées.';
/**
 * The import's marks for its measures (scripts/interface.mjs, scripts/mesures-annotations.mjs): the drop or the choice,
 * the file read by the main process, its entries read and planned (decoded, parsed, compared with the base), the ghost
 * shown, every .bib stored, the click, the action applied.
 */
const bibMark = (name: 'drop' | 'read' | 'planned' | 'ghost' | 'stored' | 'click' | 'placed') => {
  performance.clearMarks(`cirrus:bib:${name}`);
  performance.mark(`cirrus:bib:${name}`);
};

/**
 * A .bib's import (plan 4c, D9): the file dropped on the background (dropBibFile) or chosen from the menu (chooseBib),
 * read by the main process; its block follows the cursor (a placement of kind « bib ») until a click puts it down
 * (placeBib), its entries' .bib stored meanwhile.
 */
export function useBibImport(graph: Graph) {
  const { engine, sceneRef, paramsRef, stateRef, onLongNoticeRef, notify, edit, indexOf, feed, busy, busyReason } = graph;
  /** A .bib being imported (plan 4c, D9), from its ghost to its action; null otherwise. */
  const bib = useRef<BibImport | null>(null);
  /** Whether a .bib is being imported, from its ghost to its action. */
  const importing = () => bib.current !== null;
  /** A .bib put down, waiting for its .bib (M4): no gesture that puts something down begins, the menus do not open. */
  const bibWaiting = () => bib.current?.put != null;
  /** What a .bib's ghost says: its publications, and its .bib being stored, if they are. */
  const bibLabel = (b: BibImport) => {
    const n = b.planned.items.length, what = `Importer ${n === 1 ? 'une publication' : `${fr(n)} publications`}`;
    if (b.refs !== null) return what;
    return b.put ? `Enregistrement des fichiers .bib : ${fr(b.stored)} / ${fr(n)}…` : `${what} · fichiers .bib : ${fr(b.stored)} / ${fr(n)}`;
  };
  /**
   * The ghost of the .bib's block (D9, the paste's ghost of plan 3b): its label, and its outline as the block would be
   * put down at the zoom shown — at the readable step, so about the same size on screen at any zoom —, at `at` or where
   * it was. Put down and waiting for its .bib: where it was put down, at the step of then, whatever the view does.
   */
  const showBib = (at?: { x: number; y: number }) => {
    const b = bib.current, e = engine.current;
    if (!b || !e) return;
    const p = paramsRef.current, cam = e.renderer.camera, s = p.factor ** readableStep(b.put?.zoom ?? cam.zoom, p);
    const box = { w: 2 * b.halves.halfW * s * cam.zoom, h: 2 * b.halves.halfH * s * cam.zoom };
    const there = b.put ? worldToScreen(cam, b.put.at.x, b.put.at.y) : at;
    graph.placement.setGhost((g) => ({ x: there?.x ?? g?.x ?? 0, y: there?.y ?? g?.y ?? 0, text: bibLabel(b), box }));
  };
  /** The import given up (Escape, another plan, a lost focus, a refusal): its .bib no longer stored; what is stored stays. */
  const dropBib = () => {
    const b = bib.current;
    if (!b) return;
    b.stop = true;
    bib.current = null;
  };
  /**
   * A .bib the main process read (D9: dropped on the background, or chosen), for the plan `plan` shown then: decoded,
   * planned against the base (planBib), its block following the cursor from `at` until a click puts it down (placeBib),
   * its entries' .bib stored meanwhile, by batches (storeBibs). Nothing to import: the notification says why, and
   * nothing follows the cursor. Another plan shown or a gesture begun while it was read: given up, said.
   */
  const startBib = (file: BibFile | null, at: { x: number; y: number }, plan: Id) => {
    bibMark('read');
    const e = engine.current, sc = sceneRef.current;
    if (file === null || !e || !sc) return;
    if ('refused' in file) { notify(file.refused); return; }
    if (sc.plan.id !== plan || busy()) { notify(`Le plan a changé, ou un geste a commencé, pendant la lecture du fichier .bib : rien n’est importé.`); return; }
    const text = bibText(file);
    if ('refused' in text) { notify(text.refused); return; }
    const p = paramsRef.current, planned = planBib(stateRef.current, file.name, text.text, p.publicationMaxAuthors);
    bibMark('planned');
    if (planned.items.length === 0) { onLongNoticeRef.current(bibNotice(planned, 0, p.bibNoticeLines)); return; }
    const measure = graph.scenes.measureOf(p);
    const lines = planned.items.map((x) => measure(x.plan.title));
    const b: BibImport = {
      planned, plan, lines, halves: blockHalves(bibBlock(lines.length, 0, p, lines), 0, p, lines),
      stored: 0, refs: null, failed: null, stop: false, settled: Promise.resolve(), put: null,
    };
    bib.current = b;
    // Only the block's ghost is redrawn: no other gesture begins while it follows the cursor or waits (M4).
    const shown = () => bib.current === b && (graph.placement.placing.current?.kind === 'bib' || b.put !== null);
    // Counted among what the views load (viewsSettled): a capture shows the ghost once its .bib are stored (plan 4c,
    // task 7, « bloc-bib »), never halfway.
    b.settled = loading(storeBibs(planned.items.map((x) => x.plan.bib!), (batch) => window.cirrus.storeTexts(batch), (n) => {
      b.stored = n;
      if (shown()) showBib();
    }, () => b.stop).then((refs) => {
      b.refs = refs;
      if (refs) bibMark('stored');
      if (shown() && b.put === null) showBib();
    }, (err: unknown) => {
      console.error('Enregistrement des fichiers .bib :', err);
      b.failed = bibStoreFailure(err);
      // Still following the cursor: the gesture is given up, said.
      if (bib.current === b && b.put === null) { feed({ t: 'cancel' }); notify(b.failed); }
    }));
    graph.placement.startPlacing({ kind: 'bib' }, bibLabel(b), at);
    showBib(at);
    bibMark('ghost');
  };
  /**
   * The block put down at `at` (D9), at the zoom of the click, once its .bib are all stored (the ghost stays there and
   * says so while they are not): one action, « Importer <n> publications », then the notification of the import
   * (bibNotice), which stays bibNoticeMs. Another plan shown meanwhile gives it up (the scene's effect); the store
   * failed: nothing is made, said.
   */
  const placeBib = (at: Vec2, zoom: number) => {
    const b = bib.current;
    if (!b) return;
    bibMark('click');
    b.put = { at, zoom };
    if (b.refs === null) showBib();
    void b.settled.then(async () => {
      if (bib.current !== b) return;
      bib.current = null;
      graph.placement.setGhost(null);
      const sc = sceneRef.current;
      if (b.failed || b.refs === null) { notify(b.failed ?? 'Les fichiers .bib n’ont pas été enregistrés : rien n’est importé.'); return; }
      if (!sc || sc.plan.id !== b.plan) { notify('Le plan de l’import n’est plus affiché : rien n’est importé.'); return; }
      const p = paramsRef.current, refs = b.refs;
      const r = await edit(bibImportBuild(b.planned.items.map((x, i) => ({ plan: x.plan, file: refs[i] })), sc, at, zoom, p, b.lines, indexOf(sc)));
      bibMark('placed');
      if (r?.ok) onLongNoticeRef.current(bibNotice(b.planned, b.planned.items.length, p.bibNoticeLines));
    });
  };
  /** A .bib dropped on the graph's background at (sx, sy) (D9): read by the main process, then its block follows the cursor. */
  const dropBibFile = async (path: string, at: { x: number; y: number }) => {
    const plan = sceneRef.current?.plan.id;
    if (!plan) return;
    if (busy()) { notify(busyReason('d’importer un fichier .bib')); return; }
    bibMark('drop');
    let file: BibFile;
    try {
      file = await window.cirrus.readBib(path);
    } catch (e) {
      console.error('Lecture du fichier .bib :', e);
      notify('Le fichier .bib n’a pas pu être lu : rien n’est importé.');
      return;
    }
    startBib(file, at, plan);
  };
  /** The system's dialog, by the main process (D9): the .bib chosen follows the cursor from the menu's point `at`, in `plan`. */
  const chooseBib = (plan: Id, at: { x: number; y: number }) => {
    if (busy()) { notify(busyReason('d’importer un fichier .bib')); return; }
    bibMark('drop');
    window.cirrus.pickBib().then((file) => startBib(file, at, plan), (err: unknown) => {
      console.error('Lecture du fichier .bib :', err);
      notify('Le fichier .bib n’a pas pu être lu : rien n’est importé.');
    });
  };
  /** Another plan shown: a .bib put down and waiting for its .bib is given up, its ghost gone with its plan (review of task 6, M4). */
  const planLeft = () => {
    if (bibWaiting()) {
      dropBib();
      graph.placement.setGhost(null);
      notify('Le plan de l’import n’est plus affiché : rien n’est importé.');
    }
  };
  return { importing, bibWaiting, showBib, dropBib, placeBib, dropBibFile, chooseBib, planLeft };
}

export type BibPart = ReturnType<typeof useBibImport>;
