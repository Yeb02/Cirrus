/** A floating panel's place in the window, in client pixels (plan 4a, D7). */
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * The height of a panel's header (styles.css, `.panel > header`): the part of it always kept in the window, by which it
 * is moved back. A layout dimension of the stylesheet, like its paddings, not a setting.
 */
export const HEADER_PX = 32;

export type Edge = 'move' | 'e' | 's' | 'se';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Along one axis: after the point by `gap`, else before it, else against the edge it would cross. */
function side(at: number, size: number, lo: number, hi: number, gap: number): number {
  if (at + gap + size <= hi) return Math.max(lo, at + gap);
  if (at - gap - size >= lo) return at - gap - size;
  return clamp(at + gap, lo, hi - size);
}

/** A panel opened at a click: right of and below it, turned to the left or above to stay whole in `bounds`. */
export function placeAt(at: { x: number; y: number }, size: { w: number; h: number }, bounds: Rect, gap: number): Rect {
  const w = Math.min(size.w, bounds.w), h = Math.min(size.h, bounds.h);
  return { x: side(at.x, w, bounds.x, bounds.x + bounds.w, gap), y: side(at.y, h, bounds.y, bounds.y + bounds.h, gap), w, h };
}

/**
 * A panel opened beside another, `near` (a file's preview beside its node's pop-up, plan 4a, task 5): placeAt's rule
 * along x, for the whole width of `near` — right of it by `gap`, else left of it, else against the edge of the roomier
 * side (it then covers the least of `near`) — level with its top, whole in `bounds`.
 */
export function placeBeside(near: Rect, size: { w: number; h: number }, bounds: Rect, gap: number): Rect {
  const w = Math.min(size.w, bounds.w), h = Math.min(size.h, bounds.h);
  const lo = bounds.x, hi = bounds.x + bounds.w, after = near.x + near.w + gap, before = near.x - gap;
  const x = after + w <= hi ? Math.max(lo, after) : before - w >= lo ? before - w : hi - after >= before - lo ? Math.max(lo, hi - w) : lo;
  return { x, y: clamp(near.y, bounds.y, bounds.y + bounds.h - h), w, h };
}

/**
 * A panel kept usable: at least `min` on each side and no larger than `bounds` (min first, for a tiny window), its
 * header whole in `bounds` (its width inside, its first HEADER_PX pixels from the top) — the rest may go below the edge.
 */
export function clampRect(r: Rect, bounds: Rect, min: number): Rect {
  const w = Math.max(min, Math.min(r.w, bounds.w)), h = Math.max(min, Math.min(r.h, bounds.h));
  return {
    x: clamp(r.x, bounds.x, Math.max(bounds.x, bounds.x + bounds.w - w)),
    y: clamp(r.y, bounds.y, Math.max(bounds.y, bounds.y + bounds.h - HEADER_PX)),
    w, h,
  };
}

/**
 * The panel `r` as a gesture begun on it leaves it, the pointer `dx, dy` away from where it was pressed: moved by its
 * header, or resized by its right edge, its bottom edge or its corner; the edge held never leaves `bounds`.
 */
export function dragRect(r: Rect, edge: Edge, dx: number, dy: number, bounds: Rect, min: number): Rect {
  if (edge === 'move') return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, bounds, min);
  const w = edge === 's' ? r.w : Math.min(r.w + dx, bounds.x + bounds.w - r.x);
  const h = edge === 'e' ? r.h : Math.min(r.h + dy, bounds.y + bounds.h - r.y);
  return clampRect({ ...r, w, h }, bounds, min);
}
