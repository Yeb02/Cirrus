import { type Action, type Anchor, annotationTitle, createAnnotation, type Id, type State } from '@cirrus/core';
import { withOverrides } from '@cirrus/view';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportResult } from '../main/files.ts';
import { type Build, deleteAnnotationBuild, preambleBuild } from './actions.ts';
import { mark } from './bench.ts';
import { SearchBuild, type SearchHit, SearchIndex, type SearchWhere } from './search/index.ts';
import { anchorRefusal, AnnotationIndex, titleChars } from './files/annotations.ts';
import { addImported, type NodeFiles, openNotice, type Refusal, refusesStrayDrop } from './files/nodeFiles.ts';
import { loading } from './files/read.ts';
import { ViewStates } from './files/viewState.ts';
import { textOwnsKeys } from './keys.ts';
import { destination, historyKey, type HistoryMove, sideButton } from './navigation.ts';
import { useLatexRegistry, useLatexStatus } from './latex/useLatex.ts';
import { quitInOrder, typedFields } from './quit.ts';
import { withSetting } from './settingChanges.ts';
import { liveTabs, loadTabs, saveTabs } from './tabs.ts';
import { guardClicks } from './ui/clickGuard.ts';
import { FullScreen, FullScreenFailed } from './ui/FullScreen.tsx';
import { LatexNotice } from './ui/latex/LatexNotice.tsx';
import { reconcileTex } from './ui/latex/compare.ts';
import { saveTex } from './ui/latex/saveScheduler.ts';
import { GraphBoundary } from './ui/GraphBoundary.tsx';
import { type GraphHandle, GraphView } from './ui/GraphView.tsx';
import { OBJECT_GONE, showNodeIn } from './ui/graph/jumps.ts';
import { measuring } from './ui/graph/launch.ts';
import { PanelBoundary } from './ui/PanelBoundary.tsx';
import type { Rect } from './ui/panels/geometry.ts';
import { Panels, type PanelsHandle, resolveTarget } from './ui/panels/Panels.tsx';
import { useScreens } from './ui/screens.ts';
import { keepOpenViews } from './ui/viewers/common.tsx';
import { SearchBox } from './ui/SearchBox.tsx';
import { SettingsPanel } from './ui/SettingsPanel.tsx';
import { SyncChip } from './ui/SyncChip.tsx';
import { SyncVeil } from './ui/SyncVeil.tsx';
import { Tabs } from './ui/Tabs.tsx';
import { Toasts, useToasts } from './ui/Toasts.tsx';
import { EditSession, openState, type Result, SnapshotSaver } from './session.ts';
import { useSync } from './sync/useSync.ts';
import { useSettings } from './useSettings.ts';
import { replayLaunch } from './visualChecks.ts';

const NODE_GONE = 'Ce nœud n’existe plus.';
const RESULT_GONE = 'Ce résultat n’est plus là : il a été jeté, ou retiré de son plan.';
const NOTHING_FOUND: Id[] = [];
/** A whole build of the search index takes the idle moments, this long at most each (plan 6a, D1). */
const SEARCH_SLICE_MS = 8;
/** The preamble's full screen, with CodeMirror and pdf.js, in its own chunk (as the .tex workbench: FullScreen.tsx). */
const PreambleEditor = lazy(() => loading(import('./ui/latex/PreambleEditor.tsx')).then((m) => ({ default: m.PreambleEditor })));
/** The comparison of a .tex with its conflict copy (plan 5b, D7), with @codemirror/merge, in its own chunk too. */
const CompareView = lazy(() => loading(import('./ui/latex/CompareView.tsx')).then((m) => ({ default: m.CompareView })));
// What changes from one build of the test base to the next (a node's identifier) is not drawn in a capture (`.volatile`),
// nor the text cursor, which blinks (plan 4b, task 8), so that the captures repeat to the pixel.
if (window.cirrus.launch.capture) document.documentElement.classList.add('capture');

/**
 * Where the files' views were left (« au même endroit »): a per-PC convenience, in localStorage, which may be
 * unavailable. Bench and captures keep none: a capture shows a view as it opens, whatever an earlier run left.
 */
