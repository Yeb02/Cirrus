import { type Action, type FileRef, type Id, type NodeRec, preambleText, type State } from '@cirrus/core';
import { DEFAULT_PARAMS, diffFromDefaults, type RenderParams, withOverrides } from '@cirrus/view';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportResult } from '../main/files.ts';
import type { Build } from './actions.ts';
import { mark } from './bench.ts';
import { addImported, type NodeFiles, openNotice, type Refusal, refusesStrayDrop } from './files/nodeFiles.ts';
import { loading, MB, viewsSettled } from './files/read.ts';
import { ViewStates } from './files/viewState.ts';
import { textOwnsKeys } from './keys.ts';
import { LatexRegistry } from './latex/registry.ts';
import { loadTexTexts, sameTexts } from './latex/texts.ts';
import { liveTabs } from './tabs.ts';
import { guardClicks } from './ui/clickGuard.ts';
import { FullScreen, FullScreenFailed } from './ui/FullScreen.tsx';
import { saveTex } from './ui/latex/saveScheduler.ts';
import type { WorkbenchHandle } from './ui/latex/TexWorkbench.tsx';
import { GraphBoundary } from './ui/GraphBoundary.tsx';
import { type GraphHandle, GraphView } from './ui/GraphView.tsx';
import { PanelBoundary } from './ui/PanelBoundary.tsx';
import type { Rect } from './ui/panels/geometry.ts';
import { type PanelTarget, Panels, type PanelsHandle, resolveTarget } from './ui/panels/Panels.tsx';
import { keepOpenViews } from './ui/viewers/common.tsx';
import { SettingsPanel } from './ui/SettingsPanel.tsx';
import { Tabs } from './ui/Tabs.tsx';
import { type Toast, Toasts } from './ui/Toasts.tsx';
import { EditSession, openState, type Result, SnapshotSaver } from './session.ts';

const TABS_KEY = 'cirrus.tabs';
const NODE_GONE = 'Ce nœud n’existe plus.';
/** Bench and captures work on copies of a base: they keep no snapshot (none would be read again, and saving would weigh on what they measure). */
const measuring = window.cirrus.launch.bench !== undefined || window.cirrus.launch.capture === true;
const NO_TEXTS: ReadonlyMap<string, string> = new Map();
// What changes from one build of the test base to the next (a node's identifier) is not drawn in a capture (`.volatile`),
// so that the captures repeat to the pixel.
if (window.cirrus.launch.capture) document.documentElement.classList.add('capture');

/** Open tabs are a per-PC convenience: kept in localStorage, which may be unavailable. */
function loadTabs(): Id[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveTabs(tabs: Id[]): void {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* not kept */ }
}
/**
 * Where the files' views were left (« au même endroit »): a per-PC convenience, in localStorage, which may be
 * unavailable. Bench and captures keep none: a capture shows a view as it opens, whatever an earlier run left.
 */
