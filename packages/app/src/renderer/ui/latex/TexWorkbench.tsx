import type { FileRef, Id, NodeRec, State } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ViewRef } from '../../files/kind.ts';
import { loading } from '../../files/read.ts';
import type { ViewStates } from '../../files/viewState.ts';
import { type LatexRegistry, type Origin, slotOf } from '../../latex/registry.ts';
import { buildRequest } from '../../latex/request.ts';
import { knownLabels } from '../../latex/scheduler.ts';
import { useCompiled } from '../../latex/useCompiled.ts';
import { AskDialog } from '../Dialogs.tsx';
import { Banner, BINARY, Message, Notice, readFailure } from '../viewers/common.tsx';
import { PdfViewer } from '../viewers/PdfViewer.tsx';
import { TextViewer } from '../viewers/TextViewer.tsx';
import { CompileLog, errorText } from './CompileLog.tsx';
import { diagnosticsFor, lineStartOf } from './editorLogic.ts';
import { LatexEditor, type LatexEditorHandle } from './LatexEditor.tsx';
import {
  changedElsewhere, keptNotice, openedElsewhere, reloadedNotice, type SaveAnswer, SaveScheduler, type SaveState, unsavedQuestion,
} from './saveScheduler.ts';
import { readTexText } from './texText.ts';

/** What App and FullScreen ask of the workbench open: whether its text is unsaved, its last save (closing the window), its leaving. */
export interface WorkbenchHandle {
  readonly dirty: boolean;
  flush(): Promise<void>;
  /** Escape or ×: what is typed saved first; refused, the full screen stays, and a second request asks. */
  requestClose(): void;
}

const timers = { set: (fn: () => void, ms: number) => window.setTimeout(fn, ms), clear: (h: unknown) => window.clearTimeout(h as number) };

/** The file as it opened: its text to edit; too long, shown without being editable; binary or unreadable, why. */
type Opened = { text: string } | { tooLong: string } | { message: string };

/** The file read and decoded as the comparison reads it too (readTexText), its line breaks « \n »; cut by `maxMb`, or binary, why. */
async function readOpened(file: FileRef, maxMb: number, signal: AbortSignal): Promise<Opened> {
  const r = await readTexText(file, maxMb, signal);
  if ('binary' in r) return { message: BINARY };
  if ('tooLong' in r) return { tooLong: `Plus de ${maxMb.toLocaleString('fr-FR')} Mo : ce fichier ne se modifie pas dans Cirrus.` };
  return r;
}

/**
 * A .tex in full screen (plan 4b, D6; spec 12): the LaTeX editor on the left, the compiled preview on the right — the
 * last good PDF (PdfViewer, live), compiled as typed under its own slot (`draft:<slot>`, so that it never cancels the
 * saved source's views), at the typing pause —, a banner over them: the compilation (« Compilation… », « Erreur ligne
 * 12 : … ») and the save (« Enregistré », « Non enregistré : … »), and « Journal », which opens CompileLog (a click on
 * the error takes the editor to its line). The file is read by readHead and decoded (readOpened: at opening, and for a
 * version from elsewhere), its line breaks as the
 * editor reads them (« \n »): a text cut by textViewMaxMb, or a binary, is shown without being editable, with why.
 * The text is saved by `onSave` (SaveScheduler: at the pause of texSaveIdleMs, Ctrl+S, closing); leaving goes through
 * requestClose, and App flushes it before the window closes. A link to a node clicked in the preview goes to
 * `onNodeLink` (the full screen's: plan 4b, task 6). The preview is given the same props while the text is typed, so
 * that typing does not draw it again (task 5 review).
 *
 * Elsewhere (plan 5b, D6): opened, the .tex is told to the main process (texOpened, then texClosed as it goes), and
 * another PC that has it open is said in the banner (« Ce .tex est ouvert sur « Portable » depuis 14h32 : … »; offline,
 * nothing). Its file as the state holds it (`file`, followed by name) is watched (SaveScheduler.arrived): a version from
 * elsewhere is read again and replaces the text when nothing is unsaved, the cursor kept, with a notification
 * (`onNotice`); with unsaved text, the text stays, the banner says that version will be kept under its conflict name,
 * and the next save does so (saveTex, from the version the text was made from), which a notification says too.
 */
