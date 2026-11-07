import type { Anchor, FileRef, Id, State } from '@cirrus/core';
import { Component, lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AnnotationEntry, type AnnotationIndex, ofFile, titleChars } from '../../files/annotations.ts';
import { decodeText } from '../../files/decode.ts';
import { fileKind, type ViewRef } from '../../files/kind.ts';
import { blobSize, loading, MB, readHead } from '../../files/read.ts';
import { type LatexRegistry, type Origin, slotOf } from '../../latex/registry.ts';
import { buildRequest } from '../../latex/request.ts';
import { knownLabels } from '../../latex/scheduler.ts';
import { useCompiled } from '../../latex/useCompiled.ts';
import { errorText } from '../latex/CompileLog.tsx';
import { AnnotationMargin } from './AnnotationMargin.tsx';
import { Banner, Message, Notice, readFailure, type ViewProps } from './common.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import type { Annotate, Goto } from './PdfViewer.tsx';
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
 * PDF (TexPreview) instead of its source. A link to a node of the base clicked in a PDF goes to `onNodeLink` (task 6).
 * With `annotations` (plan 4c), a PDF is read with its annotations (AnnotatedPdf).
 */
export function Viewer(props: ViewProps & { node: Id; latex?: LatexContext; onNodeLink?(node: Id): void; annotations?: AnnotationContext }) {
  return <ViewBoundary name={props.file.name}><ViewOf {...props} /></ViewBoundary>;
}

/** What a .tex's preview needs to be compiled (plan 4b, task 5): the state and the registry, App's (null until built). */
export interface LatexContext { state: State; registry: LatexRegistry | null }

/** What a PDF's reader needs for its annotations (plan 4c): App's. */
export interface AnnotationContext {
  /** The base's annotations (App's, built again at each change of the state). */
  index: AnnotationIndex;
  /** A passage to annotate: whether it is taken (refused when too long, said in a notification). */
  onAnnotate(a: Anchor): boolean;
  /** The margin's annotations can be dragged onto the graph: a preview's, not the modal full screen's (D4). */
  draggable: boolean;
  /** An annotation to show, opened elsewhere (a pop-up's list, task 3): its version, its page, its passage blinking. */
  reveal?: { anchor: Anchor; seq: number };
}

function ViewOf(props: ViewProps & { node: Id; latex?: LatexContext; onNodeLink?(node: Id): void; annotations?: AnnotationContext }) {
  const view: ViewProps = { file: props.file, params: props.params, views: props.views, mode: props.mode };
  if (props.latex && fileKind(props.file.name) === 'tex') return <TexPreview {...view} node={props.node} latex={props.latex} onNodeLink={props.onNodeLink} />;
  const choice = viewOf(props.file.name);
  switch (choice?.view) {
    case 'image': return <ImageViewer {...view} />;
    case 'table': return <TableViewer {...view} />;
    case 'text': return <Suspense fallback={<Notice text="Lecture…" />}><TextViewer {...view} wrap={choice.wrap} /></Suspense>;
    case 'pdf':
      return props.annotations
        ? <AnnotatedPdf {...view} node={props.node} annotations={props.annotations} onNodeLink={props.onNodeLink} />
        : <Suspense fallback={<Notice text="Lecture…" />}><PdfViewer {...view} onNodeLink={props.onNodeLink} /></Suspense>;
    case undefined: return <Notice text="Cirrus n’a pas de vue pour ce genre de fichier." />;
  }
}

/** An earlier version shown (D2): its hash, then its file once its size is read, or why it cannot be read. */
type Version = { hash: string; ref?: FileRef; message?: string };

/**
 * A PDF of node `node` with its annotations (plan 4c, D2 to D4): the reader (PdfViewer), which draws those of the
 * version it shows and annotates a passage selected, and its margin (AnnotationMargin), which lists those of the file,
 * every version — shown when there are some, folded or not as it was left for this file (kept in `views`). An
 * annotation opened from the margin, or from elsewhere (`reveal`), shows its page, its passage blinking; one of an
 * earlier version shows that version (its blob, which the store keeps), under a banner that leads back to the current
 * one. A version missing from the store says so in the reader's place. Annotating an earlier version annotates it.
 */