function viewStorage(): Storage | null {
  if (measuring) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The state shown, with its revision and the last action applied to it: the state object stays the same, edits change
 * it in place (plan 3c), so React sees a change by `rev`.
 */
interface Shown { state: State; rev: number; action: Action | null }

export function App() {
  const [shown, setShown] = useState<Shown | null>(null);
  const state = shown?.state ?? null;
  const [params, setParams] = useState<RenderParams>(DEFAULT_PARAMS);
  const [tabs, setTabs] = useState<Id[]>([]);
  const [active, setActive] = useState<Id | null>(null);
  const [panel, setPanel] = useState(window.cirrus.launch.panel === true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const readySent = useRef(false);
  /** The settings just read are not written back. */
  const loadedParams = useRef<RenderParams | null>(null);
  const session = useRef<EditSession | null>(null);
  const saver = useRef<SnapshotSaver | null>(null);
  const activeRef = useRef<Id | null>(null);
  activeRef.current = active;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const panels = useRef<PanelsHandle>(null);
  const graph = useRef<GraphHandle>(null);
  /** The file in full screen, if any, by its name: closed once it is gone (resolveTarget). */
  const [full, setFull] = useState<PanelTarget | null>(null);
  const fullRef = useRef(full);
  fullRef.current = full;
  /** The .tex workbench open in full screen (plan 4b, D6): its text is saved before the window closes. */
  const workbench = useRef<WorkbenchHandle | null>(null);
  /** What the full screen last showed: kept while its .tex has unsaved text, should its file go meanwhile. */
  const lastFull = useRef<{ node: NodeRec; file: FileRef } | null>(null);
  /** One for the app (plan 4a): read from the storage once, and again only if its size setting changes. */
  const views = useMemo(() => new ViewStates(viewStorage(), params.viewStatesKept), [params.viewStatesKept]);
  /** The texts of the .tex, by hash, that the registry reads (plan 4b, D8), and the ceiling (textViewMaxMb) they were read under. */
  const [texts, setTexts] = useState({ byHash: NO_TEXTS, maxMb: 0 });
  const textsRef = useRef(texts);
  textsRef.current = texts;
  /** The labels and citation keys of the base (D7, D8), for the compile requests: the pop-ups and the full screen take it (tasks 5, 6). */
  const [registry, setRegistry] = useState<LatexRegistry | null>(null);
  /** The last registry built, and when: the next one reuses its analyses, and waits for the pause. */
  const built = useRef<{ registry: LatexRegistry | null; at: number }>({ registry: null, at: -Infinity });

  const toast = (text: string) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), paramsRef.current.toastMs);
  };
  /** Reports a refused edit, or names the plan an undone step changed if it is not the one on screen (spec 6.4). */
  const report = (r: Result, verb?: string) => {
    if (!r.ok) { toast(r.message); return; }
    const elsewhere = r.plans.filter((p) => p !== activeRef.current);
    if (verb && elsewhere.length > 0 && !r.plans.includes(activeRef.current!)) {
      const names = elsewhere.map((p) => `« ${session.current!.state.plans.get(p)?.name ?? '?'} »`).join(', ');
      toast(`${verb} dans ${elsewhere.length > 1 ? 'les plans' : 'le plan'} ${names} : ${r.action.label}`);
    }
  };

  // Ctrl+Z / Ctrl+Y (and Ctrl+Maj+Z) for the whole app; inside a text field, or a LaTeX field being edited, they
  // belong to the text (spec 6.4: textOwnsKeys). Not under a full screen: they would change the graph hidden under it
  // (ruling of the task 5 review).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!session.current || !e.ctrlKey || fullRef.current || textOwnsKeys(e.target instanceof Element ? (e.target as HTMLElement) : null)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); void session.current.undo().then((r) => report(r, 'Annulé')); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); void session.current.redo().then((r) => report(r, 'Rétabli')); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A click whose press closed a context menu is swallowed, wherever it lands (clickGuard.ts).
  useEffect(() => guardClicks(window), []);

  // The snapshot is due once nothing has happened for a while: any input starts that wait again.
  useEffect(() => {
    const touch = () => saver.current?.touch();
    const events = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const;
    for (const e of events) window.addEventListener(e, touch, { capture: true, passive: true });
    return () => { for (const e of events) window.removeEventListener(e, touch, { capture: true }); };
  }, []);

  // A file let go anywhere but on a node or a pop-up opens nothing (Review Focus 2): Chromium would show it in the window.
  // The graph and the pop-ups take theirs first (their default prevented: dropZone, dropRoute); elsewhere — tabs,
  // settings, a text field — the drop is refused (refusesStrayDrop), and the main process refuses any navigation anyway.
  // Text dragged in a field is left to the field.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (!refusesStrayDrop(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);

  // Closing: what is typed in a .tex's full screen saved first (D6), then the last snapshot, if anything changed since
  // the one before; then the main process may close the window. The views still open keep their place too.
  useEffect(() => window.cirrus.onQuit(() => {
    keepOpenViews();
    void (workbench.current?.flush() ?? Promise.resolve())
      .catch((e: unknown) => console.error('Enregistrement du .tex à la fermeture :', e))
      .then(() => saver.current?.flush())
      .finally(() => window.cirrus.quitReady());
  }), []);

  useEffect(() => {
    void (async () => {
      try {
        // The snapshot and the journal after it (plan 3c); the tables when the snapshot cannot be used.
        const load = (fromTables: boolean) => window.cirrus.load(fromTables).then((l) => { mark('dataReceived'); return l; });
        const [opened, settings] = await Promise.all([openState(load), window.cirrus.getSettings()]);
        if (opened.fallback) console.warn(`Instantané de la base inutilisable (${opened.fallback}) : état relu dans ses tables.`);
        const s = opened.state;
        const plans = [...s.plans.values()];
        const lobby = plans.find((p) => p.type === 'lobby')!;
        let open = loadTabs().filter((id) => s.plans.has(id) && id !== lobby.id);
        let current = lobby.id;
        const wanted = window.cirrus.launch.plan && plans.find((p) => p.name === window.cirrus.launch.plan);
        if (wanted) {
          if (wanted.type !== 'lobby' && !open.includes(wanted.id)) open = [...open, wanted.id];
          current = wanted.id;
        }
        const p = withOverrides(settings);
        loadedParams.current = p;
        session.current = new EditSession(s, (a) => window.cirrus.commit(a), (st, action, rev) => {
          setShown({ state: st, rev, action });
          saver.current?.applied();
        }, opened.seq);
        if (!measuring) saver.current = new SnapshotSaver(session.current, (data, seq) => window.cirrus.saveSnapshot(data, seq), () => paramsRef.current, opened.stale);
        mark('stateReady');
        setParams(p);
        setTabs(open);
        setActive(current);
        setShown({ state: s, rev: 0, action: null });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => { if (state) saveTabs(tabs); }, [tabs, state]);

  // Settings are written a moment after the last change (spec 19: outside the history and undo).
  useEffect(() => {
    if (!state || params === loadedParams.current) return;
    const timer = setTimeout(() => { void window.cirrus.setSettings(diffFromDefaults(params)); }, params.settingsSaveDelayMs);
    return () => clearTimeout(timer);
  }, [params, state]);

  // LaTeX (plan 4b, D2): pdfLaTeX prepared with the preamble once the state is loaded, and again when it changes. Not
  // for the bench, which measures the graph.
  const preamble = state ? preambleText(state) : null;
  useEffect(() => {
    if (preamble !== null && window.cirrus.launch.bench === undefined) window.cirrus.latexWarm(preamble);
  }, [preamble]);

  // The .tex not read yet, after each change of the state; the texts of the files gone are let go. Another ceiling
  // reads them all again: one left empty as too long may fit now.
  const rev = shown?.rev;
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
  // counted among what the views load: a capture waits for the compilations it changes (plan 4b, task 6).
  useEffect(() => {
    if (!state) return;
    const build = () => {
      const r = LatexRegistry.build(state, texts.byHash, built.current.registry ?? undefined);
      built.current = { registry: r, at: performance.now() };
      setRegistry(r);
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

  /** Captures wait for the first drawn frame; a due snapshot waits for it too (R16). */
  const firstFrame = () => {
    if (readySent.current) return;
    readySent.current = true;
    saver.current?.start();
    // Visual checks: CIRRUS_IMPORT="sx,sy|path" drops that file at that point of the graph, by the drop's own path
    // (captures only); then CIRRUS_CLICK=".gear" clicks those elements, CIRRUS_KEYS="ctrl+z,Delete" presses those keys;
    // the capture waits for the files' views they opened to settle (their file read, their code and language loaded).
    const [at, ...dropped] = (window.cirrus.launch.import ?? '').split('|').filter(Boolean);
    const clicks = (window.cirrus.launch.click ?? '').split(',').filter(Boolean);
    const keys = (window.cirrus.launch.keys ?? '').split(',').filter(Boolean);
    void (async () => {
      if (dropped.length > 0) {
        const [sx, sy] = at.split(',').map(Number);
        await graph.current?.dropFilesAt(sx, sy, dropped);
      }
      // Each click waits for what the views it opened load (a PDF's reader, its pages): the next one acts on them.
      for (const sel of clicks) {
        document.querySelector<HTMLElement>(sel)?.click();
        await new Promise((r) => setTimeout(r, 300));
        await viewsSettled();
      }
      for (const combo of keys) {
        const parts = combo.split('+');
        const key = parts.pop()!;
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt') }));
        await new Promise((r) => setTimeout(r, 150));
      }
      await viewsSettled();
      window.cirrus.ready();
    })();
  };
  useEffect(() => { if (error) firstFrame(); }, [error]);

  if (error) return <div className="app"><div className="placeholder">Impossible d’ouvrir la base : {error}</div></div>;
  if (!shown || !state || !active) return <div className="app"><div className="placeholder">Ouverture de la base…</div></div>;
  // A plan gone while its tab is open (its creation undone): the tab goes, the lobby shows. Rendered again at once with
  // them, before the graph view is given a plan that no longer exists (F4 of the final review).
  const live = liveTabs(state.plans, tabs, active);
  if (live.open !== tabs || live.active !== active) {
    setTabs(live.open);
    setActive(live.active);
    return null;
  }
  // The file in full screen: a new version of it stays; gone — removed, renamed, its addition undone, its node deleted —
  // the full screen closes (Review Focus 5). A .tex whose typed text is not saved yet stays, as it last was: its save is
  // then refused, and says why (Review Focus 4).
  const found = full && resolveTarget(state, full);
  if (found?.file) lastFull.current = { node: found.node, file: found.file };
  const fullNow = found?.file ? found : full && workbench.current?.dirty ? lastFull.current : null;
  if (full && !fullNow) {
    setFull(null);
    return null;
  }
  // The lobby has its own tab, always there: only another plan is added to the open ones.
  const openPlan = (id: Id) => { if (state.plans.get(id)?.type !== 'lobby') setTabs((t) => (t.includes(id) ? t : [...t, id])); setActive(id); };
  /**
   * A link to a node clicked in a summary, a relation or a PDF (plan 4b, D7): the node's pop-up, loose, beside the
   * panel `near` it was clicked in, or in front if it is open (openLinked); a node gone, or in the trash, says so.
   */
  const nodeLink = (node: Id, near: Rect) => {
    if (resolveTarget(state, { kind: 'node', node })) panels.current?.openLinked(node, near);
    else toast(NODE_GONE);
  };
  /** An edit from a pop-up, through the session like the graph's: a refusal is reported, and the pop-up told (false). */
  const edit = (build: Build): Promise<boolean> => (build ? session.current!.run(build).then((r) => { report(r); return r.ok; }) : Promise.resolve(true));
  /**
   * Files imported into a node (plan 4a, D6): copied into the store by the main process (`imported`), then added through
   * the session as one action; what came of it in toasts — the refused files (`refused`: already here, not on the disk)
   * in one, then what the drop did or why not.
   */
  const addFiles = async (node: Id, imported: Promise<ImportResult>, refused: Refusal[] = []) => {
    let r: ImportResult;
    try {
      r = await imported;
    } catch (e) {
      console.error('Import des fichiers :', e);
      toast('Les fichiers n’ont pas pu être importés.');
      return;
    }
    for (const notice of await addImported(session.current!, node, { refs: r.refs, refused: [...refused, ...r.refused] })) toast(notice);
  };
  const files: NodeFiles = {
    importInto: (node, paths, refused) => addFiles(node, paths.length > 0 ? window.cirrus.importFiles(paths) : Promise.resolve({ refs: [], refused: [] }), refused),
    pickInto: (node) => addFiles(node, window.cirrus.pickFiles()),
    openWithSystem: async (file) => {
      const r = await window.cirrus.openFile(file).catch((e: unknown) => {
        console.error(`Ouverture de « ${file.name} » :`, e);
        return { ok: false as const, message: `Impossible d’ouvrir « ${file.name} ».` };
      });
      const notice = openNotice(r);
      if (notice) toast(notice);
    },
  };
  return (
    <div className="app">
      <Tabs
        plans={[...state.plans.values()]}
        open={tabs}
        active={active}
        onSelect={setActive}
        onOpen={(id) => { setTabs((t) => [...t, id]); setActive(id); }}
        onClose={(id) => {
          setTabs((t) => t.filter((x) => x !== id));
          if (active === id) setActive([...state.plans.values()].find((p) => p.type === 'lobby')!.id);
        }}
        settingsOpen={panel}
        onSettings={() => setPanel((o) => !o)}
      />
      <div className="main">
        <GraphBoundary plan={active}>
          <GraphView
            state={state} rev={shown.rev} action={shown.action} plan={active} params={params} onFirstFrame={firstFrame} session={session.current}
            onResult={(r) => report(r)} onOpenPlan={openPlan}
            onOpenNode={(id, at) => panels.current?.openNode(id, at)} onClickAway={() => panels.current?.closeLoose()}
            onDropFiles={files.importInto} registry={registry} onNodeLink={nodeLink} ref={graph}
          />
        </GraphBoundary>
        {panel && <SettingsPanel params={params} onChange={(p) => setParams(withOverrides(p))} onClose={() => setPanel(false)} />}
        <Panels
          ref={panels} state={state} rev={shown.rev} action={shown.action} params={params} onEdit={edit} onOpenPlan={openPlan} files={files}
          views={views} fullHash={fullNow?.file?.hash ?? null} onFullScreen={(node, name) => setFull({ kind: 'file', node, name })} registry={registry}
          onNodeLink={nodeLink}
        />
        <Toasts toasts={toasts} />
      </div>
      {fullNow?.file && (
        // A full screen that fails says so over the window, which stays (PanelBoundary); closed, it is tried again next time.
        <PanelBoundary
          what={`Plein écran de « ${fullNow.file.name} »`} fallback={<FullScreenFailed name={fullNow.file.name} onClose={() => setFull(null)} />}
        >
          <FullScreen
            node={fullNow.node} file={fullNow.file} params={params} views={views} onClose={() => setFull(null)} onSystem={files.openWithSystem}
            nodeTitle={(id) => { const n = resolveTarget(state, { kind: 'node', node: id })?.node; return n ? n.title || 'Sans titre' : null; }}
            tex={{
              state, registry, workbench,
              onSave: (text) => saveTex(session.current!, (name, t) => window.cirrus.storeText(name, t), fullNow.node.id, fullNow.file!.name, text),
            }}
          />
        </PanelBoundary>
      )}
    </div>
  );
}
