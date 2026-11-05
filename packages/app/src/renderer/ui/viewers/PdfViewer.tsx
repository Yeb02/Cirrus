import { AbortException, type PDFDocumentProxy, type PDFPageProxy, RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { externalUrlAllowed } from '../../../main/navigation.ts';
import { type ViewRef, viewKey } from '../../files/kind.ts';
import { CSS_PER_PT, destination, openPdf, type PdfDoc, pageSize, pdfFailure } from '../../files/pdf.ts';
import {
  type Anchor, anchorAt, currentPage, fitWidthZoom, type PageSize, pageNumber, pageOffsets, placeAnchor, visiblePages, wheelSteps, zoomBy,
} from '../../files/pdfLayout.ts';
import { loading } from '../../files/read.ts';
import { keptView, Message, useKeptView, type ViewProps } from './common.tsx';

/** Fitted to the width of the first page (a wider one overflows), or at a zoom of its own (1: the pages' real size). */
type Mode = { fit: true } | { fit: false; zoom: number };
/** A document point to put at the view's place (vx, vy) at the next layout: where the view is, or a zoom's centre. */
interface Target { a: Anchor; vx: number; vy: number }
/** A link of a page, in percents of the page: to an address (http, https, mailto: openUrl), or to a destination. */
interface Link { box: CSSProperties; url?: string; dest?: unknown }

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
 * mailto: goes to the system (openUrl, which the main process checks again); any other is not a link. Its page, the
 * place in it, the horizontal centre and the zoom (or the fit) are kept by its hash.
 * `live` (plan 4b, task 5): a compiled PDF, `file` changing with each compilation. A new file replaces the document in
 * place, at the same zoom and the same scroll, bounded by the new height; the pages drawn of the last one stay until
 * the new ones are drawn over them, without a white flash. Its place is kept under `live.keptAs` (its source's), not
 * by a hash that changes with each compilation. Otherwise its parent keys it by the file's hash.
 */
export function PdfViewer(props: ViewProps & { file: ViewRef; live?: { keptAs: string } }) {
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
  }, [ready, offsets, contentW, view?.h]);

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
        />,
      );
    }
  }
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
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          if (e.key === '+' || e.key === '=') { e.preventDefault(); step(1); }
          else if (e.key === '-') { e.preventDefault(); step(-1); }
        }}
      >
        {ready && <div className="pdf-sizer" style={{ width: contentW, height: offsets[n] }}>{pages}</div>}
      </div>
      {message && <Message text={message} />}
    </div>
  );
}

interface PageProps {
  doc: PDFDocumentProxy; index: number; top: number; left: number; width: number; height: number;
  /** CSS pixels per point. */
  scale: number;
  drawn: boolean; maxPixels: number;
  onSize(index: number, size: PageSize): void; onDest(dest: unknown): void;
}

/**
 * A page's box, at its place and size. While it is `drawn`: its canvas at the screen's density (at most `maxPixels`,
 * stretched past them), drawn again at each zoom (the last drawing stretched meanwhile), its text layer (pdf.js's
 * TextLayer, kept in step with the zoom) and its links. Left: the drawing under way stopped, the canvas let go.
 */
const PdfPage = memo(function PdfPage(props: PageProps) {
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
    return () => { page?.cleanup(); };
  }, [page]);
  useEffect(() => {
    const el = box.current!;
    return () => el.querySelectorAll('canvas').forEach(free);
  }, []);

  const style = { top: props.top, left: props.left, width: props.width, height: props.height, '--total-scale-factor': scale } as CSSProperties;
  return (
    <div ref={box} className="pdf-page" style={style} data-page={index + 1}>
      <div
        ref={textBox} className="textLayer"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.classList.add('selecting');
          window.addEventListener('pointerup', () => el.classList.remove('selecting'), { once: true });
        }}
      />
      {links.length > 0 && (
        <div className="pdf-links">
          {links.map((l, i) => (
            l.url
              ? (
                <a
                  key={i} href={l.url} title={l.url.replace(/^mailto:/, '')} style={l.box} draggable={false}
                  onClick={(e) => { e.preventDefault(); void window.cirrus.openUrl(l.url!); }}
                />
              )
              : (
                <a
                  key={i} href="#" title="Lien vers une page du document" style={l.box} draggable={false}
                  onClick={(e) => { e.preventDefault(); props.onDest(l.dest); }}
                />
              )
          ))}
        </div>
      )}
    </div>
  );
});

/**
 * A page's links, in percents of it (they follow the zoom by themselves): to an address pdf.js validated and
 * externalUrlAllowed takes, or to a destination of the document. Another scheme, an action, an attachment: not a link.
 */
function linksOf(annotations: { subtype?: string; rect?: number[]; url?: string; dest?: unknown }[], page: PDFPageProxy): Link[] {
  const vp = page.getViewport({ scale: 1 });
  const out: Link[] = [];
  for (const a of annotations) {
    if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4) continue;
    const url = typeof a.url === 'string' && externalUrlAllowed(a.url) ? a.url : undefined;
    const dest = a.dest ?? undefined;
    if (!url && (dest === undefined || dest === null)) continue;
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]) as number[];
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]) as number[];
    const pct = (v: number, of: number) => `${(100 * v) / of}%`;
    const box = {
      left: pct(Math.min(x1, x2), vp.width), top: pct(Math.min(y1, y2), vp.height),
      width: pct(Math.abs(x2 - x1), vp.width), height: pct(Math.abs(y2 - y1), vp.height),
    };
    out.push({ box, url, dest: url ? undefined : dest });
  }
  return out;
}
