import type { Anchor, Id } from '@cirrus/core';
import { AbortException, type PDFDocumentProxy, type PDFPageProxy, RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type AnnotationEntry, type PageHit, rectsOnScreen, selectionToAnchor } from '../../files/annotations.ts';
import { type ViewRef, viewKey } from '../../files/kind.ts';
import { CSS_PER_PT, destination, openPdf, type PdfDoc, pageSize, pdfFailure } from '../../files/pdf.ts';
import {
  anchorAt, currentPage, fitWidthZoom, type PageSize, pageNumber, pageOffsets, placeAnchor, type Anchor as ViewPoint, visiblePages, wheelSteps, zoomBy,
} from '../../files/pdfLayout.ts';
import { loading } from '../../files/read.ts';
import { linkTarget } from '../latex/links.ts';
import { AnnotationLayer, type Flash, type MarkStyle } from './AnnotationLayer.tsx';
import { keptView, Message, useKeptView, type ViewProps } from './common.tsx';

/** Fitted to the width of the first page (a wider one overflows), or at a zoom of its own (1: the pages' real size). */
type Mode = { fit: true } | { fit: false; zoom: number };
/** A document point to put at the view's place (vx, vy) at the next layout: where the view is, or a zoom's centre. */
interface Target { a: ViewPoint; vx: number; vy: number }
/**
 * Annotating (plan 4c, D3): a passage selected in the PDF of node `pdf` offers « Annoter » (and Ctrl+Maj+A), which hands
 * its anchor to `onAnnotate`; that says whether it took it (its selection then goes) or refused it (too long: it stays).
 */
export interface Annotate { pdf: Id; onAnnotate(a: Anchor): boolean }
/** To a page (from 1), its passage `flash` blinking there (D4: an annotation opened from a list); a new `seq`, a new move. */
export interface Goto { page: number; flash?: Anchor; seq: number }

const NO_MARKS: readonly AnnotationEntry[] = [];
/** A colour of the settings (0 to 1 a channel) for CSS. */
const css = ([r, g, b]: readonly number[], alpha: number) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
const sameAnchor = (a: Anchor | null, b: Anchor | null) =>
  a === b || (a !== null && b !== null && a.page === b.page && a.text === b.text && JSON.stringify(a.rects) === JSON.stringify(b.rects));
/**
 * A link of a page, in percents of the page: to an address (http, https, mailto: openUrl), to a destination, or to a
 * node of the base (plan 4b, D7: `cirrus://node/<id>`, never handed to the system).
 */
interface Link { box: CSSProperties; url?: string; dest?: unknown; node?: Id }

/** A canvas let go at once, not at the next collection: its pixels are the page's memory. */
function free(canvas: HTMLCanvasElement): void {
  canvas.width = canvas.height = 0;
  canvas.remove();
}

/**
 * A PDF (plan 4a, D2, task 6), read by pdf.js page by page through HTTP ranges (openPdf): the pages one under the
 * other, pdfGapPx apart and centred, fitted by default to the width of the first page (a wider one overflows). Only
 * the pages in view and pdfPagesAhead on each side are drawn, at the screen's density (at most pdfCanvasMaxMp), with
 * their text, selectable and copied as text, and their links; the others are boxes at their size. A canvas leaving
 * that range is let go, its drawing stopped if under way.
 * Ctrl+wheel (a notch a step, as the graph's scaleWheelStepPx), the « − » and « + » buttons and keys zoom by
 * pdfZoomStep between pdfMinZoom and pdfMaxZoom, around the cursor or the view's centre; « Largeur » fits it again; the
 * « page n / N » field goes to a page. A link inside the document leads to its destination; one to http:, https: or
 * mailto: goes to the system (openUrl, which the main process checks again); one to a node of the base
 * (`cirrus://node/<id>`, plan 4b) to `onNodeLink`, and is not a link without it; any other is not a link. Its page, the
 * place in it, the horizontal centre and the zoom (or the fit) are kept by its hash.
 * `live` (plan 4b, task 5): a compiled PDF, `file` changing with each compilation. A new file replaces the document in
 * place, at the same zoom and the same scroll, bounded by the new height; the pages drawn of the last one stay until
 * the new ones are drawn over them, without a white flash. Its place is kept under `live.keptAs` (its source's), not
 * by a hash that changes with each compilation. Otherwise its parent keys it by the file's hash.
 * Drawn again only when its props change (memo): a parent that changes at each key typed (the .tex workbench) gives it
 * the same `live` and `onNodeLink` (task 5 review).
 * Annotations (plan 4c): `annotations`, those of this version (D2), are drawn over the pages drawn (AnnotationLayer);
 * with `annotate`, a passage selected offers « Annoter » at its end, and Ctrl+Maj+A in the view does the same — never
 * for a selection that is empty, only blanks, or begun outside the view (selectionToAnchor). `goto` brings a page into
 * view, its passage `flash` in the middle of it and blinking, even before the document is read.
 */
