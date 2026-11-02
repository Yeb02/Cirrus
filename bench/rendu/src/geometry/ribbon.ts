import { DEFAULT_PARAMS, type RenderParams } from '../scene/params';
import type { Role, Vec2 } from '../scene/types';

/** CPU reference of the ribbon shader (spec 8.5): bounded on-screen width, fading below the minimum. */
export function widthPx(scale: number, zoom: number, p: RenderParams): { width: number; alpha: number } {
  const raw = p.widthBasePx * scale * zoom;
  return { width: Math.min(p.widthMaxPx, Math.max(p.widthMinPx, raw)), alpha: Math.min(1, raw / p.widthMinPx) };
}

/** Scale along a branch, interpolated geometrically between the two ends' steps. */
export function localScale(t: number, kA: number, kB: number, factor: number): number {
  return factor ** (kA + (kB - kA) * t);
}

/** Cubic Bézier sampled into segments + 1 points. */
export function sampleBranch(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, segments: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    pts.push({ x: a * p0.x + b * c0.x + c * c1.x + d * p1.x, y: a * p0.y + b * c0.y + c * c1.y + d * p1.y });
  }
  return pts;
}

/** Two vertices per centerline point (normal +n then -n); the shader offsets them by the on-screen width. */
export function ribbonAttributes(
  centerline: Vec2[],
  scales: number[],
): { position: Float32Array; normal: Float32Array; scale: Float32Array; index: Uint32Array } {
  const n = centerline.length;
  const position = new Float32Array(n * 4), normal = new Float32Array(n * 4), scale = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const prev = centerline[Math.max(0, i - 1)], next = centerline[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const nx = -ty, ny = tx;
    const { x, y } = centerline[i];
    position.set([x, y, x, y], i * 4);
    normal.set([nx, ny, -nx, -ny], i * 4);
    scale[i * 2] = scale[i * 2 + 1] = scales[i];
  }
  const index = new Uint32Array(Math.max(0, n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    index.set([a, b, c, b, d, c], i * 6);
  }
  return { position, normal, scale, index };
}

const centroid = (pts: Vec2[]): Vec2 => ({
  x: pts.reduce((s, q) => s + q.x, 0) / pts.length,
  y: pts.reduce((s, q) => s + q.y, 0) / pts.length,
});

/**
 * One line per member, in input order, from the member to the marker. The marker sits halfway between the centre
 * of the sources and the centre of the targets; every line reaches it tangent to the sources→targets axis
 * (spec 8.5). With two members the two lines join into one smooth curve.
 */
export function bundleBranches(
  members: { pos: Vec2; role: Role; k: number }[],
  /** Fixed count, or a count derived from the chord between the member and the marker (adaptive sampling). */
  segments: number | ((chord: number) => number),
  factor: number = DEFAULT_PARAMS.factor,
): { centerline: Vec2[]; scales: number[] }[] {
  const sources = members.filter((m) => m.role === 'source').map((m) => m.pos);
  const targets = members.filter((m) => m.role === 'target').map((m) => m.pos);
  const assoc = members.filter((m) => m.role === 'associate').map((m) => m.pos);
  const from = sources.length > 0 ? centroid(sources) : centroid(assoc.length > 0 ? assoc : members.map((m) => m.pos));
  const to = targets.length > 0 ? centroid(targets) : assoc.length > 1 ? assoc[assoc.length - 1] : from;
  const marker = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  let ux = to.x - from.x, uy = to.y - from.y;
  const ulen = Math.hypot(ux, uy);
  if (ulen < 1e-9) { ux = 1; uy = 0; } else { ux /= ulen; uy /= ulen; }
  const markerK = Math.max(...members.map((m) => m.k));

  return members.map((m) => {
    const L = Math.hypot(marker.x - m.pos.x, marker.y - m.pos.y);
    // Direction from which the line enters the marker: from behind for sources, from ahead for targets.
    let dx: number, dy: number;
    if (m.role === 'source') { dx = -ux; dy = -uy; }
    else if (m.role === 'target') { dx = ux; dy = uy; }
    else {
      const side = (m.pos.x - marker.x) * -uy + (m.pos.y - marker.y) * ux >= 0 ? 1 : -1;
      dx = -uy * side; dy = ux * side;
    }
    const c1 = { x: marker.x + dx * L * 0.4, y: marker.y + dy * L * 0.4 };
    const c0 = { x: m.pos.x + (c1.x - m.pos.x) * 0.35, y: m.pos.y + (c1.y - m.pos.y) * 0.35 };
    const segs = typeof segments === 'number' ? segments : Math.max(1, segments(L));
    const centerline = sampleBranch(m.pos, c0, c1, marker, segs);
    const scales = centerline.map((_, i) => localScale(i / segs, m.k, markerK, factor));
    return { centerline, scales };
  });
}
