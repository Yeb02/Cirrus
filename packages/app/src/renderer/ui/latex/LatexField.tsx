import type { CompiledPdf, Id, State } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { loading } from '../../files/read.ts';
import { type LatexRegistry, type Origin, slotOf } from '../../latex/registry.ts';
import { buildRequest } from '../../latex/request.ts';
import { type CompiledView, knownLabels } from '../../latex/scheduler.ts';
import { useCompiled } from '../../latex/useCompiled.ts';
import { typedFields } from '../../quit.ts';
import { CompileLog, errorText } from './CompileLog.tsx';
import { diagnosticsFor, lineStartOf } from './editorLogic.ts';
import { type FieldEvent, fieldReducer, type FieldState, VIEW } from './fieldState.ts';

/** The editor (CodeMirror) and the snippet (pdf.js), each in its own chunk, loaded the first time they show. */
const LatexEditor = lazy(() => loading(import('./LatexEditor.tsx')).then((m) => ({ default: m.LatexEditor })));
const LatexSnippet = lazy(() => loading(import('./LatexSnippet.tsx')).then((m) => ({ default: m.LatexSnippet })));

/** What a compiled field shows besides its PDF: its source's state, and where its compilation is. */
interface Shown { origin: Origin; text: string; state: State; registry: LatexRegistry | null; params: RenderParams }

/** A text with nothing to compile: only blanks. */
const blank = (text: string) => text.trim() === '';

/** The request of `text` as the source `origin`, under `slot` (the saved one, or its draft's); none without a registry or a text. */
function useRequest(a: Shown, slot: string) {
  const { origin, text, state, registry } = a;
  const widthCm = a.params.latexSnippetWidthCm;
  return useMemo(() => {
    if (registry === null || blank(text)) return null;
    const r = buildRequest({ origin, source: text, s: state, registry, known: knownLabels(slotOf(origin)), widthCm });
    return r.slot === slot ? r : { ...r, slot };
  }, [text, registry, origin, slot, widthCm]);
}

/** The source as typed, in a fixed-width face, and why it is not compiled (`reason`, small). */
function Source(props: { text: string; reason?: string }) {
  return (
    <>
      <pre className="latex-source">{props.text}</pre>
      {props.reason !== undefined && <p className="latex-reason">{props.reason}</p>}
    </>
  );
}

/**
 * A compilation's state under its PDF or its source: its error in red with « Journal », which opens its log below (a
 * click on the error takes the editor to its line, `onJump`; closed, the log gives the focus back to the field,
 * `onLogClosed`, which its Escape would otherwise leave). In the editor (`editing`), always a line, which says
 * « Compilation… » while it runs: the draft under it does not move as it comes and goes.
 */
function Status(props: { view: CompiledView; editing?: boolean; onJump?(line: number): void; onLogClosed(): void }) {
  const { view } = props;
  const [open, setOpen] = useState(false);
  const error = !view.pending && view.error ? errorText(view.error) : null;
  if (error === null && !props.editing) return null;
  return (
    <>
      <div className="latex-status">
        {error !== null ? <span className="latex-error">{error}</span> : <span className="latex-reason">{view.pending ? 'Compilation…' : ''}</span>}
        <span className="spacer" />
        {error !== null && <button className={open ? 'latex-log on' : 'latex-log'} title="Journal de compilation" onClick={() => setOpen((o) => !o)}>Journal</button>}
      </div>
      {open && error !== null && (
        <CompileLog
          log={view.log} error={view.error} onClose={() => { setOpen(false); props.onLogClosed(); }}
          onJump={props.onJump && ((line) => { setOpen(false); props.onJump!(line); })}
        />
      )}
    </>
  );
}

/**
 * A source compiled as the field shows it: its PDF (LatexSnippet) — the last good one, else `seed`, the other mode's
 * last one, until it has its own; without one, its source and why (not in the editor, which shows it already). LaTeX
 * unavailable: its source and why. An error is said in red, with its log (Status).
 */
function Compiled(props: {
  shown: Shown; view: CompiledView; seed: CompiledPdf | null; editing?: boolean; onJump?(line: number): void; onNodeLink(id: Id): void;
  onLogClosed(): void;
}) {
  const { shown, view, editing } = props;
  const pdf = view.pdf ?? props.seed;
  if (view.unavailable) return editing ? <p className="latex-reason">{view.unavailable.message}</p> : <Source text={shown.text} reason={view.unavailable.message} />;
  const waiting = editing ? null : <Source text={shown.text} reason="Compilation…" />;
  return (
    <>
      {pdf
        ? (
          <Suspense fallback={waiting}>
            <LatexSnippet pdf={pdf} params={shown.params} onNodeLink={props.onNodeLink} fallback={waiting} />
          </Suspense>
        )
        : !editing && <Source text={shown.text} reason={!view.pending && view.error ? undefined : 'Compilation…'} />}
      <Status view={view} editing={editing} onJump={props.onJump} onLogClosed={props.onLogClosed} />
    </>
  );
}

