import type { Id, State } from '@cirrus/core';
import { Component, lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import { decodeText } from '../../files/decode.ts';
import { fileKind, type ViewRef } from '../../files/kind.ts';
import { loading, MB, readHead } from '../../files/read.ts';
import { type LatexRegistry, type Origin, slotOf } from '../../latex/registry.ts';
import { buildRequest } from '../../latex/request.ts';
import { knownLabels } from '../../latex/scheduler.ts';
import { useCompiled } from '../../latex/useCompiled.ts';
import { errorText } from '../latex/CompileLog.tsx';
import { Banner, Message, Notice, readFailure, type ViewProps } from './common.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import { TableViewer } from './TableViewer.tsx';
import { viewOf } from './views.ts';

/**
 * The text view, with CodeMirror, in its own chunk: loaded the first time a text is shown, so that the app's start does
 * not read it (performance); like every chunk of the app, it is served by the app, never fetched from the network.
 */
const TextViewer = lazy(() => loading(import('./TextViewer.tsx')).then((m) => ({ default: m.TextViewer })));
/** The PDF reader and pdf.js, in their own chunk too (the pop-up's thumbnails load it the same way). */
const PdfViewer = lazy(() => loading(import('./PdfViewer.tsx')).then((m) => ({ default: m.PdfViewer })));

/**
 * Around a view (Minor 4 of the task 5 review): an error thrown while it renders — a chunk that could not be loaded, a
 * view's own fault — says so in the view, in French, its cause in the console; the window and its panels stay.
 */
class ViewBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(e: unknown): void {
    console.error(`Vue de « ${this.props.name} » :`, e);
  }

  render(): ReactNode {
    return this.state.failed ? <Notice text={`La vue de « ${this.props.name} » n’a pas pu s’ouvrir.`} /> : this.props.children;
  }
}

/**
 * A file's view (plan 4a, task 5), the same in a preview (`mode` « preview », a floating panel) and in full screen
 * (« full », which gives it the focus): chosen by the file's kind (viewOf) — an image, text and code (LaTeX source
 * included), a table, a PDF (task 6). `node`: the node the file is shown for, as the plan's interface gives it; no
 * view reads it yet. Its parent keys it by the file's hash, so that a new version of the file is a new view. A view
 * that fails says so in its place (ViewBoundary). With `latex` (plan 4b, task 5: a preview), a .tex shows its compiled
 * PDF (TexPreview) instead of its source.
 */
export function Viewer(props: ViewProps & { node: Id; latex?: LatexContext }) {
  return <ViewBoundary name={props.file.name}><ViewOf {...props} /></ViewBoundary>;
}

/** What a .tex's preview needs to be compiled (plan 4b, task 5): the state and the registry, App's (null until built). */
export interface LatexContext { state: State; registry: LatexRegistry | null }

function ViewOf(props: ViewProps & { node: Id; latex?: LatexContext }) {
  const view: ViewProps = { file: props.file, params: props.params, views: props.views, mode: props.mode };
  if (props.latex && fileKind(props.file.name) === 'tex') return <TexPreview {...view} node={props.node} latex={props.latex} />;
  const choice = viewOf(props.file.name);
  switch (choice?.view) {
    case 'image': return <ImageViewer {...view} />;
    case 'table': return <TableViewer {...view} />;
    case 'text': return <Suspense fallback={<Notice text="Lecture…" />}><TextViewer {...view} wrap={choice.wrap} /></Suspense>;
    case 'pdf': return <Suspense fallback={<Notice text="Lecture…" />}><PdfViewer {...view} /></Suspense>;
    case undefined: return <Notice text="Cirrus n’a pas de vue pour ce genre de fichier." />;
  }
}

/** The file as the preview read it: its text to compile, a text to show as source (too long, binary), or why it could not be read. */
type TexRead = { text: string } | { source: true } | { message: string };

/**
 * A .tex's preview (plan 4b, task 5), read only: its compiled PDF (PdfViewer, live: a compilation after a change of
 * what it cites replaces it in place), « Compilation… » before the first, an error over the last good one as a
 * banner. Compiled under the saved source's slot (`file:<id>:<name>`; its full screen's draft has its own). LaTeX
 * unavailable: its source, as plan 4a showed it (TextViewer); so is a .tex longer than textViewMaxMb, which cannot be
 * compiled, or a binary, the source view saying why. Its text is read once (readHead); the registry not built yet, it
 * waits for it.
 */
function TexPreview(props: ViewProps & { node: Id; latex: LatexContext }) {
  const { file, params, latex } = props;
  const [read, setRead] = useState<TexRead | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    void loading((async () => {
      try {
        const { bytes, truncated } = await readHead(file, params.textViewMaxMb * MB, stop.signal);
        if (stop.signal.aborted) return;
        const d = decodeText(bytes, truncated);
        setRead(truncated || 'binary' in d ? { source: true } : { text: d.text });
      } catch (e) {
        if (!stop.signal.aborted) setRead({ message: readFailure(file.name, e) });
      }
    })());
    return () => stop.abort();
  }, []);
  const origin = useMemo<Origin>(() => ({ kind: 'file', node: props.node, name: file.name }), [props.node, file.name]);
  const slot = slotOf(origin);
  const text = read && 'text' in read ? read.text : null;
  const req = useMemo(
    () => (text !== null && latex.registry ? buildRequest({ origin, source: text, s: latex.state, registry: latex.registry, known: knownLabels(slot) }) : null),
    [text, latex.registry, origin],
  );
  const compiled = useCompiled(req, params.latexTypingPauseMs);
  const pdf = useMemo<ViewRef | null>(
    () => (compiled.pdf ? { name: `${file.name.replace(/\.tex$/i, '')}.pdf`, hash: compiled.pdf.key, size: compiled.pdf.size, store: 'latex' } : null),
    [compiled.pdf?.key],
  );
  const view: ViewProps = { file, params, views: props.views, mode: props.mode };
  if (read === null) return <Notice text="Lecture…" />;
  if ('message' in read) return <Notice text={read.message} />;
  if ('source' in read || compiled.unavailable) return <Suspense fallback={<Notice text="Lecture…" />}><TextViewer {...view} wrap={false} /></Suspense>;
  const error = compiled.error && !compiled.pending ? errorText(compiled.error) : null;
  return (
    <div className="viewer viewer-tex">
      {pdf && error && <Banner lines={[error]} />}
      {pdf
        ? <Suspense fallback={<Notice text="Lecture…" />}><PdfViewer {...view} file={pdf} live={{ keptAs: `latex:${slot}` }} /></Suspense>
        : <Message text={error ?? 'Compilation…'} />}
    </div>
  );
}