export const PdfViewer = memo(function PdfViewer(props: ViewProps & {
  file: ViewRef; live?: { keptAs: string }; onNodeLink?(node: Id): void; annotations?: readonly AnnotationEntry[]; annotate?: Annotate; goto?: Goto;
}) {
  const { file, params } = props;
  const box = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<PDFDocumentProxy | { message: string } | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [view, setView] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<Mode>({ fit: true });
  const [range, setRange] = useState({ first: 0, last: 0 });
  const [current, setCurrent] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const kept = useKeptView(props.views, props.live?.keptAs ?? file.hash);
  const target = useRef<Target | null>(null);
  const placed = useRef(false);
  const wheelRest = useRef(0);
  /** The document shown, held while it is. */
  const held = useRef<PdfDoc | null>(null);
  /** A link to a node, the pages' own callback: the same while the view lives, `onNodeLink` read when clicked. */
  const nodeLink = useRef(props.onNodeLink);
  nodeLink.current = props.onNodeLink;
  const onNode = useCallback((id: Id) => nodeLink.current?.(id), []);
  /** The pages read, by index, while they are drawn: a selection's page and its viewport (pageOf). */
  const proxies = useRef(new Map<number, PDFPageProxy>());
  const onPage = useCallback((i: number, p: PDFPageProxy | null) => { if (p) proxies.current.set(i, p); else proxies.current.delete(i); }, []);
  /** The passage selected in the view, as an anchor, while « Annoter » is offered for it. */
  const [picked, setPicked] = useState<Anchor | null>(null);
  const annotateRef = useRef(props.annotate);
  annotateRef.current = props.annotate;
  const fileRef = useRef(file);
  fileRef.current = file;
  /** A move asked (goto) and not made yet: the document is not read, or the passage's page is being read. */
  const pendingGoto = useRef<Goto | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);

  // The document, held while the view shows it; every page at the first one's size until it is read. A new one (live)
  // takes the place of the last, which is let go once the pages have moved to it.
  useEffect(() => {
    let live = true;
    void loading((async () => {
      try {
        const h = await openPdf(file, params.pdfDocsKept);
        if (!live) { h.release(); return; }
        // Its bytes no longer readable: said in its place (its pages would wait for ever).
        h.failure.catch((e: unknown) => { if (held.current === h) setOpened({ message: pdfFailure(file.name, e) }); });
        const size = pageSize(await Promise.race([h.doc.getPage(1), h.failure]));
        if (!live) { h.release(); return; }
        const before = held.current;
        held.current = h;
        // The scroll stays as it is, bounded by the new height (the browser's); the zoom, or the fit, too.
        target.current = null;
        setSizes(Array.from({ length: h.doc.numPages }, () => size));
        setOpened(h.doc);
        if (before) setTimeout(() => before.release(), 0);
      } catch (e) {
        // A compiled PDF that cannot be read while another is shown: that one stays, the cause in the console.
        if (!live) return;
        if (held.current) console.error(`PDF « ${file.name} » :`, e);
        else setOpened({ message: pdfFailure(file.name, e) });
      }
    })());
    return () => { live = false; };
  }, [viewKey(file)]);
  // After the pages' own cleanups (React runs this one first): their drawings stop before the document may close.
  useEffect(() => () => {
    const h = held.current;
    held.current = null;
    queueMicrotask(() => h?.release());
  }, []);

  useLayoutEffect(() => {
    const el = box.current!;
    const observer = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const doc = opened !== null && !('message' in opened) ? opened : null;
  const gap = params.pdfGapPx;
  // The fit follows the first page's width: a wider page found later overflows, centred, rather than shrink them all.
  const widest = sizes.reduce((m, s) => Math.max(m, s.w), 0), first = sizes[0]?.w ?? 0;
  const bounded = (z: number) => Math.min(params.pdfMaxZoom, Math.max(params.pdfMinZoom, z));
  const ready = doc !== null && view !== null && view.w > 0 && view.h > 0 && first > 0;
  const zoom = ready ? bounded(mode.fit ? fitWidthZoom(first, view.w, gap) : mode.zoom) : 1;
  const offsets = useMemo(() => pageOffsets(sizes, zoom, gap), [sizes, zoom, gap]);
  const contentW = ready ? Math.max(view.w, widest * zoom + 2 * gap) : 0;
  // What the listeners read: the last render's.
  const live = useRef({ offsets, sizes, zoom, contentW, mode, ready, params });
  live.current = { offsets, sizes, zoom, contentW, mode, ready, params };

  /**
   * The view moved (or its layout changed): its anchor — the document point at its top, in its middle —, the pages to
   * draw, the page shown, the place kept.
   */
  const scrolled = () => {
    const el = box.current!, l = live.current;
    if (!l.ready) return;
    const a = anchorAt(l.offsets, l.sizes, l.zoom, l.contentW, el.scrollLeft + el.clientWidth / 2, el.scrollTop);
    target.current = { a, vx: el.clientWidth / 2, vy: 0 };
    const r = visiblePages(l.offsets, el.scrollTop, el.clientHeight, l.params.pdfPagesAhead);
    setRange((p) => (p.first === r.first && p.last === r.last ? p : r));
    setCurrent(currentPage(l.offsets, el.scrollTop, el.clientHeight));
    kept.current = { page: a.page, offset: a.frac, x: a.relX, ...(l.mode.fit ? { fit: 1 } : { zoom: l.zoom }) };
  };

  // Each new layout (the document read, the view resized, a zoom, a page's real size): the anchor stays where it was.
  // The first one puts the view where it was left; in full screen, the view takes the focus (its keys scroll it).
  useLayoutEffect(() => {
    if (!ready) return;
    const el = box.current!;
    if (!placed.current) {
      placed.current = true;
      const k = keptView(props.views, props.live?.keptAs ?? file.hash);
      if (props.mode === 'full') el.focus({ preventScroll: true });
      if (k && Number.isFinite(k.page)) {
        const page = Math.min(sizes.length - 1, Math.max(0, Math.round(k.page)));
        target.current = { a: { page, frac: k.offset ?? 0, relX: k.x ?? 0 }, vx: el.clientWidth / 2, vy: 0 };
        if (!k.fit && k.zoom > 0 && bounded(k.zoom) !== zoom) { setMode({ fit: false, zoom: bounded(k.zoom) }); return; }
      } else {
        el.scrollTop = 0;
        el.scrollLeft = (contentW - el.clientWidth) / 2;
        target.current = null;
      }
    }
    const t = target.current;
    if (t) {
      const p = placeAnchor(t.a, offsets, sizes, zoom, contentW);
      el.scrollTop = p.y - t.vy;
      el.scrollLeft = p.x - t.vx;
    }
    scrolled();
    // A move asked before the document was read: from where the view would have opened.
    if (pendingGoto.current) moveTo();
  }, [ready, offsets, contentW, view?.h]);

  /**
   * The move asked (goto), once the document is read: its page's top at the view's top; with a passage, the passage
   * centred in the view (as far as the scroll goes; one wider than the view, its start), and blinking. The passage's
   * place is read from its page, its rotation included (a page not drawn is read first).
   */
  const moveTo = () => {
    const g = pendingGoto.current, d = held.current?.doc, l = live.current;
    if (!g || !d || !l.ready) return;
    pendingGoto.current = null;
    const page = Math.min(l.sizes.length - 1, Math.max(0, Math.round(g.page) - 1));
    if (!g.flash) {
      goTo(page);
      return;
    }
    const passage = g.flash;
    void loading((async () => {
      let p: PDFPageProxy;
      try {
        p = proxies.current.get(page) ?? await d.getPage(page + 1);
      } catch (e) {
        console.error(`Page ${page + 1} du PDF :`, e);
        return;
      }
      const el = box.current, now = live.current;
      if (!el || held.current?.doc !== d || !now.ready || pendingGoto.current) return;
      // At zoom 1, in CSS pixels: the passage's bounds on its page. Wider than the view, its start is kept in it, at
      // the pages' gap from its left; taller, its top at the view's top.
      const vp = p.getViewport({ scale: CSS_PER_PT }), all = rectsOnScreen(passage, vp);
      const top = Math.min(...all.map((x) => x.top)), bottom = Math.max(...all.map((x) => x.bottom));
      const left = Math.min(...all.map((x) => x.left)), right = Math.max(...all.map((x) => x.right));
      const fits = (right - left) * now.zoom <= el.clientWidth;
      target.current = {
        a: { page, frac: top / vp.height, relX: (fits ? (left + right) / 2 : left) - vp.width / 2 },
        vx: fits ? el.clientWidth / 2 : now.params.pdfGapPx, vy: Math.max(0, (el.clientHeight - (bottom - top) * now.zoom) / 2),
      };
      const at = placeAnchor(target.current.a, now.offsets, now.sizes, now.zoom, now.contentW);
      el.scrollTop = at.y - target.current.vy;
      el.scrollLeft = at.x - target.current.vx;
      scrolled();
      setFlash({ anchor: passage, seq: g.seq });
    })());
  };
  useLayoutEffect(() => {
    if (!props.goto) return;
    pendingGoto.current = props.goto;
    if (placed.current) moveTo();
  }, [props.goto?.seq]);

  /** A new zoom (or the fit), the document point at (vx, vy) of the view staying there. */
  const zoomTo = (m: Mode, vx: number, vy: number) => {
    const el = box.current!, l = live.current;
    if (!l.ready) return;
    target.current = { a: anchorAt(l.offsets, l.sizes, l.zoom, l.contentW, el.scrollLeft + vx, el.scrollTop + vy), vx, vy };
    setMode(m);
  };
  /** `steps` zoom steps around (vx, vy), the view's centre by default. */
  const step = (steps: number, vx?: number, vy?: number) => {
    const el = box.current!, { zoom: z, params: p, ready: r } = live.current;
    const to = zoomBy(z, steps, p.pdfZoomStep, p.pdfMinZoom, p.pdfMaxZoom);
    if (r && to !== z) zoomTo({ fit: false, zoom: to }, vx ?? el.clientWidth / 2, vy ?? el.clientHeight / 2);
  };
  // Ctrl+wheel zooms (the default would zoom the window); the wheel alone scrolls. A listener React would make passive cannot.
  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = wheelSteps(wheelRest.current, e.deltaY, live.current.params.scaleWheelStepPx);
      wheelRest.current = r.rest;
      if (r.steps === 0) return;
      const b = el.getBoundingClientRect();
      step(r.steps, e.clientX - b.left, e.clientY - b.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  /** To the top of a page. */
  const goTo = (page: number) => {
    const el = box.current!;
    el.scrollTop = live.current.offsets[page];
    scrolled();
  };

  /**
   * The page of an element of the view (a text of the selection, a line break), at its place in the window and the
   * zoom shown, its rotation included; null outside the pages drawn. Each page's box measured once per selection.
   */
  const pageHits = () => {
    const seen = new Map<Element, PageHit | null>(), scale = live.current.zoom * CSS_PER_PT;
    return (el: Element): PageHit | null => {
      const pageBox = el.closest<HTMLElement>('.pdf-page');
      if (!pageBox || !box.current?.contains(pageBox)) return null;
      let hit = seen.get(pageBox);
      if (hit === undefined) {
        const index = Number(pageBox.dataset.page) - 1, p = proxies.current.get(index), r = pageBox.getBoundingClientRect();
        hit = p ? { page: index + 1, viewport: p.getViewport({ scale, offsetX: r.left, offsetY: r.top }) } : null;
        seen.set(pageBox, hit);
      }
      return hit;
    };
  };
  const annotating = props.annotate !== undefined;
  /** The passage selected in this view, as it is now: null for none, or for a selection begun outside the view. */
  const selected = (): Anchor | null => {
    const sel = document.getSelection(), an = annotateRef.current, el = box.current;
    const range = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    return range && an && el && live.current.ready && el.contains(range.startContainer) ? selectionToAnchor(sel!, pageHits(), an.pdf, fileRef.current) : null;
  };
  // The passage selected, read again when the selection changes — once a press that makes it is over, so that
  // « Annoter » does not follow the pointer — and dropped when it leaves the view (or is made outside it).
  useEffect(() => {
    if (!annotating) return;
    const el = box.current!;
    let pressing = false, frame = 0;
    const read = () => {
      frame = 0;
      const a = selected();
      setPicked((p) => (sameAnchor(p, a) ? p : a));
    };
    const change = () => { if (!pressing && frame === 0) frame = requestAnimationFrame(read); };
    const down = (e: PointerEvent) => {
      // A press on « Annoter » is its click's.
      if ((e.target as Element | null)?.closest?.('.annotate')) return;
      pressing = true;
      setPicked(null);
    };
    const up = () => { if (pressing) { pressing = false; change(); } };
    document.addEventListener('selectionchange', change);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', change);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    };
  }, [annotating]);
  /**
   * « Annoter » (or Ctrl+Maj+A): the passage selected, read at once (a key right after the press that made it comes
   * before the frame that reads it), to `onAnnotate`; taken, its selection goes. False when there is none.
   */
  const annotateNow = (): boolean => {
    const a = selected(), an = annotateRef.current;
    if (!a || !an) return false;
    if (an.onAnnotate(a)) {
      document.getSelection()?.removeAllRanges();
      setPicked(null);
    }
    return true;
  };
  // A page's real size, once it is read: the layout follows it (the first page's size until then).
  const onSize = useCallback((i: number, s: PageSize) => {
    setSizes((prev) => (prev[i] && prev[i].w === s.w && prev[i].h === s.h ? prev : prev.map((x, k) => (k === i ? s : x))));
  }, []);
  // A link inside the document: its page, the place it names at the view's top (and left, if it names one).
  const onDest = useCallback((dest: unknown) => {
    const d = live.current, el = box.current!;
    if (!d.ready) return;
    void (async () => {
      try {
        const docNow = opened as PDFDocumentProxy;
        const to = await destination(docNow, dest);
        if (!to) return;
        const vp = (await docNow.getPage(to.page + 1)).getViewport({ scale: CSS_PER_PT });
        const [px, py] = vp.convertToViewportPoint(to.x ?? 0, to.y ?? 0);
        const l = live.current, s = l.sizes[to.page];
        const frac = to.y === null ? 0 : Math.min(1, Math.max(0, py / vp.height));
        const at = placeAnchor({ page: to.page, frac, relX: 0 }, l.offsets, l.sizes, l.zoom, l.contentW);
        el.scrollTop = at.y;
        if (to.x !== null) el.scrollLeft = (l.contentW - s.w * l.zoom) / 2 + (px / vp.width) * s.w * l.zoom;
        scrolled();
      } catch (e) {
        console.error(`Lien de « ${file.name} » :`, e);
      }
    })();
  }, [opened]);

  // The annotations of this version, by page index; how they are drawn.
  const marks = useMemo(() => {
    const m = new Map<number, AnnotationEntry[]>();
    for (const e of props.annotations ?? NO_MARKS) {
      const list = m.get(e.anchor.page - 1);
      if (list) list.push(e);
      else m.set(e.anchor.page - 1, [e]);
    }
    return m;
  }, [props.annotations]);
  const { annotationColor: tint, annotationOpacity: alpha, annotationFlashMs: flashMs } = params;
  const markStyle = useMemo<MarkStyle>(() => ({ color: css(tint, alpha), solid: css(tint, 1), flashMs }), [tint, alpha, flashMs]);

  const n = sizes.length;
  const pages = [];
  if (ready) {
    const scale = zoom * CSS_PER_PT, maxPixels = params.pdfCanvasMaxMp * 1e6;
    for (let i = 0; i < n; i++) {
      const w = sizes[i].w * zoom, h = sizes[i].h * zoom;
      pages.push(
        <PdfPage
          key={i} doc={doc} index={i} top={offsets[i]} left={(contentW - w) / 2} width={w} height={h} scale={scale}
          drawn={i >= range.first && i < range.last} maxPixels={maxPixels} onSize={onSize} onDest={onDest}
          onNode={props.onNodeLink ? onNode : undefined} onPage={onPage} marks={marks.get(i)} markStyle={markStyle}
          flash={flash && flash.anchor.page - 1 === i ? flash : undefined}
        />,
      );
    }
  }
  /** « Annoter », right under the end of the passage selected (its last line), on its page at this zoom. */
  const offer = (() => {
    const proxy = picked && ready ? proxies.current.get(picked.page - 1) : undefined;
    if (!picked || !proxy || !sizes[picked.page - 1]) return null;
    const i = picked.page - 1, [end] = rectsOnScreen({ rects: [picked.rects[picked.rects.length - 1]] }, proxy.getViewport({ scale: zoom * CSS_PER_PT }));
    return { left: (contentW - sizes[i].w * zoom) / 2 + end.right, top: offsets[i] + end.bottom };
  })();
  const message = opened === null ? 'Lecture…' : 'message' in opened ? opened.message : null;
  const p = params;
  return (
    <div className="viewer viewer-pdf">
      {doc && (
        <div className="pdf-tools">
          <button className="zoom-out" title="Zoom arrière (−)" disabled={zoom <= p.pdfMinZoom} onClick={() => step(-1)}>−</button>
          <span className="zoom">{Math.round(zoom * 100)} %</span>
          <button className="zoom-in" title="Zoom avant (+)" disabled={zoom >= p.pdfMaxZoom} onClick={() => step(1)}>+</button>
          <button
            className={mode.fit ? 'fit on' : 'fit'} title="Ajuster à la largeur"
            onClick={() => { const el = box.current!; if (!mode.fit) zoomTo({ fit: true }, el.clientWidth / 2, 0); }}
          >
            Largeur
          </button>
          <span className="spacer" />
          <label className="page">
            Page
            <input
              value={draft ?? String(current + 1)} inputMode="numeric" spellCheck={false} aria-label="Aller à la page"
              size={Math.max(2, String(n).length)}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const to = pageNumber(e.currentTarget.value, n);
                  if (to !== null) goTo(to);
                  setDraft(null);
                  e.currentTarget.select();
                } else if (e.key === 'Escape') {
                  // The field's: it gives up what is typed and lets go; the view stays (a next Escape closes it).
                  e.preventDefault();
                  setDraft(null);
                  box.current?.focus({ preventScroll: true });
                }
              }}
            />
            <span className="count">/ {n}</span>
          </label>
        </div>
      )}
      <div
        ref={box} className="pdf-scroll" tabIndex={doc ? 0 : -1} onScroll={scrolled}
        onKeyDown={(e) => {
          // Ctrl+Maj+A (D3), the view's own: no other shortcut of the app reads it.
          if (annotating && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'a') {
            if (annotateNow()) e.preventDefault();
            return;
          }
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          if (e.key === '+' || e.key === '=') { e.preventDefault(); step(1); }
          else if (e.key === '-') { e.preventDefault(); step(-1); }
        }}
      >
        {ready && (
          <div className="pdf-sizer" style={{ width: contentW, height: offsets[n] }}>
            {pages}
            {offer && annotating && (
              <button
                className="annotate" style={offer} title="Annoter ce passage (Ctrl+Maj+A)"
                // The selection stays, and the focus where it is.
                onMouseDown={(e) => e.preventDefault()} onClick={() => annotateNow()}
              >
                Annoter
              </button>
            )}
          </div>
        )}
      </div>
      {message && <Message text={message} />}
    </div>
  );
});

