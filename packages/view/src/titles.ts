import type { Vec2 } from '@cirrus/core';

export interface Rect { x: number; y: number; w: number; h: number }
export type TitleSide = 'up' | 'upright' | 'upleft' | 'down' | 'downright' | 'downleft' | 'right' | 'left' | 'upfar' | 'downfar';

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The maquette's title placement (spec 8.5: near the marker, covering neither the marker nor the lines): ten candidate
 * spots scored by their cost, the curve samples they cover and the boxes they overlap; the previous side is preferred,
 * so titles do not jump from one rebuild to the next.
 */
export function placeTitle(marker: Vec2, w: number, h: number, gap: number, samples: Vec2[], obstacles: Rect[], previous?: TitleSide): { side: TitleSide; rect: Rect } {
  const far = gap * 3.5, dx = w / 2 + gap * 0.6, dy = gap + h / 2, M = marker;
  const cands: [TitleSide, number, number, number][] = [
    ['up', M.x, M.y - dy, 0], ['upright', M.x + dx, M.y - dy, 0.2], ['upleft', M.x - dx, M.y - dy, 0.2],
    ['down', M.x, M.y + dy, 0.3], ['downright', M.x + dx, M.y + dy, 0.4], ['downleft', M.x - dx, M.y + dy, 0.4],
    ['right', M.x + gap + w / 2, M.y, 0.5], ['left', M.x - gap - w / 2, M.y, 0.5],
    ['upfar', M.x, M.y - far - h / 2, 1], ['downfar', M.x, M.y + far + h / 2, 1],
  ];
  let best: { side: TitleSide; rect: Rect } | null = null, bestScore = Infinity;
  for (const [side, cx, cy, cost] of cands) {
    const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    let score = cost - (side === previous ? 1.5 : 0);
    for (const q of samples) if (q.x > rect.x && q.x < rect.x + w && q.y > rect.y && q.y < rect.y + h) score += 1;
    for (const o of obstacles) if (overlaps(rect, o)) score += 25;
    if (score < bestScore) { bestScore = score; best = { side, rect }; }
  }
  return best!;
}
