import Flatbush from 'flatbush';
import { textPx } from './lod';
import { BOX_WORLD_WIDTH, type RenderParams } from './params';
import type { Camera, Role, Scene } from './types';

const ROOT = -1;
const ROLES: Role[] = ['source', 'target', 'associate'];
const ROLE_CODE: Record<Role, number> = { source: 0, target: 1, associate: 2 };

/** node = drawn node: the member itself, or its highest closed ancestor. */
export interface VisibleBranch { node: number; role: Role; hollow: boolean }
/** ids: aggregated connections (length >= 1). */
export interface VisibleConnection { ids: number[]; branches: VisibleBranch[]; /** Drawn as stubs toward a phantom of the far end. */ stubs?: boolean }
export interface VisibleSet { nodes: number[]; closedGroups: number[]; openGroups: number[]; connections: VisibleConnection[] }

/** Flat, contiguous copies of what the per-frame visibility pass reads, plus the connection lists by LCA. */
export interface SceneIndex {
  roots: number[];
  rootTree: Flatbush | null;
  parent: Int32Array;
  x: Float64Array;
  y: Float64Array;
  /** Half extent in world units: disc radius for a group, half box width for a leaf. */
  extent: Float64Array;
  /** Largest member step of a group, -Infinity for a leaf. */
  maxChildK: Float64Array;
  memStart: Int32Array; // members of connection c: memStart[c] .. memStart[c + 1] - 1
  memNode: Int32Array;
  memRole: Uint8Array;
  /** 1 when the connection is displayed as stubs. */
  stub: Uint8Array;
  /** Connection ids keyed by their lowest common group (-1 = top level). */
  byLca: Map<number, Int32Array>;
}

export function lowestCommonGroup(scene: Scene, nodeIds: number[]): number {
  const chainOf = (id: number) => {
    const chain: number[] = [];
    for (let p = scene.nodes[id].parent; p !== ROOT; p = scene.nodes[p].parent) chain.push(p);
    return chain; // strict ancestors, lowest first
  };
  let common = chainOf(nodeIds[0]);
  for (let i = 1; i < nodeIds.length && common.length > 0; i++) {
    const other = new Set(chainOf(nodeIds[i]));
    common = common.filter((g) => other.has(g));
  }
  return common.length > 0 ? common[0] : ROOT;
}

export function buildIndex(scene: Scene): SceneIndex {
  const n = scene.nodes.length;
  const parent = new Int32Array(n), x = new Float64Array(n), y = new Float64Array(n);
  const extent = new Float64Array(n), maxChildK = new Float64Array(n).fill(-Infinity);
  for (const node of scene.nodes) {
    parent[node.id] = node.parent;
    x[node.id] = node.x;
    y[node.id] = node.y;
    const kids = scene.children[node.id];
    extent[node.id] = kids.length > 0 ? node.r : (BOX_WORLD_WIDTH / 2) * 2 ** node.k;
    for (const c of kids) maxChildK[node.id] = Math.max(maxChildK[node.id], scene.nodes[c].k);
  }
  const roots = scene.nodes.filter((nd) => nd.parent === ROOT).map((nd) => nd.id);
  let rootTree: Flatbush | null = null;
  if (roots.length > 0) {
    rootTree = new Flatbush(roots.length);
    for (const id of roots) rootTree.add(x[id] - extent[id], y[id] - extent[id], x[id] + extent[id], y[id] + extent[id]);
    rootTree.finish();
  }

  const conns = scene.connections;
  const memStart = new Int32Array(conns.length + 1);
  let total = 0;
  for (let c = 0; c < conns.length; c++) { memStart[c] = total; total += conns[c].members.length; }
  memStart[conns.length] = total;
  const memNode = new Int32Array(total), memRole = new Uint8Array(total), stub = new Uint8Array(conns.length);
  const lists = new Map<number, number[]>();
  for (let c = 0; c < conns.length; c++) {
    const members = conns[c].members;
    stub[c] = conns[c].display === 'stubs' ? 1 : 0;
    for (let i = 0; i < members.length; i++) {
      memNode[memStart[c] + i] = members[i].node;
      memRole[memStart[c] + i] = ROLE_CODE[members[i].role];
    }
    const lca = lowestCommonGroup(scene, members.map((m) => m.node));
    let list = lists.get(lca);
    if (!list) lists.set(lca, (list = []));
    list.push(c);
  }
  const byLca = new Map<number, Int32Array>();
  for (const [lca, list] of lists) byLca.set(lca, Int32Array.from(list));
  return { roots, rootTree, parent, x, y, extent, maxChildK, memStart, memNode, memRole, stub, byLca };
}

