import { DEFAULT_PREAMBLE, preambleText, type State, type TexError } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ViewRef } from '../../files/kind.ts';
import type { ViewStates } from '../../files/viewState.ts';
import { useCompiled } from '../../latex/useCompiled.ts';
import { AskDialog, type Question } from '../Dialogs.tsx';
import { useModal } from '../FullScreen.tsx';
import { Message } from '../viewers/common.tsx';
import { PdfViewer } from '../viewers/PdfViewer.tsx';
import { CompileLog, errorText } from './CompileLog.tsx';
import { type Diag, lineStartOf } from './editorLogic.ts';
import { LatexEditor } from './LatexEditor.tsx';
import { brokenPreambleQuestion, discardPreambleQuestion, leaveUnsaved, PREAMBLE_SLOT, preambleRequest, saveStep } from './preamble.ts';

/**
 * The compilation's error as the editor shows it: the preamble's is the draft's own, on its line; the sample's is
 * said without one.
 */
function draftError(e: TexError | null): TexError | null {
  if (e === null) return null;
  return e.where === 'preamble' ? { ...e, where: 'source' } : { message: `Dans l’exemple : ${e.message}`, line: null, where: 'preamble' };
}

const LIVE = { keptAs: `latex:${PREAMBLE_SLOT}` };

/**
 * The global preamble's full screen (spec 5.6, D5, task 7), modal as a file's (useModal), opened from the settings:
 * the LaTeX editor on a draft of the preamble, and PREAMBLE_SAMPLE compiled under that draft at the typing pause
 * (slot `preamble`, mode `page`), its last good PDF kept, with the compilation's state and its log. « Préambule par
 * défaut » puts DEFAULT_PREAMBLE in the draft. « Enregistrer » (and Ctrl+S) saves it by `onSave` (preambleBuild: one
 * action, undone by Ctrl+Z), once the draft's compilation is in: a draft that does not compile asks first
 * (saveStep); unchanged, it closes. « Annuler » closes without saving; Escape or ×, with changes, ask first. Closed
 * without saving, the prepared pdfLaTeX go back to the saved preamble (leaveUnsaved).
 */
export function PreambleEditor(props: { state: State; params: RenderParams; views: ViewStates; onSave(text: string): Promise<boolean>; onClose(): void }) {
  const { params } = props;
  const saved = preambleText(props.state);
  const [draft, setDraft] = useState(saved);
  const [question, setQuestion] = useState<Question | null>(null);
  /** « Enregistrer » pressed while the draft compiled: decided once its answer is in. */
  const [saving, setSaving] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [jump, setJump] = useState<{ line: number; seq: number } | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const req = useMemo(() => preambleRequest(draft), [draft]);
  const view = useCompiled(req, params.latexTypingPauseMs);
  const latest = useRef({ draft, saved, view, props });
  latest.current = { draft, saved, view, props };

  const commit = async () => {
    const { draft: text, props: p } = latest.current;
    if (await p.onSave(text)) p.onClose();
  };
  const closeUnsaved = () => {
    const { saved: s, props: p } = latest.current;
    leaveUnsaved(s, (preamble) => window.cirrus.latexWarm(preamble), () => p.onClose());
  };
  const save = () => {
    const { draft: d, saved: s, view: v } = latest.current;
    const step = saveStep(d, s, v);
    if (step === 'close') closeUnsaved();
    else if (step === 'wait') setSaving(true);
    else if (step === 'ask') setQuestion(brokenPreambleQuestion(() => { void commit(); }));
    else void commit();
  };
  useEffect(() => {
    if (!saving || view.pending) return;
    setSaving(false);
    save();
  }, [saving, view.pending]);
  const leave = () => {
    const { draft: d, saved: s } = latest.current;
    if (d === s) closeUnsaved();
    else setQuestion(discardPreambleQuestion(closeUnsaved));
  };
  const close = useRef(leave);
  close.current = leave;
  useModal(root, close);

  const error = draftError(view.error);
  const diagnostics = useMemo<Diag[]>(() => {
    if (!error || error.where !== 'source' || error.line === null) return [];
    const from = lineStartOf(draft, error.line), to = lineStartOf(draft, error.line + 1) - 1;
    return to >= from ? [{ from, to, severity: 'error', message: error.message }] : [];
  }, [view.error]);
  const pdf = useMemo<ViewRef | null>(
    () => (view.pdf ? { name: 'préambule.pdf', hash: view.pdf.key, size: view.pdf.size, store: 'latex' } : null),
    [view.pdf?.key],
  );
  const compile = view.unavailable ? view.unavailable.message : view.pending ? 'Compilation…' : error ? errorText(error) : '';
  return (
    <div ref={root} className="full-screen preamble-editor" tabIndex={-1} role="dialog" aria-modal="true" aria-label="Préambule LaTeX">
      <header>
        <span className="name">Préambule LaTeX</span>
        <span className="node">commun à tous les nœuds</span>
        <span className="spacer" />
        <button className="system" onClick={() => setDraft(DEFAULT_PREAMBLE)}>Préambule par défaut</button>
        <button className="system" onClick={() => closeUnsaved()}>Annuler</button>
        <button className="system save" disabled={saving} onClick={() => save()}>Enregistrer</button>
        <button className="close" title="Quitter le préambule (Échap)" onClick={() => leave()}>×</button>
      </header>
      <div className="tex-workbench">
        <div className="tex-status" role="status">
          <span className={`compile${!view.pending && (view.error || view.unavailable) ? ' bad' : ''}`}>{compile}</span>
          <span className="spacer" />
          <button className={logOpen ? 'log on' : 'log'} title="Journal de compilation" onClick={() => setLogOpen((o) => !o)}>Journal</button>
        </div>
        <div className="tex-panes">
          <div className="tex-source">
            <LatexEditor
              value={draft} registry={null} diagnostics={diagnostics} params={params} autoFocus ariaLabel="Préambule LaTeX" jumpTo={jump}
              onChange={setDraft} onSave={() => save()}
            />
          </div>
          <div className="tex-preview">
            {pdf
              ? <PdfViewer file={pdf} params={params} views={props.views} mode="preview" live={LIVE} />
              : <Message text={view.unavailable?.message ?? (error && !view.pending ? errorText(error) : 'Compilation…')} />}
            {logOpen && (
              <CompileLog
                log={view.log} error={error} onClose={() => setLogOpen(false)}
                onJump={(line) => { setLogOpen(false); setJump((j) => ({ line, seq: (j?.seq ?? 0) + 1 })); }}
              />
            )}
          </div>
        </div>
        {question && <AskDialog q={question} onClose={() => setQuestion(null)} />}
      </div>
    </div>
  );
}
