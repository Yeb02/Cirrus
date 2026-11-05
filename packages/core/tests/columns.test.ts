import { expect, test } from 'vitest';
import { checkState, groupOf, touchedBy } from '../src/invariants.ts';
import type { ConnectionKind, ConnectionRec, Id, Member, NodeRec, PlanType, Role, TagKeyDef, TagValue } from '../src/model.ts';
import { invertOp, type Op } from '../src/ops.ts';
import { fromSnapshot } from '../src/snapshot.ts';
import {
  applyOp, canonical, checkRecord, connRow, dataOf, emptyState, formerConnRow, formerNodeRow, groupMembers, memberOf, nodeRow, OpConflictError, phantomsIn,
  phantomsOf, placedIn, placementOf, planRow, reindex, type State,
} from '../src/state.ts';
import * as oracleRules from './oracle/invariants.ts';
import * as oracle from './oracle/state.ts';
import { toSnapshot as oracleSnapshot } from './oracle/snapshot.ts';

/** mulberry32: a small seeded generator, so that a failure replays. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLANS = ['p0', 'p1', 'p2'];
const NODES = Array.from({ length: 12 }, (_, i) => `n${i}`);
const CONNS = Array.from({ length: 14 }, (_, i) => `c${i}`);
const PHANTOMS = Array.from({ length: 6 }, (_, i) => `f${i}`);
const KEYS = ['k0', 'k1'];
const ROLES: Role[] = ['source', 'target', 'associate'];
const KINDS: ConnectionKind[] = ['knowledge', 'inclusion', 'structure'];
const TYPES: PlanType[] = ['lobby', 'plan', 'document'];
/** Identifiers outside the universe: no record ever, only references by no-op operations. */
const UNKNOWN = { plan: 'px', connection: 'cx', node: 'nx' };

/** Operations the columns refuse (an unknown kind or role) while the object model stored them as they were. */
const INVALID = new WeakSet<Op>();

/**
 * Random operations on a small universe, each valid against the oracle (its "before" is the oracle's current record),
 * except the undos of earlier operations and the stale ones, which may conflict, and the invalid ones (INVALID).
 * Inclusions dominate, with their two members, so that groups form, change and break in every plan; connections grow
 * and shrink, records come and go; branch operations that change nothing (added when there, removed when absent)
 * come on known and unknown identifiers; tag keys are sometimes enumerations that some values do not match.
 */
function generator(seed: number, o: oracle.State) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const history: Op[] = [];
  const tags = (): TagValue[] => (r() < 0.6 ? [] : [{ key: pick(KEYS) }, ...(r() < 0.5 ? [{ key: 'k1', value: Math.floor(r() * 3) }] : [])]);
  const members = (kind: ConnectionKind): Member[] => {
    if (kind === 'inclusion' && r() < 0.85) return [{ node: pick(NODES), role: 'source' }, { node: pick(NODES), role: 'target' }];
    return Array.from({ length: Math.floor(r() * 6) }, () => ({ node: pick(NODES), role: pick(ROLES) }));
  };
  const connection = (id: Id): ConnectionRec => {
    const kind = r() < 0.45 ? 'inclusion' : pick(KINDS);
    const c: ConnectionRec = { id, kind, title: r() < 0.5 ? '' : `t${Math.floor(r() * 5)}`, relation: r() < 0.7 ? '' : 'R', tags: tags(), members: members(kind) };
    if (r() < 0.15) c.trashedAt = 1000 + Math.floor(r() * 100);
    return c;
  };
  const tagKey = (key: string): TagKeyDef => r() < 0.5
    ? { key, type: 'enum', scope: 'both', multi: false, required: false, enumValues: [{ name: 'un', rank: 1 }] }
    : { key, type: 'word', scope: pick(['node', 'connection', 'both'] as const), multi: r() < 0.5, required: false };
  const fresh = (): Op => {
    const t = r();
    if (t < 0.1) {
      const id = pick(NODES), before = o.nodes.get(id) ?? null;
      const after = before && r() < 0.3 ? null : { id, title: `T${Math.floor(r() * 9)}`, summary: '', tags: tags(), files: [], ...(r() < 0.2 ? { trashedAt: 5 } : {}) };
      return { t: 'node', before, after };
    }
    if (t < 0.14) {
      const id = pick(PLANS), before = o.plans.get(id) ?? null;
      return { t: 'plan', before, after: before && r() < 0.25 ? null : { id, name: `P${Math.floor(r() * 9)}`, type: pick(TYPES) } };
    }
    if (t < 0.32) {
      const id = pick(CONNS), before = o.connections.get(id) ?? null;
      return { t: 'connection', before, after: before && r() < 0.25 ? null : connection(id) };
    }
    if (t < 0.44) {
      const plan = pick(PLANS), node = pick(NODES), before = o.placements.get(oracle.placementKey(plan, node)) ?? null;
      return { t: 'placement', before, after: before && r() < 0.4 ? null : { plan, node, x: Math.floor(r() * 100), y: Math.floor(r() * 100), k: Math.floor(r() * 3) } };
    }
    if (t < 0.74) {
      const c = pick(CONNS), plan = pick(PLANS), ms = o.connections.get(c)?.members ?? [];
      // Mostly a member, often one not shown here yet: both branches of an inclusion make a group.
      const missing = ms.filter((m) => !o.branches.has(oracle.branchKey({ plan, connection: c, node: m.node })));
      const node = missing.length > 0 && r() < 0.5 ? pick(missing).node : ms.length > 0 && r() < 0.85 ? pick(ms).node : pick(NODES);
      const key = { plan, connection: c, node }, before = o.branches.has(oracle.branchKey(key));
      return { t: 'branch', key, before, after: !before };
    }
    if (t < 0.82) {
      const id = pick(PHANTOMS), before = o.phantoms.get(id) ?? null;
      const of = { kind: pick(['node', 'center', 'absent'] as const), node: pick(NODES) };
      const after = before && r() < 0.3 ? null : {
        id, plan: before && r() < 0.7 ? before.plan : pick(PLANS), connection: before && r() < 0.7 ? before.connection : pick(CONNS),
        of, x: 1, y: 2, k: 0, ...(r() < 0.3 ? { group: pick(NODES) } : {}),
      };
      return { t: 'phantom', before, after };
    }
    if (t < 0.88) {
      const plan = pick(PLANS), connection = pick(CONNS), before = o.connLayouts.get(oracle.layoutKey(plan, connection)) ?? null;
      return { t: 'connLayout', before, after: before && r() < 0.4 ? null : { plan, connection, marker: { x: Math.floor(r() * 9), y: 0 }, handles: {} } };
    }
    const key = pick(KEYS), before = o.tagKeys.get(key) ?? null;
    return { t: 'tagKey', before, after: before && r() < 0.4 ? null : tagKey(key) };
  };
  return (): Op => {
    const t = r();
    // An undo of an earlier operation: it conflicts when its record changed since.
    if (t < 0.08 && history.length > 0) return invertOp(pick(history));
    // A stale operation: an earlier "before" replayed.
    if (t < 0.1 && history.length > 0) return pick(history);
    // A branch operation that changes nothing, on known identifiers or on unknown ones.
    if (t < 0.13) {
      const key = r() < 0.3
        ? { plan: r() < 0.5 ? UNKNOWN.plan : pick(PLANS), connection: r() < 0.5 ? UNKNOWN.connection : pick(CONNS), node: UNKNOWN.node }
        : { plan: pick(PLANS), connection: pick(CONNS), node: pick(NODES) };
      const present = o.branches.has(oracle.branchKey(key));
      return { t: 'branch', key, before: present, after: present };
    }
    // An invalid connection record: an unknown kind, or a member with an unknown role.
    if (t < 0.15) {
      const id = pick(CONNS), c = connection(id);
      const bad = r() < 0.5 ? { ...c, kind: 'bogus' as ConnectionKind } : { ...c, members: [...c.members, { node: pick(NODES), role: 'bogus' as Role }] };
      const op: Op = { t: 'connection', before: o.connections.get(id) ?? null, after: bad };
      INVALID.add(op);
      return op;
    }
    const op = fresh();
    history.push(op);
    return op;
  };
}

