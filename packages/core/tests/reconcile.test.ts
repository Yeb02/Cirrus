import { afterEach, expect, test, vi } from 'vitest';
import {
  type Action, addedViolation, CommandError, connect, createNode, createPlan, deleteEverywhere, editNode, exclude, include, moveNodes, placeNode,
  removeFromPlan, setRole,
} from '../src/commands.ts';
import { uuidv7 } from '../src/ids.ts';
import { checkState, groupOf } from '../src/invariants.ts';
import type { Id, Role, TagValue } from '../src/model.ts';
import { invertOp, type Op } from '../src/ops.ts';
import { fromSnapshot, toSnapshot } from '../src/snapshot.ts';
import { applyOp, applyOps, canonical, emptyState, OpConflictError, type State } from '../src/state.ts';
import { parseRemoteUnit, parseUnit, reconcile, type RemoteUnit, SyncDivergedError, type Unit } from '../src/sync.ts';

afterEach(() => { vi.restoreAllMocks(); });

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const created = (a: Action, t: 'node' | 'connection' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
/** Through JSON, as on the network. */
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** A state's content, each list sorted: equal states, whatever the order their rows were made in. */
const image = (s: State): string => canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));
const copy = (s: State): State => fromSnapshot(wire(toSnapshot(s)));
const unitOf = (a: Action, pc: string, at: number): Unit => ({ unit: uuidv7(), action: a.id, label: a.label, at, pc, ops: a.ops });
/** The unit as the server relays it, numbered. */
const relayed = (u: Unit, seq: number): RemoteUnit => ({ ...wire(u), seq });

const T0 = Date.UTC(2026, 10, 8, 9);

/** Plan P; X, G and H placed in it. */
function world() {
  const s = emptyState();
  const P = created(run(s, createPlan(s, 'P', 'plan')), 'plan');
  const mk = (title: string, x: number) => created(run(s, createNode(s, { plan: P, title, x, y: 0, k: 0 })), 'node');
  return { s, P, X: mk('X', 0), G: mk('G', 100), H: mk('H', 200) };
}

test('addedViolation : la violation que des opérations appliquées ajoutent ; une déjà là n’est pas leur fait ; l’état garde les opérations', () => {
  const { s, P, X, G, H } = world();
  run(s, include(s, P, X, G));
  const ops: Op[] = [
    { t: 'connection', before: null, after: { id: 'c2', kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: X, role: 'source' }, { node: H, role: 'target' }] } },
    { t: 'branch', key: { plan: P, connection: 'c2', node: X }, before: false, after: true },
    { t: 'branch', key: { plan: P, connection: 'c2', node: H }, before: false, after: true },
  ];
  applyOps(s, ops);
  expect(addedViolation(s, ops)).toEqual(expect.objectContaining({ code: 'twoGroups', subject: X }));
  expect(s.connections.has('c2')).toBe(true);
  const rename: Op[] = [{ t: 'node', before: s.nodes.get(X)!, after: { ...s.nodes.get(X)!, title: 'X2' } }];
  applyOps(s, rename);
  expect(addedViolation(s, rename)).toBeNull();
  expect(s.nodes.get(X)!.title).toBe('X2');
});

test('reconcile : une écriture reçue qui est la première en attente, aux mêmes opérations, est un accusé de réception : rien à défaire', () => {
  const { s, X } = world();
  const server = copy(s);
  const u = unitOf(run(s, editNode(s, X, { title: 'X2' })), 'pc-a', T0);
  applyOps(server, wire(u).ops);
  const before = image(s);
  const r = reconcile(s, [u], [relayed(u, 4)], []);
  expect(r).toEqual({ rewind: [], remote: [relayed(u, 4)], rebased: [], dropped: [], acked: [u.unit], notices: [] });
  expect(image(s)).toBe(before);
  expect(image(s)).toBe(image(server));
});

test('reconcile : accusée, la première ; la suivante reste en attente telle quelle, sans rien défaire', () => {
  const { s, X, G } = world();
  const u1 = unitOf(run(s, editNode(s, X, { title: 'X2' })), 'pc-a', T0);
  const u2 = unitOf(run(s, editNode(s, G, { title: 'G2' })), 'pc-a', T0 + 1);
  const r = reconcile(s, [u1, u2], [relayed(u1, 1)], []);
  expect([r.acked, r.rewind, r.dropped]).toEqual([[u1.unit], [], []]);
  expect(r.rebased[0]).toBe(u2);
});

