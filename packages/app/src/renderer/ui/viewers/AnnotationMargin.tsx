import { annotationTitle } from '@cirrus/core';
import { memo } from 'react';
import { type AnnotationEntry, NODE_MIME } from '../../files/annotations.ts';

/**
 * One annotation of a list (plan 4c, D4), the reader's margin's or a PDF's pop-up's: the start of its passage
 * (`titleChars` characters), its page, the plans it is in, then `note` — « sur une version précédente », or what is
 * missing to open it (Review Focus 4). `here`: of the version shown, marked. A click, or Entrée, opens it (`onOpen`);
 * without, it cannot be opened, and says why in its note. With `draggable`, it is dragged out as its node (NODE_MIME,
 * effectAllowed « copy »), to be put down on the graph (task 3).
 */
export const AnnotationItem = memo(function AnnotationItem(props: {
  entry: AnnotationEntry; titleChars: number; here: boolean; note: string | null; draggable: boolean; onOpen?(e: AnnotationEntry): void;
}) {
  const e = props.entry, start = annotationTitle(e.anchor.text, props.titleChars), onOpen = props.onOpen;
  const open = onOpen && (() => onOpen(e));
  return (
    <li
      className={[props.here && 'here', !open && 'gone'].filter(Boolean).join(' ') || undefined} data-node={e.node.id} role="button" tabIndex={0}
      aria-disabled={open ? undefined : true} draggable={props.draggable} title={e.node.title === start ? undefined : e.node.title}
      onClick={open}
      onKeyDown={(ev) => { if (open && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); open(); } }}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(NODE_MIME, e.node.id);
        ev.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <span className="page">p. {e.anchor.page}</span>
      <span className="start">{start}</span>
      <span className="plans">{e.plans.length > 0 ? e.plans.map((p) => p.name).join(', ') : 'dans aucun plan'}</span>
      {props.note && <span className="version">{props.note}</span>}
    </li>
  );
});

/** The note of an annotation made on another version than the file's (D2). */
export const EARLIER_VERSION = 'sur une version précédente';

/**
 * The reader's margin (plan 4c, D4): the annotations of the PDF shown, every version, in the order of the pages —
 * each an AnnotationItem, « sur une version précédente » for those of another version than the node's file (`current`,
 * D2). Those of the version shown (`shown`) are marked. A click, or Entrée, opens one (`onOpen`: its page, its passage
 * blinking, on its version). With `draggable` (a preview, not the modal full screen), an annotation is dragged out as
 * its node, to be put down on the graph (task 3). Folded, a narrow strip with its count; `onToggle` folds and unfolds it.
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
      <ol className="annotation-list">
        {props.entries.map((e) => (
          <AnnotationItem
            key={e.node.id} entry={e} titleChars={props.titleChars} here={e.anchor.hash === props.shown}
            note={e.anchor.hash !== props.current ? EARLIER_VERSION : null} draggable={props.draggable} onOpen={props.onOpen}
          />
        ))}
      </ol>
    </aside>
  );
});