/**
 * Applies `op` to both models: both accept it, or both refuse it (a conflict) and stay as they were. An invalid
 * record is refused by the columns before any write, and the oracle does not get it.
 */
function both(s: State, o: oracle.State, op: Op): void {
  if (INVALID.has(op)) {
    expect(() => applyOp(s, op)).toThrow(/unknown (connection kind|role)/);
    return;
  }
  let oracleErr: unknown = null, err: unknown = null;
  try { oracle.applyOp(o, op); } catch (e) { oracleErr = e; }
  try { applyOp(s, op); } catch (e) { err = e; }
  if (oracleErr) expect(oracleErr).toBeInstanceOf(oracle.OpConflictError);
  expect(err === null).toBe(oracleErr === null);
  if (err) expect(err).toBeInstanceOf(OpConflictError);
}

// Sorted: the two models do not iterate in the same order, the content must be the same.
const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();
const bkey = (b: { plan: Id; connection: Id; node: Id }) => `${b.plan}|${b.connection}|${b.node}`;
const view = (s: State | oracle.State) => ({
  nodes: sorted(s.nodes), connections: sorted(s.connections), plans: sorted(s.plans), tagKeys: sorted(s.tagKeys), placements: sorted(s.placements),
  branches: [...s.branches].map((b) => (typeof b === 'string' ? b : bkey(b))).sort(), connLayouts: sorted(s.connLayouts), phantoms: sorted(s.phantoms),
  sizes: [s.nodes.size, s.connections.size, s.plans.size, s.tagKeys.size, s.placements.size, s.branches.size, s.connLayouts.size, s.phantoms.size],
});

/** Every lookup of the façades and direct accessors, on every identifier of the universe, against the oracle. */
function lookups(s: State, o: oracle.State): void {
  const T = dataOf(s).tables;
  const same = (a: unknown, b: unknown) => expect(canonical(a ?? null)).toBe(canonical(b ?? null));
  for (const id of NODES) { expect(s.nodes.has(id)).toBe(o.nodes.has(id)); same(s.nodes.get(id), o.nodes.get(id)); }
  for (const id of PLANS) { expect(s.plans.has(id)).toBe(o.plans.has(id)); same(s.plans.get(id), o.plans.get(id)); }
  for (const id of PHANTOMS) { expect(s.phantoms.has(id)).toBe(o.phantoms.has(id)); same(s.phantoms.get(id), o.phantoms.get(id)); }
  for (const id of CONNS) { expect(s.connections.has(id)).toBe(o.connections.has(id)); same(s.connections.get(id), o.connections.get(id)); }
  for (const plan of PLANS) {
    for (const node of NODES) {
      const key = oracle.placementKey(plan, node);
      expect(s.placements.has(key)).toBe(o.placements.has(key));
      same(s.placements.get(key), o.placements.get(key));
      same(placementOf(s, plan, node), o.placements.get(key));
    }
    // forEachInPlan: the nodes shown in this plan, per connection.
    const seen = new Map<Id, Id[]>();
    s.branches.forEachInPlan(plan, (c, nodes) => seen.set(T.conns.rows.ids[c], Array.from(nodes, (n) => T.nodes.rows.ids[n]).sort()));
    const expected = new Map<Id, Id[]>();
    for (const k of o.branches) {
      const b = oracle.parseBranchKey(k);
      if (b.plan === plan) expected.set(b.connection, [...(expected.get(b.connection) ?? []), b.node].sort());
    }
    expect(new Map([...seen].sort())).toEqual(new Map([...expected].sort()));
    for (const c of CONNS) {
      expect(s.branches.nodesIn(c, plan).sort()).toEqual(expected.get(c) ?? []);
      for (const node of NODES) expect(s.branches.has({ plan, connection: c, node })).toBe(o.branches.has(oracle.branchKey({ plan, connection: c, node })));
    }
  }
  for (const c of CONNS) {
    const plans = new Set([...o.branches].map(oracle.parseBranchKey).filter((b) => b.connection === c).map((b) => b.plan));
    expect(s.branches.plansOf(c).sort()).toEqual([...plans].sort());
  }
}

