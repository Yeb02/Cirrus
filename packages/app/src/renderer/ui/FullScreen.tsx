import type { Anchor, FileRef, Id, NodeRec, State } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { lazy, type RefObject, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationIndex } from '../files/annotations.ts';
import { fileKind } from '../files/kind.ts';
import { offersSystem } from '../files/nodeFiles.ts';
import { loading } from '../files/read.ts';
import type { ViewStates } from '../files/viewState.ts';
import type { LatexRegistry } from '../latex/registry.ts';
import type { SaveAnswer } from './latex/saveScheduler.ts';
import type { WorkbenchHandle } from './latex/TexWorkbench.tsx';
import { Notice } from './viewers/common.tsx';
import { Viewer } from './viewers/Viewer.tsx';

/** The .tex workbench, with CodeMirror and pdf.js, in its own chunk (as the views are: Viewer.tsx). */
const TexWorkbench = lazy(() => loading(import('./latex/TexWorkbench.tsx')).then((m) => ({ default: m.TexWorkbench })));

/** What the full screen of a .tex needs (plan 4b, task 5): the state and the registry for its compilation, its save, its handle for App. */
export interface TexContext {
  state: State; registry: LatexRegistry | null; onSave(text: string): Promise<SaveAnswer>; workbench: RefObject<WorkbenchHandle | null>;
}

/**
 * Where Tab goes inside a modal holding `count` focusable elements, the focus on the one at `at` (−1: on none of them,
 * the modal itself): the index to focus when it must wrap around — past the last back to the first, before the first to
 * the last, from none to the first (or the last, backwards) —, null when the browser moves it inside on its own.
 */
export function tabTarget(count: number, at: number, back: boolean): number | null {
  if (count === 0) return null;
  if (at < 0) return back ? count - 1 : 0;
  if (!back && at === count - 1) return 0;
  if (back && at === 0) return count - 1;
  return null;
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

/**
 * A modal over the whole window (FullScreen; the preamble's, task 7): it takes the focus and keeps it — Tab goes round
 * inside `root` (tabTarget), and a focus gone elsewhere comes back —, so that no key reaches what is under it; Escape
 * that nothing took calls `close`; the focus goes back where it was as it leaves.
 */
export function useModal(root: RefObject<HTMLElement | null>, close: RefObject<() => void>): void {
  useEffect(() => {
    const el = root.current!;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const list = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.tabIndex >= 0 && !x.matches(':disabled') && x.getClientRects().length > 0);
        const to = tabTarget(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (to !== null || list.length === 0) e.preventDefault();
        if (to !== null) list[to].focus();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        close.current();
      }
    };
    const away = (e: FocusEvent) => { if (!el.contains(e.target as Node)) el.focus({ preventScroll: true }); };
    window.addEventListener('keydown', key);
    document.addEventListener('focusin', away);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('focusin', away);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
}

/**
 * A file in full screen (spec 12; plan 4a, task 5): over the whole window, tabs included, its Viewer under a header
 * that names the file and its node, and offers « Ouvrir avec l’application du système » for the kinds handed to it
 * (offersSystem: images and PDFs; never text, code or tables). Escape that nothing took (CodeMirror's search panel
 * takes its own) leaves it, as its ×; App closes it when its file is gone (resolveTarget, Review Focus 5).
 * A modal (Minor 5 of the task 5 review; useModal): no key reaches the graph or the panels under it; App leaves its
 * shortcuts (Ctrl+Z, Ctrl+Y) while it is open. It gives the focus back as it leaves.
 * A .tex (plan 4b, D6) opens its workbench instead of a view (`tex`): the editor and the compiled preview, followed by
 * its name (a save changes its hash, the workbench stays). Escape and × then go through the workbench, which saves
 * what is typed before leaving (requestClose).
 * A link to a node clicked in a PDF here (plan 4b, task 6) opens nothing, the full screen being modal: its header says
 * « Lien vers « titre » : ferme le plein écran pour l’ouvrir. » for toastMs (`nodeTitle`: the node's title, null when it
 * is gone, which it says too).
 * A PDF is read and annotated here with its annotations (plan 4c, D4: `annotations`, `onAnnotate`); they are not
 * dragged out of its margin, the full screen being modal.
 */
export function FullScreen(props: {
  node: NodeRec; file: FileRef; params: RenderParams; views: ViewStates; onClose(): void; onSystem(file: FileRef): void; tex?: TexContext;
  nodeTitle(node: Id): string | null; annotations?: AnnotationIndex | null; onAnnotate?(a: Anchor): boolean;
}) {
  const { node, file, tex } = props;
  const root = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const annotate = useCallback((a: Anchor) => latest.current.onAnnotate?.(a) ?? false, []);
  const noticeTimer = useRef<number | undefined>(undefined);
  const onNodeLink = useCallback((id: Id) => {
    const title = latest.current.nodeTitle(id);
    setNotice(title === null ? 'Ce nœud n’existe plus.' : `Lien vers « ${title} » : ferme le plein écran pour l’ouvrir.`);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), latest.current.params.toastMs);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const isTex = tex !== undefined && fileKind(file.name) === 'tex';
  const leave = () => {
    const bench = isTex ? tex.workbench.current : null;
    if (bench) bench.requestClose();
    else props.onClose();
  };
  const close = useRef(leave);
  close.current = leave;
  useModal(root, close);
  return (
    <div ref={root} className="full-screen" tabIndex={-1} role="dialog" aria-modal="true" aria-label={file.name}>
      <header>
        <span className="name" title={file.name}>{file.name}</span>
        <span className="node" title={node.title}>{node.title}</span>
        <span className="spacer" />
        {notice && <span className="notice" role="status">{notice}</span>}
        {offersSystem(file.name) && <button className="system" onClick={() => props.onSystem(file)}>Ouvrir avec l’application du système</button>}
        <button className="close" title="Quitter le plein écran (Échap)" onClick={() => leave()}>×</button>
      </header>
      {!isTex
        ? (
          <Viewer
            key={file.hash} file={file} node={node.id} mode="full" params={props.params} views={props.views} onNodeLink={onNodeLink}
            annotations={props.annotations && props.onAnnotate ? { index: props.annotations, onAnnotate: annotate, draggable: false } : undefined}
          />
        )
        : !tex.registry ? <Notice text="Lecture…" />
        : (
          <Suspense fallback={<Notice text="Lecture…" />}>
            <TexWorkbench
              ref={tex.workbench} node={node} file={file} state={tex.state} registry={tex.registry} params={props.params} views={props.views}
              onSave={tex.onSave} onClose={props.onClose} onNodeLink={onNodeLink}
            />
          </Suspense>
        )}
    </div>
  );
}

/**
 * The full screen of a file in place of one that failed (PanelBoundary, App): still over the whole window, its × with
 * the focus, which Escape leaves too; why, in French, in its middle.
 */
export function FullScreenFailed(props: { name: string; onClose(): void }) {
  return (
    <div
      className="full-screen" role="dialog" aria-modal="true" aria-label={props.name}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); props.onClose(); } }}
    >
      <header>
        <span className="name" title={props.name}>{props.name}</span>
        <span className="spacer" />
        <button className="close" title="Quitter le plein écran (Échap)" autoFocus onClick={() => props.onClose()}>×</button>
      </header>
      <Notice text="Le plein écran n’a pas pu s’afficher." />
    </div>
  );
}