export function computeVisible(scene: Scene, index: SceneIndex, cam: Camera, p: RenderParams): VisibleSet {
  const { parent, x, y, extent, maxChildK, memStart, memNode, memRole, stub } = index;
  const n = parent.length;
  const halfW = (cam.widthPx / 2 + p.viewMarginPx) / cam.zoom;
  const halfH = (cam.heightPx / 2 + p.viewMarginPx) / cam.zoom;
  const minX = cam.x - halfW, maxX = cam.x + halfW, minY = cam.y - halfH, maxY = cam.y + halfH;
  const inView = (id: number) =>
    x[id] + extent[id] >= minX && x[id] - extent[id] <= maxX && y[id] + extent[id] >= minY && y[id] - extent[id] <= maxY;

  // Same rule as isGroupOpen, read from the flat arrays.
  const openState = new Int8Array(n); // 0 unknown, 1 open, 2 closed
  const open = (g: number) => {
    if (openState[g] === 0) openState[g] = maxChildK[g] > -Infinity && textPx(maxChildK[g], cam.zoom, p) >= p.groupFold[0] ? 1 : 2;
    return openState[g] === 1;
  };

  const out: VisibleSet = { nodes: [], closedGroups: [], openGroups: [], connections: [] };
  const stack = index.rootTree ? index.rootTree.search(minX, minY, maxX, maxY).map((i) => index.roots[i]) : [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (scene.children[id].length === 0) out.nodes.push(id);
    else if (open(id)) {
      out.openGroups.push(id);
      for (const c of scene.children[id]) if (inView(c)) stack.push(c);
    } else out.closedGroups.push(id);
  }

  // Endpoint of a member: the highest closed ancestor if any, else the member itself. Memoized per call.
  const endpoint = new Int32Array(n).fill(-2);
  const endpointOf = (m: number): number => {
    if (endpoint[m] !== -2) return endpoint[m];
    let e = m;
    for (let a = parent[m]; a !== ROOT; a = parent[a]) if (!open(a)) e = a;
    return (endpoint[m] = e);
  };

  const pairs = new Map<number, Map<number, VisibleConnection>>();
  const stubPairs = new Map<number, Map<number, VisibleConnection>>(); // never aggregated with full connections
  const others = new Map<string, VisibleConnection>();
  const result: VisibleConnection[] = [];
  const codes: number[] = [];
  for (const lca of [ROOT, ...out.openGroups]) {
    const list = index.byLca.get(lca);
    if (!list) continue;
    for (let li = 0; li < list.length; li++) {
      const cid = list[li];
      const start = memStart[cid], end = memStart[cid + 1];
      if (end - start === 2) {
        // Fast path for two-member connections, keyed by two small integers.
        const n0 = memNode[start], n1 = memNode[start + 1];
        const e0 = endpointOf(n0), e1 = endpointOf(n1);
        if (e0 === e1) continue;
        // Shown only if at least one endpoint is on screen or in the margin (user rule, spec 8.5).
        if (!inView(e0) && !inView(e1)) continue;
        const r0 = memRole[start], r1 = memRole[start + 1];
        const c0 = e0 * 3 + r0, c1 = e1 * 3 + r1;
        const lo = c0 < c1 ? c0 : c1, hi = c0 < c1 ? c1 : c0;
        const table = stub[cid] ? stubPairs : pairs;
        let inner = table.get(lo);
        if (!inner) table.set(lo, (inner = new Map()));
        const existing = inner.get(hi);
        if (existing) existing.ids.push(cid);
        else {
          const vc: VisibleConnection = { ids: [cid], branches: [
            { node: e0, role: ROLES[r0], hollow: e0 !== n0 },
            { node: e1, role: ROLES[r1], hollow: e1 !== n1 },
          ] };
          if (stub[cid]) vc.stubs = true;
          inner.set(hi, vc);
          result.push(vc);
        }
        continue;
      }
      // Up to five members: dedupe branches by (endpoint, role) with a linear scan.
      codes.length = 0;
      const branches: VisibleBranch[] = [];
      let distinct = 0, first = -1, anyInView = false;
      for (let i = start; i < end; i++) {
        const e = endpointOf(memNode[i]);
        const code = e * 3 + memRole[i];
        if (codes.includes(code)) continue;
        codes.push(code);
        branches.push({ node: e, role: ROLES[memRole[i]], hollow: e !== memNode[i] });
        if (first === -1) { first = e; distinct = 1; } else if (distinct === 1 && e !== first) distinct = 2;
        if (!anyInView && inView(e)) anyInView = true;
      }
      if (distinct < 2 || !anyInView) continue;
      const key = (stub[cid] ? 's' : 'f') + codes.sort((u, v) => u - v).join(',');
      const existing = others.get(key);
      if (existing) existing.ids.push(cid);
      else {
        const vc: VisibleConnection = stub[cid] ? { ids: [cid], branches, stubs: true } : { ids: [cid], branches };
        others.set(key, vc);
        result.push(vc);
      }
    }
  }
  out.connections = result;
  return out;
}