/**
 * The books of the tables against the oracle: each row counted exactly by the references to its identifier (record,
 * members, branches, placements), free rows empty, and each pool's live space the sum of its lists' capacities.
 */
function bookkeeping(s: State, o: oracle.State): void {
  const T = dataOf(s).tables, I = dataOf(s).index;
  const want = { nodes: new Map<Id, number>(), plans: new Map<Id, number>(), conns: new Map<Id, number>() };
  const add = (m: Map<Id, number>, id: Id) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const id of o.nodes.keys()) add(want.nodes, id);
  for (const id of o.plans.keys()) add(want.plans, id);
  for (const c of o.connections.values()) { add(want.conns, c.id); for (const m of c.members) add(want.nodes, m.node); }
  for (const p of o.placements.values()) { add(want.plans, p.plan); add(want.nodes, p.node); }
  for (const k of o.branches) { const b = oracle.parseBranchKey(k); add(want.plans, b.plan); add(want.conns, b.connection); add(want.nodes, b.node); }
  for (const [rows, expected] of [[T.nodes.rows, want.nodes], [T.plans.rows, want.plans], [T.conns.rows, want.conns]] as const) {
    expect(new Map([...rows.row].map(([id, r]) => [id, rows.refs[r]]))).toEqual(expected);
    expect(rows.row.size + rows.free.length).toBe(rows.end);
    for (const r of rows.free) expect([rows.ids[r], rows.refs[r]]).toEqual(['', 0]);
  }
  for (const pool of [T.conns.members, T.conns.branches, I.memberOf, I.placedIn]) {
    let cap = 0;
    for (let owner = 0; owner < pool.cap.length; owner++) { cap += pool.cap[owner]; expect(pool.len[owner]).toBeLessThanOrEqual(pool.cap[owner]); }
    expect(cap).toBe(pool.top - pool.waste);
  }
  for (const id of CONNS) {
    const r = connRow(s, id);
    expect(r < 0 ? 0 : T.conns.members.len[r]).toBe(o.connections.get(id)?.members.length ?? 0);
    expect(r < 0 ? 0 : T.conns.branches.len[r] / 2).toBe([...o.branches].filter((k) => oracle.parseBranchKey(k).connection === id).length);
  }
  expect([T.nodes.count, T.plans.count, T.conns.count, T.plans.placementCount, T.conns.branchCount])
    .toEqual([o.nodes.size, o.plans.size, o.connections.size, o.placements.size, o.branches.size]);
}

/** The groups of spec 10 read straight from the oracle: inclusions not in the trash, first source in first target, both branches shown. */
function oracleGroups(o: oracle.State, plan: Id, node: Id): Id[] {
  const out: Id[] = [];
  for (const c of o.connections.values()) {
    if (c.kind !== 'inclusion' || c.trashedAt !== undefined) continue;
    const m = c.members.find((x) => x.role === 'source'), g = c.members.find((x) => x.role === 'target');
    if (!m || !g || m.node !== node) continue;
    const shown = (n: Id) => o.branches.has(oracle.branchKey({ plan, connection: c.id, node: n }));
    if (shown(node) && shown(g.node)) out.push(g.node);
  }
  return out;
}

