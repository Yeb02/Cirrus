import type { CompiledPdf, Id } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewRef } from '../../files/kind.ts';
import { CSS_PER_PT, openPdf, type PdfDoc, pageSize } from '../../files/pdf.ts';
import type { PageSize } from '../../files/pdfLayout.ts';
import { loading } from '../../files/read.ts';
import { PdfPage } from '../viewers/PdfViewer.tsx';

/**
 * The white card's padding on each side (styles.css, `.latex-snippet`), out of the width its pages fit: a layout
 * dimension of the stylesheet, like the table's CELL_PAD_PX, not a setting.
 */
const CARD_PAD_PX = 8;

/**
 * The pages' sizes of each compiled PDF once read, while something holds its record (a view, a pop-up's memory): shown
 * again, its card has its size at once, its pages drawn as soon as the document is open (no source in between).
 */
const sizesOf = new WeakMap<CompiledPdf, PageSize[]>();

/**
 * A summary's or a relation's compiled PDF (plan 4b, D3; task 6), drawn by pdf.js on a white card at its box's width:
 * every page, one under the other, fitted to that width but never enlarged past latexSnippetMaxZoom, sharp at the
 * screen's density (at most pdfCanvasMaxMp: PdfPage), its text selectable. A link to a node of the base calls
 * `onNodeLink`; one to http:, https: or mailto: goes to the system (openUrl); any other — a destination inside it among
 * them — is not a link. A new PDF takes the place of the last once its pages are read, the last one's drawing kept
 * meanwhile: typing never flashes. Its height is its pages'. Until its first PDF is read, `fallback` stands in its
 * place, or blank pages at their size when they are known from an earlier showing (sizesOf).
 */
export function LatexSnippet(props: { pdf: CompiledPdf; params: RenderParams; onNodeLink(id: Id): void; fallback?: ReactNode }) {
  const { pdf, params } = props;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [shown, setShown] = useState<{ doc: PDFDocumentProxy; sizes: PageSize[] } | { message: string } | null>(null);
  /** The document shown, held while it is. */
  const held = useRef<PdfDoc | null>(null);
  const nodeLink = useRef(props.onNodeLink);
  nodeLink.current = props.onNodeLink;
  const onNode = useCallback((id: Id) => nodeLink.current(id), []);
  // Every page's size is read before it is shown.
  const onSize = useCallback(() => {}, []);

  // The document and all its pages' sizes, then in place of the last one, which is let go once its pages have moved.
  useEffect(() => {
    let live = true;
    const ref: ViewRef = { name: 'compilé.pdf', hash: pdf.key, size: pdf.size, store: 'latex' };
    void loading((async () => {
      let h: PdfDoc | null = null;
      try {
        h = await openPdf(ref, params.pdfDocsKept);
        const sizes: PageSize[] = [];
        for (let i = 1; i <= h.doc.numPages && live; i++) sizes.push(pageSize(await Promise.race([h.doc.getPage(i), h.failure])));
        if (!live) { h.release(); return; }
        const before = held.current;
        held.current = h;
        sizesOf.set(pdf, sizes);
        setShown({ doc: h.doc, sizes });
        if (before) setTimeout(() => before.release(), 0);
      } catch (e) {
        if (h && held.current !== h) h.release();
        if (!live) return;
        // A compiled PDF that cannot be read: the last one stays; without one, why (the cause in the console).
        console.error('PDF compilé :', e);
        if (!held.current) setShown({ message: 'Le PDF compilé n’a pas pu être lu.' });
      }
    })());
    return () => { live = false; };
  }, [pdf.key]);
  // After the pages' own cleanups: their drawings stop before the document may close.
  useEffect(() => () => {
    const h = held.current;
    held.current = null;
    queueMicrotask(() => h?.release());
  }, []);

  useLayoutEffect(() => {
    const el = box.current!;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const room = width - 2 * CARD_PAD_PX;
  const doc = shown && 'doc' in shown ? shown : null;
  // Its document not open yet, its pages' sizes known from an earlier showing: blank pages at their size meanwhile.
  const sizes = doc?.sizes ?? (shown === null ? sizesOf.get(pdf) : undefined);
  if (!sizes || room <= 0) {
    return <div ref={box} className="latex-snippet-box">{shown && 'message' in shown ? <p className="latex-reason">{shown.message}</p> : props.fallback}</div>;
  }
  const widest = sizes.reduce((m, s) => Math.max(m, s.w), 0);
  const zoom = widest > 0 ? Math.min(params.latexSnippetMaxZoom, room / widest) : 1;
  const maxPixels = params.pdfCanvasMaxMp * 1e6;
  const pages = [];
  let height = 0;
  for (let i = 0; i < sizes.length; i++) {
    const w = sizes[i].w * zoom, h = sizes[i].h * zoom;
    pages.push(doc
      ? (
        <PdfPage
          key={i} doc={doc.doc} index={i} top={height} left={0} width={w} height={h} scale={zoom * CSS_PER_PT} drawn maxPixels={maxPixels}
          onSize={onSize} onNode={onNode}
        />
      )
      : <div key={i} className="pdf-page" style={{ top: height, left: 0, width: w, height: h }} />);
    height += h;
  }
  return (
    <div ref={box} className="latex-snippet-box">
      <div className="latex-snippet"><div className="pages" style={{ height }}>{pages}</div></div>
    </div>
  );
}
