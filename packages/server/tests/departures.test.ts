import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, addMember, applyOps, canonical, connect, createNode, createPlan, deleteEverywhere, emptyState, fromSnapshot, type Id, parseRemoteUnit,
  type RemoteUnit, type State, toSnapshot, type Unit, uuidv7,
} from '@cirrus/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Canon, withDepartures } from '../src/canon.ts';
import { created, T0 } from './support.ts';

// The server's one rule (plan 6b, D3, review of task 3): a write that crossed another it could not see — a node thrown
// away there, added to a connection here — is completed by the departures (departuresAfter), journaled, relayed and
// reloaded as completed; past MAX_OPS_PER_UNIT it is refused.

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-departures-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const copy = (s: State): State => fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s))));
const image = (s: State): string => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));
let at = T0;
const unit = (a: Action, pc = 'pc-a'): Unit => ({ unit: uuidv7(), action: a.id, label: a.label, at: at++, pc, ops: a.ops });

/** A plan with X and Y, and a connection of Y alone; the writes that made it. */
function base() {
  const s = emptyState();
  const plan = run(s, createPlan(s, 'P', 'plan')), P = created(plan, 'plan');
  const x = run(s, createNode(s, { plan: P, title: 'X', x: 0, y: 0, k: 0 })), y = run(s, createNode(s, { plan: P, title: 'Y', x: 300, y: 0, k: 0 }));
  const Y = created(y, 'node');
  const c = run(s, connect(s, { plan: P, members: [{ node: Y, role: 'source' }] }));
  const C = (c.ops.find((o) => o.t === 'connection')!.after as { id: Id }).id;
  return { s, P, X: created(x, 'node'), Y, C, writes: [plan, x, y, c] };
}

test.each(['l’ajout d’abord', 'la suppression d’abord'] as const)('Canon.accept : un ajout à une connexion et la suppression de ce nœud, croisés (%s) : la seconde écriture est complétée, journalisée, relayée et relue telle quelle', (order) => {
  const { s, P, X, Y, C, writes } = base();
  const relayed: RemoteUnit[] = [];
  let canon = Canon.open(join(dir, 'base'), (u) => relayed.push(u));
  for (const w of writes) expect(canon.accept(unit(w), 'pc-a')).toMatchObject({ accepted: expect.any(Number) });
  // B adds X to the connection; A, on the same base, throws X away: neither write touches the other's records.
  const add = unit(addMember(copy(s), P, C, { node: X, role: 'target' }), 'pc-b'), del = unit(deleteEverywhere(copy(s), X), 'pc-a');
  const [first, second] = order === 'l’ajout d’abord' ? [add, del] : [del, add];
  const seq0 = canon.seq;
  expect(canon.accept(first, first.pc)).toEqual({ accepted: seq0 + first.ops.length });
  expect(relayed.at(-1)!.ops).toEqual(first.ops);
  const r = canon.accept(second, second.pc);
  // Completed: the connection loses X, and, left with Y alone after holding two, goes to the trash with X's time.
  const kept = relayed.at(-1)!;
  expect(kept.unit).toBe(second.unit);
  expect(kept.ops.slice(0, second.ops.length)).toEqual(second.ops);
  expect(kept.ops.length).toBeGreaterThan(second.ops.length);
  expect(r).toEqual({ accepted: seq0 + first.ops.length + kept.ops.length });
  expect(kept.seq).toBe(canon.seq);
  const conn = canon.state.connections.get(C)!;
  expect(conn.members.map((m) => m.node)).toEqual([Y]);
  expect(conn.trashedAt).toBe(canon.state.nodes.get(X)!.trashedAt);
  expect([...canon.state.branches].some((b) => b.connection === C)).toBe(false);
  // The journal holds the write as relayed, line for line; a PC reads it (parseRemoteUnit).
  const rows = canon.base.changesSince(0).filter((row) => row.unit === second.unit);
  expect(rows.map((row) => row.op)).toEqual(kept.ops);
  expect(rows.map((row) => row.serverSeq)).toEqual(kept.ops.map((_, i) => kept.seq - kept.ops.length + 1 + i));
  expect(() => parseRemoteUnit(JSON.parse(JSON.stringify(kept)))).not.toThrow();
  // Opened again, the same state.
  const before = image(canon.state);
  canon.close();
  canon = Canon.open(join(dir, 'base'), () => {});
  expect(image(canon.state)).toBe(before);
  expect(canon.seq).toBe(kept.seq);
  canon.close();
});

test('withDepartures : sans départ, l’écriture même ; au-delà de la borne d’opérations, refusée, les départs non appliqués', () => {
  const { s, P, X, C } = base();
  const add = addMember(copy(s), P, C, { node: X, role: 'target' }), del = deleteEverywhere(copy(s), X);
  run(s, add);
  // Nothing to complete: the same object.
  const plain = unit(add);
  expect(withDepartures(copy(s), plain)).toBe(plain);
  applyOps(s, del.ops);
  const u = unit(del), without = image(s);
  // One operation short of what it would need: refused, in French, the state as the write left it.
  const full = withDepartures(copy(s), u);
  expect('ops' in full && full.ops.length).toBeGreaterThan(u.ops.length);
  const needed = (full as Unit).ops.length;
  expect(withDepartures(s, u, needed - 1)).toEqual({ refused: `Avec les connexions que ses nœuds quittent, cette écriture compterait plus de ${needed - 1} opérations : elle est refusée.` });
  expect(image(s)).toBe(without);
  // At the bound: completed.
  expect((withDepartures(s, u, needed) as Unit).ops).toHaveLength(needed);
  expect(image(s)).not.toBe(without);
});
