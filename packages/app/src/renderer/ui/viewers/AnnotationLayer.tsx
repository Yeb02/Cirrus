import type { Anchor } from '@cirrus/core';
import type { PDFPageProxy } from 'pdfjs-dist';
import { type CSSProperties, memo } from 'react';
import { type AnnotationEntry, type DOMRectLike, rectsOnScreen } from '../../files/annotations.ts';

/** A passage blinking (D4: opened from a list), until the next one; `seq` starts it again. */
export interface Flash { anchor: Anchor; seq: number }

const place = (r: DOMRectLike): CSSProperties => ({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top });

/** How the highlights are drawn: annotationColor at annotationOpacity, the same opaque for a passage blinking, for annotationFlashMs. */
export interface MarkStyle { color: string; solid: string; flashMs: number }

/**
 * A page's highlights (plan 4c, D3), over its canvas and under its text, which stays selectable: a translucent
 * rectangle per line of each annotation of the version shown (`marks`), multiplied with the page (the text stays
 * black), and the passage blinking for `flashMs` (`flash`; 0: none). Drawn only for the pages drawn (PdfPage), at the
 * page's zoom and rotation (its viewport).
 */
export const AnnotationLayer = memo(function AnnotationLayer(props: {
  page: PDFPageProxy; scale: number; marks: readonly AnnotationEntry[]; flash?: Flash; style: MarkStyle;
}) {
  const vp = props.page.getViewport({ scale: props.scale });
  const { flash, style } = props;
  return (
    <div className="annotation-layer" aria-hidden="true">
      {props.marks.map((e) => rectsOnScreen(e.anchor, vp).map((r, k) => (
        <div key={`${e.node.id}/${k}`} className="mark" style={{ ...place(r), background: style.color }} />
      )))}
      {flash && style.flashMs > 0 && rectsOnScreen(flash.anchor, vp).map((r, k) => (
        <div key={`${flash.seq}/${k}`} className="flash" style={{ ...place(r), background: style.solid, animationDuration: `${style.flashMs}ms` }} />
      ))}
    </div>
  );
});
