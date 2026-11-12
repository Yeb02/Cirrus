import type { ConnectionLayout, Id, Role, Vec2 } from '@cirrus/core';
import { stepScale } from '../lod.ts';
import type { RenderParams } from '../params.ts';
import { centroid } from './hull.ts';
import { add, mul, norm, perp, rot, sub } from './vec.ts';

export interface BundleEnd {
  /** Box to anchor on (world). */
  pos: Vec2;
  halfW: number;
  halfH: number;
  /** A group node: anchor on its padded envelope instead (centre = the group's position). */
  hull?: { poly: Vec2[]; centre: Vec2; pad: number };
  role: Role;
  k: number;
  dashed: boolean;
  key: Id;
}

export interface BundleInput {
  ends: BundleEnd[];
  /** Absent members without a phantom (spec 11.3); key: the member. */
  stubs: { role: Role; key?: Id }[];
  /** 'far' part of a split arm: the fixed centre phantom. */
  centre?: Vec2;
  layout?: Pick<ConnectionLayout, 'marker' | 'angle' | 'handles'>;
}

/** A cubic Bézier from p0 to p3; the node is at nodeEnd. */
export interface Branch {
  p0: Vec2;
  b1: Vec2;
  b2: Vec2;
  p3: Vec2;
  nodeEnd: 'p0' | 'p3';
  /** The glyph drawn at the node end. */
  role: Role;
  kNode: number;
  kMarker: number;
  dashed: boolean;
  stub: boolean;
  /** The member this branch leads to (hit testing: which arm a click is on). */
  key: Id | null;
}

export interface BundleGeometry { marker: Vec2; u: Vec2; kMax: number; trunk: [Vec2, Vec2] | null; branches: Branch[]; multi: boolean }

/**
 * Below this share of its distance to the marker, an associate counts as on the axis (plan 3c task 8: with two
 * members it always is, and the sign of a zero left to the rounding put its curve on either side, the GPU's float32
 * and the CPU's double disagreeing). Ruling R23: a numerical tolerance, not a rendering setting.
 */
export const SIDE_TOLERANCE = 1e-6;

/** Where a line toward `toward` leaves the end's box (or a closed group's padded envelope), plus the anchor gap. */
function anchor(e: BundleEnd, toward: Vec2, p: RenderParams): Vec2 {
  // Without a vector per step: the arithmetic of norm(), sub(), add() and mul(), in their order.
  if (e.hull) {
    const { poly, centre, pad } = e.hull;
    const qx = toward.x - centre.x, qy = toward.y - centre.y, l = Math.hypot(qx, qy);
    const dx = l < 1e-9 ? 1 : qx / l, dy = l < 1e-9 ? 0 : qy / l;
    let best = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ex = b.x - a.x, ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const vx = a.x - centre.x, vy = a.y - centre.y;
      const s = (vx * ey - vy * ex) / den, t = (vx * dy - vy * dx) / den;
      if (s >= 0 && t >= -1e-6 && t <= 1 + 1e-6 && s > best) best = s;
    }
    const k = best + pad;
    return { x: centre.x + dx * k, y: centre.y + dy * k };
  }
  const gap = p.anchorGap * stepScale(e.k, p);
  const dx = toward.x - e.pos.x, dy = toward.y - e.pos.y;
  const sx = Math.abs(dx) > 1e-9 ? (e.halfW + gap) / Math.abs(dx) : Infinity;
  const sy = Math.abs(dy) > 1e-9 ? (e.halfH + gap) / Math.abs(dy) : Infinity;
  const m = Math.min(sx, sy, 1);
  return { x: e.pos.x + dx * m, y: e.pos.y + dy * m };
}

/** A branch's control-point offsets when its layout gives none (read only). */
const NO_OFFSET: { b1: Vec2; b2: Vec2 } = Object.freeze({ b1: Object.freeze({ x: 0, y: 0 }), b2: Object.freeze({ x: 0, y: 0 }) });

/**
 * The maquette's bundle (spec 8.5): sources converge on the trunk's start A, targets leave from its end B, associates
 * join the marker M from the side; every branch reaches the trunk tangent to it. With two members there is no trunk
 * and the two branches join into one smooth curve. The marker and trunk take the largest step of the connection.
 * Built without a vector per step (plan 3c task 9: a preview rewrites many bundles a frame), by the arithmetic of the
 * vec.ts helpers in their order: the same numbers to the bit.
 */
