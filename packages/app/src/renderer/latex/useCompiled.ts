import type { CompileRequest } from '@cirrus/core';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { loading } from '../files/read.ts';
import { CompileScheduler, type CompiledView, IDLE_VIEW, noteInstalled } from './scheduler.ts';

/**
 * The main process's compilation, counted among what the views load (a capture waits for it); the packages an answer
 * installed are told (noteInstalled), whichever view it goes to.
 */
const bridge = {
  compile: (r: CompileRequest) => loading(window.cirrus.latexCompile(r).then((a) => { noteInstalled(a); return a; })),
  cancel: (slot: string) => window.cirrus.latexCancel(slot),
};
const timers = { set: (fn: () => void, ms: number) => window.setTimeout(fn, ms), clear: (h: unknown) => window.clearTimeout(h as number) };

/**
 * A compilation counted among what the views load (viewsSettled) for as long as it is pending, its typing pause
 * included, and not only while the main process compiles: a capture signals that it is ready once every compilation
 * asked has finished (plan 4b, task 6). `set(true)` holds, `set(false)` lets go.
 */
export class PendingHold {
  private release: (() => void) | null = null;

  set(pending: boolean): void {
    if (pending && this.release === null) void loading(new Promise<void>((resolve) => { this.release = resolve; }));
    else if (!pending && this.release !== null) {
      this.release();
      this.release = null;
    }
  }
}

/**
 * The compilation of `req` (null: none) as it stands: a thin React wrapper of a CompileScheduler of its own, made at
 * mount and disposed at unmount. `pauseMs`: the typing pause (latexTypingPauseMs), read when a pause starts. While it
 * is pending, a capture waits for it (PendingHold), and until the answer is rendered: the effects of what shows it
 * (its PDF read and drawn) run before this hook's own, and have started their loads by then.
 */
export function useCompiled(req: CompileRequest | null, pauseMs = DEFAULT_PARAMS.latexTypingPauseMs): CompiledView {
  const pause = useRef(pauseMs);
  pause.current = pauseMs;
  const [view, setView] = useState(IDLE_VIEW);
  const scheduler = useRef<CompileScheduler | null>(null);
  const hold = useRef<PendingHold | null>(null);
  /** The scheduler's view as it is now, which the one rendered may not be yet. */
  const pendingNow = useRef(false);
  useEffect(() => {
    const s = new CompileScheduler(bridge, timers, () => pause.current);
    const h = new PendingHold();
    scheduler.current = s;
    hold.current = h;
    const off = s.subscribe((v) => {
      pendingNow.current = v.pending;
      if (v.pending) h.set(true);
      setView(v);
    });
    return () => {
      off();
      s.dispose();
      h.set(false);
      scheduler.current = null;
      hold.current = null;
    };
  }, []);
  // After the effect above: the scheduler exists. An equal request, built again at each render, changes nothing.
  useEffect(() => { scheduler.current?.request(req); }, [req]);
  // The answer rendered, and nothing asked since: let go.
  useEffect(() => { if (!view.pending && !pendingNow.current) hold.current?.set(false); }, [view]);
  return view;
}
