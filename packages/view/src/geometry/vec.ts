import type { Vec2 } from '@cirrus/core';

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const EAST: Vec2 = Object.freeze({ x: 1, y: 0 });
/** Unit vector; a vector shorter than 1e-9 gives `fallback` (as it is: never changed), so no NaN ever reaches a buffer. */
export const norm = (a: Vec2, fallback: Vec2 = EAST): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? fallback : { x: a.x / l, y: a.y / l };
};
export const rot = (a: Vec2, r: number): Vec2 => ({ x: a.x * Math.cos(r) - a.y * Math.sin(r), y: a.x * Math.sin(r) + a.y * Math.cos(r) });
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
