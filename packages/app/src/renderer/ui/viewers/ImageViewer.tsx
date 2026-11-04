import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fileUrl } from '../../files/kind.ts';
import { loading, ReadError, readHead } from '../../files/read.ts';
import { keptView, Message, useKeptView, type ViewProps } from './common.tsx';
import { clampView, fitView, type ImageFrame, type ImageView, isFit, panBy, type Size, toggleFit, zoomAt } from './views.ts';

/** An image without its own size (an SVG with neither width nor height): the size CSS gives a replaced element. */
const NO_SIZE: Size = { w: 300, h: 150 };

/**
 * An image (plan 4a, task 5), served by cirrus-file: to an <img>: fitted to the view, enlarged at most to
 * imageFitMaxZoom (4 by default); the wheel zooms around the cursor (imageZoomSpeed), from the smaller of the fit and
 * its own size up to imageMaxZoom; a drag moves it; a double-click goes from the fit to its own size around the point,
 * and back. It is
 * drawn at its zoomed size rather than scaled by a transform, so that an SVG is drawn sharp. Its place is kept by its
 * hash: fitted (fitted again to the view it opens in), or its zoom and centre.
 */
export function ImageViewer(props: ViewProps) {
  const { file, params } = props;
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<Size | null>(null);
  const [image, setImage] = useState<Size | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState<{ at: ImageView; fit: boolean } | null>(null);
  const kept = useKeptView(props.views, file.hash);
  const frameOf = (im: Size | null, v: Size | null): ImageFrame | null =>
    (im && v && v.w > 0 && v.h > 0 ? { image: im, view: v, maxZoom: params.imageMaxZoom, fitMaxZoom: params.imageFitMaxZoom } : null);
  const frame = frameOf(image, view);
  // What the listeners read: the last render's.
  const live = useRef({ frame, shown, params });
  live.current = { frame, shown, params };

  // Loaded or not, it no longer holds a capture back. Made before the image can load: its load event comes in a later task.
  const settle = useRef<(() => void) | null>(null);
  const loaded = (el: HTMLImageElement) => {
    setImage(el.naturalWidth > 0 && el.naturalHeight > 0 ? { w: el.naturalWidth, h: el.naturalHeight } : NO_SIZE);
    settle.current?.();
  };
  useLayoutEffect(() => {
    void loading(new Promise<void>((done) => { settle.current = done; }));
    const el = img.current!;
    if (el.complete && el.naturalWidth > 0) loaded(el);
    const observer = new ResizeObserver(() => {
      const b = box.current;
      if (b) setView({ w: b.clientWidth, h: b.clientHeight });
    });
    observer.observe(box.current!);
    return () => { observer.disconnect(); settle.current?.(); };
  }, []);

  // Shown once its size and the view's are known: where it was left, or fitted; the view resized (or a setting changed),
  // fitted again or kept usable.
  useEffect(() => {
    const f = frameOf(image, view);
    if (!f) return;
    setShown((s) => {
      if (!s) {
        const k = keptView(props.views, file.hash);
        if (k && !k.fit && k.zoom > 0) return { at: clampView({ zoom: k.zoom, cx: k.cx, cy: k.cy }, f), fit: false };
        return { at: fitView(f), fit: true };
      }
      return s.fit ? { at: fitView(f), fit: true } : { at: clampView(s.at, f), fit: false };
    });
  }, [view, image, params.imageMaxZoom, params.imageFitMaxZoom]);
  useEffect(() => {
    if (shown) kept.current = shown.fit ? { fit: 1 } : { zoom: shown.at.zoom, cx: shown.at.cx, cy: shown.at.cy };
  }, [shown]);

  /** A new place: the fit again when its zoom comes back to the fit's (a window resized then fits it again). */
  const place = (f: ImageFrame, at: ImageView) => setShown({ at, fit: isFit(at, f) });
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // The wheel's default (scrolling what is under the view) is taken: a listener React would make passive cannot.
  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      const { frame: f, shown: s, params: p } = live.current;
      if (!f || !s) return;
      e.preventDefault();
      place(f, zoomAt(s.at, f, local(e), Math.exp(-e.deltaY * p.imageZoomSpeed)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const release = (el: HTMLElement) => { drag.current = null; el.classList.remove('dragging'); };

  const style = shown && frame
    ? {
      width: frame.image.w * shown.at.zoom, height: frame.image.h * shown.at.zoom,
      transform: `translate(${frame.view.w / 2 - shown.at.cx * shown.at.zoom}px, ${frame.view.h / 2 - shown.at.cy * shown.at.zoom}px)`,
    }
    : { visibility: 'hidden' as const };
  return (
    <div
      ref={box} className="viewer viewer-image" tabIndex={-1}
      // While dragged, the view is `.dragging` (its cursor), set on the element: a press is no render.
      onPointerDown={(e) => {
        if (e.button !== 0 || !shown) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.classList.add('dragging');
      }}
      onPointerMove={(e) => {
        const d = drag.current, { frame: f, shown: s } = live.current;
        if (!d || !f || !s) return;
        drag.current = { x: e.clientX, y: e.clientY };
        place(f, panBy(s.at, f, e.clientX - d.x, e.clientY - d.y));
      }}
      onPointerUp={(e) => release(e.currentTarget)}
      onLostPointerCapture={(e) => release(e.currentTarget)}
      onDoubleClick={(e) => {
        const { frame: f, shown: s } = live.current;
        if (f && s) place(f, toggleFit(s.at, f, local(e)));
      }}
    >
      <img
        ref={img} src={fileUrl(file)} alt={file.name} draggable={false} style={style}
        onLoad={(e) => loaded(e.currentTarget)}
        onError={() => {
          // Why: a blob missing from the store (readHead's 404, one byte asked) or an image that does not decode.
          void loading(readHead(file, 1).then(() => 'Image illisible.', (e: unknown) => (e instanceof ReadError ? e.message : 'Image illisible.')))
            .then(setFailed)
            .finally(() => settle.current?.());
        }}
      />
      {failed && <Message text={failed} />}
    </div>
  );
}