/** The indices kept by applyOp against what they mean, computed from the oracle. */
function indicesMatchOracle(s: State, o: oracle.State): void {
  const T = dataOf(s).tables, I = dataOf(s).index;
  for (const n of NODES) {
    const r = nodeRow(s, n);
    const conns = r < 0 ? [] : Array.from(memberOf(s, r), (c) => T.conns.rows.ids[c]).sort();
    expect(conns).toEqual([...o.connections.values()].filter((c) => c.members.some((m) => m.node === n)).map((c) => c.id).sort());
    const plans = r < 0 ? [] : Array.from(placedIn(s, r), (p) => T.plans.rows.ids[p]).sort();
    expect(plans).toEqual([...o.placements.values()].filter((p) => p.node === n).map((p) => p.plan).sort());
  }
  for (const c of CONNS) {
    expect([...phantomsOf(s, c)].sort()).toEqual([...o.phantoms.values()].filter((p) => p.connection === c).map((p) => p.id).sort());
  }
  for (const g of NODES) expect([...phantomsIn(s, g)].sort()).toEqual([...o.phantoms.values()].filter((p) => p.group === g).map((p) => p.id).sort());
  expect([...I.structures].map((c) => T.conns.rows.ids[c]).sort()).toEqual([...o.connections.values()].filter((c) => c.kind === 'structure').map((c) => c.id).sort());
  for (const key of KEYS) {
    const carriers = [...o.nodes.values(), ...o.connections.values()].filter((r) => r.tags.some((t) => t.key === key)).map((r) => r.id).sort();
    expect([...(I.tagged.get(key) ?? [])].sort()).toEqual(carriers);
  }
  for (const plan of PLANS) {
    const members = new Map<Id, Id[]>();
    for (const n of NODES) {
      const expected = oracleGroups(o, plan, n), g = groupOf(s, plan, n);
      if (expected.length === 0) expect(g).toBeUndefined();
      else expect(expected).toContain(g);
      const pr = planRow(s, plan), nr = nodeRow(s, n);
      const multi = pr < 0 || nr < 0 ? undefined : I.groupOf[pr]?.multi.get(nr);
      if (expected.length > 1) expect(multi?.map((x) => T.nodes.rows.ids[x]).sort()).toEqual(expected.sort());
      else expect(multi).toBeUndefined();
      if (g !== undefined) members.set(g, [...(members.get(g) ?? []), n].sort());
    }
    for (const g of NODES) {
      const pr = planRow(s, plan), gr = nodeRow(s, g);
      const got = pr < 0 || gr < 0 ? [] : groupMembers(s, pr, gr).map((x) => T.nodes.rows.ids[x]).sort();
      expect(got).toEqual(members.get(g) ?? []);
    }
  }
}

/** Every index in identifier terms (rows differ from one state to another), lists sorted where their order is free. */
function indexDump(s: State) {
  const T = dataOf(s).tables, I = dataOf(s).index, nid = (r: number) => T.nodes.rows.ids[r], pid = (r: number) => T.plans.rows.ids[r];
  const out: string[] = [];
  for (let n = 0; n < T.nodes.rows.end; n++) {
    if (T.nodes.rows.ids[n] === '') {
      expect(I.memberOf.len[n] ?? 0).toBe(0); // a free row holds nothing
      continue;
    }
    out.push(`memberOf ${nid(n)} ${Array.from(memberOf(s, n), (c) => T.conns.rows.ids[c]).sort()}`);
    out.push(`placedIn ${nid(n)} ${Array.from(placedIn(s, n), pid).sort()}`);
  }
  I.groupOf.forEach((pg, p) => {
    if (!pg) return;
    pg.group.forEach((g, n) => { if (g >= 0) out.push(`groupOf ${pid(p)} ${nid(n)} ${nid(g)} ${pg.multi.get(n)?.map(nid) ?? ''}`); });
  });
  I.groupMembers.forEach((gm, p) => { for (const [g, ms] of gm ?? []) out.push(`groupMembers ${pid(p)} ${nid(g)} ${ms.map(nid).sort()}`); });
  for (const [c, ids] of I.phantomsOf) out.push(`phantomsOf ${c} ${[...ids].sort()}`);
  for (const [g, ids] of I.phantomsIn) out.push(`phantomsIn ${g} ${[...ids].sort()}`);
  out.push(`structures ${[...I.structures].map((c) => T.conns.rows.ids[c]).sort()}`);
  for (const [key, ids] of I.tagged) out.push(`tagged ${key} ${[...ids].sort()}`);
  return out.sort();
}

/** The state rebuilt from the oracle's own snapshot (the oracle predates the preamble): loaded in bulk, then indexed by reindex. */
function rebuilt(o: oracle.State): State {
  const x = oracleSnapshot(o);
  return fromSnapshot({ ...x, branches: x.branches.map((k) => { const b = oracle.parseBranchKey(k); return [b.plan, b.connection, b.node]; }), preamble: null });
}

/** How often the rule checks were compared, and how many cycle violations were left out as ambiguous. */
const ruleStats = { compared: 0, ambiguous: 0 };

/**
 * The rule checks against the old implementation (oracle/invariants.ts): on the whole state, its whole check; on a
 * scope, the violations of its whole check about the scope, which is exactly what a scoped check gives since plan 3c,
 * task 3 (the old scoped check also skipped the rules of groups and branches when no connection was in scope, and
 * nodes and plans without a record). A cycle is found by following each node's first group; with several groups (rule
 * twoGroups, reported by both) the old model's first depended on the order of its branch set, the columns take the
 * inclusion of smallest identifier: a cycle violation whose chain meets such a node is left out of the comparison,
 * nothing else is.
 */
function rulesMatchOracle(s: State, o: oracle.State, scopes: (Set<Id> | undefined)[]): void {
  const ambiguous = (subject: Id) => PLANS.some((plan) => {
    const seen = new Set([subject]);
    for (let gs = oracleGroups(o, plan, subject); gs.length > 0; gs = oracleGroups(o, plan, gs[0])) {
      if (gs.length > 1) return true;
      if (seen.has(gs[0])) return false;
      seen.add(gs[0]);
    }
    return false;
  });
  const keys = (vs: readonly { code: string; subject: Id; message: string }[]) => vs
    .filter((v) => { const skip = v.code === 'cycle' && ambiguous(v.subject); if (skip) ruleStats.ambiguous++; return !skip; })
    .map((v) => `${v.code}|${v.subject}|${v.message}`).sort();
  const whole = oracleRules.checkState(o);
  /** The scope as checkState reads it: the touched objects, and the members of touched inclusions. */
  const read = (scope: Set<Id>) => {
    const out = new Set(scope);
    for (const id of scope) { const c = o.connections.get(id); if (c?.kind === 'inclusion') for (const m of c.members) out.add(m.node); }
    return out;
  };
  for (const scope of scopes) {
    const about = scope && read(scope);
    expect(keys(checkState(s, scope))).toEqual(keys(about ? whole.filter((v) => about.has(v.subject)) : whole));
    ruleStats.compared++;
  }
}

