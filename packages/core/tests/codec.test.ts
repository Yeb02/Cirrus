import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { buildFixture, buildLargeState } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { expect, test } from 'vitest';
import { decodeState, encodeState, SNAPSHOT_VERSION, SnapshotError, snapshotVersion } from '../src/codec.ts';
import { connect, createNode, deleteEverywhere, moveNodes } from '../src/commands.ts';
import type { ConnectionRec, Id, NodeRec, PhantomRec } from '../src/model.ts';
import type { Op } from '../src/ops.ts';
import { toSnapshot } from '../src/snapshot.ts';
import { applyOp, applyOps, canonical, dataOf, emptyState, memberOf, placedIn, type State } from '../src/state.ts';
import { fromSnapshot as oracleFromSnapshot } from './oracle/snapshot.ts';
import * as oracle from './oracle/state.ts';

// V8's own test natives: whether two values are one heap object (strings have no identity in JavaScript itself).
setFlagsFromString('--allow-natives-syntax');
const sameHeapObject = new Function('a', 'b', 'return %IsSameHeapObject(a, b)') as (a: unknown, b: unknown) => boolean;

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

// Sorted: the two models do not iterate in the same order, the content must be the same.
const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();
const bkey = (b: { plan: Id; connection: Id; node: Id }) => `${b.plan}|${b.connection}|${b.node}`;
const view = (s: State | oracle.State) => ({
  nodes: sorted(s.nodes), connections: sorted(s.connections), plans: sorted(s.plans), tagKeys: sorted(s.tagKeys), placements: sorted(s.placements),
  branches: [...s.branches].map((b) => (typeof b === 'string' ? b : bkey(b))).sort(), connLayouts: sorted(s.connLayouts), phantoms: sorted(s.phantoms),
  sizes: [s.nodes.size, s.connections.size, s.plans.size, s.tagKeys.size, s.placements.size, s.branches.size, s.connLayouts.size, s.phantoms.size],
});
/** The object model loaded from a state's records. */
function oracleOf(s: State): oracle.State {
  const x = toSnapshot(s);
  return oracleFromSnapshot({ ...x, branches: x.branches.map(([plan, connection, node]) => bkey({ plan, connection, node })) });
}
/** The rows of each table, as they are: identifiers, references held, free lists, record and pool counts. */
function rows(s: State) {
  const T = dataOf(s).tables;
  const of = (r: { ids: string[]; refs: Int32Array; free: number[]; end: number }) => ({ ids: [...r.ids], refs: [...r.refs.subarray(0, r.end)], free: [...r.free], end: r.end });
  return { nodes: of(T.nodes.rows), plans: of(T.plans.rows), conns: of(T.conns.rows), counts: [T.nodes.count, T.plans.count, T.conns.count, T.conns.branchCount, T.plans.placementCount] };
}
/** Every index in identifier terms, lists sorted where their order is free. */
function indexDump(s: State): string[] {
  const T = dataOf(s).tables, I = dataOf(s).index, nid = (r: number) => T.nodes.rows.ids[r], pid = (r: number) => T.plans.rows.ids[r];
  const out: string[] = [];
  for (let n = 0; n < T.nodes.rows.end; n++) {
    if (T.nodes.rows.ids[n] === '') continue;
    out.push(`memberOf ${nid(n)} ${Array.from(memberOf(s, n), (c) => T.conns.rows.ids[c]).sort()}`, `placedIn ${nid(n)} ${Array.from(placedIn(s, n), pid).sort()}`);
  }
  I.groupOf.forEach((pg, p) => { if (pg) pg.group.forEach((g, n) => { if (g >= 0) out.push(`groupOf ${pid(p)} ${nid(n)} ${nid(g)} ${pg.multi.get(n)?.map(nid) ?? ''}`); }); });
  I.groupMembers.forEach((gm, p) => { for (const [g, ms] of gm ?? []) if (ms.length > 0) out.push(`groupMembers ${pid(p)} ${nid(g)} ${ms.map(nid).sort()}`); });
  for (const [c, ids] of I.phantomsOf) out.push(`phantomsOf ${c} ${[...ids].sort()}`);
  for (const [g, ids] of I.phantomsIn) out.push(`phantomsIn ${g} ${[...ids].sort()}`);
  out.push(`structures ${[...I.structures].map((c) => T.conns.rows.ids[c]).sort()}`);
  for (const [key, ids] of I.tagged) out.push(`tagged ${key} ${[...ids].sort()}`);
  return out.sort();
}

/** Round trip: the decoded state equals the oracle record for record, row for row, index for index. */
function roundTrip(s: State, o: oracle.State): State {
  const buf = encodeState(s);
  expect(buf.byteLength % 8).toBe(0);
  expect(snapshotVersion(buf)).toBe(SNAPSHOT_VERSION);
  const d = decodeState(buf);
  expect(view(d)).toEqual(view(o));
  expect(rows(d)).toEqual(rows(s));
  expect(indexDump(d)).toEqual(indexDump(s));
  return d;
}

