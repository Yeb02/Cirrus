import { expect, test } from 'vitest';
import {
  anchorAt, currentPage, fitWidthZoom, pageAt, pageOffsets, pageNumber, placeAnchor, visiblePages, wheelSteps, zoomBy,
} from '../src/renderer/files/pdfLayout.ts';

// Three pages: A4 portrait, Letter landscape, a small card (CSS pixels at zoom 1).
const SIZES = [{ w: 794, h: 1123 }, { w: 1056, h: 816 }, { w: 400, h: 300 }];

test('pageOffsets : le haut de chaque page, l’écart avant chacune et après la dernière, la hauteur totale en dernier', () => {
  expect([...pageOffsets(SIZES, 1, 12)]).toEqual([12, 12 + 1123 + 12, 12 + 1123 + 12 + 816 + 12, 12 + 1123 + 12 + 816 + 12 + 300 + 12]);
  // The pages scale with the zoom, the gaps do not.
  expect([...pageOffsets(SIZES, 0.5, 10)]).toEqual([10, 10 + 561.5 + 10, 10 + 561.5 + 10 + 408 + 10, 10 + 561.5 + 10 + 408 + 10 + 150 + 10]);
  expect([...pageOffsets(SIZES, 2, 0)]).toEqual([0, 2246, 2246 + 1632, 2246 + 1632 + 600]);
  expect([...pageOffsets([], 1, 12)]).toEqual([12]);
});

/** The same as visiblePages, by a scan of every page: the pages wholly above the view, those starting above its bottom. */
function scan(offsets: Float64Array, top: number, height: number, ahead: number): { first: number; last: number } {
  const n = offsets.length - 1;
  let above = 0, started = 0;
  for (let i = 0; i < n; i++) {
    if (offsets[i + 1] <= top) above++;
    if (offsets[i] < top + height) started++;
  }
  return { first: Math.max(0, above - ahead), last: Math.min(n, started + ahead) };
}

test('visiblePages : en haut, au milieu, au bas, une vue plus haute que le document, `ahead` qui déborde des bornes', () => {
  const o = pageOffsets(SIZES, 1, 12); // [12, 1147, 1975, 2287]
  // At the top: the first page only (its leading gap is no page); one more each side with ahead 1.
  expect(visiblePages(o, 0, 900, 0)).toEqual({ first: 0, last: 1 });
  expect(visiblePages(o, 0, 900, 1)).toEqual({ first: 0, last: 2 });
  // In the middle: the end of the first page and the start of the second.
  expect(visiblePages(o, 1000, 400, 0)).toEqual({ first: 0, last: 2 });
  expect(visiblePages(o, 1200, 400, 0)).toEqual({ first: 1, last: 2 });
  // The second page's band ends where the third starts: 1975 is the third's.
  expect(visiblePages(o, 1975, 100, 0)).toEqual({ first: 2, last: 3 });
  // At the bottom.
  expect(visiblePages(o, 2287 - 500, 500, 0)).toEqual({ first: 1, last: 3 });
  // A view taller than the document: every page.
  expect(visiblePages(o, 0, 5000, 0)).toEqual({ first: 0, last: 3 });
  // `ahead` past the bounds stays in them.
  expect(visiblePages(o, 0, 900, 5)).toEqual({ first: 0, last: 3 });
  expect(visiblePages(o, 2287 - 100, 100, 4)).toEqual({ first: 0, last: 3 });
  // Nothing in view (the leading gap, or past the end): an empty range where it would be, widened by `ahead`.
  expect(visiblePages(o, 0, 10, 0)).toEqual({ first: 0, last: 0 });
  expect(visiblePages(o, 5000, 100, 0)).toEqual({ first: 3, last: 3 });
  expect(visiblePages(o, 5000, 100, 1)).toEqual({ first: 2, last: 3 });
});

test('visiblePages : sur 2 000 pages, égal à un balayage linéaire pour 1 000 positions au hasard', () => {
  // A seeded generator, so that a failure comes back.
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const sizes = Array.from({ length: 2000 }, () => ({ w: 600 + rand() * 400, h: 300 + rand() * 900 }));
  const zoom = 0.5 + rand() * 2;
  const o = pageOffsets(sizes, zoom, 12);
  const total = o[o.length - 1];
  for (let k = 0; k < 1000; k++) {
    const top = rand() * (total + 400) - 200, height = rand() * 3000, ahead = Math.floor(rand() * 4);
    expect(visiblePages(o, top, height, ahead), `${top} ${height} ${ahead}`).toEqual(scan(o, top, height, ahead));
  }
  // Page tops exactly at the view's edges.
  for (let i = 0; i < 2000; i += 97) {
    expect(visiblePages(o, o[i], o[i + 1] - o[i], 0)).toEqual(scan(o, o[i], o[i + 1] - o[i], 0));
  }
});