test('oracle : 2 000 opérations au hasard, les façades égalent le modèle objet après chaque centaine', () => {
  const s = emptyState(), o = oracle.emptyState();
  const next = generator(1, o);
  const r = rng(11), window: Op[] = [];
  const someIds = () => new Set(Array.from({ length: 1 + Math.floor(r() * 4) }, () => [...NODES, ...CONNS, UNKNOWN.node][Math.floor(r() * 27)]));
  for (let i = 1; i <= 2000; i++) {
    const op = next();
    both(s, o, op);
    if (!INVALID.has(op)) window.push(op);
    if (i % 20 === 0) {
      rulesMatchOracle(s, o, [undefined, touchedBy(s, window), someIds(), someIds(), someIds()]);
      window.length = 0;
    }
    if (i % 100 === 0) {
      expect(view(s)).toEqual(view(o));
      lookups(s, o);
      bookkeeping(s, o);
    }
  }
  expect(ruleStats.compared).toBe(500);
  // Everything removed: no row is left held, no list left in the pools.
  for (const op of removeAll(o)) both(s, o, op);
  expect(view(s)).toEqual(view(o));
  bookkeeping(s, o);
  const T = dataOf(s).tables, I = dataOf(s).index;
  for (const rows of [T.nodes.rows, T.plans.rows, T.conns.rows]) {
    expect(rows.row.size).toBe(0);
    expect(rows.free.length).toBe(rows.end);
    expect(rows.refs.every((n) => n === 0)).toBe(true);
  }
  for (const pool of [T.conns.members, T.conns.branches, I.memberOf, I.placedIn]) expect(pool.top).toBe(pool.waste);
  expect([I.phantomsOf.size, I.phantomsIn.size, I.structures.size, I.tagged.size]).toEqual([0, 0, 0, 0]);
  expect(I.groupMembers.every((m) => !m || m.size === 0)).toBe(true);
});

test('index : tenus par applyOp, égaux à leur définition et à ceux de reindex sur un état reconstruit, après chaque centaine', () => {
  const s = emptyState(), o = oracle.emptyState();
  const next = generator(2, o);
  for (let i = 1; i <= 2000; i++) {
    both(s, o, next());
    if (i % 100 === 0) {
      indicesMatchOracle(s, o);
      bookkeeping(s, o);
      const dump = indexDump(s);
      expect(indexDump(rebuilt(o))).toEqual(dump);
      // Built again over the same tables, rows included; the operations that follow go on from these indices.
      reindex(s);
      expect(indexDump(s)).toEqual(dump);
    }
  }
});

/** Operations that empty the oracle, in an order that leaves references dangling for a while (nodes before their connections). */
function removeAll(o: oracle.State): Op[] {
  return [
    ...[...o.nodes.values()].map((before): Op => ({ t: 'node', before, after: null })),
    ...[...o.plans.values()].map((before): Op => ({ t: 'plan', before, after: null })),
    ...[...o.placements.values()].map((before): Op => ({ t: 'placement', before, after: null })),
    ...[...o.connections.values()].map((before): Op => ({ t: 'connection', before, after: null })),
    ...[...o.branches].map((k): Op => ({ t: 'branch', key: oracle.parseBranchKey(k), before: true, after: false })),
    ...[...o.phantoms.values()].map((before): Op => ({ t: 'phantom', before, after: null })),
    ...[...o.connLayouts.values()].map((before): Op => ({ t: 'connLayout', before, after: null })),
    ...[...o.tagKeys.values()].map((before): Op => ({ t: 'tagKey', before, after: null })),
  ];
}

const nodeOp = (id: Id): Op => ({ t: 'node', before: null, after: { id, title: id, summary: '', tags: [], files: [] } });
const conn = (id: Id, nodes: Id[], kind: ConnectionKind = 'knowledge'): ConnectionRec =>
  ({ id, kind, title: '', relation: '', tags: [], members: nodes.map((node, i) => ({ node, role: i === 0 ? 'source' : 'target' })) });
const branchOp = (plan: Id, connection: Id, node: Id, present: boolean): Op => ({ t: 'branch', key: { plan, connection, node }, before: !present, after: present });