/** The base of test (plan 2), as the store's tables give it, and its oracle replayed from the journal. */
function fixture(): { s: State; o: oracle.State } {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-codec-'));
  const store = LocalStore.open(dir, { pc: 'codec' });
  try {
    buildFixture(store, dir);
    const s = store.loadState(), o = oracle.emptyState();
    for (const row of store.changesSince(0)) oracle.applyOp(o, row.op);
    return { s, o };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('aller-retour sur la base de test : égal à l’oracle rejoué depuis le journal', () => {
  const { s, o } = fixture();
  expect(view(s)).toEqual(view(o));
  roundTrip(s, o);
});

test('aller-retour sur une grande base de 2 000 nœuds, puis des commandes sur l’état décodé comme sur l’oracle', () => {
  const { state: s, lobby } = buildLargeState({ seed: 1, nodes: 2000, connections: 20_000 });
  const o = oracleOf(s);
  const d = roundTrip(s, o);
  // Views on the buffer, pools packed: they grow, shrink and recycle rows as the original's.
  const ids = [...d.nodes.keys()], r = rng(5);
  const both = (ops: Op[]) => { applyOps(d, ops); for (const op of ops) oracle.applyOp(o, op); };
  for (let i = 0; i < 20; i++) {
    const a = ids[Math.floor(r() * ids.length)], b = ids[Math.floor(r() * ids.length)];
    both(connect(d, { plan: lobby, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] }).ops);
    both(moveNodes(d, lobby, [{ node: a, x: i, y: -i }]).ops);
  }
  both(deleteEverywhere(d, ids[7]).ops);
  both(createNode(d, { plan: lobby, title: 'après', x: 0, y: 0, k: 0 }).ops);
  expect(view(d)).toEqual(view(o));
}, 60_000);

/** Records the columns and the string table must carry exactly, and rows freed, held without a record or recycled. */
function oddities(): { s: State; o: oracle.State } {
  const s = emptyState(), o = oracle.emptyState();
  const run = (op: Op) => { applyOp(s, op); oracle.applyOp(o, op); };
  const node = (id: Id, extra: Partial<NodeRec> = {}): NodeRec => ({ id, title: id, summary: '', tags: [], files: [], ...extra });
  const conn = (id: Id, members: Id[], extra: Partial<ConnectionRec> = {}): ConnectionRec =>
    ({ id, kind: 'knowledge', title: '', relation: '', tags: [], members: members.map((n, i) => ({ node: n, role: i === 0 ? 'source' : 'target' })), ...extra });
  // The very first string starts with a byte order mark: the decoder must not eat it.
  run({ t: 'node', before: null, after: node('﻿bom') });
  for (const type of ['lobby', 'plan', 'document'] as const) run({ t: 'plan', before: null, after: { id: `p-${type}`, name: `Plan ${type} é`, type } });
  run({ t: 'node', before: null, after: node('n1', { title: 'Énoncé 🎓 « MDL »', summary: 'nul\0dedans', tags: [{ key: 'mot' }, { key: 'rang', value: 3.5 }, { key: 'auteur', value: 'Paul Vitányi' }] }) });
  run({ t: 'node', before: null, after: node('n2', { title: 'surrogat \uD800 seul', files: [{ name: 'a é.pdf', hash: 'h1', size: 12 }], trashedAt: 1234.5 }) });
  run({ t: 'node', before: null, after: { ...node('n3'), extra: { libre: true } } as NodeRec });
  run({ t: 'node', before: null, after: node('n4', { tags: [{ key: 'bizarre', value: 'x', note: 1 } as never] }) });
  run({ t: 'node', before: null, after: node('n5', { title: '' }) });
  run({ t: 'tagKey', before: null, after: { key: 'rang', type: 'enum', scope: 'both', multi: false, required: false, enumValues: [{ name: 'un', rank: 1 }] } });
  run({ t: 'connection', before: null, after: conn('c1', ['n1', 'n2'], { title: 'titre', relation: 'relation\0nulle', tags: [{ key: 'mot' }, { key: 'n', value: -0 }] }) });
  run({ t: 'connection', before: null, after: conn('c2', ['n2', 'n1', 'n3'], { kind: 'inclusion', trashedAt: 99 }) });
  run({ t: 'connection', before: null, after: conn('c3', ['n1', 'ghost'], { tags: [{ key: 'k', value: 1, extra: 2 } as never] }) });
  for (const [p, c, n] of [['p-plan', 'c1', 'n1'], ['p-plan', 'c1', 'n2'], ['p-lobby', 'c2', 'n2'], ['p-lobby', 'c2', 'n3'], ['p-plan', 'cx', 'n5'], ['p-gone', 'c3', 'n1']]) {
    run({ t: 'branch', key: { plan: p, connection: c, node: n }, before: false, after: true });
  }
  for (const [p, n, x] of [['p-plan', 'n1', 1.25], ['p-plan', 'n2', -3], ['p-lobby', 'n1', 7], ['p-gone', 'n5', 0]] as const) {
    run({ t: 'placement', before: null, after: { plan: p, node: n, x, y: x / 3, k: 1 } });
  }
  run({ t: 'placement', before: null, after: { plan: 'p-document', node: 'n2', x: 0, y: 0, k: 0, note: 'à part' } as never });
  const ph = (id: Id, extra: Partial<PhantomRec> = {}): PhantomRec => ({ id, plan: 'p-plan', connection: 'c1', of: { kind: 'node', node: 'n2' }, x: 1, y: 2, k: 0, ...extra });
  run({ t: 'phantom', before: null, after: ph('f1') });
  run({ t: 'phantom', before: null, after: ph('f2', { of: { kind: 'center', node: 'n2' }, group: 'n1' }) });
  run({ t: 'phantom', before: null, after: ph('f3', { connection: 'disparue', plan: 'p-ailleurs', of: { kind: 'absent', node: 'personne' } }) });
  run({ t: 'phantom', before: null, after: { ...ph('f4'), extra: [1] } as PhantomRec });
  run({ t: 'connLayout', before: null, after: { plan: 'p-plan', connection: 'c1', marker: { x: 1, y: 2 }, angle: 0.5, handles: { n1: { b1: { x: 0, y: 1 }, b2: { x: 2, y: 3 } } } } });
  // Rows freed in every table (and one recycled), a connection row held by a branch only, a node row held by a member only.
  run({ t: 'node', before: null, after: node('gone1') });
  run({ t: 'node', before: null, after: node('gone2') });
  run({ t: 'node', before: s.nodes.get('gone1')!, after: null });
  run({ t: 'node', before: s.nodes.get('gone2')!, after: null });
  run({ t: 'node', before: null, after: node('recycled') });
  run({ t: 'plan', before: null, after: { id: 'p-temp', name: 'Temp', type: 'plan' } });
  run({ t: 'plan', before: s.plans.get('p-temp')!, after: null });
  run({ t: 'connection', before: null, after: conn('c-temp', ['n1']) });
  run({ t: 'connection', before: s.connections.get('c-temp')!, after: null });
  expect(dataOf(s).tables.nodes.rows.free.length).toBe(1);
  return { s, o };
}

test('aller-retour exact des cas limites : textes (\\0, surrogat seul, marque d’ordre), enregistrements irréguliers, rangées libres ou sans enregistrement', () => {
  const { s, o } = oddities();
  const d = roundTrip(s, o);
  // A free row is recycled as in the original (last in, first out).
  for (const st of [s, d]) applyOp(st, { t: 'node', before: null, after: { id: 'neuf', title: '', summary: '', tags: [], files: [] } });
  expect(rows(d)).toEqual(rows(s));
  expect(d.nodes.get('n1')!.summary).toBe('nul\0dedans');
  expect(d.nodes.get('n2')!.title).toBe('surrogat \uD800 seul');
  expect(d.nodes.has('﻿bom')).toBe(true);
});

test('un état vide fait l’aller-retour', () => {
  const d = decodeState(encodeState(emptyState()));
  expect(view(d)).toEqual(view(oracle.emptyState()));
});

test('internement : sur 1 000 références tirées au hasard, members[i].node et nodes.get(id).id sont la même chaîne', () => {
  const [a, b] = 'x'.repeat(30).concat('|', 'x'.repeat(30)).split('|');
  expect([sameHeapObject(a, a), a === b, sameHeapObject(a, b)]).toEqual([true, true, false]);
  const d = decodeState(encodeState(buildLargeState({ seed: 1, nodes: 2000, connections: 20_000 }).state));
  const conns = [...d.connections.values()], r = rng(9);
  let checked = 0;
  for (let i = 0; i < 1000; i++) {
    const c = conns[Math.floor(r() * conns.length)], m = c.members[Math.floor(r() * c.members.length)];
    expect(sameHeapObject(m.node, d.nodes.get(m.node)!.id)).toBe(true);
    checked++;
  }
  expect(checked).toBe(1000);
}, 60_000);

test('un instantané endommagé, tronqué ou d’une autre version est refusé (SnapshotError), jamais lu à moitié', () => {
  const { s } = oddities();
  const buf = encodeState(s);
  expect(() => decodeState(buf.slice(0))).not.toThrow();
  // A byte changed anywhere after the header: in the directory, the columns, the strings, the JSON.
  for (const at of [40, 300, Math.floor(buf.byteLength / 2), buf.byteLength - 20]) {
    const bad = buf.slice(0);
    new Uint8Array(bad)[at] ^= 0x10;
    expect(() => decodeState(bad), `octet ${at}`).toThrow(SnapshotError);
  }
  expect(() => decodeState(buf.slice(0, buf.byteLength - 8))).toThrow(SnapshotError);
  const other = buf.slice(0);
  new Uint32Array(other, 0, 2)[1] = SNAPSHOT_VERSION + 1;
  expect(snapshotVersion(other)).toBe(SNAPSHOT_VERSION + 1);
  expect(() => decodeState(other)).toThrow(SnapshotError);
  for (const junk of [new ArrayBuffer(0), new ArrayBuffer(64), new TextEncoder().encode('{"nodes":[]}').buffer as ArrayBuffer]) {
    expect(() => decodeState(junk)).toThrow(SnapshotError);
  }
});
