import { fromSnapshot, type Id, type Role, type Snapshot, type State } from '@cirrus/core';
// The bench's generator (plan 1): the small-world, scale-free synthetic graph the user described, kept as the one
// source of the synthetic distribution. Pure code, no rendering.
import { generateScene } from '../../../bench/rendu/src/scene/generate';
import { DEFAULT_PARAMS as BENCH_PARAMS } from '../../../bench/rendu/src/scene/params';

export interface LargeSpec { seed: number; nodes: number; connections: number }

/**
 * The version of what buildLargeState produces: the bench's base on disk is rebuilt when it changes. Bump it with any
 * change of the output (here or in the plan 1 generator). 2: identifiers of 36 characters (plan 3c).
 */
export const LARGE_GENERATOR_VERSION = 2;

/** The synthetic identifiers' clock: they read as UUIDv7s created one millisecond apart from this date. */
const BENCH_EPOCH_MS = Date.UTC(2026, 0, 1);

/** 32-bit FNV-1a of a string. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A 32-bit integer mix (murmur3's finaliser): neighbouring inputs give unrelated bits. */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

const hex = (v: number, digits: number) => v.toString(16).padStart(digits, '0');

/**
 * A synthetic identifier of 36 characters in the UUIDv7 form, as long as the app's own (the bench pays their real size):
 * deterministic, unique and increasing with i. The time field is the epoch plus i; the kind's hash and a mix of i fill
 * the random bits, so two kinds never share an identifier. Joined rather than concatenated: one flat string, as the app
 * reads them, not a tree of pieces.
 */
export function benchId(kind: string, i: number): string {
  const time = hex(BENCH_EPOCH_MS + i, 12);
  const k = fnv1a(kind), r = mix32(k ^ mix32(i));
  return [time.slice(0, 8), time.slice(8), `7${hex(k >>> 20, 3)}`, hex(0x8000 | (k & 0x3fff), 4), `${hex(r, 8)}${hex(mix32(r ^ i) >>> 16, 4)}`].join('-');
}

/**
 * A large lobby for measurements (spec 21): nested groups (five levels at most), 80 % local connections, 10 % bundles
 * of three to five members, and the far two-member connections as split arms with their two phantoms (spec 8.5).
 * Built as records loaded in bulk (no commands, no checks per action): fast at 500 000 connections. Every reference to
 * an identifier is the record's own string.
 */
export function buildLargeState(spec: LargeSpec): { state: State; lobby: Id } {
  const scene = generateScene({
    seed: spec.seed, nodeCount: spec.nodes, connectionCount: spec.connections, minChildren: 4, maxChildren: 12,
    groupShare: 0.15, multiMemberShare: 0.1, locality: [0.8, 0.15, 0.05],
  }, BENCH_PARAMS);
  const lobby = benchId('plan', 0);
  const x: Snapshot = { nodes: [], connections: [], plans: [{ id: lobby, name: 'Lobby', type: 'lobby' }], tagKeys: [], placements: [], branches: [], connLayouts: [], phantoms: [] };
  const ids = new Map(scene.nodes.map((n) => [n.id, benchId('node', n.id)]));
  const id = (i: number) => ids.get(i)!;
  const branch = (connection: Id, node: Id) => x.branches.push([lobby, connection, node]);
  for (const n of scene.nodes) {
    x.nodes.push({ id: id(n.id), title: n.title, summary: '', tags: [], files: [] });
    x.placements.push({ plan: lobby, node: id(n.id), x: n.x, y: n.y, k: n.k });
  }
  for (const n of scene.nodes) {
    if (n.parent < 0) continue;
    const c = benchId('inclusion', n.id);
    x.connections.push({ id: c, kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: id(n.id), role: 'source' }, { node: id(n.parent), role: 'target' }] });
    branch(c, id(n.id));
    branch(c, id(n.parent));
  }
  for (const c of scene.connections) {
    const cid = benchId('connection', c.id);
    const members = c.members.map((m) => ({ node: id(m.node), role: m.role as Role }));
    x.connections.push({ id: cid, kind: 'knowledge', title: '', relation: '', tags: [], members });
    const split = c.display === 'stubs' && members.length === 2;
    members.forEach((m, i) => { if (!(split && i === 1)) branch(cid, m.node); });
    if (split) {
      // The far node's arm: a phantom of it near the near node, a centre phantom near it (fixed in the plan).
      const near = scene.nodes[c.members[0].node], far = scene.nodes[c.members[1].node];
      const dx = far.x - near.x, dy = far.y - near.y, d = Math.hypot(dx, dy) || 1;
      const reach = (k: number) => 1.5 * 210 * 2 ** k;
      x.phantoms.push({ id: benchId('phantom', 2 * c.id), plan: lobby, connection: cid, of: { kind: 'node', node: members[1].node }, x: near.x + (dx / d) * reach(near.k), y: near.y + (dy / d) * reach(near.k), k: near.k });
      x.phantoms.push({ id: benchId('phantom', 2 * c.id + 1), plan: lobby, connection: cid, of: { kind: 'center', node: members[1].node }, x: far.x - (dx / d) * reach(far.k), y: far.y - (dy / d) * reach(far.k), k: far.k });
    }
  }
  return { state: fromSnapshot(x), lobby };
}