test('plusieurs groupes : le retenu est celui de l’inclusion au plus petit identifiant, quel que soit l’ordre des rangées, retraits et annulations compris', () => {
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'P', type: 'plan' } });
  for (const id of ['m', 'g1', 'g2']) applyOp(s, nodeOp(id));
  // Created in reverse identifier order: inc-b (into g1) takes the first row, inc-a (into g2) the second.
  for (const [id, group] of [['inc-b', 'g1'], ['inc-a', 'g2']]) {
    applyOp(s, { t: 'connection', before: null, after: conn(id, ['m', group], 'inclusion') });
    for (const node of ['m', group]) applyOp(s, branchOp('p', id, node, true));
  }
  expect(connRow(s, 'inc-b')).toBeLessThan(connRow(s, 'inc-a'));
  /** The groups of m by definition (spec 10), from the façades, ordered by inclusion identifier: the first is the one kept. */
  const defined = () => [...s.connections.values()]
    .filter((c) => c.kind === 'inclusion' && c.trashedAt === undefined && c.members.find((x) => x.role === 'source')?.node === 'm')
    .filter((c) => { const g = c.members.find((x) => x.role === 'target')!.node; return s.branches.has({ plan: 'p', connection: c.id, node: 'm' }) && s.branches.has({ plan: 'p', connection: c.id, node: g }); })
    .sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => c.members.find((x) => x.role === 'target')!.node);
  const expectGroups = (groups: Id[]) => {
    const T = dataOf(s).tables, I = dataOf(s).index, ids = (rows: readonly number[]) => rows.map((r) => T.nodes.rows.ids[r]);
    expect(defined()).toEqual(groups);
    expect(groupOf(s, 'p', 'm')).toBe(groups[0]);
    const multi = I.groupOf[planRow(s, 'p')]?.multi.get(nodeRow(s, 'm'));
    expect(multi && ids(multi)).toEqual(groups.length > 1 ? groups : undefined);
    for (const g of ['g1', 'g2']) expect(ids(groupMembers(s, planRow(s, 'p'), nodeRow(s, g)))).toEqual(g === groups[0] ? ['m'] : []);
    expect(checkState(s).some((v) => v.code === 'twoGroups' && v.subject === 'm')).toBe(groups.length > 1);
    const dump = indexDump(s);
    reindex(s);
    expect(indexDump(s)).toEqual(dump);
  };
  expectGroups(['g2', 'g1']);
  // Each inclusion goes (its record, then one of its branches), and comes back by the inverse operation.
  for (const [id, left] of [['inc-a', ['g1']], ['inc-b', ['g2']]] as const) {
    const removal: Op = { t: 'connection', before: s.connections.get(id)!, after: null };
    applyOp(s, removal);
    expectGroups([...left]);
    applyOp(s, invertOp(removal));
    expectGroups(['g2', 'g1']);
    const hidden = branchOp('p', id, 'm', false);
    applyOp(s, hidden);
    expectGroups([...left]);
    applyOp(s, invertOp(hidden));
    expectGroups(['g2', 'g1']);
  }
});

test('une opération sans effet ou invalide laisse l’état tel quel : branche déjà là ou absente, genre ou rôle inconnu', () => {
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'P', type: 'plan' } });
  for (const id of ['a', 'b', 'c', 'd']) applyOp(s, nodeOp(id));
  applyOp(s, { t: 'connection', before: null, after: conn('X', ['a', 'b']) });
  applyOp(s, { t: 'connection', before: null, after: conn('Y', ['c', 'd']) });
  for (const [c, n] of [['X', 'a'], ['X', 'b'], ['Y', 'c']]) applyOp(s, branchOp('p', c, n, true));
  const books = () => {
    const T = dataOf(s).tables;
    return canonical({
      view: view(s), dump: indexDump(s),
      rows: [T.nodes.rows, T.plans.rows, T.conns.rows].map((r) => [[...r.row], [...r.refs.subarray(0, r.end)], r.free, r.end]),
      counts: [T.nodes.count, T.plans.count, T.conns.count, T.conns.branchCount],
    });
  };
  const before = books();
  applyOp(s, { t: 'branch', key: { plan: 'p', connection: 'Y', node: 'd' }, before: false, after: false });
  applyOp(s, { t: 'branch', key: { plan: 'p', connection: 'X', node: 'a' }, before: true, after: true });
  applyOp(s, { t: 'branch', key: { plan: 'q', connection: 'Z', node: 'zz' }, before: false, after: false });
  expect(books()).toBe(before);
  expect(() => applyOp(s, { t: 'connection', before: null, after: { ...conn('K', ['a', 'b']), kind: 'bogus' as ConnectionKind } })).toThrow(/unknown connection kind/);
  expect(() => applyOp(s, { t: 'connection', before: null, after: { ...conn('K', ['c', 'a']), members: [{ node: 'c', role: 'source' }, { node: 'a', role: 'bogus' as Role }] } }))
    .toThrow(/unknown role/);
  expect(() => applyOp(s, { t: 'connection', before: s.connections.get('X')!, after: { ...conn('X', ['a', 'c']), kind: 'bogus' as ConnectionKind } })).toThrow(/unknown/);
  expect(books()).toBe(before);
  expect(s.connections.has('K')).toBe(false);
});

test('un enregistrement que les colonnes ou les index ne savent pas lire est refusé avant toute écriture, par le même contrôle que la base (checkRecord)', () => {
  const s = emptyState();
  for (const id of ['a', 'b']) applyOp(s, nodeOp(id));
  applyOp(s, { t: 'connection', before: null, after: conn('X', ['a', 'b']) });
  const books = () => canonical({ view: view(s), dump: indexDump(s) });
  const before = books();
  const tagless: Partial<ConnectionRec> = conn('K', ['a', 'b']);
  delete tagless.tags;
  const x = s.connections.get('X')!, a = s.nodes.get('a')!;
  const bad: Op[] = [
    { t: 'connection', before: null, after: tagless as ConnectionRec },
    { t: 'connection', before: x, after: { ...x, tags: undefined as never } },
    { t: 'connection', before: null, after: { ...conn('K', ['a']), tags: [null] as never } },
    { t: 'connection', before: null, after: { ...conn('K', ['a']), members: [null] as never } },
    { t: 'connection', before: null, after: { ...conn('K', ['a']), members: [{ node: 7, role: 'source' }] as never } },
    { t: 'connection', before: null, after: { ...conn('K', ['a']), members: 'a' as never } },
    { t: 'connection', before: null, after: { ...conn('K', ['a']), id: 3 as never } },
    { t: 'node', before: null, after: { id: 'n', title: 'n', summary: '', files: [] } as unknown as NodeRec },
    { t: 'node', before: null, after: { id: 'n', title: 'n', summary: '', tags: [] } as unknown as NodeRec },
    { t: 'node', before: a, after: { ...a, tags: 'x' as never } },
  ];
  for (const op of bad) {
    expect(() => checkRecord(op), JSON.stringify(op)).toThrow(/invalid/);
    expect(() => applyOp(s, op), JSON.stringify(op)).toThrow(/invalid/);
    expect(books()).toBe(before);
  }
  expect(() => checkRecord({ t: 'connection', before: null, after: conn('K', ['a']) })).not.toThrow();
});

