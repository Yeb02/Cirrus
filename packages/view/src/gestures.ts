import type { Vec2 } from '@cirrus/core';
import { type Bounds, type Camera, screenToWorld } from './camera.ts';
import type { Hit } from './hit.ts';
import type { RenderParams } from './params.ts';

export type Input =
  | { t: 'down'; button: 0 | 1 | 2; sx: number; sy: number; ctrl: boolean; alt: boolean; shift: boolean; hit: Hit }
  | { t: 'move'; sx: number; sy: number }
  | { t: 'up'; button: 0 | 1 | 2; sx: number; sy: number }
  | { t: 'key'; key: string }
  /** Focus lost, tab changed: whatever is in progress is abandoned. */
  | { t: 'cancel' };

/** Gestures without a held button (spec 9.1): the thing follows the cursor until a left click places it. */
export type Mode = 'place' | 'connect' | 'exclude' | 'paste' | 'split';

export type Intent =
  | { t: 'click'; hit: Hit; ctrl: boolean; shift: boolean; sx: number; sy: number }
  | { t: 'context'; hit: Hit; sx: number; sy: number }
  | { t: 'pan'; dxPx: number; dyPx: number }
  | { t: 'dragStart'; hit: Hit; alt: boolean }
  /** World offset from where the drag started. */
  | { t: 'dragMove'; dx: number; dy: number; sx: number; sy: number }
  | { t: 'dragEnd'; dx: number; dy: number; at: Vec2; alt: boolean }
  | { t: 'dragCancel' }
  | { t: 'rectMove'; rect: Bounds }
  | { t: 'rectEnd'; rect: Bounds }
  | { t: 'rectCancel' }
  | { t: 'placeMove'; at: Vec2; sx: number; sy: number }
  | { t: 'place'; mode: Mode; at: Vec2; hit: Hit }
  | { t: 'placeCancel'; mode: Mode };

type State =
  | { s: 'idle' }
  | { s: 'pressed'; button: 0 | 1 | 2; x: number; y: number; hit: Hit; ctrl: boolean; alt: boolean; shift: boolean }
  | { s: 'pan'; x: number; y: number }
  | { s: 'drag'; x: number; y: number; alt: boolean; lastX: number; lastY: number }
  | { s: 'rect'; x: number; y: number }
  | { s: 'swallow' } // a button pressed to cancel: its release does nothing
  | { s: 'mode'; mode: Mode };

/**
 * The mouse and keyboard grammar of the graph (spec 9.1), as a pure state machine: it turns pointer events into
 * intents. A press that moves at most clickSlopPx is a click. Held on an element it moves it (with the selection);
 * on the background (an open group's included) it moves the view; with Ctrl it draws a selection rectangle; with Alt
 * it moves an element out of its group. Escape, a right click or a lost focus cancel what is in progress.
 */
export class GestureMachine {
  private st: State = { s: 'idle' };
  private readonly p: RenderParams;

  constructor(p: RenderParams) {
    this.p = p;
  }

  get busy(): boolean {
    // Waiting for the release of a button that placed or cancelled something is not a gesture.
    return this.st.s !== 'idle' && this.st.s !== 'swallow';
  }

  get mode(): Mode | null {
    return this.st.s === 'mode' ? this.st.mode : null;
  }

  start(mode: Mode): void {
    this.st = { s: 'mode', mode };
  }

