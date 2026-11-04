import type { ConnectionLayout, Id, Role, Vec2 } from '@cirrus/core';
import { stepScale } from '../lod.ts';
import type { RenderParams } from '../params.ts';
import { centroid } from './hull.ts';
import { add, len, mul, norm, perp, rot, sub } from './vec.ts';

export interface BundleEnd {
  /** Box to anchor on (world). */
  pos: Vec2;
  halfW: number;
  halfH: number;
  /** A closed group: anchor on its padded envelope instead (centre = the group's position). */
  hull?: { poly: Vec2[]; centre: Vec2; pad: number };
  role: Role;
  k: number;
  hollow: boolean;
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
  hollow: boolean;
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
  if (e.hull) {
    const { poly, centre, pad } = e.hull;
    const d = norm(sub(toward, centre));
    let best = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ed = sub(b, a);
      const den = d.x * ed.y - d.y * ed.x;
      if (Math.abs(den) < 1e-12) continue;
      const v = sub(a, centre);
      const s = (v.x * ed.y - v.y * ed.x) / den, t = (v.x * d.y - v.y * d.x) / den;
      if (s >= 0 && t >= -1e-6 && t <= 1 + 1e-6 && s > best) best = s;
    }
    return add(centre, mul(d, best + pad));
  }
  const gap = p.anchorGap * stepScale(e.k, p);
  const d = sub(toward, e.pos);
  const sx = Math.abs(d.x) > 1e-9 ? (e.halfW + gap) / Math.abs(d.x) : Infinity;
  const sy = Math.abs(d.y) > 1e-9 ? (e.halfH + gap) / Math.abs(d.y) : Infinity;
  return add(e.pos, mul(d, Math.min(sx, sy, 1)));
}

/**
 * The maquette's bundle (spec 8.5): sources converge on the trunk's start A, targets leave from its end B, associates
 * join the marker M from the side; every branch reaches the trunk tangent to it. With two members there is no trunk
 * and the two branches join into one smooth curve. The marker and trunk take the largest step of the connection.
 */
export function bundleGeometry(input: BundleInput, p: RenderParams): BundleGeometry {
  const { ends, stubs } = input;
  const roleOf = (r: Role) => ends.filter((e) => e.role === r);
  const pairNeu = ends.length === 2 && stubs.length === 0 && ends.every((e) => e.role === 'associate');
  const S = pairNeu ? [ends[0]] : roleOf('source');
  const T = pairNeu ? [ends[1]] : roleOf('target');
  const N = pairNeu ? [] : roleOf('associate');
  const all = ends.length > 0 ? ends.map((e) => e.pos) : [input.centre ?? { x: 0, y: 0 }];
  const fallback = N.length > 0 ? centroid(N.map((e) => e.pos)) : centroid(all);
  const cs = S.length > 0 ? centroid(S.map((e) => e.pos)) : fallback;
  const ct = T.length > 0 ? centroid(T.map((e) => e.pos)) : fallback;
  const kMax = ends.length > 0 ? Math.max(...ends.map((e) => e.k)) : 0;
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
  const handles = input.layout?.handles ?? {};
  const off = (key: Id) => handles[key] ?? { b1: { x: 0, y: 0 }, b2: { x: 0, y: 0 } };
  const branches: Branch[] = [];
  const base = (e: { role: Role; k: number; hollow: boolean; dashed: boolean }, stub: boolean, key: Id | null) =>
    ({ role: pairNeu ? 'associate' as Role : e.role, kNode: e.k, kMarker: kMax, hollow: e.hollow, dashed: e.dashed, stub, key });

  const incoming = (a: Vec2, o: { b1: Vec2; b2: Vec2 }, extra: ReturnType<typeof base>) => {
    const t = p.trunkTension * len(sub(A, a));
    branches.push({ p0: a, b1: add(add(a, mul(norm(sub(A, a), u), t * 0.6)), o.b1), b2: add(sub(A, mul(u, t)), o.b2), p3: A, nodeEnd: 'p0', ...extra });
  };
  const outgoing = (a: Vec2, o: { b1: Vec2; b2: Vec2 }, extra: ReturnType<typeof base>) => {
    const t = p.trunkTension * len(sub(B, a));
    branches.push({ p0: B, b1: add(add(B, mul(u, t)), o.b1), b2: add(add(a, mul(norm(sub(B, a), mul(u, -1)), t * 0.6)), o.b2), p3: a, nodeEnd: 'p3', ...extra });
  };
  const side = (a: Vec2, at: Vec2) => {
    let n = perp(u);
    const v = sub(at, M);
    // An associate on the axis (always, with two members) joins from +n: its side is not left to the rounding.
    if (n.x * v.x + n.y * v.y < -SIDE_TOLERANCE * len(v)) n = mul(n, -1);
    const t = p.trunkTension * len(sub(M, a));
    return { n, t };
  };
  const sideways = (a: Vec2, at: Vec2, o: { b1: Vec2; b2: Vec2 }, extra: ReturnType<typeof base>) => {
    const { n, t } = side(a, at);
    branches.push({ p0: a, b1: add(add(a, mul(norm(sub(M, a), mul(n, -1)), t * 0.6)), o.b1), b2: add(add(M, mul(n, t)), o.b2), p3: M, nodeEnd: 'p0', ...extra });
  };

  for (const e of S) incoming(anchor(e, A, p), off(e.key), base(e, false, e.key));
  for (const e of T) outgoing(anchor(e, B, p), off(e.key), base(e, false, e.key));
  for (const e of N) sideways(anchor(e, M, p), e.pos, off(e.key), base(e, false, e.key));

  // Absent members: a dashed stub of stubLength, fanned out by stubAngle (+a, −a, +2a, …).
  const L = p.stubLength * sc, none = { b1: { x: 0, y: 0 }, b2: { x: 0, y: 0 } };
  const count: Record<Role, number> = { source: 0, target: 0, associate: 0 };
  for (const st of stubs) {
    const i = count[st.role]++;
    const ang = p.stubAngle * Math.ceil((i + 1) / 2) * (i % 2 === 0 ? 1 : -1);
    const extra = base({ role: st.role, k: kMax, hollow: false, dashed: true }, true, st.key ?? null);
    if (st.role === 'source') incoming(add(A, mul(rot(mul(u, -1), ang), L)), none, extra);
    else if (st.role === 'target') outgoing(add(B, mul(rot(u, ang), L)), none, extra);
    else {
      const end = add(M, mul(rot(perp(u), ang), L));
      sideways(end, end, none, extra);
    }
  }
  return { marker: M, u, kMax, trunk: multi ? [A, B] : null, branches, multi };
}
