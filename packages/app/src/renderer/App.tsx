import { type Action, type Anchor, annotationTitle, createAnnotation, type Id, type State } from '@cirrus/core';
import { withOverrides } from '@cirrus/view';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportResult } from '../main/files.ts';
import { type Build, deleteAnnotationBuild, preambleBuild } from './actions.ts';
import { mark } from './bench.ts';
import { anchorRefusal, AnnotationIndex, titleChars } from './files/annotations.ts';
import { addImported, type NodeFiles, openNotice, type Refusal, refusesStrayDrop } from './files/nodeFiles.ts';
import { loading } from './files/read.ts';
import { ViewStates } from './files/viewState.ts';
import { textOwnsKeys } from './keys.ts';
import { useLatexRegistry, useLatexStatus } from './latex/useLatex.ts';
import { quitInOrder, typedFields } from './quit.ts';
import { withSetting } from './settingChanges.ts';
import { liveTabs, loadTabs, saveTabs } from './tabs.ts';
import { guardClicks } from './ui/clickGuard.ts';
import { FullScreen, FullScreenFailed } from './ui/FullScreen.tsx';
import { LatexNotice } from './ui/latex/LatexNotice.tsx';
import { saveTex } from './ui/latex/saveScheduler.ts';
import { GraphBoundary } from './ui/GraphBoundary.tsx';
import { type GraphHandle, GraphView } from './ui/GraphView.tsx';
import { PanelBoundary } from './ui/PanelBoundary.tsx';
import type { Rect } from './ui/panels/geometry.ts';
import { Panels, type PanelsHandle, resolveTarget } from './ui/panels/Panels.tsx';
import { useScreens } from './ui/screens.ts';
import { keepOpenViews } from './ui/viewers/common.tsx';
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
/** The preamble's full screen, with CodeMirror and pdf.js, in its own chunk (as the .tex workbench: FullScreen.tsx). */
const PreambleEditor = lazy(() => loading(import('./ui/latex/PreambleEditor.tsx')).then((m) => ({ default: m.PreambleEditor })));
/** Bench and captures work on copies of a base: they keep no snapshot (none would be read again, and saving would weigh on what they measure). */
const measuring = window.cirrus.launch.bench !== undefined || window.cirrus.launch.capture === true;
// What changes from one build of the test base to the next (a node's identifier) is not drawn in a capture (`.volatile`),
// nor the text cursor, which blinks (plan 4b, task 8), so that the captures repeat to the pixel.
if (window.cirrus.launch.capture) document.documentElement.classList.add('capture');

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
  /** What is open over the graph: the settings panel, a file's full screen and its own steps, the preamble's (ui/screens.ts). */
  const { panel, setPanel, setFull, fullRef, workbench, preambleOpen, setPreambleOpen, preambleRef, fullSteps, fullIn } = useScreens();
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
          saver.current?.applied();
        }, opened.seq);
        if (!measuring) saver.current = new SnapshotSaver(session.current, (data, seq) => window.cirrus.saveSnapshot(data, seq), () => paramsRef.current, opened.stale);
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
  // requests read (D7, D8), built again after each change of the state (latex/useLatex.ts).
  const { latex, installLatex } = useLatexStatus(state, setParams);
  const rev = shown?.rev;
  const registry = useLatexRegistry(state, rev, params);

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
            onDropFiles={files.importInto} registry={registry} onNodeLink={nodeLink} ref={graph}
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
          ref={panels} state={state} rev={shown.rev} action={shown.action} params={params} onEdit={edit} onOpenPlan={openPlan} files={files}
          views={views} fullHash={fullNow?.file?.hash ?? null} onFullScreen={(node, name) => setFull({ kind: 'file', node, name })} registry={registry}
          onNodeLink={nodeLink} covered={preambleOpen} annotations={annotations} onAnnotate={(a) => annotate(a, false)}
          onDeleteAnnotation={(node) => deleteAnnotation(node, false)}
        />
        <Toasts toasts={toasts} onClose={closeToast}>
          <LatexNotice status={latex} toastMs={params.toastMs} onInstall={installLatex} />
        </Toasts>
      </div>
      {fullNow?.file && (
        // A full screen that fails says so over the window, which stays (PanelBoundary); closed, it is tried again next time.
        <PanelBoundary
          what={`Plein écran de « ${fullNow.file.name} »`} fallback={<FullScreenFailed name={fullNow.file.name} onClose={() => setFull(null)} />}
        >
          <FullScreen
            node={fullNow.node} file={fullNow.file} params={params} views={views} onClose={() => setFull(null)} onSystem={files.openWithSystem}
            nodeTitle={(id) => { const n = resolveTarget(state, { kind: 'node', node: id })?.node; return n ? n.title || 'Sans titre' : null; }}
            annotations={annotations} onAnnotate={(a) => annotate(a, true)} onDeleteAnnotation={(node) => deleteAnnotation(node, true)}
            tex={{
              state, registry, workbench,
              onSave: (text) => saveTex(session.current!, (name, t) => window.cirrus.storeText(name, t), fullNow.node.id, fullNow.file!.name, text),
            }}
          />
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
