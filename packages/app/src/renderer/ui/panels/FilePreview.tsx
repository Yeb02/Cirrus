import type { FileRef, Id } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useRef } from 'react';
import type { ViewStates } from '../../files/viewState.ts';
import { type LatexContext, Viewer } from '../viewers/Viewer.tsx';
import { FloatingPanel, type Frame } from './FloatingPanel.tsx';

const ExpandIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * A file's preview (plan 4a, task 5): its Viewer in a floating panel, pinned, moved and resized as a node's pop-up; ⤢
 * shows it in full screen. `found`: the file as resolveTarget finds it by its name, null once it is gone (Review Focus 5):
 * the panel says why (`gone`), its last name in the header. While its content is in full screen (`covered`: views keep
 * their place by content), its view here is left, its place kept, and comes back where the full screen leaves it.
 * A .tex shows its compiled PDF (plan 4b, task 5: `latex`, App's state and registry).
 */
export function FilePreview(props: {
  frame: Frame; node: Id; found: FileRef | null; gone: string; covered: boolean; params: RenderParams; views: ViewStates; latex: LatexContext;
  onFull(): void;
}) {
  const f = props.found;
  const lastName = useRef('');
  if (f) lastName.current = f.name;
  const title = <span className={`title${f ? '' : ' gone'}`} title={lastName.current}>{lastName.current}</span>;
  const tools = f && <button className="expand" title="Plein écran" onClick={() => props.onFull()}><ExpandIcon /></button>;
  return (
    <FloatingPanel frame={props.frame} className="file-preview" title={title} tools={tools}>
      {!f ? <p className="dim gone">{props.gone}</p>
        : props.covered ? null
        : <Viewer key={f.hash} file={f} node={props.node} mode="preview" params={props.params} views={props.views} latex={props.latex} />}
    </FloatingPanel>
  );
}