test('reconcile : une écriture en retard est défaite, les reçues appliquées, puis elle est rejouée par-dessus, fusionnée', () => {
  const { s, X } = world();
  const server = copy(s);
  const u = unitOf(run(s, editNode(s, X, { title: 'X2' })), 'pc-a', T0 + 1);
  const theirs = unitOf(run(server, editNode(server, X, { summary: 'vu ailleurs' })), 'pc-b', T0);
  const r = reconcile(s, [u], [relayed(theirs, 1)], []);
  expect(r.acked).toEqual([]);
  expect(r.rewind).toEqual([...u.ops].reverse().map(invertOp));
  expect(r.remote).toEqual([relayed(theirs, 1)]);
  expect(r.rebased).toEqual([expect.objectContaining({ unit: u.unit, action: u.action, label: u.label, at: u.at, pc: u.pc })]);
  expect(r.rebased[0].ops[0].before).toEqual(expect.objectContaining({ title: 'X', summary: 'vu ailleurs' }));
  expect([s.nodes.get(X)!.title, s.nodes.get(X)!.summary]).toEqual(['X2', 'vu ailleurs']);
  // The server takes the replayed write as it comes: it then holds what the PC holds.
  applyOps(server, wire(r.rebased[0]).ops);
  expect(image(s)).toBe(image(server));
});

test('reconcile : mon écriture acceptée après celle d’un autre PC arrive derrière elle : défaite, puis reçue, plus en attente', () => {
  const { s, X, H } = world();
  const server = copy(s);
  const u = unitOf(run(s, editNode(s, X, { title: 'X2' })), 'pc-a', T0 + 1);
  const theirs = unitOf(run(server, editNode(server, H, { title: 'H2' })), 'pc-b', T0);
  applyOps(server, wire(u).ops);
  const r = reconcile(s, [u], [relayed(theirs, 1), relayed(u, 2)], []);
  expect([r.acked, r.rebased, r.dropped]).toEqual([[], [], []]);
  expect(r.rewind).toHaveLength(1);
  expect(image(s)).toBe(image(server));
});

test('reconcile : une écriture refusée par le serveur est écartée avec son message ; la suivante est rejouée sans elle', () => {
  const { s, P, X, G } = world();
  const inc = unitOf(run(s, include(s, P, X, G)), 'pc-a', T0);
  const ren = unitOf(run(s, editNode(s, X, { title: 'X2' })), 'pc-a', T0 + 1);
  const r = reconcile(s, [inc, ren], [], [{ unit: inc.unit, message: 'Ce nœud est déjà dans un groupe de ce plan.' }]);
  expect(r.dropped).toEqual([{ unit: inc, message: '« Mettre « X » dans « G » » écartée : Ce nœud est déjà dans un groupe de ce plan.' }]);
  expect(r.rebased).toHaveLength(1);
  expect(r.rebased[0]).toBe(ren);
  expect(groupOf(s, P, X)).toBeUndefined();
  expect(s.nodes.get(X)!.title).toBe('X2');
});

test('reconcile : deux inclusions du même nœud dans deux groupes du même plan : la seconde est écartée, et la notification la nomme', () => {
  const { s, P, X, G, H } = world();
  const server = copy(s);
  const mine = unitOf(run(s, include(s, P, X, G)), 'pc-a', T0 + 1);
  const theirs = unitOf(run(server, include(server, P, X, H)), 'pc-b', T0);
  const r = reconcile(s, [mine], [relayed(theirs, theirs.ops.length)], []);
  expect(r.dropped).toEqual([{ unit: mine, message: '« Mettre « X » dans « G » » écartée : « X » est déjà dans le groupe « H », depuis un autre PC.' }]);
  expect(r.rebased).toEqual([]);
  expect(groupOf(s, P, X)).toBe(H);
  expect(checkState(s)).toEqual([]);
  expect(image(s)).toBe(image(server));
});

test('reconcile : une opération reçue qui ne s’applique pas lève SyncDivergedError, et l’état reste intact', () => {
  const { s, X, H } = world();
  const u = unitOf(run(s, editNode(s, X, { title: 'X2' })), 'pc-a', T0);
  const h = s.nodes.get(H)!;
  const good: RemoteUnit = { unit: 'r1', action: 'a1', label: 'l', at: T0, pc: 'pc-b', seq: 1, ops: [{ t: 'node', before: h, after: { ...h, title: 'H2' } }] };
  const bogus: RemoteUnit = { unit: 'r2', action: 'a2', label: 'l', at: T0, pc: 'pc-b', seq: 2, ops: [{ t: 'node', before: { ...h, title: 'jamais vu' }, after: { ...h, title: 'Y' } }] };
  const before = image(s);
  expect(() => reconcile(s, [u], [good, bogus], [])).toThrow(SyncDivergedError);
  expect(image(s)).toBe(before);
  expect(() => reconcile(s, [], [good, bogus], [])).toThrow(/ne suit plus/);
  expect(image(s)).toBe(before);
});