export function TexWorkbench(props: {
  node: NodeRec; file: FileRef; state: State; registry: LatexRegistry; params: RenderParams; views: ViewStates;
  onSave(text: string, base: string | null): Promise<SaveAnswer>; onNotice(text: string): void; onClose(): void; onNodeLink?(node: Id): void;
  ref?: Ref<WorkbenchHandle>;
}) {
  const { node, file, params, registry } = props;
  const [opened, setOpened] = useState<Opened | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveState>({ dirty: false, saving: false, saved: false, failure: null, elsewhere: false });
  /** Another PC that has this .tex open, as the banner says it (D6). */
  const [presence, setPresence] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [jump, setJump] = useState<{ line: number; seq: number } | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const scheduler = useRef<SaveScheduler | null>(null);
  /** The editor, which a version from elsewhere is loaded into at once (LatexEditorHandle.load). */
  const editor = useRef<LatexEditorHandle | null>(null);
  /** Where leaving stands: a flush under way, or refused once (the next request asks). */
  const leaving = useRef<'no' | 'flushing' | 'refused'>('no');
  const askingNow = useRef(false);
  askingNow.current = asking;

  useEffect(() => {
    const stop = new AbortController();
    void loading((async () => {
      try {
        const o = await readOpened(file, latest.current.params.textViewMaxMb, stop.signal);
        if (stop.signal.aborted) return;
        if (!('text' in o)) { setOpened(o); return; }
        // Each save from the version the text was made from (D6); one that kept the version from elsewhere says so.
        const save = async (x: string, base: string | null) => {
          const r = await latest.current.onSave(x, base);
          if (r.kept !== undefined) latest.current.onNotice(keptNotice(latest.current.file.name, r.kept));
          return r;
        };
        const s = new SaveScheduler(o.text, save, timers, () => latest.current.params.texSaveIdleMs, file.hash);
        scheduler.current = s;
        s.onState(setSaving);
        setText(o.text);
        setOpened(o);
      } catch (e) {
        if (!stop.signal.aborted) setOpened({ message: readFailure(file.name, e) });
      }
    })());
    return () => {
      stop.abort();
      // Left otherwise than by requestClose (App, its file gone with nothing typed): what is typed is saved still.
      const s = scheduler.current;
      scheduler.current = null;
      if (s) {
        void s.flush();
        s.dispose();
      }
    };
  }, []);

  // Opened here, told to the main process, which answers with another PC that has it open (D6); closed as it goes.
  useEffect(() => {
    let live = true;
    const id = node.id, name = file.name;
    window.cirrus.texOpened(id, name).then(
      (o) => { if (live && o) setPresence(openedElsewhere(o.pc, o.since, Date.now())); },
      (e: unknown) => console.warn(`Présence de « ${name} » :`, e),
    );
    return () => {
      live = false;
      window.cirrus.texClosed(id, name);
    };
  }, []);

  // The file as the state holds it, at each new version, and once a save ends (D6): a version from elsewhere is read
  // again when nothing is unsaved (SaveScheduler.arrived), then replaces the text, unless something was typed meanwhile
  // — the next pass then keeps it for the save. Binary or too long now, it is shown as it would open.
  useEffect(() => {
    const s = scheduler.current;
    if (!s || s.arrived(file) !== 'reload') return;
    const stop = new AbortController(), name = file.name, hash = file.hash;
    void (async () => {
      let o: Opened;
      try {
        o = await readOpened(file, latest.current.params.textViewMaxMb, stop.signal);
      } catch (e) {
        // Not read (its bytes not to be had now): the text stays, and a save made from it keeps that version beside it.
        if (stop.signal.aborted) return;
        console.error(`Lecture de « ${name} » :`, e);
        latest.current.onNotice(`« ${name} » a été modifié sur un autre PC, mais sa nouvelle version n’a pas pu être lue.`);
        return;
      }
      if (stop.signal.aborted || scheduler.current !== s) return;
      if (!('text' in o)) {
        if (s.dirty) return;
        scheduler.current = null;
        s.dispose();
        setOpened(o);
        return;
      }
      // The scheduler and the editor take it in this one call: no keystroke lands between them on the old text, and the
      // editor's Ctrl+Z never brings that text back (fix round 1 of the review, Important 1).
      if (!s.reloaded(o.text, hash)) return;
      editor.current?.load(o.text);
      setText(o.text);
      latest.current.onNotice(reloadedNotice(name));
    })();
    return () => stop.abort();
  }, [file.hash, opened, saving.saving, saving.dirty]);

  const requestClose = async () => {
    if (askingNow.current || leaving.current === 'flushing') return;
    const s = scheduler.current;
    if (!s) { latest.current.onClose(); return; }
    const refusedBefore = leaving.current === 'refused';
    leaving.current = 'flushing';
    await s.flush();
    if (!s.dirty) {
      leaving.current = 'no';
      latest.current.onClose();
      return;
    }
    // Refused: the banner says why; the full screen stays, and a second request asks.
    leaving.current = 'refused';
    if (refusedBefore) setAsking(true);
  };
  useImperativeHandle(props.ref, () => ({
    get dirty() { return scheduler.current?.dirty ?? false; },
    flush: () => scheduler.current?.flush() ?? Promise.resolve(),
    requestClose: () => { void requestClose(); },
  }), []);

  const origin = useMemo<Origin>(() => ({ kind: 'file', node: node.id, name: file.name }), [node.id, file.name]);
  const slot = slotOf(origin);
  // The draft's request, under its own slot; the saved source's labels until the draft has its own (knownLabels).
  const req = useMemo(() => {
    if (text === null) return null;
    const r = buildRequest({ origin, source: text, s: props.state, registry, known: knownLabels(slot), widthCm: params.latexSnippetWidthCm });
    return { ...r, slot: `draft:${r.slot}` };
  }, [text, registry, origin]);
  const view = useCompiled(req, params.latexTypingPauseMs);
  const diagnostics = useMemo(
    () => (text === null || req === null ? [] : diagnosticsFor(registry.scanOf(origin, text), req, registry, origin, view.error, (n) => lineStartOf(text, n))),
    [req, view.error],
  );
  const live = useMemo(() => ({ keptAs: `latex:${slot}` }), [slot]);
  const onNodeLink = useCallback((id: Id) => latest.current.onNodeLink?.(id), []);
  const pdf = useMemo<ViewRef | null>(
    () => (view.pdf ? { name: `${file.name.replace(/\.tex$/i, '')}.pdf`, hash: view.pdf.key, size: view.pdf.size, store: 'latex' } : null),
    [view.pdf?.key],
  );

  if (opened === null) return <Notice text="Lecture…" />;
  if ('message' in opened) return <Notice text={opened.message} />;
  if ('tooLong' in opened) {
    return (
      <div className="tex-workbench">
        <Banner lines={[opened.tooLong]} />
        <TextViewer file={file} params={params} views={props.views} mode="full" wrap={false} />
      </div>
    );
  }
  const compile = view.unavailable ? view.unavailable.message : view.pending ? 'Compilation…' : view.error ? errorText(view.error) : '';
  const saved = saving.failure !== null ? `Non enregistré : ${saving.failure}` : saving.saving ? 'Enregistrement…' : saving.saved && !saving.dirty ? 'Enregistré' : '';
  // What another PC has to do with it (D6): open there, changed there while the text here is unsaved.
  const elsewhere = [presence, saving.elsewhere ? changedElsewhere(file.name) : null].filter((x): x is string => x !== null);
  return (
    <div className="tex-workbench">
      <div className="tex-status" role="status">
        <span className={`compile${!view.pending && (view.error || view.unavailable) ? ' bad' : ''}`}>{compile}</span>
        <span className="spacer" />
        <span className={`save${saving.failure !== null ? ' bad' : ''}`}>{saved}</span>
        <button className={logOpen ? 'log on' : 'log'} title="Journal de compilation" onClick={() => setLogOpen((o) => !o)}>Journal</button>
      </div>
      <Banner lines={elsewhere} />
      <div className="tex-panes">
        <div className="tex-source">
          <LatexEditor
            ref={editor} value={text!} registry={registry} diagnostics={diagnostics} params={params} autoFocus ariaLabel={file.name} jumpTo={jump}
            onChange={(t) => { setText(t); scheduler.current?.edit(t); }}
            onSave={() => { void scheduler.current?.saveNow(); }}
          />
        </div>
        <div className="tex-preview">
          {pdf
            ? <PdfViewer file={pdf} params={params} views={props.views} mode="preview" live={live} onNodeLink={onNodeLink} />
            : <Message text={view.unavailable?.message ?? (view.error && !view.pending ? errorText(view.error) : 'Compilation…')} />}
          {logOpen && (
            <CompileLog
              log={view.log} error={view.error} onClose={() => setLogOpen(false)}
              onJump={(line) => { setLogOpen(false); setJump((j) => ({ line, seq: (j?.seq ?? 0) + 1 })); }}
            />
          )}
        </div>
      </div>
      {asking && (
        <AskDialog
          onClose={() => setAsking(false)}
          q={unsavedQuestion(file.name, saving.failure, () => {
            scheduler.current?.dispose();
            scheduler.current = null;
            latest.current.onClose();
          })}
        />
      )}
    </div>
  );
}
