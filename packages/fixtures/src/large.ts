import { applyOp, type Id, type Op, type Role, type State, emptyState } from '@cirrus/core';
// The bench's generator (plan 1): the small-world, scale-free synthetic graph the user described, kept as the one
// source of the synthetic distribution. Pure code, no rendering.
import { generateScene } from '../../../bench/rendu/src/scene/generate';
import { DEFAULT_PARAMS as BENCH_PARAMS } from '../../../bench/rendu/src/scene/params';

export interface LargeSpec { seed: number; nodes: number; connections: number }

/**
 * A large lobby for measurements (spec 21): nested groups (five levels at most), 80 % local connections, 10 % bundles
 * of three to five members, and the far two-member connections as split arms with their two phantoms (spec 8.5).
 * Built with raw operations (no commands, no checks per action): fast at 500 000 connections.
 */
export function buildLargeState(spec: LargeSpec): { state: State; lobby: Id } {
  const scene = generateScene({
    seed: spec.seed, nodeCount: spec.nodes, connectionCount: spec.connections, minChildren: 4, maxChildren: 12,
    groupShare: 0.15, multiMemberShare: 0.1, locality: [0.8, 0.15, 0.05],
  }, BENCH_PARAMS);
  const s = emptyState();
  const lobby = 'lobby';
  const apply = (op: Op) => applyOp(s, op);
  apply({ t: 'plan', before: null, after: { id: lobby, name: 'Lobby', type: 'lobby' } });
  const id = (i: number) => `n${i}`;
  const branch = (connection: Id, node: Id) => apply({ t: 'branch', key: { plan: lobby, connection, node }, before: false, after: true });
  for (const n of scene.nodes) {
    apply({ t: 'node', before: null, after: { id: id(n.id), title: n.title, summary: '', tags: [], files: [] } });
    apply({ t: 'placement', before: null, after: { plan: lobby, node: id(n.id), x: n.x, y: n.y, k: n.k } });
  }
  for (const n of scene.nodes) {
    if (n.parent < 0) continue;
    const c = `inc${n.id}`;
    apply({ t: 'connection', before: null, after: { id: c, kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: id(n.id), role: 'source' }, { node: id(n.parent), role: 'target' }] } });
    branch(c, id(n.id));
    branch(c, id(n.parent));
  }
  for (const c of scene.connections) {
    const cid = `c${c.id}`;
    const members = c.members.map((m) => ({ node: id(m.node), role: m.role as Role }));
    apply({ t: 'connection', before: null, after: { id: cid, kind: 'knowledge', title: '', relation: '', tags: [], members } });
    const split = c.display === 'stubs' && members.length === 2;
    members.forEach((m, i) => { if (!(split && i === 1)) branch(cid, m.node); });
    if (split) {
      // The far node's arm: a phantom of it near the near node, a centre phantom near it (fixed in the plan).
      const near = scene.nodes[c.members[0].node], far = scene.nodes[c.members[1].node];
      const dx = far.x - near.x, dy = far.y - near.y, d = Math.hypot(dx, dy) || 1;
      const reach = (k: number) => 1.5 * 210 * 2 ** k;
      apply({ t: 'phantom', before: null, after: { id: `${cid}-n`, plan: lobby, connection: cid, of: { kind: 'node', node: members[1].node }, x: near.x + (dx / d) * reach(near.k), y: near.y + (dy / d) * reach(near.k), k: near.k } });
      apply({ t: 'phantom', before: null, after: { id: `${cid}-c`, plan: lobby, connection: cid, of: { kind: 'center', node: members[1].node }, x: far.x - (dx / d) * reach(far.k), y: far.y - (dy / d) * reach(far.k), k: far.k } });
    }
  }
  return { state: s, lobby };
}
