import { type Bounds, type Camera, fitBounds, panBy, zoomAt } from './camera.ts';
import { offsetPolygon } from './geometry/hull.ts';
import type { RenderParams } from './params.ts';
import type { PlanScene } from './scene.ts';

export type NavInput =
  | { t: 'wheel'; sx: number; sy: number; deltaY: number; ctrl: boolean }
  | { t: 'key'; key: string }
  | { t: 'drag'; dxPx: number; dyPx: number }
  | { t: 'resize'; widthPx: number; heightPx: number };

/**
 * Camera moves (spec 8.1, 9.1): wheel zoom around the cursor, + and − around the centre, arrows to pan, drag on the
 * background. Ctrl+wheel changes a scale step (plan 3b), never the camera. The camera is not undoable (spec 6.4).
 */
export function navigate(c: Camera, input: NavInput, p: RenderParams): Camera {
  switch (input.t) {
    case 'wheel':
      return input.ctrl ? c : zoomAt(c, input.sx, input.sy, Math.exp(-input.deltaY * p.wheelZoomSpeed), p);
    case 'drag':
      return panBy(c, input.dxPx, input.dyPx);
    case 'resize':
      return { ...c, widthPx: input.widthPx, heightPx: input.heightPx };
    case 'key': {
      const step = p.keyPanPx / c.zoom;
      switch (input.key) {
        case '+': case '=': return zoomAt(c, c.widthPx / 2, c.heightPx / 2, p.keyZoomStep, p);
        case '-': return zoomAt(c, c.widthPx / 2, c.heightPx / 2, 1 / p.keyZoomStep, p);
        case 'ArrowLeft': return { ...c, x: c.x - step };
        case 'ArrowRight': return { ...c, x: c.x + step };
        case 'ArrowUp': return { ...c, y: c.y - step };
        case 'ArrowDown': return { ...c, y: c.y + step };
        default: return c;
      }
    }
  }
}

/** Frames one item: a group with its padded envelope, a node or phantom with its box. */
export function fitItem(scene: PlanScene, item: number, cam: Camera, p: RenderParams): Camera {
  const it = scene.items[item];
  let b: Bounds;
  if (it.kind === 'group') {
    const poly = offsetPolygon(it.hull!, it.pad!);
    const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
    b = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  } else {
    b = { minX: it.x - it.halfW, minY: it.y - it.halfH, maxX: it.x + it.halfW, maxY: it.y + it.halfH };
  }
  return fitBounds(b, cam.widthPx, cam.heightPx, p);
}
