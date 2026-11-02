import { BOX_WORLD_WIDTH, DEFAULT_MAX_DEPTH, type RenderParams, type SceneSpec } from './params';
import { mulberry32 } from './rng';
import type { Role, Scene, SceneConnection, SceneNode } from './types';

const ROOT = -1;
/** Tail index of the node weights: below 2 the degree distribution has the heavy tail of scale-free graphs. */
const PARETO_ALPHA = 1.2;

export function generateScene(spec: SceneSpec, params: RenderParams): Scene {
  const rand = mulberry32(spec.seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const maxDepth = spec.maxDepth ?? DEFAULT_MAX_DEPTH;

  // 1. Hierarchy, breadth first, with exactly nodeCount nodes.
  const parent: number[] = [];
  const depth: number[] = [];
  const children: number[][] = [];
  const rootChildren: number[] = [];
  const addNode = (p: number) => {
    const id = parent.length;
    parent.push(p);
    depth.push(p === ROOT ? 0 : depth[p] + 1);
    children.push([]);
    (p === ROOT ? rootChildren : children[p]).push(id);
    return id;
  };
  const queue: number[] = [];
  let head = 0;
  while (parent.length < spec.nodeCount) {
    if (head === queue.length) {
      // Queue exhausted: open a new top-level group so the budget is always reached.
      queue.push(addNode(ROOT));
      continue;
    }
    const g = queue[head++];
    const count = Math.min(randInt(spec.minChildren, spec.maxChildren), spec.nodeCount - parent.length);
    for (let i = 0; i < count; i++) {
      const id = addNode(g);
      if (depth[id] < maxDepth && rand() < spec.groupShare) queue.push(id);
    }
  }

  // 2. Scale steps: siblings share a step, a group sits groupOffsetSteps above its members.
  const height = Math.max(...depth);
  const k = depth.map((d) => (height - d) * params.groupOffsetSteps);

  // 3. Layout, bottom up: each node gets a footprint radius and positions relative to its parent.
  const n = parent.length;
  const footprint = new Array<number>(n).fill(0);
  const radius = new Array<number>(n).fill(0);
  const relX = new Array<number>(n).fill(0);
  const relY = new Array<number>(n).fill(0);
  const leafFootprint = (id: number) => 0.75 * BOX_WORLD_WIDTH * params.factor ** k[id];

  const pack = (kids: number[]): number => {
    // Square grid with spacing so that jittered neighbours never overlap, cells taken by distance to centre.
    const maxFp = Math.max(...kids.map((c) => footprint[c]));
    const d = (2 * maxFp) / 0.7;
    const side = Math.ceil(Math.sqrt(kids.length)) + 2;
    const cells: [number, number][] = [];
    for (let i = -side; i <= side; i++) for (let j = -side; j <= side; j++) cells.push([i * d, j * d]);
    cells.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[0] - b[0] || a[1] - b[1]);
    let r = 0;
    kids.forEach((c, idx) => {
      const [cx, cy] = cells[idx];
      relX[c] = cx + (rand() - 0.5) * 0.3 * d;
      relY[c] = cy + (rand() - 0.5) * 0.3 * d;
      r = Math.max(r, Math.hypot(relX[c], relY[c]) + footprint[c]);
    });
    return r;
  };

  const byDepthDesc = Array.from({ length: n }, (_, i) => i).sort((a, b) => depth[b] - depth[a]);
  for (const id of byDepthDesc) {
    if (children[id].length === 0) {
      footprint[id] = leafFootprint(id);
    } else {
      radius[id] = pack(children[id]);
      footprint[id] = radius[id];
    }
  }
  pack(rootChildren);

  // 4. Absolute positions, top down.
  const x = new Array<number>(n).fill(0);
  const y = new Array<number>(n).fill(0);
  const byDepthAsc = [...byDepthDesc].reverse();
  for (const id of byDepthAsc) {
    const p = parent[id];
    x[id] = (p === ROOT ? 0 : x[p]) + relX[id];
    y[id] = (p === ROOT ? 0 : y[p]) + relY[id];
  }

  const nodes: SceneNode[] = Array.from({ length: n }, (_, id) => ({
    id,
    x: x[id],
    y: y[id],
    k: k[id],
    parent: parent[id],
    r: radius[id],
    title: titleFor(id),
  }));

  // 5. Connections with the requested locality.
  const connections = generateConnections(spec, rand, randInt, parent, children, rootChildren);
  return { nodes, connections, children };
}

