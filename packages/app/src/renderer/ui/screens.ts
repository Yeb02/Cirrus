import type { FileRef, Id, NodeRec, State } from '@cirrus/core';
import { useEffect, useRef, useState } from 'react';
import { sameName } from '../files/merge.ts';
import type { WorkbenchHandle } from './latex/TexWorkbench.tsx';
import { type PanelTarget, resolveTarget } from './panels/Panels.tsx';

/**
 * What the full screen shows: a file of a node (a .tex's workbench, plan 4b), or the comparison of a .tex with its
 * conflict copy (plan 5b, D7), the node's two files by their names.
 */
export type FullTarget = PanelTarget | { kind: 'compare'; node: Id; original: string; copy: string };

/** What a full screen target is now: its node and its file (a comparison: the original) and, for a comparison, its copy. */
export interface FullShown { node: NodeRec; file: FileRef; copy?: FileRef }

/**
 * What the full screen's target is now, or null when it is gone (Review Focus 5 of plan 4a; Review Focus 4 of plan 5b): a
 * file as resolveTarget finds it; a comparison needs the node (not in the trash) and both files, each found by its name
 * (sameName) — either one removed or renamed, or the node gone, closes it.
 */
export function resolveFull(s: State, t: FullTarget): FullShown | null {
  if (t.kind !== 'compare') {
    const found = resolveTarget(s, t);
    return found?.file ? { node: found.node, file: found.file } : null;
  }
  const node = resolveTarget(s, { kind: 'node', node: t.node })?.node;
  const file = node?.files.find((f) => sameName(f.name, t.original)), copy = node?.files.find((f) => sameName(f.name, t.copy));
  return node && file && copy ? { node, file, copy } : null;
}

/**
 * What App opens over the graph: the settings panel (`panel`), a file in full screen (`full`; a .tex's workbench,
 * plan 4b, D6; or a .tex compared with its conflict copy, plan 5b, D7), the preamble's full screen (`preambleOpen`, D5);
 * and the steps made in a file's full screen, the only ones its Ctrl+Z and Ctrl+Y undo and redo (`fullSteps`, plan
 * 4c). A comparison makes none: its save is one action, made as it closes, and undone by Ctrl+Z in the graph.
 */
export function useScreens() {
  const [panel, setPanel] = useState(window.cirrus.launch.panel === true);
  /** The file in full screen, if any, by its name (a comparison: both): closed once it is gone (resolveFull). */
  const [full, setFull] = useState<FullTarget | null>(null);
  const fullRef = useRef(full);
  fullRef.current = full;
  /**
   * The .tex workbench open in full screen (plan 4b, D6): its text is saved before the window closes. A comparison
   * answers through it too (plan 5b, D7): `dirty` once blocks were taken, and a `flush` that saves them as « Enregistrer »
   * does, the copy left in the node (task 8a): closing the window never drops them.
   */
  const workbench = useRef<WorkbenchHandle | null>(null);
  /** What the full screen last showed: kept while its .tex has unsaved text, should its file go meanwhile. */
  const lastFull = useRef<FullShown | null>(null);
  /** The preamble's full screen (D5), opened from the settings; a modal, as a file's. */
  const [preambleOpen, setPreambleOpen] = useState(false);
  const preambleRef = useRef(preambleOpen);
  preambleRef.current = preambleOpen;
  /** The steps made in the full screen open (its annotations): the only ones its Ctrl+Z and Ctrl+Y undo and redo. */
  const fullSteps = useRef(new Set<Id>());
  // A full screen opened or closed: its steps are no longer its own.
  useEffect(() => { fullSteps.current = new Set(); }, [full]);

  /**
   * The file in full screen, as `state` has it: a new version of it stays; gone — removed, renamed, its addition
   * undone, its node deleted — the full screen closes (Review Focus 5), and `undefined` says so: App renders again at
   * once. A .tex whose typed text is not saved yet stays, as it last was: its save is then refused, and says why
   * (Review Focus 4).
   */
  const fullIn = (state: State) => {
    const found = full && resolveFull(state, full);
    if (found) lastFull.current = found;
    const fullNow = found ?? (full && workbench.current?.dirty ? lastFull.current : null);
    if (full && !fullNow) {
      setFull(null);
      return undefined;
    }
    return fullNow;
  };
  return { panel, setPanel, full, setFull, fullRef, workbench, preambleOpen, setPreambleOpen, preambleRef, fullSteps, fullIn };
}
