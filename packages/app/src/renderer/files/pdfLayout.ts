/**
 * A PDF's layout in its reader (plan 4a, task 6), without the DOM: the pages one under the other, `gap` pixels apart
 * and around them, each at its own size times the zoom; which of them are in view, by binary search; where a point of
 * the document goes when the zoom changes. Sizes are in CSS pixels at zoom 1 (a point is 96/72 px: zoom 1 is the
 * page's real size).
 */

export interface PageSize { w: number; h: number }

/** The top of each page, then the total height: a gap before each page and after the last. */
export function pageOffsets(sizes: PageSize[], zoom: number, gap: number): Float64Array {
  const out = new Float64Array(sizes.length + 1);
  out[0] = gap;
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i].h * zoom + gap;
  return out;
}

/** How many of `a[from..to)`, ascending, are at most `x` (`strict`: below it). */
function countUpTo(a: Float64Array, from: number, to: number, x: number, strict: boolean): number {
  let lo = from, hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? a[mid] < x : a[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo - from;
}

/**
 * The pages to draw (`last` excluded) for a view `height` high scrolled to `top`, `ahead` more on each side, within
 * the document. Each page's band runs from its top to the next one's (its gap after it included): `first` is the
 * number of bands wholly above the view, `last` the number starting above its bottom — two binary searches, whatever
 * the number of pages. Nothing in view gives an empty range where it would be, widened by `ahead`.
 */
export function visiblePages(offsets: Float64Array, top: number, height: number, ahead: number): { first: number; last: number } {
  const n = offsets.length - 1;
  const above = countUpTo(offsets, 1, n + 1, top, false);
  const started = countUpTo(offsets, 0, n, top + height, true);
  return { first: Math.max(0, above - ahead), last: Math.min(n, started + ahead) };
}

/** The zoom at which a page `pageWidth` wide (at zoom 1) fills a view `viewWidth` wide, `margin` on each side. */
export function fitWidthZoom(pageWidth: number, viewWidth: number, margin: number): number {
  return Math.max(1, viewWidth - 2 * margin) / pageWidth;
}

/** The page whose band holds the document's height `y`: the first before its top, the last past the end. */
export function pageAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1;
  return Math.max(0, Math.min(n - 1, countUpTo(offsets, 0, n, y, false) - 1));
}

/** The page shown: the one whose band fills most of the view, the first of them on a tie (« page n / N »). */
export function currentPage(offsets: Float64Array, top: number, height: number): number {
  const n = offsets.length - 1;
  const { first, last } = visiblePages(offsets, top, height, 0);
  if (first >= last) return Math.max(0, Math.min(n - 1, first));
  let best = first, most = -1;
  for (let i = first; i < last; i++) {
    const part = Math.min(offsets[i + 1], top + height) - Math.max(offsets[i], top);
    if (part > most) { most = part; best = i; }
  }
  return best;
}

/**
 * A point of the document, kept across a zoom or a new layout: its page, how far down it (a share of the page's
 * height), and its distance from the content's middle at zoom 1 (the pages are centred).
 */
export interface Anchor { page: number; frac: number; relX: number }

/** The point at (x, y) of the content (the scroll plus a place in the view), `contentWidth` wide at `zoom`. */
export function anchorAt(offsets: Float64Array, sizes: PageSize[], zoom: number, contentWidth: number, x: number, y: number): Anchor {
  const page = pageAt(offsets, y);
  return { page, frac: (y - offsets[page]) / (sizes[page].h * zoom), relX: (x - contentWidth / 2) / zoom };
}

/** Where an anchor is in a layout: the content's coordinates to put under the place it was taken at. */
export function placeAnchor(a: Anchor, offsets: Float64Array, sizes: PageSize[], zoom: number, contentWidth: number): { x: number; y: number } {
  const page = Math.max(0, Math.min(sizes.length - 1, a.page));
  return { x: contentWidth / 2 + a.relX * zoom, y: offsets[page] + a.frac * sizes[page].h * zoom };
}

/** `steps` zoom steps of `step` from `zoom` (in for positive steps), between `min` and `max`. */
export function zoomBy(zoom: number, steps: number, step: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, zoom * step ** steps));
}

/**
 * Ctrl+wheel as zoom steps, as in the graph (scaleWheelStepPx): a wheel notch (|deltaY| ≥ notchPx) is one step, the
 * smaller scrolls of a touchpad add up to one; upwards zooms in. `rest`: what earlier scrolls left.
 */
export function wheelSteps(rest: number, deltaY: number, notchPx: number): { steps: number; rest: number } {
  if (Math.abs(deltaY) >= notchPx) return { steps: -Math.sign(deltaY), rest: 0 };
  let r = rest - deltaY, steps = 0;
  while (Math.abs(r) >= notchPx) { steps += Math.sign(r); r -= Math.sign(r) * notchPx; }
  return { steps, rest: r };
}

/** The page the « page n / N » field asks for (its index), or null for anything but a whole number from 1 to N. */
export function pageNumber(text: string, count: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= count ? n - 1 : null;
}
