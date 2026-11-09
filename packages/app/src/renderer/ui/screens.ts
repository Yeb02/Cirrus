import type { FileRef, Id, NodeRec, State } from '@cirrus/core';
import { useEffect, useRef, useState } from 'react';
import type { WorkbenchHandle } from './latex/TexWorkbench.tsx';
import { type PanelTarget, resolveTarget } from './panels/Panels.tsx';

/**
 * What App opens over the graph: the settings panel (`panel`), a file in full screen (`full`; a .tex's workbench,
 * plan 4b, D6), the preamble's full screen (`preambleOpen`, D5); and the steps made in a file's full screen, the only
 * ones its Ctrl+Z and Ctrl+Y undo and redo (`fullSteps`, plan 4c).
 */
export function useScreens() {
  const [panel, setPanel] = useState(window.cirrus.launch.panel === true);
  /** The file in full screen, if any, by its name: closed once it is gone (resolveTarget). */
  const [full, setFull] = useState<PanelTarget | null>(null);
  const fullRef = useRef(full);
  fullRef.current = full;
  /** The .tex workbench open in full screen (plan 4b, D6): its text is saved before the window closes. */
  const workbench = useRef<WorkbenchHandle | null>(null);
  /** What the full screen last showed: kept while its .tex has unsaved text, should its file go meanwhile. */
  const lastFull = useRef<{ node: NodeRec; file: FileRef } | null>(null);
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
    const found = full && resolveTarget(state, full);
    if (found?.file) lastFull.current = { node: found.node, file: found.file };
    const fullNow = found?.file ? found : full && workbench.current?.dirty ? lastFull.current : null;
    if (full && !fullNow) {
      setFull(null);
      return undefined;
    }
    return fullNow;
  };
  return { panel, setPanel, full, setFull, fullRef, workbench, preambleOpen, setPreambleOpen, preambleRef, fullSteps, fullIn };
}