export interface PageProps {
  doc: PDFDocumentProxy; index: number; top: number; left: number; width: number; height: number;
  /** CSS pixels per point. */
  scale: number;
  drawn: boolean; maxPixels: number;
  onSize(index: number, size: PageSize): void;
  /** Where a link inside the document leads, and one to a node of the base; without them, those are not links. */
  onDest?(dest: unknown): void; onNode?(node: Id): void;
  /**
   * A link pressed keeps the focus where it was (a compiled summary's, under its editor: plan 4b, task 6, its links
   * drawn anew with each compilation); the reader's take it, as any link, so that its keys go to the reader.
   */
  keepFocus?: boolean;
  /** The page read while it is drawn (null once let go): the reader finds a selection's page and viewport by it. */
  onPage?(index: number, page: PDFPageProxy | null): void;
  /** The annotations drawn on this page (plan 4c), the passage blinking on it, and how they are drawn. */
  marks?: readonly AnnotationEntry[]; flash?: Flash; markStyle?: MarkStyle;
}

/**
 * A page's box, at its place and size. While it is `drawn`: its canvas at the screen's density (at most `maxPixels`,
 * stretched past them), drawn again at each zoom (the last drawing stretched meanwhile), its text layer (pdf.js's
 * TextLayer, kept in step with the zoom) and its links. Left: the drawing under way stopped, the canvas let go. The
 * reader's pages, and a compiled summary's (LatexSnippet, plan 4b).
 */
