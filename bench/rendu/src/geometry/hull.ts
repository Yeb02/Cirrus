import type { Vec2 } from '../scene/types';

/** Andrew's monotone chain; counter-clockwise, collinear points dropped. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Envelope mesh without a blur filter: the hull grown by `padding` is filled at alpha 1, then a ring of width
 * `feather` fades to alpha 0. Positions are whatever frame the hull is given in (callers pass local coordinates).
 */
export function featherRing(
  hull: Vec2[],
  padding: number,
  feather: number,
): { position: Float32Array; alpha: Float32Array; index: Uint32Array } {
  let poly = hull;
  if (poly.length < 3) {
    // One or two members: an octagon around them.
    const c = { x: poly.reduce((s, q) => s + q.x, 0) / poly.length, y: poly.reduce((s, q) => s + q.y, 0) / poly.length };
    const r = Math.max(1e-6, ...poly.map((q) => Math.hypot(q.x - c.x, q.y - c.y)));
    poly = Array.from({ length: 8 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 4), y: c.y + r * Math.sin((i * Math.PI) / 4) }));
  }
  const m = poly.length;
  const cx = poly.reduce((s, q) => s + q.x, 0) / m, cy = poly.reduce((s, q) => s + q.y, 0) / m;
  // Vertex 0: centre. Then m inner vertices (alpha 1), then m outer vertices (alpha 0).
  const position = new Float32Array((1 + 2 * m) * 2);
  const alpha = new Float32Array(1 + 2 * m);
  position[0] = cx; position[1] = cy; alpha[0] = 1;
  for (let i = 0; i < m; i++) {
    const prev = poly[(i + m - 1) % m], cur = poly[i], next = poly[(i + 1) % m];
    // Outward normal: average of the two adjacent edge normals (counter-clockwise hull → normal = (dy, -dx)).
    const n1 = { x: cur.y - prev.y, y: -(cur.x - prev.x) }, n2 = { x: next.y - cur.y, y: -(next.x - cur.x) };
    const l1 = Math.hypot(n1.x, n1.y) || 1, l2 = Math.hypot(n2.x, n2.y) || 1;
    let nx = n1.x / l1 + n2.x / l2, ny = n1.y / l1 + n2.y / l2;
    const ln = Math.hypot(nx, ny) || 1;
    nx /= ln; ny /= ln;
    position[(1 + i) * 2] = cur.x + nx * padding;
    position[(1 + i) * 2 + 1] = cur.y + ny * padding;
    alpha[1 + i] = 1;
    position[(1 + m + i) * 2] = cur.x + nx * (padding + feather);
    position[(1 + m + i) * 2 + 1] = cur.y + ny * (padding + feather);
    alpha[1 + m + i] = 0;
  }
  const index = new Uint32Array(m * 3 + m * 6);
  for (let i = 0; i < m; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % m);
    index.set([0, a, b], i * 3);
    const oa = a + m, ob = b + m;
    index.set([a, oa, b, b, oa, ob], m * 3 + i * 6);
  }
  return { position, alpha, index };
}
