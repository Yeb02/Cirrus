import type { Vec2 } from '@cirrus/core';
import type { RenderParams } from './params.ts';

/** (x, y): world point at the centre of the screen; zoom: screen px per world unit. */
export interface Camera { x: number; y: number; zoom: number; widthPx: number; heightPx: number }

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

const clampZoom = (z: number, p: RenderParams) => Math.min(p.zoomMax, Math.max(p.zoomMin, z));

export function screenToWorld(c: Camera, sx: number, sy: number): Vec2 {
  return { x: c.x + (sx - c.widthPx / 2) / c.zoom, y: c.y + (sy - c.heightPx / 2) / c.zoom };
}

export function worldToScreen(c: Camera, wx: number, wy: number): Vec2 {
  return { x: (wx - c.x) * c.zoom + c.widthPx / 2, y: (wy - c.y) * c.zoom + c.heightPx / 2 };
}

/** Zoom by `factor` around the screen point (sx, sy), which keeps the same world point under it (spec 8.1). */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number, p: RenderParams): Camera {
  const w = screenToWorld(c, sx, sy);
  const zoom = clampZoom(c.zoom * factor, p);
  return { ...c, zoom, x: w.x - (sx - c.widthPx / 2) / zoom, y: w.y - (sy - c.heightPx / 2) / zoom };
}

/** The view follows a drag of (dxPx, dyPx) on screen. */
export function panBy(c: Camera, dxPx: number, dyPx: number): Camera {
  return { ...c, x: c.x - dxPx / c.zoom, y: c.y - dyPx / c.zoom };
}

/** Frames the bounds with fitMarginPx around them; an empty plan opens at the origin, zoom 1. */
export function fitBounds(b: Bounds | null, widthPx: number, heightPx: number, p: RenderParams): Camera {
  if (!b) return { x: 0, y: 0, zoom: 1, widthPx, heightPx };
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const availW = Math.max(1, widthPx - 2 * p.fitMarginPx), availH = Math.max(1, heightPx - 2 * p.fitMarginPx);
  const fits = [bw > 0 ? availW / bw : Infinity, bh > 0 ? availH / bh : Infinity];
  const zoom = Math.min(...fits);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom: zoom === Infinity ? 1 : clampZoom(zoom, p), widthPx, heightPx };
}
