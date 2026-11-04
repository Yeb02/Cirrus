import type { FileRef, NodeRec } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef } from 'react';
import { offersSystem } from '../files/nodeFiles.ts';
import type { ViewStates } from '../files/viewState.ts';
import { Viewer } from './viewers/Viewer.tsx';

/**
 * A file in full screen (spec 12; plan 4a, task 5): over the whole window, tabs included, its Viewer under a header
 * that names the file and its node, and offers « Ouvrir avec l’application du système » for the kinds handed to it
 * (offersSystem: images and PDFs; never text, code or tables). Escape that nothing took (CodeMirror's search panel
 * takes its own) leaves it, as its ×; App closes it when its file is gone (followTarget, Review Focus 5). It takes the
 * focus, so that the keys go to it and not to the graph under it, and gives it back as it leaves.
 */
export function FullScreen(props: { node: NodeRec; file: FileRef; params: RenderParams; views: ViewStates; onClose(): void; onSystem(file: FileRef): void }) {
  const { node, file } = props;
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root.current!.contains(document.activeElement)) root.current!.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close.current(); } };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div ref={root} className="full-screen" tabIndex={-1} role="dialog" aria-label={file.name}>
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