/** « AAAA-MM-JJ HHhMM » in this PC's local time, as a conflict copy's name gives it (R4). */
const stamp = (at: number) => {
  const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
};
const MIN = 60_000;

/**
 * Node N with note.tex (version 0) in plan P, on a PC and on the server; the PC saves note.tex at each given time
 * (versions 1, 2, 3…, one action, one write each: plan 4b, D5), the server takes version b from another PC at `theirsAt`.
 */
function texSaves(saves: number[], theirsAt: number) {
  const s = emptyState();
  const P = created(run(s, createPlan(s, 'P', 'plan')), 'plan'), N = created(run(s, createNode(s, { plan: P, title: 'N', x: 0, y: 0, k: 0 })), 'node');
  const tex = (h: string) => ({ name: 'note.tex', hash: h.repeat(64), size: 1 });
  run(s, editNode(s, N, { files: [tex('0')] }));
  const server = copy(s);
  let action: Id | undefined;
  const pending = saves.map((at, i) => {
    const a = run(s, editNode(s, N, { files: [tex(String(i + 1))] }));
    action ??= a.id;
    return { ...unitOf(a, 'pc-a', at), action };
  });
  const theirs = unitOf(run(server, editNode(server, N, { files: [tex('b')] })), 'pc-b', theirsAt);
  const files = (x: State) => x.nodes.get(N)!.files.map((f) => `${f.name}=${f.hash[0]}`);
  return { s, server, N, pending, theirs, tex, files };
}

test.each([
  { name: 'le leur plus récent que tous : il garde le nom, la copie tient ma dernière version, datée de mon dernier enregistrement', theirsAt: 10 * MIN, kept: 'b', copy: '3', copyAt: 2 * MIN },
  { name: 'le leur entre deux de mes enregistrements : mon dernier gagne, la copie tient la sienne, datée de son écriture', theirsAt: 1.5 * MIN, kept: '3', copy: 'b', copyAt: 1.5 * MIN },
  { name: 'le leur plus ancien que tous : ma dernière version garde le nom, la copie tient la sienne', theirsAt: -60 * MIN, kept: '3', copy: 'b', copyAt: -60 * MIN },
])('reconcile : plusieurs enregistrements en attente du même .tex contre un changement reçu, $name — une seule copie, une seule notification', ({ theirsAt, kept, copy: held, copyAt }) => {
  const T = Date.UTC(2026, 10, 8, 9);
  const { s, server, pending, theirs, files } = texSaves([T, T + MIN, T + 2 * MIN], T + theirsAt);
  const r = reconcile(s, pending, [relayed(theirs, 1)], []);
  const name = `note (conflit du ${stamp(T + copyAt)}).tex`;
  expect(files(s)).toEqual([`note.tex=${kept}`, `${name}=${held}`]);
  expect(r.notices).toEqual([`Un .tex a été modifié sur deux PC : l’autre version est gardée sous « ${name} ».`]);
  expect(r.dropped).toEqual([]);
  // The server takes the replayed writes as they come: it then holds what the PC holds.
  for (const u of r.rebased) applyOps(server, wire(u).ops);
  expect(image(s)).toBe(image(server));
});

test.each([
  { name: 'le leur plus récent', theirsAt: MIN, kept: 'b', copy: 'a', copyAt: 0 },
  { name: 'le mien plus récent', theirsAt: -MIN, kept: 'a', copy: 'b', copyAt: -MIN },
])('reconcile : un même .tex ajouté sur deux PC, deux contenus ($name) : les deux versions restent, une notification', ({ theirsAt, kept, copy: held, copyAt }) => {
  const T = Date.UTC(2026, 10, 8, 9);
  const { s, X } = world();
  const server = copy(s);
  const tex = (h: string) => [{ name: 'note.tex', hash: h.repeat(64), size: 1 }];
  const mine = unitOf(run(s, editNode(s, X, { files: tex('a') })), 'pc-a', T);
  const theirs = unitOf(run(server, editNode(server, X, { files: tex('b') })), 'pc-b', T + theirsAt);
  const r = reconcile(s, [mine], [relayed(theirs, 1)], []);
  const name = `note (conflit du ${stamp(T + copyAt)}).tex`;
  expect(s.nodes.get(X)!.files.map((f) => `${f.name}=${f.hash[0]}`)).toEqual([`note.tex=${kept}`, `${name}=${held}`]);
  expect(r.notices).toEqual([`Un .tex a été modifié sur deux PC : l’autre version est gardée sous « ${name} ».`]);
  for (const u of r.rebased) applyOps(server, wire(u).ops);
  expect(image(s)).toBe(image(server));
});