test('le « avant » d’une connexion se compare à ses colonnes comme canonical le compare au record', () => {
  const s = emptyState();
  for (const id of ['a', 'b']) applyOp(s, nodeOp(id));
  const c: ConnectionRec = { ...conn('X', ['a', 'b']), tags: [{ key: 'k', value: 1 }], trashedAt: 7 };
  applyOp(s, { t: 'connection', before: null, after: c });
  /** Whether an operation with this "before" applies (it is then undone). */
  const accepts = (before: unknown) => {
    try {
      applyOp(s, { t: 'connection', before: before as ConnectionRec, after: { ...c, title: 'T' } });
    } catch (e) {
      expect(e).toBeInstanceOf(OpConflictError);
      return false;
    }
    applyOp(s, { t: 'connection', before: { ...c, title: 'T' }, after: c });
    return true;
  };
  const m = c.members;
  const variants: unknown[] = [
    c, { ...c }, { ...c, extra: undefined }, { trashedAt: 7, members: m, tags: c.tags, relation: '', title: '', kind: 'knowledge', id: 'X' },
    { ...c, tags: [{ value: 1, key: 'k' }] }, { ...c, members: m.map((x) => ({ role: x.role, node: x.node })) },
    { ...c, color: 'rouge' }, { ...c, members: [{ ...m[0], x: 1 }, m[1]] }, { ...c, members: [m[1], m[0]] }, { ...c, members: [m[0]] },
    { ...c, members: [m[0], { ...m[1], role: 'associate' }] }, { ...c, title: undefined }, { ...c, tags: [] }, { ...c, tags: [{ key: 'k', value: '1' }] },
    { ...c, trashedAt: undefined }, { ...c, trashedAt: 8 }, { ...c, id: 'Y' }, { ...c, kind: 'inclusion' }, null,
  ];
  for (const v of variants) expect(accepts(v), canonical(v)).toBe(canonical(v) === canonical(s.connections.get('X')));
  expect(variants.filter(accepts)).toHaveLength(6);
});

test('pools : une connexion qui grandit est relogée en fin de pool, et grandit sur place quand elle y est déjà', () => {
  const s = emptyState();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) applyOp(s, nodeOp(id));
  applyOp(s, { t: 'connection', before: null, after: conn('X', ['a', 'b']) });
  applyOp(s, { t: 'connection', before: null, after: conn('Y', ['c', 'd']) });
  const T = dataOf(s).tables, pool = T.conns.members, x = connRow(s, 'X'), y = connRow(s, 'Y');
  const capX = pool.cap[x];
  applyOp(s, { t: 'connection', before: s.connections.get('X')!, after: conn('X', ['a', 'b', 'c', 'd', 'e']) });
  expect(pool.start[x]).toBeGreaterThan(pool.start[y]);
  expect(pool.waste).toBe(capX);
  expect(s.connections.get('X')!.members.map((m) => m.node)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(s.connections.get('Y')!.members.map((m) => m.node)).toEqual(['c', 'd']);
  expect(Array.from(memberOf(s, nodeRow(s, 'c')), (r) => T.conns.rows.ids[r]).sort()).toEqual(['X', 'Y']);
  // Now last in the pool: it grows where it is.
  const start = pool.start[x];
  applyOp(s, { t: 'connection', before: s.connections.get('X')!, after: conn('X', ['a', 'b', 'c', 'd', 'e', 'f']) });
  expect(pool.start[x]).toBe(start);
  expect(pool.waste).toBe(capX);
  expect(s.connections.get('X')!.members).toHaveLength(6);
});

test('pools : au-delà de 50 % de perte, le pool se compacte sans rien perdre', () => {
  const s = emptyState();
  for (let i = 0; i < 10; i++) applyOp(s, nodeOp(`n${i}`));
  for (let i = 0; i < 200; i++) applyOp(s, { t: 'connection', before: null, after: conn(`c${i}`, [`n${i % 10}`, `n${(i + 3) % 10}`]) });
  const pool = dataOf(s).tables.conns.members, peak = pool.top;
  let compacted = false;
  for (let i = 0; i < 150; i++) {
    applyOp(s, { t: 'connection', before: s.connections.get(`c${i}`)!, after: null });
    expect(pool.waste * 2).toBeLessThanOrEqual(pool.top);
    if (pool.top < peak) compacted = true;
  }
  expect(compacted).toBe(true);
  expect(pool.top - pool.waste).toBe(100);
  for (let i = 150; i < 200; i++) expect(s.connections.get(`c${i}`)!.members.map((m) => m.node)).toEqual([`n${i % 10}`, `n${(i + 3) % 10}`]);
});

