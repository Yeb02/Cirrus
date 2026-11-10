import { expect } from 'vitest';
import { type Action, addedViolation } from '../src/commands.ts';
import { uuidv7 } from '../src/ids.ts';
import { checkState } from '../src/invariants.ts';
import type { Id } from '../src/model.ts';
import { invertOp } from '../src/ops.ts';
import { fromSnapshot, toSnapshot } from '../src/snapshot.ts';
import { applyOps, canonical, OpConflictError, type State } from '../src/state.ts';
import { parseUnit, reconcile, type RemoteUnit, type Unit } from '../src/sync.ts';

// Two PCs and a server, as the tag registry's tests first made them (plan 6a, task 3a), shared since with the trash's
// (task 4): a server as reconcile.test.ts's sequencer (shape, "befores", rules) and two PCs that each make one write on
// the same base, then send, receive and reconcile until nothing moves.

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const unitOf = (a: Action, pc: string, at: number): Unit => ({ unit: uuidv7(), action: a.id, label: a.label, at, pc, ops: a.ops });
/** The time the crossed writes are stamped from: `at` in crossed counts from it. */
const T0 = Date.UTC(2026, 10, 10, 9);

export type Answer = 'accepted' | 'stale' | { refused: string };

/** POST /units for one write, as the server takes it: parseUnit, the "befores", no violation added. */
export function accept(server: State, journal: RemoteUnit[], u: Unit): Answer {
  const unit = parseUnit(wire(u));
  try {
    applyOps(server, unit.ops);
  } catch (e) {
    if (e instanceof OpConflictError) return 'stale';
    throw e;
  }
  const v = addedViolation(server, unit.ops);
  if (v) {
    applyOps(server, [...unit.ops].reverse().map(invertOp));
    return { refused: v.message };
  }
  journal.push({ ...wire(unit), seq: (journal.at(-1)?.seq ?? 0) + unit.ops.length });
  return 'accepted';
}

/** A state's content, each list sorted: equal states, whatever the order their rows were made in. */
export const image = (s: State): string => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));
/** A copy of a state, through JSON, as on the network. */
export const copy = (s: State): State => fromSnapshot(wire(toSnapshot(s)));

interface Pc { s: State; pending: Unit[]; next: number; refused: { unit: Id; message: string }[]; dropped: string[] }

/**
 * Two PCs make a write each on the same base; the server receives them in `order`; each PC sends what is pending
 * (stale: it waits for the journal), receives the journal, reconciles; until nothing moves. Every state is then the
 * server's, and valid.
 */
export function crossed(s0: State, mine: (s: State) => Action, theirs: (s: State) => Action, order: 'mine first' | 'theirs first', at: { mine: number; theirs: number }) {
  const server = copy(s0), journal: RemoteUnit[] = [];
  const pcs: Pc[] = [copy(s0), copy(s0)].map((s) => ({ s, pending: [], next: 0, refused: [], dropped: [] }));
  const [A, B] = pcs;
  A.pending.push(unitOf(run(A.s, mine(A.s)), 'pc-a', T0 + at.mine));
  B.pending.push(unitOf(run(B.s, theirs(B.s)), 'pc-b', T0 + at.theirs));
  const send = (pc: Pc) => {
    for (const u of pc.pending) {
      if (journal.some((j) => j.unit === u.unit)) continue;
      const answer = accept(server, journal, u);
      if (answer === 'stale') break;
      if (answer !== 'accepted') pc.refused.push({ unit: u.unit, message: answer.refused });
    }
  };
  const receive = (pc: Pc) => {
    const r = reconcile(pc.s, pc.pending, journal.slice(pc.next).map(wire), pc.refused);
    pc.pending = r.rebased;
    pc.next = journal.length;
    pc.refused = [];
    pc.dropped.push(...r.dropped.map((d) => d.message));
  };
  for (const pc of order === 'mine first' ? [A, B] : [B, A]) send(pc);
  for (let round = 0; pcs.some((pc) => pc.pending.length > 0 || pc.next < journal.length); round++) {
    if (round > 10) throw new Error('pas de repos');
    for (const pc of pcs) { receive(pc); send(pc); }
  }
  for (const pc of pcs) receive(pc);
  for (const [i, pc] of pcs.entries()) {
    expect(image(pc.s), `PC ${i}`).toBe(image(server));
    expect(checkState(pc.s), `PC ${i}`).toEqual([]);
  }
  expect(checkState(server)).toEqual([]);
  return { server, dropped: pcs.flatMap((pc) => pc.dropped) };
}