function titleFor(id: number): string {
  let t = `Nœud ${id}`;
  if (id % 7 === 0) t += ' θ';
  if (id % 11 === 0) t += ' ∑';
  if (id % 13 === 0) t += ' ≤ é';
  return t;
}

function generateConnections(
  spec: SceneSpec,
  rand: () => number,
  randInt: (lo: number, hi: number) => number,
  parent: number[],
  children: number[][],
  rootChildren: number[],
): SceneConnection[] {
  const n = parent.length;
  const kidsOf = (g: number) => (g === ROOT ? rootChildren : children[g]);
  const containers = [ROOT, ...children.map((_, i) => i).filter((i) => children[i].length > 0)];
  const grandKids = new Map<number, number[]>();
  for (const g of containers) {
    const gk = kidsOf(g).flatMap((c) => children[c]);
    if (gk.length > 0) grandKids.set(g, gk);
  }
  const bySize = (pool: Map<number, number[]> | number[], m: number) =>
    Array.isArray(pool) ? pool.filter((g) => kidsOf(g).length >= m) : [...pool].filter(([, v]) => v.length >= m).map(([g]) => g);
  const sameParentPools = new Map<number, number[]>();
  const sameGrandPools = new Map<number, number[]>();
  for (const m of [2, 3, 4, 5]) {
    sameParentPools.set(m, bySize(containers, m));
    sameGrandPools.set(m, bySize(grandKids, m));
  }

  // Scale-free degrees (user: "small world, scale free"): every node gets a Pareto weight, picks are weighted.
  const weight = Array.from({ length: n }, () => (1 - rand()) ** (-1 / PARETO_ALPHA));
  const weightedPick = (pool: number[], total: number): number => {
    let r = rand() * total;
    for (const id of pool) { r -= weight[id]; if (r <= 0) return id; }
    return pool[pool.length - 1];
  };
  const pickDistinct = (pool: number[], m: number): number[] => {
    const total = pool.reduce((s, id) => s + weight[id], 0);
    const picked = new Set<number>();
    while (picked.size < m) picked.add(weightedPick(pool, total));
    return [...picked];
  };
  const cumulative = new Float64Array(n);
  weight.forEach((w, i) => { cumulative[i] = (i > 0 ? cumulative[i - 1] : 0) + w; });
  const anyNodes = (m: number): number[] => {
    const picked = new Set<number>();
    while (picked.size < m) {
      const r = rand() * cumulative[n - 1];
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < r) lo = mid + 1; else hi = mid; }
      picked.add(lo);
    }
    return [...picked];
  };

  const [localShare, grandShare] = spec.locality;
  const connections: SceneConnection[] = [];
  for (let id = 0; id < spec.connectionCount; id++) {
    const m = rand() < spec.multiMemberShare ? randInt(3, 5) : 2;
    const u = rand();
    let ids: number[];
    let display: SceneConnection['display'] = 'full';
    const sp = sameParentPools.get(m)!;
    const sg = sameGrandPools.get(m)!;
    if (u < localShare && sp.length > 0) ids = pickDistinct(kidsOf(sp[Math.floor(rand() * sp.length)]), m);
    else if (u < localShare + grandShare && sg.length > 0) ids = pickDistinct(grandKids.get(sg[Math.floor(rand() * sg.length)])!, m);
    else {
      // The rare far connections: shown as stubs toward a phantom of the far end (user's choice, spec 8.5).
      ids = anyNodes(m);
      display = 'stubs';
    }
    connections.push({ id, members: assignRoles(ids, rand), display });
  }
  return connections;
}

function assignRoles(ids: number[], rand: () => number): { node: number; role: Role }[] {
  if (ids.length === 2) {
    const role: [Role, Role] = rand() < 0.1 ? ['associate', 'associate'] : ['source', 'target'];
    return ids.map((node, i) => ({ node, role: role[i] }));
  }
  const sources = Math.max(1, Math.floor(ids.length / 2));
  return ids.map((node, i) => ({ node, role: i < sources ? 'source' : i === ids.length - 1 && rand() < 0.2 ? 'associate' : 'target' }));
}
