import type { Vec2 } from '@cirrus/core';

export function centroid(pts: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const q of pts) { x += q.x; y += q.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** Andrew's monotone chain; counter-clockwise (y up), collinear points dropped. */
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

/** Outward unit normals of a counter-clockwise polygon, averaged at each vertex. */
export function vertexNormals(poly: Vec2[]): Vec2[] {
  const m = poly.length;
  return poly.map((cur, i) => {
    const prev = poly[(i + m - 1) % m], next = poly[(i + 1) % m];
    const n1 = { x: cur.y - prev.y, y: -(cur.x - prev.x) }, n2 = { x: next.y - cur.y, y: -(next.x - cur.x) };
    const l1 = Math.hypot(n1.x, n1.y) || 1, l2 = Math.hypot(n2.x, n2.y) || 1;
    const nx = n1.x / l1 + n2.x / l2, ny = n1.y / l1 + n2.y / l2;
    const ln = Math.hypot(nx, ny);
    return ln < 1e-9 ? { x: 1, y: 0 } : { x: nx / ln, y: ny / ln };
  });
}

/** A hull of fewer than three points (one or two members, or confounded points) becomes an octagon around them. */
export function solidPolygon(hull: Vec2[]): Vec2[] {
  if (hull.length >= 3) return hull;
  const c = centroid(hull);
  const r = Math.max(1e-6, ...hull.map((q) => Math.hypot(q.x - c.x, q.y - c.y)));
  return Array.from({ length: 8 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 4), y: c.y + r * Math.sin((i * Math.PI) / 4) }));
}

/** Each vertex pushed by d along its averaged outward normal (the envelope's padding). */
export function offsetPolygon(hull: Vec2[], d: number): Vec2[] {
  const poly = solidPolygon(hull);
  const normals = vertexNormals(poly);
  return poly.map((q, i) => ({ x: q.x + normals[i].x * d, y: q.y + normals[i].y * d }));
}
