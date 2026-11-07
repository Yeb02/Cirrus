import { annotationTitle } from '@cirrus/core';
import { memo } from 'react';
import { type AnnotationEntry, NODE_MIME } from '../../files/annotations.ts';

/**
 * The reader's margin (plan 4c, D4): the annotations of the PDF shown, every version, in the order of the pages —
 * each with its page, the start of its passage (annotationTitleChars characters), the plans it is in, and « sur une
 * version précédente » for those of another version than the node's file (`current`, D2). Those of the version shown
 * (`shown`) are marked. A click, or Entrée, opens one (`onOpen`: its page, its passage blinking, on its version). With
 * `draggable` (a preview, not the modal full screen), an annotation is dragged out as its node (NODE_MIME), to be put
 * down on the graph (task 3). Folded, a narrow strip with its count; `onToggle` folds and unfolds it.
 */
export const AnnotationMargin = memo(function AnnotationMargin(props: {
  entries: readonly AnnotationEntry[]; current: string; shown: string; folded: boolean; widthPx: number; titleChars: number; draggable: boolean;
  onToggle(): void; onOpen(e: AnnotationEntry): void;
}) {
  const count = props.entries.length;
  if (props.folded) {
    return (
      <aside className="annotation-margin folded" aria-label="Annotations">
        <button className="fold" title="Montrer les annotations" aria-expanded={false} onClick={() => props.onToggle()}>
          ‹<span className="count">{count}</span>
        </button>
      </aside>
    );
  }
  return (
    <aside className="annotation-margin" aria-label="Annotations" style={{ width: props.widthPx }}>
      <header>
        <span className="heading">Annotations</span>
        <span className="count">{count}</span>
        <span className="spacer" />
        <button className="fold" title="Replier la marge" aria-expanded onClick={() => props.onToggle()}>›</button>
      </header>
      <ol>
        {props.entries.map((e) => {
          const start = annotationTitle(e.anchor.text, props.titleChars), here = e.anchor.hash === props.shown;
          const open = () => props.onOpen(e);
          return (
            <li
              key={e.node.id} className={here ? 'here' : undefined} data-node={e.node.id} role="button" tabIndex={0} draggable={props.draggable}
              title={e.node.title === start ? undefined : e.node.title}
              onClick={open}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } }}
              onDragStart={(ev) => {
                ev.dataTransfer.setData(NODE_MIME, e.node.id);
                ev.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span className="page">p. {e.anchor.page}</span>
              <span className="start">{start}</span>
              <span className="plans">{e.plans.length > 0 ? e.plans.map((p) => p.name).join(', ') : 'dans aucun plan'}</span>
              {e.anchor.hash !== props.current && <span className="version">sur une version précédente</span>}
            </li>
          );
        })}
      </ol>
    </aside>
  );
});