function AnnotatedPdf(props: ViewProps & { node: Id; annotations: AnnotationContext; onNodeLink?(node: Id): void }) {
  const { file, params, views, node } = props, ctx = props.annotations;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [version, setVersion] = useState<Version | null>(null);
  const versionRef = useRef(version);
  versionRef.current = version;
  const [goto, setGoto] = useState<Goto | undefined>(undefined);
  const seq = useRef(0);
  const foldKey = `annotations:${file.hash}`;
  const [folded, setFolded] = useState(() => views.get(foldKey)?.folded === 1);
  const foldedRef = useRef(folded);
  foldedRef.current = folded;
  const shown: FileRef | null = version === null ? file : version.ref ?? null;
  const shownHash = version?.hash ?? file.hash;
  const all = ctx.index.of(node);
  const list = useMemo(() => ofFile(all, file), [all, file.name, file.hash]);
  const drawn = ctx.index.forVersion(node, shownHash);
  const annotate = useMemo<Annotate>(() => ({ pdf: node, onAnnotate: (a) => ctxRef.current.onAnnotate(a) }), [node]);

  // An annotation opened: its page and its passage, in the version it was made on — the current file, the one shown,
  // or an earlier one, whose size is read first (the node no longer holds its FileRef).
  const open = useCallback((a: Anchor) => {
    setGoto({ page: a.page, flash: a, seq: ++seq.current });
    if (a.hash === (versionRef.current?.hash ?? file.hash)) return;
    if (a.hash === file.hash) { setVersion(null); return; }
    const hash = a.hash;
    setVersion({ hash });
    void loading(blobSize({ name: file.name, hash }).then(
      (size) => setVersion((v) => (v?.hash === hash ? { hash, ref: { name: file.name, hash, size } } : v)),
      (e: unknown) => setVersion((v) => (v?.hash === hash ? { hash, message: readFailure(file.name, e) } : v)),
    ));
  }, [file.hash, file.name]);
  const onOpen = useCallback((e: AnnotationEntry) => open(e.anchor), [open]);
  useEffect(() => { if (ctx.reveal) open(ctx.reveal.anchor); }, [ctx.reveal?.seq]);
  const toggle = useCallback(() => {
    const f = !foldedRef.current;
    setFolded(f);
    views.set(foldKey, { folded: f ? 1 : 0 });
  }, [views, foldKey]);

  const view: ViewProps = { file, params, views, mode: props.mode };
  return (
    <div className="viewer viewer-annotated">
      {version && (
        <p className="version-banner">
          <span className="what">Version précédente de « {file.name} », réimporté depuis.</span>
          <button onClick={() => { setGoto(undefined); setVersion(null); }}>Revenir à la version actuelle</button>
        </p>
      )}
      <div className="annotated">
        {shown
          ? (
            <Suspense fallback={<Notice text="Lecture…" />}>
              <PdfViewer key={shown.hash} {...view} file={shown} onNodeLink={props.onNodeLink} annotations={drawn} annotate={annotate} goto={goto} />
            </Suspense>
          )
          : <Notice text={version?.message ?? 'Lecture…'} />}
        {list.length > 0 && (
          <AnnotationMargin
            entries={list} current={file.hash} shown={shownHash} folded={folded} widthPx={params.annotationMarginPx}
            titleChars={titleChars(params.annotationTitleChars)} draggable={ctx.draggable} onToggle={toggle} onOpen={onOpen}
          />
        )}
      </div>
    </div>
  );
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
function TexPreview(props: ViewProps & { node: Id; latex: LatexContext; onNodeLink?(node: Id): void }) {
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
    () => (text !== null && latex.registry ? buildRequest({ origin, source: text, s: latex.state, registry: latex.registry, known: knownLabels(slot), widthCm: params.latexSnippetWidthCm }) : null),
    [text, latex.registry, origin],
  );
  const compiled = useCompiled(req, params.latexTypingPauseMs);
  const pdf = useMemo<ViewRef | null>(
    () => (compiled.pdf ? { name: `${file.name.replace(/\.tex$/i, '')}.pdf`, hash: compiled.pdf.key, size: compiled.pdf.size, store: 'latex' } : null),
    [compiled.pdf?.key],
  );
  const live = useMemo(() => ({ keptAs: `latex:${slot}` }), [slot]);
  const view: ViewProps = { file, params, views: props.views, mode: props.mode };
  if (read === null) return <Notice text="Lecture…" />;
  if ('message' in read) return <Notice text={read.message} />;
  if ('source' in read || compiled.unavailable) return <Suspense fallback={<Notice text="Lecture…" />}><TextViewer {...view} wrap={false} /></Suspense>;
  const error = compiled.error && !compiled.pending ? errorText(compiled.error) : null;
  return (
    <div className="viewer viewer-tex">
      {pdf && error && <Banner lines={[error]} />}
      {pdf
        ? <Suspense fallback={<Notice text="Lecture…" />}><PdfViewer {...view} file={pdf} live={live} onNodeLink={props.onNodeLink} /></Suspense>
        : <Message text={error ?? 'Compilation…'} />}
    </div>
  );
}