/**
 * The last PDF each source showed compiled this session, with its text, by slot: a pop-up opened again shows it at
 * once, while its request — which the main process's cache answers — is on its way, rather than its source for a
 * moment. One small record per summary or relation shown.
 */
const shownBefore = new Map<string, { text: string; pdf: CompiledPdf }>();

/** The field shown compiled: the saved text under its own slot; empty, the placeholder's box. */
function ViewMode(props: {
  shown: Shown; seed: CompiledPdf | null; placeholder: string; rows: number; onPdf(pdf: CompiledPdf): void; onNodeLink(id: Id): void; onLogClosed(): void;
}) {
  const { shown } = props;
  const slot = slotOf(shown.origin);
  const req = useRequest(shown, slot);
  const view = useCompiled(req, shown.params.latexTypingPauseMs);
  useEffect(() => {
    if (!view.pdf) return;
    props.onPdf(view.pdf);
    // The same PDF answered again (the cache) keeps its first record, which its pages' sizes are known by (LatexSnippet).
    const kept = shownBefore.get(slot);
    if (!kept || kept.text !== shown.text || kept.pdf.key !== view.pdf.key) shownBefore.set(slot, { text: shown.text, pdf: view.pdf });
  }, [view.pdf]);
  // The empty field as it was before LaTeX: a box with its placeholder, which a click or a key opens (plan 4b, P3).
  if (blank(shown.text)) return <textarea className="latex-empty" readOnly tabIndex={-1} rows={props.rows} value="" placeholder={props.placeholder} />;
  const before = shownBefore.get(slot);
  const seed = props.seed ?? (before?.text === shown.text ? before.pdf : null);
  return <Compiled shown={shown} view={view} seed={seed} onNodeLink={props.onNodeLink} onLogClosed={props.onLogClosed} />;
}

/**
 * The field typed in: the compact LaTeX editor, its suggestions and diagnostics, and under it the draft compiled at
 * the typing pause, under its own slot (`draft:<slot>`), as the full screen's workbench does.
 */
function EditMode(props: {
  shown: Shown; seed: CompiledPdf | null; ariaLabel: string; onInput(text: string): void; onPdf(pdf: CompiledPdf): void; onNodeLink(id: Id): void;
  onLogClosed(): void; focusSeq: number;
}) {
  const { shown } = props;
  const [jump, setJump] = useState<{ line: number; seq: number } | undefined>(undefined);
  const req = useRequest(shown, `draft:${slotOf(shown.origin)}`);
  const view = useCompiled(req, shown.params.latexTypingPauseMs);
  useEffect(() => { if (view.pdf) props.onPdf(view.pdf); }, [view.pdf]);
  const { registry, origin, text } = shown;
  const diagnostics = useMemo(
    () => (req === null || registry === null ? [] : diagnosticsFor(registry.scanOf(origin, text), req, registry, origin, view.error, (n) => lineStartOf(text, n))),
    [req, view.error],
  );
  return (
    <>
      <Suspense fallback={<div className="latex-editor compact" />}>
        <LatexEditor
          value={text} registry={registry} diagnostics={diagnostics} params={shown.params} compact autoFocus ariaLabel={props.ariaLabel} jumpTo={jump}
          focusSeq={props.focusSeq} onChange={props.onInput}
        />
      </Suspense>
      {!blank(text) && (
        <div className="latex-draft">
          <Compiled
            shown={shown} view={view} seed={props.seed} editing onNodeLink={props.onNodeLink} onLogClosed={props.onLogClosed}
            onJump={(line) => setJump((j) => ({ line, seq: (j?.seq ?? 0) + 1 }))}
          />
        </div>
      )}
    </>
  );
}

/**
 * A node's summary or a connection's relation in its pop-up (plan 4b, D3; task 6): shown compiled (ViewMode), edited
 * in place (EditMode). A click elsewhere than on a link, or Enter or F2 while the field has the focus, opens its editor;
 * the focus leaving the field and its preview commits the draft if it changed (`onCommit`, through the session), then
 * shows it compiled; Escape gives it up (fieldReducer). Leaving while the window loses the focus is no leaving; the
 * field unmounted while typed in commits too, and so does the window closing (typedFields). What is committed is shown
 * until the value has it, or the commit is refused (`onCommit` resolves false): the value then shows again. The two
 * modes compile under their own slots, never both at once (a source has one useCompiled); each shows the other's last
 * PDF until it has its own, so that switching never flashes the source. `registry`: App's, null until built (the source
 * is then shown, waiting).
 */