test.each([
  { name: 'ma version avait gagné, la leur change encore, plus récente : une seule copie, la mienne', secondAt: 30 * MIN, kept: 'c', copy: '1', copyAt: 0 },
  { name: 'ma version avait gagné, la leur change encore, plus ancienne : une seule copie, leur dernière', secondAt: -30 * MIN, kept: '1', copy: 'c', copyAt: -30 * MIN },
  { name: 'la leur avait gagné, elle change encore : la copie de la mienne reste seule', secondAt: 30 * MIN, firstAt: 10 * MIN, kept: 'c', copy: '1', copyAt: 0 },
])('reconcile : une écriture qui porte déjà une copie de conflit, rejouée sur un nouveau changement du .tex — $name', ({ secondAt, firstAt, kept, copy: held, copyAt }) => {
  const T = Date.UTC(2026, 10, 8, 9);
  const { s, server, N, pending, theirs, tex, files } = texSaves([T], T + (firstAt ?? -60 * MIN));
  const first = reconcile(s, pending, [relayed(theirs, 1)], []);
  expect(first.notices).toHaveLength(1);
  // Before the replayed write reaches the server, another change of the .tex arrives.
  const again = unitOf(run(server, editNode(server, N, { files: [tex('c')] })), 'pc-b', T + secondAt);
  const second = reconcile(s, first.rebased, [relayed(again, 2)], []);
  const name = `note (conflit du ${stamp(T + copyAt)}).tex`;
  expect(files(s)).toEqual([`note.tex=${kept}`, `${name}=${held}`]);
  expect(second.notices).toEqual(firstAt === undefined ? [`Un .tex a été modifié sur deux PC : l’autre version est gardée sous « ${name} ».`] : []);
  for (const u of second.rebased) applyOps(server, wire(u).ops);
  expect(image(s)).toBe(image(server));
});

// ---------------------------------------------------------------------------------------------------------------------
// The simulation (the test that counts): an in-memory sequencer applying the server's rules (D1), three virtual PCs,
// random commands, deliveries delayed and interleaved at random; at rest, the four states are equal and valid.

/** Mulberry32: a small seeded generator, the same run every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Result = { accepted: number } | { stale: number } | { refused: string };

/** The server's acceptance (D1, task 2's Canon.accept), on its state alone: shape, "befores", rules; numbered and relayed. */
class Sequencer {
  readonly s: State;
  seq = 0;
  readonly journal: RemoteUnit[] = [];
  private readonly known = new Map<Id, number>();

  constructor(s: State) { this.s = s; }

  /** POST /units: in order; after the first one not accepted, the rest are stale. */
  post(units: unknown[]): Result[] {
    const out: Result[] = [];
    for (const u of units) out.push(out.some((r) => !('accepted' in r)) ? { stale: this.seq } : this.accept(u));
    return out;
  }

  private accept(x: unknown): Result {
    const u = parseUnit(x);
    const known = this.known.get(u.unit);
    if (known !== undefined) return { accepted: known };
    try {
      applyOps(this.s, u.ops);
    } catch (e) {
      if (e instanceof OpConflictError) return { stale: this.seq };
      throw e;
    }
    const v = addedViolation(this.s, u.ops);
    if (v) {
      applyOps(this.s, [...u.ops].reverse().map(invertOp));
      return { refused: v.message };
    }
    this.seq += u.ops.length;
    this.journal.push({ ...u, seq: this.seq });
    this.known.set(u.unit, this.seq);
    return { accepted: this.seq };
  }
}

interface Pc {
  name: string;
  s: State;
  pending: Unit[];
  /** Units of the journal received (index of the next one), and the number of the last one. */
  next: number;
  seq: number;
  /** A request sent, then its answer once the server has processed it. */
  inflight: { units: unknown[]; results: Result[] | null } | null;
  /** After a stale answer: the number to have received before sending again. */
  waitFor: number;
  refused: { unit: Id; message: string }[];
}

