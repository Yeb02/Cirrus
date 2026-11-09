import type { State } from '@cirrus/core';
import { DEFAULT_PARAMS, type RenderParams, withOverrides } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { applyReceived, dueChanges, keepUnsaved } from './settingChanges.ts';

/**
 * The settings in App (spec 19: outside the history and undo): `params` as shown, and `paramsRef` for what reads them
 * later; first read at startup (`firstSettings`), written a moment after each change made here, and changed by those
 * received from the server (plan 5a, task 6, D9). `state`: null until the base is open, and nothing is written before.
 */
export function useSettings(state: State | null) {
  const [params, setParams] = useState<RenderParams>(DEFAULT_PARAMS);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  /**
   * The settings as last read, written or received (task 6): what differs from them was changed here, and only that is
   * written; the settings just read are not written back.
   */
  const savedParams = useRef<RenderParams | null>(null);
  /** Shared settings received before the settings were read (task 6): applied once they are. */
  const earlySettings = useRef<Record<string, unknown>[]>([]);
  /**
   * Settings as the main process wrote them, a batch (task 6): received from the server, or the answer to a save. Applied
   * over the saved settings at once, in one render — none when they change nothing —; a setting changed here and not yet
   * written keeps its value, which is written next. Reads only refs: the first render's copy serves the listeners.
   */
  const adoptSettings = (changes: Record<string, unknown>) => {
    const before = savedParams.current;
    if (!before) {
      earlySettings.current.push(changes);
      return;
    }
    const after = applyReceived(before, changes);
    if (after === before) return;
    savedParams.current = after;
    setParams((p) => keepUnsaved(p, before, after, Object.keys(changes)));
  };
  /** The settings read at startup (App), as they are saved from then on: shown once the state is (setParams). */
  const firstSettings = (settings: Record<string, unknown>): RenderParams => {
    // Batches received while the settings were read (a page reloaded, its main process syncing on): applied over them.
    const p = earlySettings.current.splice(0).reduce(applyReceived, withOverrides(settings));
    savedParams.current = p;
    return p;
  };

  // Settings are written a moment after the last change (spec 19: outside the history and undo): only those changed
  // here, never one received meanwhile (with a server paired, each written one is shared: task 6).
  // A batch received after the timer was set, and not rendered yet when it fires, stands it down (review of task 6,
  // round 2): its render sets it again, over the received settings.
  useEffect(() => {
    const base = savedParams.current;
    if (!state || !base || params === base) return;
    const timer = setTimeout(() => {
      const changes = dueChanges(base, savedParams.current!, params);
      if (!changes) return;
      savedParams.current = params;
      // The main process answers with what it wrote (review of task 6, Minor 2): a row received for one of these keys
      // while the save was on its way, told before the answer, gives way to it, as in settings.json.
      if (Object.keys(changes).length > 0) {
        window.cirrus.setSettings(changes).then((written) => { if (written) adoptSettings(written); }, (e: unknown) => console.error('Réglages non enregistrés :', e));
      }
    }, params.settingsSaveDelayMs);
    return () => clearTimeout(timer);
  }, [params, state]);

  // Shared settings received from the server (task 6, D9), one batch at a time.
  useEffect(() => window.cirrus.onSettingsChanged((changes) => adoptSettings(changes)), []);

  return { params, setParams, paramsRef, firstSettings };
}