export function LatexField(props: {
  origin: Origin; value: string; placeholder: string; rows?: number; state: State; registry: LatexRegistry | null; params: RenderParams;
  onCommit(text: string): Promise<boolean>; onNodeLink(id: Id): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [field, setField] = useState<FieldState>(VIEW);
  const fieldNow = useRef(field);
  const latest = useRef(props);
  latest.current = props;
  /** The text committed, shown until the value has it. */
  const [committed, setCommitted] = useState<string | null>(null);
  const text = committed ?? props.value;
  const textNow = useRef(text);
  textNow.current = text;
  /** Each mode's last PDF, and the one the mode shown now starts from. */
  const last = useRef<{ view: CompiledPdf | null; draft: CompiledPdf | null }>({ view: null, draft: null });
  const [seed, setSeed] = useState<CompiledPdf | null>(null);
  /** Asks the editor for the focus back, at each new value (fieldReducer's `focusEditor`). */
  const [editorFocus, setEditorFocus] = useState(0);

  // The value changed (the commit written, or any other change): what was committed is in it, or replaced.
  useEffect(() => { setCommitted(null); }, [props.value]);

  /** `t` written through the session, shown meanwhile (and the field's text at once, for a commit at closing or unmount). */
  const commit = (t: string): Promise<void> => {
    setCommitted(t);
    textNow.current = t;
    return latest.current.onCommit(t).then(
      (ok) => { if (!ok) setCommitted((c) => (c === t ? null : c)); },
      (e: unknown) => { console.error('Modification du champ LaTeX :', e); setCommitted((c) => (c === t ? null : c)); },
    );
  };
  const dispatch = (e: FieldEvent) => {
    const before = fieldNow.current, r = fieldReducer(before, e);
    if (r.state !== before) {
      fieldNow.current = r.state;
      setField(r.state);
      if (before.mode !== r.state.mode) setSeed(r.commit !== undefined ? last.current.draft : last.current.view);
    }
    if (r.commit !== undefined) void commit(r.commit);
    if (r.focusEditor) setEditorFocus((n) => n + 1);
  };
  // Typed in: what is typed is committed before the window closes (App, quitInOrder), the focus leaving the window
  // being no leaving (final review, I1).
  useEffect(() => {
    if (field.mode !== 'edit') return;
    return typedFields.hold(() => {
      const f = fieldNow.current;
      return f.mode === 'edit' && f.draft !== textNow.current ? commit(f.draft) : Promise.resolve();
    });
  }, [field.mode]);
  // Unmounted while typed in (its pop-up closed, its node gone): what is typed is committed still.
  useEffect(() => () => {
    const f = fieldNow.current;
    if (f.mode === 'edit' && f.draft !== textNow.current) void latest.current.onCommit(f.draft).catch(() => {});
  }, []);

  /** The focus back in the field — its editor, when typed in — once its log closes. */
  const refocus = () => {
    const el = root.current;
    (el?.querySelector<HTMLElement>('.cm-content') ?? el)?.focus({ preventScroll: true });
  };
  const shown: Shown = { origin: props.origin, text: field.mode === 'edit' ? field.draft : text, state: props.state, registry: props.registry, params: props.params };
  let body: ReactNode;
  if (field.mode === 'view') {
    body = (
      <ViewMode
        shown={shown} seed={seed} placeholder={props.placeholder} rows={props.rows ?? 3} onNodeLink={props.onNodeLink} onLogClosed={refocus}
        onPdf={(pdf) => { last.current.view = pdf; }}
      />
    );
  } else {
    body = (
      <EditMode
        shown={shown} seed={seed} ariaLabel={props.placeholder} onNodeLink={props.onNodeLink} onLogClosed={refocus} focusSeq={editorFocus}
        onInput={(t) => dispatch({ kind: 'input', text: t })} onPdf={(pdf) => { last.current.draft = pdf; }}
      />
    );
  }
  return (
    <div
      ref={root} className={`latex-field ${field.mode}`} tabIndex={field.mode === 'view' ? 0 : -1}
      title={field.mode === 'view' ? 'Modifier : clic, Entrée ou F2' : undefined}
      onClick={(e) => {
        // A selection made in the compiled text is kept; a link, a button, the log, the editor take their own clicks.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
        dispatch({ kind: 'click', link: (e.target as Element).closest('a, button, .compile-log, .cm-editor') !== null, value: textNow.current });
      }}
      onKeyDown={(e) => {
        if (fieldNow.current.mode === 'view') {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== 'F2')) return;
          e.preventDefault();
          dispatch({ kind: 'key', key: e.key, value: textNow.current });
        } else if (e.key === 'Escape' && !e.defaultPrevented) {
          // The field's: its panel stays. The focus stays in it (on itself), so that its editor leaving is no leaving.
          e.preventDefault();
          root.current?.focus({ preventScroll: true });
          dispatch({ kind: 'escape' });
        }
      }}
      onBlur={(e) => {
        if (fieldNow.current.mode !== 'edit') return;
        const to = e.relatedTarget as Node | null;
        if (to !== null ? e.currentTarget.contains(to) : !document.hasFocus()) return;
        dispatch({ kind: 'leave', value: textNow.current });
      }}
    >
      {body}
    </div>
  );
}
