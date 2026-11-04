import { extensionOf, fileKind } from '../../files/kind.ts';

/**
 * The logic of the file views (plan 4a, task 5), without the DOM: which view a file has, the banners of a head read, an
 * image's zoom and place, a table's visible part.
 */

export type ViewChoice = { view: 'image' } | { view: 'pdf' } | { view: 'text'; wrap: boolean } | { view: 'table' };

/** Prose, whose long lines are wrapped: the rest of the text kinds is code, read line by line. */
const WRAPPED = new Set(['txt', 'md', 'log']);

/**
 * The view a file is shown in, by its kind (fileKind): an image, a PDF, a table, or text — LaTeX source included, coloured
 * as LaTeX (languageFor). A kind Cirrus has no view for (`other`) has none: the system's application opens it.
 */
export function viewOf(name: string): ViewChoice | null {
  switch (fileKind(name)) {
    case 'image': return { view: 'image' };
    case 'pdf': return { view: 'pdf' };
    case 'table': return { view: 'table' };
    case 'tex': case 'text': return { view: 'text', wrap: WRAPPED.has(extensionOf(name)) };
    case 'other': return null;
  }
}

/** The banner of a head read (readHead) of `maxMb` Mo. */
export function truncationNotice(maxMb: number): string {
  return maxMb === 1 ? 'Seul le premier Mo est affiché.' : `Seuls les ${maxMb.toLocaleString('fr-FR')} premiers Mo sont affichés.`;
}

/** The banner of a table cut at `rows` rows (tableMaxRows). */
export function rowsNotice(rows: number): string {
  return `Seules les ${rows.toLocaleString('fr-FR')} premières lignes sont affichées.`;
}

// ———— Images

export interface Size { w: number; h: number }
/** An image as it is shown: its scale (1 is its own size), and the point of it, in its own pixels, at the view's centre. */
export interface ImageView { zoom: number; cx: number; cy: number }
/**
 * What an image's view is computed in: the image's own size, the view's, the largest zoom (imageMaxZoom) and the largest
 * a fit enlarges it to (imageFitMaxZoom; 1 would show an image smaller than the view at its own size).
 */
export interface ImageFrame { image: Size; view: Size; maxZoom: number; fitMaxZoom: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** The scale at which the whole image is in the view, enlarged at most to fitMaxZoom. */
const fitZoom = (f: ImageFrame) => Math.min(f.fitMaxZoom, f.view.w / f.image.w, f.view.h / f.image.h);

/** The image fitted to the view, centred. */
export function fitView(f: ImageFrame): ImageView {
  return { zoom: fitZoom(f), cx: f.image.w / 2, cy: f.image.h / 2 };
}

/** Along one axis: an image wider than the view keeps it filled; one it holds whole stays in its middle. */
function axis(c: number, size: number, view: number, zoom: number): number {
  const half = view / 2 / zoom;
  return size <= 2 * half ? size / 2 : clamp(c, half, size - half);
}

/**
 * A zoom from the smaller of the fit and 1:1 to the larger of the fit and maxZoom: an image the fit shrinks is never
 * smaller than its fit, one the fit enlarges can still be seen at its own size (the double-click's 1:1, the wheel).
 */
const bounded = (zoom: number, f: ImageFrame) => {
  const fit = fitZoom(f);
  return clamp(zoom, Math.min(fit, 1), Math.max(fit, f.maxZoom));
};

/** A view kept usable: its scale within `bounded`, the image never dragged out of it. */
export function clampView(v: ImageView, f: ImageFrame): ImageView {
  const zoom = bounded(v.zoom, f);
  return { zoom, cx: axis(v.cx, f.image.w, f.view.w, zoom), cy: axis(v.cy, f.image.h, f.view.h, zoom) };
}

/** Whether a view is the fit: its zoom is the fit's (clampView then centres it). */
export const isFit = (v: ImageView, f: ImageFrame): boolean => v.zoom === fitZoom(f);

/** Scaled by `factor` around `at` (view pixels from its top left): the image point under it stays there. */
export function zoomAt(v: ImageView, f: ImageFrame, at: { x: number; y: number }, factor: number): ImageView {
  const dx = at.x - f.view.w / 2, dy = at.y - f.view.h / 2;
  const px = v.cx + dx / v.zoom, py = v.cy + dy / v.zoom, zoom = bounded(v.zoom * factor, f);
  return clampView({ zoom, cx: px - dx / zoom, cy: py - dy / zoom }, f);
}

/** Dragged by `dx, dy` view pixels: the image follows the pointer. */
export function panBy(v: ImageView, f: ImageFrame, dx: number, dy: number): ImageView {
  return clampView({ zoom: v.zoom, cx: v.cx - dx / v.zoom, cy: v.cy - dy / v.zoom }, f);
}

/** A double-click: fitted, the image goes to its own size around the point; otherwise back to the fit. */
export function toggleFit(v: ImageView, f: ImageFrame, at: { x: number; y: number }): ImageView {
  return isFit(v, f) ? zoomAt(v, f, at, 1 / v.zoom) : fitView(f);
}

// ———— Tables

/**
 * The data rows to draw (`last` excluded) for a view `height` high scrolled to `top`, `margin` more on each side: each
 * row `rowPx` high, under a header row as high. The row hidden under the sticky header is drawn too.
 */
export function rowWindow(top: number, height: number, rowPx: number, count: number, margin: number): { first: number; last: number } {
  const last = clamp(Math.ceil((top + height + margin) / rowPx) - 1, 0, count);
  return { first: clamp(Math.floor((top - margin) / rowPx) - 1, 0, last), last };
}

/** Where each column starts, its total width last. */
export function columnOffsets(widths: number[]): Float64Array {
  const out = new Float64Array(widths.length + 1);
  for (let i = 0; i < widths.length; i++) out[i + 1] = out[i] + widths[i];
  return out;
}

/** The first index whose value is above `x`, in the ascending `a` from `from` (a.length if none). */
function firstAbove(a: Float64Array, x: number, from: number): number {
  let lo = from, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] > x) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** The columns to draw (`last` excluded) for a view `width` wide scrolled to `left`, `margin` more on each side. */
export function columnWindow(offsets: Float64Array, left: number, width: number, margin: number): { first: number; last: number } {
  const n = offsets.length - 1;
  // The first column ending past the left edge; the first starting at the right edge or past it.
  const first = Math.min(n, Math.max(0, firstAbove(offsets, left - margin, 1) - 1));
  let last = first;
  while (last < n && offsets[last] < left + width + margin) last++;
  return { first, last };
}

/**
 * Each column as wide as its longest value (in characters, ragged rows included) measured by `measure`, plus `padPx`
 * (the cells' padding), at most `maxPx`: one pass over the rows, one measure per column.
 */
export function columnWidths(rows: string[][], measure: (text: string) => number, maxPx: number, padPx: number): number[] {
  const longest: string[] = [];
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (longest[c] === undefined || row[c].length > longest[c].length) longest[c] = row[c];
    }
  }
  return longest.map((text) => Math.min(maxPx, Math.ceil(measure(text)) + padPx));
}
