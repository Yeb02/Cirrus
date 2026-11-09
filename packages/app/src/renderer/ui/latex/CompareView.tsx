import type { FileRef, NodeRec } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { MergeView } from '@codemirror/merge';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { loading } from '../../files/read.ts';
import { AskDialog } from '../Dialogs.tsx';
import { useModal } from '../FullScreen.tsx';
import { Banner, Notice, readFailure } from '../viewers/common.tsx';
import { languageFor, PHRASES_FR } from '../viewers/language.ts';
import { THEME } from '../viewers/TextViewer.tsx';
import {
  abandonQuestion, closingSave, compareTitle, copyKeptNotice, copyNotLoaded, copyReloadedNotice, originalNotLoaded, type ReconcileAnswer, readCompared,
  readNewVersion, Reconciliation,
} from './compare.ts';
import { loadText } from './editorLoad.ts';
import { changedElsewhere, keptNotice, reloadedNotice } from './saveScheduler.ts';
import type { WorkbenchHandle } from './TexWorkbench.tsx';

/** CodeMirror's texts in French (PHRASES_FR) and the merge view's own: the folded lines, the arrow of a block. */
const PHRASES = { ...PHRASES_FR, '$ unchanged lines': '$ lignes identiques', 'Revert this chunk': 'Reprendre ce bloc de la copie' };

/** A change made by the comparison itself (a new version of the original loaded), not by the user: not told back. */
const fromOutside = Annotation.define<boolean>();

/** What the comparison shows: reading, why it cannot be shown, or the two texts. */
type Shown = { message: string } | { texts: { a: string; b: string } } | null;

/**
 * A .tex compared with its conflict copy, in full screen (plan 5b, D7; spec 6.2), modal as the preamble's (useModal):
 * @codemirror/merge's MergeView, the original on the left, editable (`a`), the copy on the right, read-only (`b`), both
 * coloured as LaTeX like the .tex editor's. The blocks that differ are coloured, and an arrow between the two takes a
 * block of the copy into the original (`revertControls: 'b-to-a'`); the identical lines are folded (compareContextLines,
 * compareFoldMinLines). Both texts are read by readHead and decoded as the .tex full screen's are (readCompared); a file
 * above textViewMaxMb is not compared (« Trop grand pour être comparé ici. »), nor edited.
 *
 * « Enregistrer » writes the original (`onSave`, one action « Réconcilier « x.tex » »), « Enregistrer et retirer la copie »
 * also takes the copy shown out of the node — a copy changed elsewhere meanwhile stays, which a notification says; both
 * close the comparison once saved, and Ctrl+Z in the graph undoes the action. Refused — the node or a file gone —, the
 * comparison stays and says why. Escape or ×, with blocks taken, ask « Abandonner la réconciliation ? ». It answers App
 * through the same handle as the .tex workbench (`dirty`); its `flush`, as the window closes, saves the blocks taken as
 * « Enregistrer » does (closingSave: the copy stays), so that closing the window never drops them (task 8a).
 *
 * The original changed elsewhere meanwhile (`original` is the file as the state holds it) follows the .tex full screen's
 * rule (D6, Reconciliation): with nothing taken, its new version is loaded, with a notification; else the text stays, the
 * banner says that version will be kept under its conflict name, and the save does so, which a notification says too.
 * The copy changed elsewhere (`copy`, as the state holds it) is shown in its new version, read-only, with a notification.
 */