test('fitWidthZoom : la page aussi large que la vue, ses marges ôtées', () => {
  expect(fitWidthZoom(794, 818, 12)).toBe(1);
  expect(fitWidthZoom(800, 1624, 12)).toBe(2);
  expect(fitWidthZoom(800, 424, 12)).toBe(0.5);
  // A view narrower than its margins keeps a pixel of page, never a zoom of 0 or below.
  expect(fitWidthZoom(800, 20, 12)).toBe(1 / 800);
});

test('pageAt et currentPage : la page sous un point, et celle qui occupe le plus la vue (la première à égalité)', () => {
  const o = pageOffsets(SIZES, 1, 12);
  expect([pageAt(o, 0), pageAt(o, 12), pageAt(o, 1146), pageAt(o, 1147), pageAt(o, 2286), pageAt(o, 9999)]).toEqual([0, 0, 0, 1, 2, 2]);
  expect(currentPage(o, 0, 900)).toBe(0);
  // 147 px of the first page, 700 of the second.
  expect(currentPage(o, 1000, 847)).toBe(1);
  // The view on the second page's top, the whole third page too: the second, which fills more of it.
  expect(currentPage(o, 1147, 2000)).toBe(1);
  // Equal parts: the first of them.
  const same = pageOffsets([{ w: 100, h: 100 }, { w: 100, h: 100 }, { w: 100, h: 100 }], 1, 0);
  expect(currentPage(same, 0, 300)).toBe(0);
  expect(currentPage(same, 50, 100)).toBe(0);
  // Past the end: the last page; nothing in view at the top: the first.
  expect(currentPage(o, 5000, 100)).toBe(2);
  expect(currentPage(o, 0, 5)).toBe(0);
});

test('anchorAt et placeAnchor : un point du document reste sous le curseur quand le zoom change', () => {
  const o1 = pageOffsets(SIZES, 1, 12), w1 = 1056 + 24;
  // 300 px into the second page, 100 px right of the content's centre.
  const a = anchorAt(o1, SIZES, 1, w1, w1 / 2 + 100, o1[1] + 300);
  expect(a.page).toBe(1);
  expect(a.frac).toBeCloseTo(300 / 816, 12);
  expect(a.relX).toBe(100);
  const back = placeAnchor(a, o1, SIZES, 1, w1);
  expect(back.x).toBe(w1 / 2 + 100);
  expect(back.y).toBeCloseTo(o1[1] + 300, 9);
  // At ×2 the same point is twice as far into its page, and from the centre.
  const o2 = pageOffsets(SIZES, 2, 12), w2 = 2 * 1056 + 24;
  const p = placeAnchor(a, o2, SIZES, 2, w2);
  expect(p.x).toBe(w2 / 2 + 200);
  expect(p.y).toBeCloseTo(o2[1] + 600, 9);
  // A point of the leading gap is the first page's, before its top.
  expect(anchorAt(o1, SIZES, 1, w1, 0, 0)).toMatchObject({ page: 0 });
});

test('zoomBy et wheelSteps : des pas bornés ; un cran de molette est un pas, les petits défilements s’ajoutent', () => {
  expect(zoomBy(1, 1, 1.25, 0.25, 5)).toBe(1.25);
  expect(zoomBy(1, -2, 2, 0.25, 5)).toBe(0.25);
  expect(zoomBy(4, 3, 2, 0.25, 5)).toBe(5);
  expect(zoomBy(0.3, -1, 2, 0.25, 5)).toBe(0.25);
  // A notch (|deltaY| ≥ notchPx) is one step, upwards zooming in.
  expect(wheelSteps(0, -120, 100)).toEqual({ steps: 1, rest: 0 });
  expect(wheelSteps(0, 300, 100)).toEqual({ steps: -1, rest: 0 });
  // A touchpad's small deltas add up to a step.
  let r = { steps: 0, rest: 0 }, steps = 0;
  for (let i = 0; i < 10; i++) { r = wheelSteps(r.rest, -25, 100); steps += r.steps; }
  expect(steps).toBe(2);
  expect(r.rest).toBe(50);
});

test('pageNumber : le champ « page n / N » mène à une page de 1 à N, sinon à rien', () => {
  expect(pageNumber('3', 12)).toBe(2);
  expect(pageNumber(' 12 ', 12)).toBe(11);
  expect(pageNumber('1', 1)).toBe(0);
  for (const t of ['', '0', '13', '2,5', '1e1', 'deux', '-1']) expect(pageNumber(t, 12), t).toBeNull();
});