test('pools et rangées : une rangée ou une entrée inconnue fait échouer bruyamment, sans rien écrire', () => {
  const s = emptyState();
  applyOp(s, nodeOp('a'));
  const T = dataOf(s).tables;
  expect(() => T.conns.members.removeAt(-1, 0)).toThrow(/no owner/);
  expect(() => T.conns.members.push(-1, 3)).toThrow(/no owner/);
  expect(() => T.conns.members.release(-1)).toThrow(/no owner/);
  expect(() => dataOf(s).index.memberOf.removeAt(nodeRow(s, 'a'), 0)).toThrow(/no entry/);
  expect(() => T.nodes.rows.unref(-1)).toThrow(/not held/);
  expect(() => T.conns.rows.refAgain(5)).toThrow(/not held/);
  expect([T.nodes.rows.free, T.conns.rows.free]).toEqual([[], []]);
});

test('rangées recyclées sans fuite : une rangée libérée resert, un identifiant encore référencé garde la sienne', () => {
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'P', type: 'plan' } });
  for (const id of ['a', 'b']) applyOp(s, nodeOp(id));
  applyOp(s, { t: 'connection', before: null, after: conn('X', ['a', 'b']) });
  for (const node of ['a', 'b']) applyOp(s, branchOp('p', 'X', node, true));
  const x = connRow(s, 'X'), a = nodeRow(s, 'a');
  // The record of a goes, its references stay: same row, same identifier in the connection.
  applyOp(s, { t: 'node', before: s.nodes.get('a')!, after: null });
  expect(s.nodes.has('a')).toBe(false);
  expect(nodeRow(s, 'a')).toBe(a);
  expect(s.connections.get('X')!.members[0].node).toBe('a');
  // The connection's record goes, its branches keep its row; then they go too.
  applyOp(s, { t: 'connection', before: s.connections.get('X')!, after: null });
  expect(s.connections.has('X')).toBe(false);
  expect(connRow(s, 'X')).toBe(x);
  expect(nodeRow(s, 'a')).toBe(a); // still a branch of X
  for (const node of ['a', 'b']) applyOp(s, branchOp('p', 'X', node, false));
  expect(connRow(s, 'X')).toBe(-1);
  expect(nodeRow(s, 'a')).toBe(-1);
  // The freed rows serve again, last freed first.
  applyOp(s, { t: 'connection', before: null, after: conn('Y', ['b', 'b']) });
  expect(connRow(s, 'Y')).toBe(x);
  applyOp(s, nodeOp('z'));
  expect(nodeRow(s, 'z')).toBe(a);
  // Emptied, nothing is held.
  applyOp(s, { t: 'connection', before: s.connections.get('Y')!, after: null });
  for (const id of ['b', 'z']) applyOp(s, { t: 'node', before: s.nodes.get(id)!, after: null });
  applyOp(s, { t: 'plan', before: s.plans.get('p')!, after: null });
  const T = dataOf(s).tables;
  for (const rows of [T.nodes.rows, T.plans.rows, T.conns.rows]) expect([rows.row.size, rows.refs.every((n) => n === 0)]).toEqual([0, true]);
  expect(T.nodes.rows.end).toBe(2);
});

test('rangée d’avant : un identifiant libéré garde la trace de sa rangée tant qu’aucun autre ne la reprend', () => {
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'P', type: 'plan' } });
  for (const id of ['a', 'b', 'c']) applyOp(s, nodeOp(id));
  const make = (id: Id) => { applyOp(s, { t: 'connection', before: null, after: conn(id, ['a', 'b']) }); for (const n of ['a', 'b']) applyOp(s, branchOp('p', id, n, true)); };
  const drop = (id: Id) => { for (const n of ['a', 'b']) applyOp(s, branchOp('p', id, n, false)); applyOp(s, { t: 'connection', before: s.connections.get(id)!, after: null }); };
  make('X');
  make('Y');
  const x = connRow(s, 'X'), y = connRow(s, 'Y'), c = nodeRow(s, 'c');
  expect([formerConnRow(s, 'X'), formerConnRow(s, 'never')]).toEqual([-1, -1]);
  // Freed (the undo of a connection): its row is known until another takes it.
  drop('X');
  drop('Y');
  expect([connRow(s, 'X'), formerConnRow(s, 'X'), formerConnRow(s, 'Y')]).toEqual([-1, x, y]);
  make('Z'); // last freed first: Y's row
  expect([connRow(s, 'Z'), formerConnRow(s, 'Y'), formerConnRow(s, 'X'), formerConnRow(s, 'Z')]).toEqual([y, -1, x, -1]);
  make('X'); // back, on its own row
  expect([connRow(s, 'X'), formerConnRow(s, 'X')]).toEqual([x, -1]);
  // A node whose last reference goes (the undo of a creation), then a node that takes its row.
  applyOp(s, { t: 'node', before: s.nodes.get('c')!, after: null });
  expect([nodeRow(s, 'c'), formerNodeRow(s, 'c')]).toEqual([-1, c]);
  applyOp(s, nodeOp('d'));
  expect([nodeRow(s, 'd'), formerNodeRow(s, 'c')]).toEqual([c, -1]);
});

test('façades en lecture seule : écrire ailleurs que par applyOp lève une erreur', () => {
  const s = emptyState();
  const write = (m: unknown) => (m as { set: (k: unknown, v: unknown) => void }).set('x', {});
  for (const m of [s.nodes, s.connections, s.plans, s.placements, s.phantoms, s.connLayouts, s.tagKeys]) expect(() => write(m)).toThrow(/applyOp/);
  expect(() => (s.branches as unknown as { add: (b: unknown) => void }).add({ plan: 'p', connection: 'c', node: 'n' })).toThrow(/applyOp/);
});