export function CompareView(props: {
  node: NodeRec; original: FileRef; copy: FileRef; params: RenderParams;
  /**
   * `text`: the original with the blocks taken, null when none was; `base`: the hash it was made from; `removeCopy`:
   * « … et retirer la copie », the copy as shown (its name, the hash of the version on the right), else null.
   */
  onSave(text: string | null, base: string | null, removeCopy: Pick<FileRef, 'name' | 'hash'> | null): Promise<ReconcileAnswer>;
  onNotice(text: string): void; onClose(): void; ref?: Ref<WorkbenchHandle>;
}) {
  const { node, original, copy } = props;
  const [shown, setShown] = useState<Shown>(null);
  const [state, setState] = useState({ dirty: false, elsewhere: false });
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MergeView | null>(null);
  const model = useRef<Reconciliation | null>(null);
  /** The hash of the copy's version shown on the right: the one « … et retirer la copie » removes. */
  const shownCopy = useRef(copy.hash);
  /** The save under way, « Enregistrer » or the window's closing: the other waits for it. */
  const pending = useRef<Promise<unknown> | null>(null);
  /** The original's history, in a compartment: a version from elsewhere loaded empties it (loadText). */
  const historyOf = useRef<Compartment | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const savingNow = useRef(false);
  const askingNow = useRef(false);
  askingNow.current = asking;

  /** What the model says, told to the screen. */
  const sync = () => {
    const m = model.current;
    if (m) setState((s) => (s.dirty === m.dirty && s.elsewhere === m.elsewhere ? s : { dirty: m.dirty, elsewhere: m.elsewhere }));
  };

  // The two texts, read and decoded.
  useEffect(() => {
    const stop = new AbortController();
    void loading((async () => {
      try {
        const r = await readCompared(original, copy, latest.current.params.textViewMaxMb, stop.signal);
        if (stop.signal.aborted) return;
        if (!('message' in r)) model.current = new Reconciliation(r.a, original.hash);
        setShown('message' in r ? r : { texts: r });
      } catch (e) {
        if (!stop.signal.aborted) setShown({ message: readFailure(original.name, e) });
      }
    })());
    return () => stop.abort();
  }, []);

  // The merge view, built once the texts are in; left, it is destroyed. Nothing typed is saved on the way out.
  const texts = shown !== null && 'texts' in shown ? shown.texts : null;
  useEffect(() => {
    if (!texts) return;
    const p = latest.current.params;
    const language = new Compartment(), histories = new Compartment();
    historyOf.current = histories;
    const common: Extension[] = [
      EditorState.phrases.of(PHRASES), lineNumbers(), highlightSpecialChars(), bracketMatching(), search({ top: true }), highlightSelectionMatches(),
      syntaxHighlighting(classHighlighter), language.of([]), EditorView.lineWrapping, THEME,
    ];
    const mv = new MergeView({
      a: {
        doc: texts.a,
        extensions: [
          common, histories.of(history()),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { void finish(false); return true; } },
            ...searchKeymap, ...historyKeymap, ...defaultKeymap.filter((b) => b.key !== 'Escape'),
          ]),
          EditorView.contentAttributes.of({ 'aria-label': `${latest.current.original.name} (original)`, spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((t) => t.annotation(fromOutside))) return;
            model.current?.edit(u.state.doc.toString());
            sync();
          }),
        ],
      },
      b: {
        doc: texts.b,
        extensions: [
          common, EditorState.readOnly.of(true),
          keymap.of([...searchKeymap, ...defaultKeymap.filter((b) => b.key !== 'Escape')]),
          EditorView.contentAttributes.of({ 'aria-label': `${latest.current.copy.name} (copie)`, spellcheck: 'false' }),
        ],
      },
      parent: host.current!,
      orientation: 'a-b',
      revertControls: 'b-to-a',
      highlightChanges: true,
      collapseUnchanged: { margin: p.compareContextLines, minSize: p.compareFoldMinLines },
    });
    view.current = mv;
    mv.a.focus();
    let live = true;
    // A language that could not be loaded leaves both texts uncoloured.
    const desc = languageFor(latest.current.original.name);
    if (desc) {
      void loading(desc.load()).then(
        (support) => {
          if (!live) return;
          mv.a.dispatch({ effects: language.reconfigure(support) });
          mv.b.dispatch({ effects: language.reconfigure(support) });
        },
        (e: unknown) => console.error('Langage LaTeX de la comparaison :', e),
      );
    }
    return () => { live = false; mv.destroy(); view.current = null; };
  }, [texts]);

  // The original as the state holds it, at each new version (D6): read again and loaded when nothing is taken, else kept
  // for the save. Typed meanwhile, a version read is not loaded: the next pass (the text is dirty now) keeps it.
  useEffect(() => {
    const m = model.current, mv = view.current;
    if (!m || !mv) return;
    const wanted = m.arrived(original.hash) === 'reload';
    sync();
    if (!wanted) return;
    const stop = new AbortController(), name = original.name, hash = original.hash;
    void (async () => {
      const r = await readNewVersion(original, latest.current.params.textViewMaxMb, stop.signal);
      const histories = historyOf.current;
      if (stop.signal.aborted || model.current !== m || view.current !== mv || !histories) return;
      // Too big to be compared here, or unreadable: the text shown stays, and that version is kept (originalNotLoaded).
      if ('not' in r) {
        latest.current.onNotice(originalNotLoaded(name, r.not));
        return;
      }
      // The model and the original's editor take it in this one call, the cursor kept, out of the history, emptied
      // (loadText): no keystroke lands between them on the old text, and Ctrl+Z never brings that text back (fix round 1
      // of the review of task 5).
      if (!m.reloaded(r.text, hash)) return;
      for (const spec of loadText(mv.a.state, r.text, histories, history(), [fromOutside.of(true)])) mv.a.dispatch(spec);
      sync();
      latest.current.onNotice(reloadedNotice(name));
    })();
    return () => stop.abort();
  }, [original.hash, state.dirty, texts]);

  // The copy as the state holds it, at each new version (task 8a): read again and shown on the right, read-only, so that
  // « … et retirer la copie » removes what is shown. Not shown (too big, unreadable), the right side stays, and the copy
  // is never removed for it: its hash is not the one shown.
  useEffect(() => {
    const mv = view.current;
    if (!mv || copy.hash === shownCopy.current) return;
    const stop = new AbortController(), name = copy.name, hash = copy.hash;
    void (async () => {
      const r = await readNewVersion(copy, latest.current.params.textViewMaxMb, stop.signal);
      if (stop.signal.aborted || view.current !== mv) return;
      if ('not' in r) {
        latest.current.onNotice(copyNotLoaded(name, r.not));
        return;
      }
      mv.b.dispatch({ changes: { from: 0, to: mv.b.state.doc.length, insert: r.text }, annotations: fromOutside.of(true) });
      shownCopy.current = hash;
      latest.current.onNotice(copyReloadedNotice(name));
    })();
    return () => stop.abort();
  }, [copy.hash, texts]);

  /** Saves and closes: « Enregistrer » (`removeCopy` false) or « Enregistrer et retirer la copie ». Refused, it stays and says why. */
  const finish = async (removeCopy: boolean) => {
    const m = model.current, mv = view.current;
    if (!m || !mv || savingNow.current || askingNow.current) return;
    // Nothing taken: there is nothing to write.
    if (!m.dirty && !removeCopy) { latest.current.onClose(); return; }
    savingNow.current = true;
    setSaving(true);
    setFailure(null);
    const text = m.dirty ? mv.a.state.doc.toString() : null;
    let r: ReconcileAnswer;
    const saved = (async () => latest.current.onSave(text, m.base, removeCopy ? { name: latest.current.copy.name, hash: shownCopy.current } : null))();
    // The window's closing (flush) waits for it.
    pending.current = saved.catch(() => {});
    try {
      r = await saved;
    } catch (e) {
      console.error('Enregistrement de la réconciliation :', e);
      r = { ok: false, message: 'enregistrement impossible' };
    }
    pending.current = null;
    savingNow.current = false;
    setSaving(false);
    if (r.ok) {
      if (text !== null) m.wrote(text, r.hash);
      if (r.kept !== undefined) latest.current.onNotice(keptNotice(latest.current.original.name, r.kept));
      if (r.copyKept !== undefined) latest.current.onNotice(copyKeptNotice(r.copyKept));
      latest.current.onClose();
    } else setFailure(r.message ?? 'enregistrement refusé');
  };

  /** The window closing (App's quitInOrder): a save under way waited for, then the blocks taken saved as « Enregistrer » (closingSave). */
  const flush = async () => {
    await pending.current;
    const m = model.current;
    if (!m) return;
    const r = await closingSave(m, (text, base, removeCopy) => latest.current.onSave(text, base, removeCopy));
    if (r && !r.ok) console.error(`Réconciliation de « ${latest.current.original.name} » non enregistrée à la fermeture : ${r.message ?? 'enregistrement refusé'}`);
  };

  const leave = () => {
    if (askingNow.current || savingNow.current) return;
    if (model.current?.dirty) setAsking(true);
    else latest.current.onClose();
  };
  const close = useRef(leave);
  close.current = leave;
  useModal(root, close);
  useImperativeHandle(props.ref, () => ({
    get dirty() { return model.current?.dirty ?? false; },
    flush: () => flush(),
    requestClose: () => leave(),
  }), []);

  const title = compareTitle(original.name, copy.name);
  const ready = texts !== null;
  const lines = [state.elsewhere ? changedElsewhere(original.name) : null, failure !== null ? `Non enregistré : ${failure}` : null].filter((x): x is string => x !== null);
  return (
    <div ref={root} className="full-screen compare-view" tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
      <header>
        <span className="name" title={title}>{title}</span>
        <span className="node" title={node.title}>{node.title}</span>
        <span className="spacer" />
        {ready && <button className="system" disabled={saving} onClick={() => { void finish(false); }}>Enregistrer</button>}
        {ready && <button className="system save" disabled={saving} onClick={() => { void finish(true); }}>Enregistrer et retirer la copie</button>}
        <button className="close" title="Quitter la comparaison (Échap)" onClick={() => leave()}>×</button>
      </header>
      {shown === null && <Notice text="Lecture…" />}
      {shown !== null && 'message' in shown && <Notice text={shown.message} />}
      {ready && (
        <div className="compare-body">
          <Banner lines={lines} />
          <div className="compare-sides">
            <span title={original.name}>Original, modifiable</span>
            <span title={copy.name}>Copie de conflit, lecture seule</span>
          </div>
          <div ref={host} className="compare-host" />
        </div>
      )}
      {asking && <AskDialog q={abandonQuestion(original.name, () => latest.current.onClose())} onClose={() => setAsking(false)} />}
    </div>
  );
}