export const PdfPage = memo(function PdfPage(props: PageProps) {
  const { doc, index, drawn, scale } = props;
  const box = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const scaleNow = useRef(scale);
  scaleNow.current = scale;
  const text = useRef<{ layer: TextLayer; rendered: boolean } | null>(null);

  // The page while it is drawn: its real size for the layout, its links. A new document's (live) replaces the last
  // one's once read, so that its drawing stays meanwhile.
  useEffect(() => {
    if (!drawn) return;
    let live = true;
    void loading((async () => {
      try {
        const p = await doc.getPage(index + 1);
        if (!live) return;
        props.onSize(index, pageSize(p));
        setPage(p);
        setLinks([]);
        const annotations = await p.getAnnotations({ intent: 'display' });
        if (live) setLinks(linksOf(annotations, p));
      } catch (e) {
        if (live) console.error(`Page ${index + 1} du PDF :`, e);
      }
    })());
    return () => { live = false; };
  }, [drawn, doc]);
  useEffect(() => {
    if (!drawn) return;
    return () => { setPage(null); setLinks([]); };
  }, [drawn]);

  // Drawn at this zoom, into a new canvas that replaces the last one once complete.
  useEffect(() => {
    if (!page) return;
    const viewport = page.getViewport({ scale });
    const density = Math.min(window.devicePixelRatio || 1, Math.sqrt(props.maxPixels / (viewport.width * viewport.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * density));
    canvas.height = Math.max(1, Math.floor(viewport.height * density));
    const task = page.render({ canvas, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
    let done = false;
    void loading(task.promise.then(
      () => {
        done = true;
        const el = box.current;
        if (!el) { free(canvas); return; }
        const before = el.querySelector('canvas');
        el.prepend(canvas);
        if (before) free(before);
      },
      (e: unknown) => {
        free(canvas);
        if (!(e instanceof RenderingCancelledException)) console.error(`Dessin de la page ${index + 1} du PDF :`, e);
      },
    ));
    return () => { if (!done) task.cancel(); };
  }, [page, scale]);

  // Its text, laid over the canvas: transparent, selectable, copied as text.
  useEffect(() => {
    if (!page) return;
    const container = textBox.current!;
    const at = scaleNow.current;
    const layer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container, viewport: page.getViewport({ scale: at }),
    });
    const t = { layer, rendered: false };
    text.current = t;
    void loading(layer.render().then(
      () => {
        if (text.current !== t) return;
        t.rendered = true;
        // pdf.js's end of content: while a selection is made, it covers the page so that the selection does not jump.
        const end = document.createElement('div');
        end.className = 'endOfContent';
        container.append(end);
        if (scaleNow.current !== at) layer.update({ viewport: page.getViewport({ scale: scaleNow.current }) });
      },
      (e: unknown) => { if (!(e instanceof AbortException)) console.error(`Texte de la page ${index + 1} du PDF :`, e); },
    ));
    return () => { text.current = null; layer.cancel(); container.replaceChildren(); };
  }, [page]);
  useEffect(() => {
    const t = text.current;
    if (page && t?.rendered) t.layer.update({ viewport: page.getViewport({ scale }) });
  }, [scale]);

  // A page let go: what pdf.js keeps of it — after the cleanups above (React runs them in order): a page whose drawing
  // is under way would keep it. Its canvas goes once the page is left (no page), not when a new document's page takes
  // its place (live): that drawing stays until the new one replaces it.
  useEffect(() => {
    if (page === null) box.current?.querySelectorAll('canvas').forEach(free);
    props.onPage?.(index, page);
    return () => { page?.cleanup(); };
  }, [page]);
  useEffect(() => () => props.onPage?.(index, null), []);
  useEffect(() => {
    const el = box.current!;
    return () => el.querySelectorAll('canvas').forEach(free);
  }, []);

  const style = { top: props.top, left: props.left, width: props.width, height: props.height, '--total-scale-factor': scale } as CSSProperties;
  return (
    <div ref={box} className="pdf-page" style={style} data-page={index + 1}>
      {page && props.markStyle && ((props.marks?.length ?? 0) > 0 || props.flash) && (
        <AnnotationLayer page={page} scale={scale} marks={props.marks ?? NO_MARKS} flash={props.flash} style={props.markStyle} />
      )}
      <div
        ref={textBox} className="textLayer"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.classList.add('selecting');
          window.addEventListener('pointerup', () => el.classList.remove('selecting'), { once: true });
        }}
      />
      {links.length > 0 && (
        <div className="pdf-links" onMouseDown={props.keepFocus ? (e) => { if ((e.target as Element).closest('a')) e.preventDefault(); } : undefined}>
          {links.map((l, i) => (
            l.url
              ? (
                <a
                  key={i} href={l.url} title={l.url.replace(/^mailto:/, '')} style={l.box} draggable={false}
                  onClick={(e) => { e.preventDefault(); void window.cirrus.openUrl(l.url!); }}
                />
              )
              : l.node !== undefined
                ? props.onNode && (
                  <a
                    key={i} href="#" title="Ouvrir le pop-up de ce nœud" style={l.box} draggable={false}
                    onClick={(e) => { e.preventDefault(); props.onNode!(l.node!); }}
                  />
                )
                : props.onDest && (
                  <a
                    key={i} href="#" title="Lien vers une page du document" style={l.box} draggable={false}
                    onClick={(e) => { e.preventDefault(); props.onDest!(l.dest); }}
                  />
                )
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * A page's links, in percents of it (they follow the zoom by themselves), each where linkTarget says it leads: a node
 * of the base, an address pdf.js validated and externalUrlAllowed takes, a destination of the document. Another
 * scheme, an action, an attachment: not a link.
 */
function linksOf(annotations: { subtype?: string; rect?: number[]; url?: string; unsafeUrl?: string; dest?: unknown }[], page: PDFPageProxy): Link[] {
  const vp = page.getViewport({ scale: 1 });
  const out: Link[] = [];
  for (const a of annotations) {
    if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4) continue;
    const to = linkTarget(a);
    if (to === null) continue;
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]) as number[];
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]) as number[];
    const pct = (v: number, of: number) => `${(100 * v) / of}%`;
    const box = {
      left: pct(Math.min(x1, x2), vp.width), top: pct(Math.min(y1, y2), vp.height),
      width: pct(Math.abs(x2 - x1), vp.width), height: pct(Math.abs(y2 - y1), vp.height),
    };
    out.push({ box, ...to });
  }
  return out;
}