function viewStorage(): Storage | null {
  if (measuring()) return null;
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
  /** The settings: read at startup, written after a change here, changed by those received (useSettings.ts). */
  const { params, setParams, paramsRef, firstSettings } = useSettings(state);
  const [tabs, setTabs] = useState<Id[]>([]);
  const [active, setActive] = useState<Id | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readySent = useRef(false);
  const session = useRef<EditSession | null>(null);
  const saver = useRef<SnapshotSaver | null>(null);
  const activeRef = useRef<Id | null>(null);
  activeRef.current = active;
  const panels = useRef<PanelsHandle>(null);
  const graph = useRef<GraphHandle>(null);
  /** One for the app (plan 4a): read from the storage once, and again only if its size setting changes. */
  const views = useMemo(() => new ViewStates(viewStorage(), params.viewStatesKept), [params.viewStatesKept]);
  /** The last annotation index built (plan 4c): the next one reads again only what changed. */
  const builtAnnotations = useRef<AnnotationIndex | null>(null);
  /**
   * The search (plan 6a, D1). Its index is built whole once wanted — after the first frame, or at a first Ctrl+K in
   * bench and capture modes — in idle slices (`searchBase`, for the state it was built on); then at each change of the
   * state from the last one (`builtSearch`), by the actions applied since (`searchLog`, every one the session told,
   * none lost when renders gather; null while no whole build is under way or done).
   */
  const [searchWanted, setSearchWanted] = useState(false);
  const [searchBase, setSearchBase] = useState<SearchIndex | null>(null);
  const searchLog = useRef<Action[] | null>(null);
  const builtSearch = useRef<{ base: SearchIndex; index: SearchIndex } | null>(null);
  /** The box open (Ctrl+K: `asked` counts them, the field taking the focus again), and what it found in this plan. */
  const [searchBox, setSearchBox] = useState<{ asked: number } | null>(null);
  const [searchFound, setSearchFound] = useState<Id[]>(NOTHING_FOUND);

  /** Notifications (ui/Toasts.tsx): `toast(text, closable)`. */
  const { toasts, toast, closeToast } = useToasts(paramsRef);
  /** Reports a refused edit, or names the plan an undone step changed if it is not the one on screen (spec 6.4). */
  const report = (r: Result, verb?: string) => {
    if (!r.ok) { toast(r.message); return; }
    const elsewhere = r.plans.filter((p) => p !== activeRef.current);
    if (verb && elsewhere.length > 0 && !r.plans.includes(activeRef.current!)) {
      const names = elsewhere.map((p) => `« ${session.current!.state.plans.get(p)?.name ?? '?'} »`).join(', ');
      toast(`${verb} dans ${elsewhere.length > 1 ? 'les plans' : 'le plan'} ${names} : ${r.action.label}`);
    }
  };
  /** What is open over the graph: the settings, a file's full screen and its own steps, the preamble's (ui/screens.ts). */
  const { panel, setPanel, full, setFull, fullRef, workbench, preambleOpen, setPreambleOpen, preambleRef, fullSteps, fullIn } = useScreens();
  /** The synchronisation (plan 5a): what it shows (the veil, the chip), the server paired, and its session. */
  const sync = useSync(toast, paramsRef);

  // Ctrl+Z / Ctrl+Y (and Ctrl+Maj+Z) for the whole app; inside a text field, or a LaTeX field being edited, they
  // belong to the text (spec 6.4: textOwnsKeys). Not under the preamble's full screen; under a file's, only for the
  // steps made there (plan 4c: its annotations, D3) — the others would change the graph hidden under it (ruling of the
  // task 5 review).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!session.current || !e.ctrlKey || preambleRef.current) return;
      if (textOwnsKeys(e.target instanceof Element ? (e.target as HTMLElement) : null)) return;
      const k = e.key.toLowerCase(), undo = k === 'z' && !e.shiftKey, redo = k === 'y' || (k === 'z' && e.shiftKey);
      if (!undo && !redo) return;
      const next = undo ? session.current.nextUndo : session.current.nextRedo;
      if (fullRef.current && (next === null || !fullSteps.current.has(next))) return;
      e.preventDefault();
      if (undo) void session.current.undo().then((r) => report(r, 'Annulé'));
      else void session.current.redo().then((r) => report(r, 'Rétabli'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl+K opens the search (plan 6a, D1) from anywhere, a text field included — but not over a full screen, which is
  // modal (a file's, the preamble's), nor in a code editor (CodeMirror), where it keeps its own meaning. Open, it gives
  // its field the focus again.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.key.toLowerCase() !== 'k') return;
      if (!session.current || fullRef.current || preambleRef.current) return;
      if (e.target instanceof Element && e.target.closest('.cm-editor')) return;
      e.preventDefault();
      setSearchWanted(true);
      setSearchBox((b) => ({ asked: (b?.asked ?? 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // « Précédent » et « suivant » (plan 6a, D2): Alt+← and Alt+→, the mouse's side buttons (3 and 4, on release) and the
  // app commands of Windows, from anywhere — a panel's focus included —, but not in a text field or a code editor, which
  // keep their keys, nor over a full screen, which is modal. The graph does not take a side button for a left press.
  useEffect(() => {
    const go = (dir: HistoryMove) => { if (session.current && !fullRef.current && !preambleRef.current) graph.current?.[dir](); };
    const onKey = (e: KeyboardEvent) => {
      const dir = historyKey(e);
      if (dir === null) return;
      const target = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (textOwnsKeys(target) || target?.closest('.cm-editor')) return;
      e.preventDefault();
      go(dir);
    };
    const onMouse = (e: MouseEvent) => {
      const dir = sideButton(e.button);
      if (dir === null) return;
      e.preventDefault();
      go(dir);
    };
    // The browser keys, and the mouse buttons a driver sends as app commands (the main process hears them, window.ts): a
    // side button itself reaches the page as mouseup — Chromium consumes it, no app command follows (tested).
    const off = window.cirrus.onAppCommand((command) => go(command === 'browser-backward' ? 'back' : 'forward'));
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse, true);
    return () => { off(); window.removeEventListener('keydown', onKey); window.removeEventListener('mouseup', onMouse, true); };
  }, []);

  // A full screen opened (a file's from a pop-up, the preamble's from the settings) closes the search: it is modal, and
  // the box stands over the notifications, which stand over it.
  useEffect(() => {
    if (!full && !preambleOpen) return;
    setSearchBox(null);
    setSearchFound(NOTHING_FOUND);
  }, [full, preambleOpen]);

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

  // Closing: what is typed in a .tex's full screen saved first (D6), then what is typed in a summary or a relation being
  // edited (final review, I1), then the last snapshot, if anything changed since the one before; then the main process
  // may close the window (quitInOrder). The views still open keep their place too.
  useEffect(() => window.cirrus.onQuit(() => {
    keepOpenViews();
    void quitInOrder({
      workbench: () => workbench.current?.flush() ?? Promise.resolve(),
      fields: () => typedFields.commitAll(),
      snapshot: () => saver.current?.flush() ?? Promise.resolve(),
      ready: () => window.cirrus.quitReady(),
      error: (what, e) => console.error(what, e),
    });
  }), []);

  useEffect(() => {
    // What the main process says of the server, heard from now until the sync session listens (B2: sync/useSync.ts).
    const startup = sync.starting();
    void (async () => {
      try {
        // The snapshot and the journal after it (plan 3c); the tables when the snapshot cannot be used. With a server
        // paired, the pending writes too (plan 5a). The server asked first: paired then, it is when the state is read,
        // whose pending writes are then all of them (B2).
        const load = (fromTables: boolean) => window.cirrus.load(fromTables).then((l) => { mark('dataReceived'); return l; });
        const asked = startup.ask();
        const [opened, settings, info] = await Promise.all([openState(load), window.cirrus.getSettings(), asked]);
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
        const p = firstSettings(settings);
        session.current = new EditSession(s, (a, unit) => window.cirrus.commit(a, unit), (st, action, rev) => {
          setShown({ state: st, rev, action });
          // Every action, for the search index (plan 6a, D1); a state read anew is built whole again.
          if (action) searchLog.current?.push(action);
          saver.current?.applied();
          // What the synchronisation applied, for LaTeX's background compilations (plan 5b, D1).
          sync.received.note(action);
        }, opened.seq);
        // Bench and captures work on copies of a base: they keep no snapshot (none would be read again, and saving would
        // weigh on what they measure).
        if (!measuring()) saver.current = new SnapshotSaver(session.current, (data, seq) => window.cirrus.saveSnapshot(data, seq), () => paramsRef.current, opened.stale);
        // The synchronisation (plan 5a): its session made, then started once the state is shown.
        const startSync = startup.attach(session.current, info);
        mark('stateReady');
        setParams(p);
        setTabs(open);
        setActive(current);
        setShown({ state: s, rev: 0, action: null });
        // The startup veil lasts the setting just read: the ref holds it only once rendered (review, Important 3).
        startSync(opened, p.syncConnectTimeoutMs);
      } catch (e) {
        startup.stop();
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => { if (state) saveTabs(tabs); }, [tabs, state]);

  // LaTeX (plan 4b): its state on this PC and the preamble's warm-up (task 7, D2), then the registry the compile
  // requests read (D7, D8), built again after each change of the state (latex/useLatex.ts), which sends what the
  // synchronisations changed to the background (plan 5b, D1).
  const { latex, installLatex } = useLatexStatus(state, setParams);
  const rev = shown?.rev;
  const { registry, texts } = useLatexRegistry(state, rev, params, sync.received);
  const textsRef = useRef(texts);
  textsRef.current = texts;

  // The search index's whole build (plan 6a, D1), once wanted, for this state: by slices in the idle moments, so that
  // neither the first frame nor the window waits for it (about two seconds at 50 000 nodes with long summaries). The
  // actions applied meanwhile are logged from its start, and given to it once done (below).
  useEffect(() => {
    if (!state || !searchWanted || searchBase?.state === state) return;
    searchLog.current = [];
    const job = new SearchBuild(state, textsRef.current), started = performance.now();
    let handle = 0;
    const slice = (idle: IdleDeadline) => {
      const done = job.step(performance.now() + Math.min(SEARCH_SLICE_MS, Math.max(1, idle.timeRemaining())));
      if (!done) { handle = requestIdleCallback(slice, { timeout: 200 }); return; }
      console.log(`Index de recherche construit en ${(performance.now() - started).toFixed(0)} ms (${done.size} objets).`);
      setSearchBase(done);
    };
    handle = requestIdleCallback(slice, { timeout: 200 });
    return () => cancelIdleCallback(handle);
  }, [state, searchWanted, searchBase]);

  // The search index at each change of the state (plan 6a, D1): from the last one, by the actions logged since (their
  // subjects read again) and the .tex read since; null until its whole build is done for this state.
  const searchIndex = useMemo(() => {
    if (!state || !searchBase || searchBase.state !== state) return null;
    const b = builtSearch.current, previous = b && b.base === searchBase ? b.index : searchBase;
    const log = searchLog.current ?? [];
    searchLog.current = [];
    const action = log.length <= 1 ? log[0] : { id: log[log.length - 1].id, label: 'Synchronisation de la recherche', ops: log.flatMap((a) => a.ops) };
    const index = SearchIndex.build(state, texts, previous, action);
    builtSearch.current = { base: searchBase, index };
    return index;
  }, [state, rev, texts, searchBase]);
  /** Where the search is made from: the plan shown, the lobby, the tabs. */
  const lobbyId = state ? [...state.plans.values()].find((p) => p.type === 'lobby')?.id ?? null : null;
  const searchWhere = useMemo<SearchWhere | null>(() => (active && lobbyId ? { plan: active, lobby: lobbyId, tabs } : null), [active, lobbyId, tabs]);

  // The annotations (plan 4c, D4), built again at each change of the state from the last index: what did not change
  // is not read again, and an index where nothing changed is the same (the readers draw nothing again).
  const annotations = useMemo(() => {
    if (!state) return null;
    const built = AnnotationIndex.build(state, builtAnnotations.current ?? undefined);
    builtAnnotations.current = built;
    return built;
  }, [state, rev]);

  /** Captures wait for the first drawn frame; a due snapshot waits for it too (R16). */
  const firstFrame = () => {
    if (readySent.current) return;
    readySent.current = true;
    saver.current?.start();
    // The search index is built now, in the idle moments; bench and captures build it at a first Ctrl+K only.
    if (!measuring()) setSearchWanted(true);
    // The visual checks' drops, clicks and keys (visualChecks.ts), then the page says it is ready.
    void replayLaunch(graph);
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
  // The file in full screen, closed once it is gone (fullIn); rendered again at once then.
  const fullNow = fullIn(state);
  if (fullNow === undefined) return null;
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
  /**
   * A plan's button in a node's pop-up (plan 6a, D2): the node framed in that plan, as a jump; the node gone from it, the
   * plan opens as before. « Aller au nœud », in the pop-up a link opened: this plan if the node is in it, else the lobby or
   * the first plan it is in (destination); in none, or gone since, it says so.
   */
  const showIn = (node: Id, plan: Id) => showNodeIn({ reveal: (t) => graph.current?.reveal(t) ?? false }, openPlan, plan, node);
  const goToNode = (node: Id) => {
    const plan = destination(state, 'node', node, active, tabs);
    if (plan === null) toast('Ce nœud n’est dans aucun plan.');
    else if (!graph.current?.reveal({ plan, id: node, kind: 'node' })) toast(OBJECT_GONE);
  };
  /** The search box closed: nothing ringed any more, the focus back to the graph (plan 6a, D1). */
  const closeSearch = () => {
    setSearchBox(null);
    setSearchFound(NOTHING_FOUND);
    graph.current?.focus();
  };
  /**
   * A result chosen (plan 6a, D2): the jump to its plan, which frames and rings it; an object in no plan (an annotation)
   * opens its pop-up, under the box. Gone since it was listed, it says so.
   */
  const pickResult = (hit: SearchHit) => {
    closeSearch();
    if (hit.plan === null) {
      if (hit.kind === 'node' && resolveTarget(state, { kind: 'node', node: hit.id })) {
        const r = document.querySelector('.graph')?.getBoundingClientRect();
        panels.current?.openNode(hit.id, r ? { x: r.left + r.width / 2 - 190, y: r.top + 80 } : { x: 200, y: 120 });
      } else toast(RESULT_GONE);
      return;
    }
    if (!graph.current?.reveal({ plan: hit.plan, id: hit.id, kind: hit.kind })) toast(RESULT_GONE);
  };
  /** An edit from a pop-up, through the session like the graph's: a refusal is reported, and the pop-up told (false). */
  const edit = (build: Build): Promise<boolean> => (build ? session.current!.run(build).then((r) => { report(r); return r.ok; }) : Promise.resolve(true));
  /**
   * A passage annotated in a reader (plan 4c, D3): a node of its own, in no plan, its title the start of the passage
   * (annotationTitleChars), one action. Too long a passage is refused, said in a notification (false: the selection
   * stays); so is a PDF gone meanwhile (createAnnotation's refusal). Made in the full screen, the step is its own: its
   * Ctrl+Z undoes it there.
   */
  const annotate = (a: Anchor, inFull: boolean): boolean => {
    const refusal = anchorRefusal(a);
    if (refusal) { toast(refusal); return false; }
    const title = annotationTitle(a.text, titleChars(paramsRef.current.annotationTitleChars));
    void session.current!.run((s) => createAnnotation(s, a, title)).then((r) => {
      if (r.ok && inFull) fullSteps.current.add(r.action.id);
      report(r);
    });
    return true;
  };
  /**
   * An annotation deleted by its line's menu (final review, I2), in a reader's margin or a PDF's pop-up: everywhere,
   * one action (deleteAnnotationBuild). Made in the full screen, the step is its own: its Ctrl+Z and Ctrl+Y undo and
   * redo it there, as an annotation made there.
   */
  const deleteAnnotation = (node: Id, inFull: boolean) => {
    void session.current!.run(deleteAnnotationBuild(node)!).then((r) => {
      if (r.ok && inFull) fullSteps.current.add(r.action.id);
      report(r);
    });
  };
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
        chip={sync.view.chip && <SyncChip chip={sync.view.chip} onRetry={sync.retry} />}
      />
      <div className="main">
        <GraphBoundary plan={active}>
          <GraphView
            state={state} rev={shown.rev} action={shown.action} plan={active} params={params} onFirstFrame={firstFrame} session={session.current}
            onResult={(r) => report(r)} onLongNotice={(text) => toast(text, true)} onOpenPlan={openPlan}
            onOpenNode={(id, at) => panels.current?.openNode(id, at)} onClickAway={() => panels.current?.closeLoose()}
            onDropFiles={files.importInto} registry={registry} onNodeLink={nodeLink} tabs={tabs} ref={graph}
            found={searchBox ? searchFound : NOTHING_FOUND}
            overlay={searchBox && searchWhere && (
              <SearchBox
                asked={searchBox.asked} index={searchIndex} state={state} where={searchWhere} max={params.searchMaxResults}
                onPick={pickResult} onClose={closeSearch} onFound={setSearchFound}
              />
            )}
          />
        </GraphBoundary>
        {panel && (
          <SettingsPanel
            // Key by key, from the latest settings (review of task 6, Important 1); « Tout réinitialiser »: every default.
            params={params} onChange={(key, v) => setParams(withSetting(key, v))} onResetAll={() => setParams(withOverrides({}))}
            onClose={() => setPanel(false)} latex={latex} onInstallLatex={installLatex}
            onEditPreamble={() => setPreambleOpen(true)} server={sync.serverBlock}
          />
        )}
        <Panels
          ref={panels} state={state} rev={shown.rev} action={shown.action} params={params} onEdit={edit} onShowIn={showIn} onGoToNode={goToNode} files={files}
          views={views} fullHash={fullNow?.file?.hash ?? null} onFullScreen={(node, name) => setFull({ kind: 'file', node, name })} registry={registry}
          onNodeLink={nodeLink} covered={preambleOpen} annotations={annotations} onAnnotate={(a) => annotate(a, false)}
          onDeleteAnnotation={(node) => deleteAnnotation(node, false)} onCompare={(node, original, copy) => setFull({ kind: 'compare', node, original, copy })}
        />
        <Toasts toasts={toasts} onClose={closeToast}>
          <LatexNotice status={latex} toastMs={params.toastMs} onInstall={installLatex} />
        </Toasts>
      </div>
      {fullNow?.file && !fullNow.copy && (
        // A full screen that fails says so over the window, which stays (PanelBoundary); closed, it is tried again next time.
        <PanelBoundary
          what={`Plein écran de « ${fullNow.file.name} »`} fallback={<FullScreenFailed name={fullNow.file.name} onClose={() => setFull(null)} />}
        >
          <FullScreen
            node={fullNow.node} file={fullNow.file} params={params} views={views} onClose={() => setFull(null)} onSystem={files.openWithSystem}
            nodeTitle={(id) => { const n = resolveTarget(state, { kind: 'node', node: id })?.node; return n ? n.title || 'Sans titre' : null; }}
            annotations={annotations} onAnnotate={(a) => annotate(a, true)} onDeleteAnnotation={(node) => deleteAnnotation(node, true)}
            tex={{
              state, registry, workbench, onNotice: (text) => toast(text),
              onSave: (text, base) => saveTex(session.current!, (name, t) => window.cirrus.storeText(name, t), fullNow.node.id, fullNow.file!.name, text, base),
            }}
          />
        </PanelBoundary>
      )}
      {fullNow?.copy && (
        // The comparison of a .tex with its conflict copy (plan 5b, D7): over the window as a file's full screen is.
        <PanelBoundary
          what={`Comparaison de « ${fullNow.file.name} »`} fallback={<FullScreenFailed name={`Comparaison de « ${fullNow.file.name} »`} onClose={() => setFull(null)} />}
        >
          <Suspense fallback={null}>
            <CompareView
              ref={workbench} node={fullNow.node} original={fullNow.file} copy={fullNow.copy} params={params} onNotice={(text) => toast(text)}
              onSave={(text, base, removeCopy) => reconcileTex(
                session.current!, (name, t) => window.cirrus.storeText(name, t), fullNow.node.id, fullNow.file.name, text,
                { removeCopy: removeCopy ?? undefined, base },
              )}
              onClose={() => setFull(null)}
            />
          </Suspense>
        </PanelBoundary>
      )}
      {preambleOpen && (
        <PanelBoundary what="Préambule LaTeX" fallback={<FullScreenFailed name="Préambule LaTeX" onClose={() => setPreambleOpen(false)} />}>
          <Suspense fallback={null}>
            <PreambleEditor
              state={state} params={params} views={views} onClose={() => setPreambleOpen(false)} onSave={(text) => edit(preambleBuild(text))}
            />
          </Suspense>
        </PanelBoundary>
      )}
      {sync.view.veil && <SyncVeil />}
    </div>
  );
}
