import type { Id } from '../src/model.ts';
import type { Op } from '../src/ops.ts';
import { canonical, type State } from '../src/state.ts';
import type * as oracle from './oracle/state.ts';

// What the core's tests share: a seeded generator, the record an action creates, a state's content in a form that
// compares, and the time stamp of a conflict copy.

/** mulberry32: a small seeded generator, so that a failure replays. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The record of kind `t` an action (or a write) creates first: its identifier. */
export const created = (a: { ops: readonly Op[] }, t: 'node' | 'connection' | 'plan'): Id =>
  (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

// Sorted: the two models do not iterate in the same order, the content must be the same.
export const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();
export const bkey = (b: { plan: Id; connection: Id; node: Id }) => `${b.plan}|${b.connection}|${b.node}`;
export const view = (s: State | oracle.State) => ({
  nodes: sorted(s.nodes), connections: sorted(s.connections), plans: sorted(s.plans), tagKeys: sorted(s.tagKeys), placements: sorted(s.placements),
  branches: [...s.branches].map((b) => (typeof b === 'string' ? b : bkey(b))).sort(), connLayouts: sorted(s.connLayouts), phantoms: sorted(s.phantoms),
  sizes: [s.nodes.size, s.connections.size, s.plans.size, s.tagKeys.size, s.placements.size, s.branches.size, s.connLayouts.size, s.phantoms.size],
});

/** « AAAA-MM-JJ HHhMM » in this PC's local time, as a conflict copy's name gives it: « (conflit du …) » (R4). */
export const stamp = (at: number) => {
  const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
};
