import type { FileRef, NodeRec } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef } from 'react';
import { offersSystem } from '../files/nodeFiles.ts';
import type { ViewStates } from '../files/viewState.ts';
import { Viewer } from './viewers/Viewer.tsx';

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

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

/**
 * A file in full screen (spec 12; plan 4a, task 5): over the whole window, tabs included, its Viewer under a header
 * that names the file and its node, and offers « Ouvrir avec l’application du système » for the kinds handed to it
 * (offersSystem: images and PDFs; never text, code or tables). Escape that nothing took (CodeMirror's search panel
 * takes its own) leaves it, as its ×; App closes it when its file is gone (resolveTarget, Review Focus 5).
 * A modal (Minor 5 of the task 5 review): it takes the focus and keeps it — Tab goes round inside it (tabTarget), and
 * a focus gone elsewhere comes back —, so that no key reaches the graph or the panels under it; App leaves its
 * shortcuts (Ctrl+Z, Ctrl+Y) while it is open. It gives the focus back as it leaves.
 */
export function FullScreen(props: { node: NodeRec; file: FileRef; params: RenderParams; views: ViewStates; onClose(): void; onSystem(file: FileRef): void }) {
  const { node, file } = props;
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
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
  return (
    <div ref={root} className="full-screen" tabIndex={-1} role="dialog" aria-modal="true" aria-label={file.name}>
      <header>
        <span className="name" title={file.name}>{file.name}</span>
        <span className="node" title={node.title}>{node.title}</span>
        <span className="spacer" />
        {offersSystem(file.name) && <button className="system" onClick={() => props.onSystem(file)}>Ouvrir avec l’application du système</button>}
        <button className="close" title="Quitter le plein écran (Échap)" onClick={() => props.onClose()}>×</button>
      </header>
      <Viewer key={file.hash} file={file} node={node.id} mode="full" params={props.params} views={props.views} />
    </div>
  );
}