test('simulation : trois PC et un séquenceur, 2 000 commandes au hasard, livraisons retardées et mêlées : au repos, quatre états égaux et valides', () => {
  const rand = mulberry32(20261108), ids = mulberry32(5);
  let now = T0;
  // Identifiers and times drawn from the seeds: the same run every time.
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
    const bytes = new Uint8Array(a!.buffer, a!.byteOffset, a!.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(ids() * 256);
    return a;
  });
  const pick = <T>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new CommandError('rien à choisir');
    return xs[Math.floor(rand() * xs.length)];
  };

  // The base every PC and the server start from.
  const s0 = emptyState();
  const P1 = created(run(s0, createPlan(s0, 'Un', 'plan')), 'plan'), P2 = created(run(s0, createPlan(s0, 'Deux', 'plan')), 'plan');
  applyOp(s0, { t: 'tagKey', before: null, after: { key: 'statut', type: 'text', scope: 'both', multi: false, required: false } });
  const first: Id[] = [];
  for (let i = 0; i < 8; i++) first.push(created(run(s0, createNode(s0, { plan: P1, title: `n${i}`, x: i * 50, y: 0, k: 0 })), 'node'));
  for (const n of first.slice(0, 3)) run(s0, placeNode(s0, P2, n, 0, 0, 0));
  run(s0, connect(s0, { plan: P1, members: [{ node: first[0], role: 'source' }, { node: first[1], role: 'target' }] }));
  const server = new Sequencer(copy(s0));
  const pcs: Pc[] = ['pc-a', 'pc-b', 'pc-c'].map((name) => ({ name, s: copy(s0), pending: [], next: 0, seq: 0, inflight: null, waitFor: 0, refused: [] }));

  const stats = { commands: 0, writes: 0, refusedCommands: 0, reconciliations: 0, acked: 0, rebased: 0, rewritten: 0, dropped: 0, stale: 0, notices: 0 };
  const WORDS = ['MDL', 'Kolmogorov', 'Solomonoff', 'Bayes', 'Occam', 'Shannon'];
  const TAGS: TagValue[] = [{ key: 'lu' }, { key: 'important' }, { key: 'auteur', value: 'Li' }, { key: 'auteur', value: 'Vitányi' }];
  const ROLES: Role[] = ['source', 'target', 'associate'];

  /** One command drawn at random, often on the same few nodes (the oldest ones), so that the PCs' writes collide. */
  function command(s: State): Action {
    const plan = rand() < 0.6 ? P1 : P2;
    const live = [...s.nodes.values()].filter((n) => n.trashedAt === undefined).map((n) => n.id);
    const placed = [...s.placements.values()].filter((p) => p.plan === plan).map((p) => p.node);
    const hot = (xs: Id[]) => (rand() < 0.7 ? [...xs].sort().slice(0, 6) : xs);
    const r = rand() * 24;
    if (r < 3) return createNode(s, { plan, title: pick(WORDS), x: Math.round(rand() * 1000), y: Math.round(rand() * 1000), k: 0 });
    if (r < 6) return editNode(s, pick(hot([...s.nodes.keys()])), { title: `${pick(WORDS)} ${Math.floor(rand() * 100)}` });
    if (r < 9) {
      const n = s.nodes.get(pick(hot([...s.nodes.keys()])))!;
      let tags: TagValue[];
      if (rand() < 0.3) tags = [...n.tags.filter((t) => t.key !== 'statut'), { key: 'statut', value: pick(['brouillon', 'relu', 'publié']) }];
      else {
        const t = pick(TAGS), has = n.tags.some((x) => canonical(x) === canonical(t));
        tags = has ? n.tags.filter((x) => canonical(x) !== canonical(t)) : [...n.tags, t];
      }
      return editNode(s, n.id, { tags });
    }
    if (r < 12) return moveNodes(s, plan, [{ node: pick(hot(placed)), x: Math.round(rand() * 1000), y: Math.round(rand() * 1000) }]);
    if (r < 14.5) return include(s, plan, pick(hot(placed)), pick(hot(placed)));
    if (r < 15.5) return exclude(s, plan, pick(hot(placed)));
    if (r < 16.5) return rand() < 0.5 ? removeFromPlan(s, plan, pick(hot(placed))) : deleteEverywhere(s, pick(hot(live)));
    if (r < 18.5) {
      const a = pick(hot(live)), b = pick(live);
      if (a === b) throw new CommandError('un seul nœud');
      return connect(s, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] });
    }
    if (r < 20.5) {
      const c = s.connections.get(pick(hot([...s.connections.keys()])))!;
      return setRole(s, c.id, pick(c.members).node, pick(ROLES));
    }
    if (r >= 22) {
      // An autosave of a node's .tex (plan 4b): each one a write of its own, often of the same file on several PCs.
      const n = s.nodes.get(pick(hot([...s.nodes.keys()])))!, hash = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
      return editNode(s, n.id, { files: [...n.files.filter((f) => f.name !== 'note.tex'), { name: 'note.tex', hash, size: 1 }] });
    }
    const other = plan === P1 ? P2 : P1;
    return placeNode(s, other, pick(hot(live)), Math.round(rand() * 1000), 0, 0);
  }

  function act(pc: Pc): void {
    stats.commands++;
    let a: Action;
    try {
      a = command(pc.s);
    } catch (e) {
      if (e instanceof CommandError) { stats.refusedCommands++; return; }
      throw e;
    }
    if (a.ops.length === 0) return;
    applyOps(pc.s, a.ops);
    // Coarse times: ties happen, and the PC identifier settles them.
    pc.pending.push(unitOf(a, pc.name, Math.floor(now / 50) * 50));
    stats.writes++;
  }

  function sync(pc: Pc, incoming: RemoteUnit[]): void {
    const r = reconcile(pc.s, pc.pending, incoming, pc.refused);
    stats.reconciliations++;
    stats.acked += r.acked.length;
    stats.dropped += r.dropped.length;
    stats.notices += r.notices.length;
    if (r.rewind.length > 0) {
      stats.rebased += r.rebased.length;
      const before = new Map(pc.pending.map((u) => [u.unit, u]));
      stats.rewritten += r.rebased.filter((u) => before.get(u.unit) !== u).length;
    }
    pc.pending = r.rebased;
    pc.refused = [];
    if (incoming.length > 0) pc.seq = incoming[incoming.length - 1].seq;
  }

  for (let step = 0; ; step++) {
    if (step > 400_000) throw new Error('pas de repos');
    now += 1 + Math.floor(rand() * 30);
    const choices: (() => void)[] = [];
    for (const pc of pcs) {
      if (stats.commands < 2000) choices.push(() => act(pc));
      // As the client does (task 3): what is pending goes as soon as nothing is in flight, at most syncBatchUnits (50).
      if (!pc.inflight && pc.pending.length > 0 && pc.seq >= pc.waitFor) choices.push(() => { pc.inflight = { units: wire(pc.pending.slice(0, 50)), results: null }; });
      const inflight = pc.inflight;
      if (inflight && !inflight.results) choices.push(() => { inflight.results = server.post(inflight.units); });
      if (inflight?.results) {
        choices.push(() => {
          inflight.results!.forEach((res, i) => {
            if ('refused' in res) pc.refused.push({ unit: (inflight.units[i] as Unit).unit, message: res.refused });
            if ('stale' in res) { pc.waitFor = Math.max(pc.waitFor, res.stale); stats.stale++; }
          });
          pc.inflight = null;
          if (pc.refused.length > 0) sync(pc, []);
        });
      }
      if (pc.next < server.journal.length) {
        choices.push(() => {
          const batch = server.journal.slice(pc.next, pc.next + 1 + Math.floor(rand() * 3)).map((u) => parseRemoteUnit(wire(u)));
          pc.next += batch.length;
          sync(pc, batch);
        });
      }
    }
    if (choices.length === 0) break;
    pick(choices)();
  }

  for (const pc of pcs) {
    expect(pc.pending, pc.name).toEqual([]);
    expect(pc.seq, pc.name).toBe(server.seq);
    expect(image(pc.s), pc.name).toBe(image(server.s));
    expect(checkState(pc.s), pc.name).toEqual([]);
  }
  expect(checkState(server.s)).toEqual([]);
  // The run did collide: writes were replayed, rewritten and dropped, not only acknowledged.
  expect(stats.writes).toBeGreaterThan(1000);
  expect(stats.rewritten).toBeGreaterThan(0);
  expect(stats.dropped).toBeGreaterThan(0);
  expect(stats.stale).toBeGreaterThan(0);
  // The same .tex saved on two PCs at once: conflict copies were made.
  expect(stats.notices).toBeGreaterThan(0);
}, 60_000);
