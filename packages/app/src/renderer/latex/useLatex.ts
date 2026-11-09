import { type LatexStatus, preambleText, type State } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { loading, MB } from '../files/read.ts';
import { backgroundRequests, type SyncedChanges } from './background.ts';
import { withPackage } from './install.ts';
import { LatexRegistry } from './registry.ts';
import { latexChanged, onPackagesInstalled } from './scheduler.ts';
import { loadTexTexts, sameTexts } from './texts.ts';

// LaTeX in App (plan 4b): pdfLaTeX on this PC, its state and its installation (useLatexStatus), and the registry of the
// base's labels and citation keys that every compile request reads (useLatexRegistry).

const NO_TEXTS: ReadonlyMap<string, string> = new Map();

/**
 * LaTeX on this PC (task 7), as the main process tells it — null until it has —, and `installLatex`, the user's ask;
 * pdfLaTeX prepared with the preamble of `state`. The packages a compilation installed are added to the settings
 * (`setParams`).
 */
export function useLatexStatus(state: State | null, setParams: Dispatch<SetStateAction<RenderParams>>) {
  /** LaTeX on this PC (task 7), as the main process tells it; null until it has. */
  const [latex, setLatex] = useState<LatexStatus | null>(null);

  // LaTeX (plan 4b, D2): pdfLaTeX prepared with the preamble once the state is loaded, and again when it changes. Not
  // for the bench, which measures the graph.
  const preamble = state ? preambleText(state) : null;
  useEffect(() => {
    if (preamble !== null && window.cirrus.launch.bench === undefined) window.cirrus.latexWarm(preamble);
  }, [preamble]);

  // LaTeX's state (task 7): asked once, then told at each change. At each change of state, and at each `ready`
  // (installed, or packages added), the views that could not compile ask again (latexChanged): they compile, or say
  // why not as it now stands (installing, failed). Not for the bench, which measures the graph.
  useEffect(() => {
    if (window.cirrus.launch.bench !== undefined) return;
    let told = false, before: LatexStatus['state'] | null = null;
    const off = window.cirrus.onLatexStatus((s) => {
      told = true;
      setLatex(s);
      if (s.state === 'ready' || s.state !== before) latexChanged();
      before = s.state;
    });
    window.cirrus.latexStatus().then((s) => { if (!told) setLatex(s); }, (e: unknown) => console.error('État de LaTeX :', e));
    return off;
  }, []);
  // The packages a compilation installed join latexPackages, which every PC installs at its start (D1).
  useEffect(() => onPackagesInstalled((names) => setParams((p) => names.reduce((q, name) => withPackage(q, name) ?? q, p))), []);

  /** TinyTeX installed, the user having asked (the notice, the settings); how it goes is told by its state. */
  const installLatex = () => { window.cirrus.latexInstall().catch((e: unknown) => console.error('Installation de LaTeX :', e)); };
  return { latex, installLatex };
}

/**
 * The registry (plan 4b, D7, D8), built again from `state` (`rev`: its revision) and the texts of its .tex, read here;
 * null until the state is loaded. At each build, what the synchronisations changed (`synced`) is compiled in the
 * background, latexBackgroundMax requests at most (plan 5b, D1).
 */
export function useLatexRegistry(state: State | null, rev: number | undefined, params: RenderParams, synced: SyncedChanges): LatexRegistry | null {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  /** The texts of the .tex, by hash, that the registry reads (plan 4b, D8), and the ceiling (textViewMaxMb) they were read under. */
  const [texts, setTexts] = useState({ byHash: NO_TEXTS, maxMb: 0 });
  const textsRef = useRef(texts);
  textsRef.current = texts;
  /** The labels and citation keys of the base (D7, D8), for the compile requests: the pop-ups and the full screen take it (tasks 5, 6). */
  const [registry, setRegistry] = useState<LatexRegistry | null>(null);
  /** The last registry built, and when: the next one reuses its analyses, and waits for the pause. */
  const built = useRef<{ registry: LatexRegistry | null; at: number }>({ registry: null, at: -Infinity });

  // The .tex not read yet, after each change of the state; the texts of the files gone are let go. Another ceiling
  // reads them all again: one left empty as too long may fit now.
  useEffect(() => {
    if (!state) return;
    const maxMb = params.textViewMaxMb, stop = new AbortController();
    const have = textsRef.current.maxMb === maxMb ? textsRef.current.byHash : NO_TEXTS;
    void loading(loadTexTexts(state, have, maxMb * MB, stop.signal)).then(
      (byHash) => {
        const now = textsRef.current;
        if (now.maxMb !== maxMb || !sameTexts(byHash, now.byHash)) setTexts({ byHash, maxMb });
      },
      (e: unknown) => { if (!stop.signal.aborted) console.error('Lecture des .tex pour leurs labels :', e); },
    );
    return () => stop.abort();
  }, [state, rev, params.textViewMaxMb]);

  // The registry, built again when the state or the texts change, at most once per typing pause: at once after a
  // quiet moment, else once the pause since the last build is over, with the state as it then is. A build waiting is
  // counted among what the views load: a capture waits for the compilations it changes (plan 4b, task 6). Then what
  // the synchronisations changed goes to the background, once the .tex they changed are read (plan 5b, D1).
  useEffect(() => {
    if (!state) return;
    const build = () => {
      const previous = built.current.registry;
      const r = LatexRegistry.build(state, texts.byHash, previous ?? undefined);
      built.current = { registry: r, at: performance.now() };
      setRegistry(r);
      const p = paramsRef.current, origins = synced.take(previous, r, state, texts.byHash).slice(0, p.latexBackgroundMax);
      if (origins.length > 0) window.cirrus.latexBackground(backgroundRequests(origins, state, r, p.latexSnippetWidthCm));
    };
    const wait = built.current.at + params.latexTypingPauseMs - performance.now();
    if (wait <= 0) {
      build();
      return;
    }
    let done = () => {};
    void loading(new Promise<void>((resolve) => { done = resolve; }));
    const timer = setTimeout(() => { build(); done(); }, wait);
    return () => { clearTimeout(timer); done(); };
  }, [state, rev, texts, params.latexTypingPauseMs]);

  return registry;
}
