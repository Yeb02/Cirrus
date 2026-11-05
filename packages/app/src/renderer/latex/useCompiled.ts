import type { CompileRequest } from '@cirrus/core';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { loading } from '../files/read.ts';
import { CompileScheduler, type CompiledView, IDLE_VIEW } from './scheduler.ts';

/** The main process's compilation, counted among what the views load (a capture waits for it). */
const bridge = {
  compile: (r: CompileRequest) => loading(window.cirrus.latexCompile(r)),
  cancel: (slot: string) => window.cirrus.latexCancel(slot),
};
const timers = { set: (fn: () => void, ms: number) => window.setTimeout(fn, ms), clear: (h: unknown) => window.clearTimeout(h as number) };

/**
 * The compilation of `req` (null: none) as it stands: a thin React wrapper of a CompileScheduler of its own, made at
 * mount and disposed at unmount. `pauseMs`: the typing pause (latexTypingPauseMs), read when a pause starts.
 */
export function useCompiled(req: CompileRequest | null, pauseMs = DEFAULT_PARAMS.latexTypingPauseMs): CompiledView {
  const pause = useRef(pauseMs);
  pause.current = pauseMs;
  const [view, setView] = useState(IDLE_VIEW);
  const scheduler = useRef<CompileScheduler | null>(null);
  useEffect(() => {
    const s = new CompileScheduler(bridge, timers, () => pause.current);
    scheduler.current = s;
    const off = s.subscribe(setView);
    return () => {
      off();
      s.dispose();
      scheduler.current = null;
    };
  }, []);
  // After the effect above: the scheduler exists. An equal request, built again at each render, changes nothing.
  useEffect(() => { scheduler.current?.request(req); }, [req]);
  return view;
}