  feed(input: Input, cam: Camera): Intent[] {
    const st = this.st;
    const world = (sx: number, sy: number) => screenToWorld(cam, sx, sy);
    const rectOf = (x0: number, y0: number, x1: number, y1: number): Bounds => {
      const a = world(x0, y0), b = world(x1, y1);
      return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    };
    const cancelling = input.t === 'cancel' || (input.t === 'key' && input.key === 'Escape') || (input.t === 'down' && input.button === 2);

    if (st.s === 'mode') {
      if (cancelling) { this.st = input.t === 'down' ? { s: 'swallow' } : { s: 'idle' }; return [{ t: 'placeCancel', mode: st.mode }]; }
      if (input.t === 'move') return [{ t: 'placeMove', at: world(input.sx, input.sy), sx: input.sx, sy: input.sy }];
      if (input.t === 'down' && input.button === 0) {
        this.st = { s: 'swallow' };
        return [{ t: 'place', mode: st.mode, at: world(input.sx, input.sy), hit: input.hit }];
      }
      return [];
    }
    if (st.s === 'drag' && cancelling) { this.st = input.t === 'down' ? { s: 'swallow' } : { s: 'idle' }; return [{ t: 'dragCancel' }]; }
    if (st.s === 'rect' && cancelling) { this.st = input.t === 'down' ? { s: 'swallow' } : { s: 'idle' }; return [{ t: 'rectCancel' }]; }
    if (input.t === 'cancel') { this.st = { s: 'idle' }; return []; }

    switch (input.t) {
      case 'down':
        if (st.s !== 'idle') return [];
        this.st = { s: 'pressed', button: input.button, x: input.sx, y: input.sy, hit: input.hit, ctrl: input.ctrl, alt: input.alt, shift: input.shift };
        return [];
      case 'move': {
        if (st.s === 'pressed') {
          if (Math.hypot(input.sx - st.x, input.sy - st.y) <= this.p.clickSlopPx) return [];
          if (st.button === 2) { this.st = { s: 'swallow' }; return []; }
          // A stub is dragged like an element: it gets a place of its own (spec 8.5).
          if (st.button === 1 || (st.hit.kind !== 'item' && st.hit.kind !== 'stub' && !st.ctrl)) {
            this.st = { s: 'pan', x: input.sx, y: input.sy };
            return [{ t: 'pan', dxPx: input.sx - st.x, dyPx: input.sy - st.y }];
          }
          if (st.ctrl) {
            this.st = { s: 'rect', x: st.x, y: st.y };
            return [{ t: 'rectMove', rect: rectOf(st.x, st.y, input.sx, input.sy) }];
          }
          this.st = { s: 'drag', x: st.x, y: st.y, alt: st.alt, lastX: input.sx, lastY: input.sy };
          return [{ t: 'dragStart', hit: st.hit, alt: st.alt }, { t: 'dragMove', dx: (input.sx - st.x) / cam.zoom, dy: (input.sy - st.y) / cam.zoom, sx: input.sx, sy: input.sy }];
        }
        if (st.s === 'pan') {
          this.st = { s: 'pan', x: input.sx, y: input.sy };
          return [{ t: 'pan', dxPx: input.sx - st.x, dyPx: input.sy - st.y }];
        }
        if (st.s === 'drag') {
          st.lastX = input.sx;
          st.lastY = input.sy;
          return [{ t: 'dragMove', dx: (input.sx - st.x) / cam.zoom, dy: (input.sy - st.y) / cam.zoom, sx: input.sx, sy: input.sy }];
        }
        if (st.s === 'rect') return [{ t: 'rectMove', rect: rectOf(st.x, st.y, input.sx, input.sy) }];
        return [];
      }
      case 'up': {
        this.st = { s: 'idle' };
        if (st.s === 'pressed') {
          if (st.button === 0) return [{ t: 'click', hit: st.hit, ctrl: st.ctrl, shift: st.shift, sx: st.x, sy: st.y }];
          if (st.button === 2) return [{ t: 'context', hit: st.hit, sx: st.x, sy: st.y }];
          return [];
        }
        if (st.s === 'drag') return [{ t: 'dragEnd', dx: (input.sx - st.x) / cam.zoom, dy: (input.sy - st.y) / cam.zoom, at: world(input.sx, input.sy), alt: st.alt }];
        if (st.s === 'rect') return [{ t: 'rectEnd', rect: rectOf(st.x, st.y, input.sx, input.sy) }];
        return [];
      }
      case 'key':
        return [];
    }
  }
}

/** Scale steps under way with Ctrl+wheel; `rest`: small scrolls not yet a step; `flush` is the previous gesture, ended by a pause or another target. */
export interface WheelSteps { target: string; delta: number; rest: number; last: number; flush: { target: string; delta: number } | null }

/**
 * Ctrl+wheel changes the scale step of the selection or of the element under the cursor (spec 8.1): the notches of
 * one gesture add up into one action, written once the wheel pauses for scaleGesturePauseMs or the target changes. A
 * wheel notch (|deltaY| ≥ scaleWheelStepPx) is one step; smaller scrolls add up to one (I13 of the plan 3b review).
 */
export function stepWheel(prev: WheelSteps | null, target: string, deltaY: number, now: number, p: RenderParams): WheelSteps {
  const same = prev !== null && prev.target === target && now - prev.last <= p.scaleGesturePauseMs;
  const flush = same || !prev || prev.delta === 0 ? null : { target: prev.target, delta: prev.delta };
  let delta = same ? prev.delta : 0, rest = same ? prev.rest : 0;
  const up = -deltaY;
  if (Math.abs(deltaY) >= p.scaleWheelStepPx) { delta += Math.sign(up); rest = 0; }
  else {
    rest += up;
    while (Math.abs(rest) >= p.scaleWheelStepPx) { delta += Math.sign(rest); rest -= Math.sign(rest) * p.scaleWheelStepPx; }
  }
  return { target, delta, rest, last: now, flush };
}

/** A touchpad pinch reaches the page as Ctrl+wheel with fractional deltas: it zooms the view, it does not scale an element. */
export const isPinch = (deltaY: number): boolean => !Number.isInteger(deltaY);

/**
 * The buttons pressed between two pointer events, as `button` numbers (0 left, 1 middle, 2 right), from the `buttons`
 * masks (1 left, 2 right, 4 middle). A button pressed while another is held comes as a pointermove, not a pointerdown
 * (I1 of the plan 3b review): a right click must still cancel a drag.
 */
export function newlyPressed(prev: number, now: number): (0 | 1 | 2)[] {
  const out: (0 | 1 | 2)[] = [];
  if (now & 1 && !(prev & 1)) out.push(0);
  if (now & 4 && !(prev & 4)) out.push(1);
  if (now & 2 && !(prev & 2)) out.push(2);
  return out;
}