export function bundleGeometry(input: BundleInput, p: RenderParams): BundleGeometry {
  const { ends, stubs } = input;
  const pairNeu = ends.length === 2 && stubs.length === 0 && ends.every((e) => e.role === 'associate');
  // The ends by role, in their order.
  let S: BundleEnd[], T: BundleEnd[], N: BundleEnd[];
  if (pairNeu) { S = [ends[0]]; T = [ends[1]]; N = []; }
  else {
    S = []; T = []; N = [];
    for (const e of ends) (e.role === 'source' ? S : e.role === 'target' ? T : N).push(e);
  }
  /** The centroid of the ends' positions (centroid's sums, in its order). */
  const middle = (list: BundleEnd[]): Vec2 => {
    let x = 0, y = 0;
    for (const e of list) { x += e.pos.x; y += e.pos.y; }
    return { x: x / list.length, y: y / list.length };
  };
  const fallback = N.length > 0 ? middle(N) : ends.length > 0 ? middle(ends) : centroid([input.centre ?? { x: 0, y: 0 }]);
  const cs = S.length > 0 ? middle(S) : fallback;
  const ct = T.length > 0 ? middle(T) : fallback;
  let kMax = ends.length > 0 ? -Infinity : 0;
  for (const e of ends) kMax = Math.max(kMax, e.k);
  const sc = p.factor ** kMax;

  let M: Vec2, u: Vec2;
  if (input.centre) {
    M = input.centre;
    const e = ends[0];
    u = e && e.role === 'source' ? norm(sub(M, e.pos)) : norm(sub(e ? e.pos : M, M));
  } else {
    M = input.layout?.marker ?? mul(add(cs, ct), 0.5);
    u = norm(sub(ct, cs));
  }
  if (input.layout?.angle !== undefined) u = { x: Math.cos(input.layout.angle), y: Math.sin(input.layout.angle) };

  const multi = ends.length + stubs.length > 2;
  const h = multi ? (p.trunkLength / 2) * sc : 0;
  const A = sub(M, mul(u, h)), B = add(M, mul(u, h));
  const handles = input.layout?.handles;
  const off = (key: Id) => handles?.[key] ?? NO_OFFSET;
  const branches: Branch[] = [];
  type Of = { role: Role; k: number; dashed: boolean };
  const branch = (p0: Vec2, b1: Vec2, b2: Vec2, p3: Vec2, nodeEnd: Branch['nodeEnd'], e: Of, stub: boolean, key: Id | null): Branch =>
    ({ p0, b1, b2, p3, nodeEnd, role: pairNeu ? 'associate' : e.role, kNode: e.k, kMarker: kMax, dashed: e.dashed, stub, key });

  const incoming = (a: Vec2, o: { b1: Vec2; b2: Vec2 }, e: Of, stub: boolean, key: Id | null) => {
    const dx = A.x - a.x, dy = A.y - a.y, l = Math.hypot(dx, dy), t = p.trunkTension * l, k = t * 0.6;
    const nx = l < 1e-9 ? u.x : dx / l, ny = l < 1e-9 ? u.y : dy / l;
    branches.push(branch(a, { x: a.x + nx * k + o.b1.x, y: a.y + ny * k + o.b1.y }, { x: A.x - u.x * t + o.b2.x, y: A.y - u.y * t + o.b2.y }, A, 'p0', e, stub, key));
  };
  const outgoing = (a: Vec2, o: { b1: Vec2; b2: Vec2 }, e: Of, stub: boolean, key: Id | null) => {
    const dx = B.x - a.x, dy = B.y - a.y, l = Math.hypot(dx, dy), t = p.trunkTension * l, k = t * 0.6;
    const nx = l < 1e-9 ? u.x * -1 : dx / l, ny = l < 1e-9 ? u.y * -1 : dy / l;
    branches.push(branch(B, { x: B.x + u.x * t + o.b1.x, y: B.y + u.y * t + o.b1.y }, { x: a.x + nx * k + o.b2.x, y: a.y + ny * k + o.b2.y }, a, 'p3', e, stub, key));
  };
  const sideways = (a: Vec2, at: Vec2, o: { b1: Vec2; b2: Vec2 }, e: Of, stub: boolean, key: Id | null) => {
    // The side, perp(u): an associate on the axis (always, with two members) joins from +n, not left to the rounding.
    let nx = -u.y, ny = u.x;
    const vx = at.x - M.x, vy = at.y - M.y;
    if (nx * vx + ny * vy < -SIDE_TOLERANCE * Math.hypot(vx, vy)) { nx = nx * -1; ny = ny * -1; }
    const dx = M.x - a.x, dy = M.y - a.y, l = Math.hypot(dx, dy), t = p.trunkTension * l, k = t * 0.6;
    const mx = l < 1e-9 ? nx * -1 : dx / l, my = l < 1e-9 ? ny * -1 : dy / l;
    branches.push(branch(a, { x: a.x + mx * k + o.b1.x, y: a.y + my * k + o.b1.y }, { x: M.x + nx * t + o.b2.x, y: M.y + ny * t + o.b2.y }, M, 'p0', e, stub, key));
  };

  for (const e of S) incoming(anchor(e, A, p), off(e.key), e, false, e.key);
  for (const e of T) outgoing(anchor(e, B, p), off(e.key), e, false, e.key);
  for (const e of N) sideways(anchor(e, M, p), e.pos, off(e.key), e, false, e.key);

  // Absent members: a dashed stub of stubLength, fanned out by stubAngle (+a, −a, +2a, …).
  const L = p.stubLength * sc;
  const count: Record<Role, number> = { source: 0, target: 0, associate: 0 };
  for (const st of stubs) {
    const i = count[st.role]++;
    const ang = p.stubAngle * Math.ceil((i + 1) / 2) * (i % 2 === 0 ? 1 : -1);
    const of: Of = { role: st.role, k: kMax, dashed: true }, key = st.key ?? null;
    if (st.role === 'source') incoming(add(A, mul(rot(mul(u, -1), ang), L)), NO_OFFSET, of, true, key);
    else if (st.role === 'target') outgoing(add(B, mul(rot(u, ang), L)), NO_OFFSET, of, true, key);
    else {
      const end = add(M, mul(rot(perp(u), ang), L));
      sideways(end, end, NO_OFFSET, of, true, key);
    }
  }
  return { marker: M, u, kMax, trunk: multi ? [A, B] : null, branches, multi };
}
