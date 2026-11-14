import { afterEach, expect, test, vi } from 'vitest';
import {
  type Action, addMember, CommandError, connect, createAnnotation, createNode, createPlan, deleteConnection, deleteEverywhere, editConnection, placeAbsent, placeNode,
  removeFromPlan, removeMember, RESTORE_CONNECTION_LOST, restoreConnection, restoreNode, setBranches, setRole, splitArm,
} from '../src/commands.ts';
import { checkState } from '../src/invariants.ts';
import type { Anchor, Id, PlanType } from '../src/model.ts';
import { applyOps, emptyState, placementKey, type State } from '../src/state.ts';
import { created, rng } from './helpers.ts';
import { crossed, image, informed } from './twoPcs.ts';

// Plan 6b, D2: a knowledge connection of a single member; a node on its way to the trash (deleted everywhere, or out of
// its last plan) leaves its connections, and a live one left with no node, or with one, goes to the trash with it.

afterEach(() => { vi.restoreAllMocks(); });

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const T0 = Date.UTC(2026, 10, 14, 9);
/** The command run at time `at` (its trashedAt). */
const at = <T>(t: number, fn: () => T): T => {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(t);
  try { return fn(); } finally { spy.mockRestore(); }
};
const branchesOf = (s: State, c: Id) => [...s.branches].filter((b) => b.connection === c).map((b) => `${b.plan}|${b.node}`).sort();
const membersOf = (s: State, c: Id) => s.connections.get(c)!.members.map((m) => m.node);
const phantomsOf = (s: State, node: Id) => [...s.phantoms.values()].filter((p) => p.of.node === node);

function world(plans: [string, PlanType][] = [['P', 'plan'], ['Q', 'plan'], ['D', 'document']]) {
  const s = emptyState();
  const plan: Record<string, Id> = {};
  for (const [name, type] of plans) plan[name] = created(run(s, createPlan(s, name, type)), 'plan');
  let x = 0;
  /** A node placed in the plans given (the first one creates it). */
  const mk = (title: string, where: string[] = ['P']) => {
    const id = created(run(s, createNode(s, { plan: plan[where[0]], title, x: (x += 100), y: 0, k: 0 })), 'node');
    for (const p of where.slice(1)) run(s, placeNode(s, plan[p], id, x, 50, 0));
    return id;
  };
  /** A connection drawn in `where`, then shown in the plans `also` too. */
  const link = (where: string, nodes: Id[], also: string[] = []) => {
    const c = created(run(s, connect(s, { plan: plan[where], members: nodes.map((node, i) => ({ node, role: i === 0 ? 'source' : 'target' })) })), 'connection');
    for (const p of also) run(s, setBranches(s, c, nodes.map((node) => ({ plan: plan[p], node })), true));
    return c;
  };
  return { s, plan, mk, link };
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    return (e as Error).message;
  }
  throw new Error('la commande n’a pas été refusée');
}

const anchor = (pdf: Id): Anchor => ({ pdf, file: 'chapitre.pdf', hash: '0123456789abcdef'.repeat(4), page: 1, rects: [[72, 581, 300, 594.8]], text: 'Un passage' });

// ---------------------------------------------------------------------------------------------------------------------
// The rule

test('une connexion d’un seul membre se crée', () => {
  const { s, plan, mk } = world();
  const A = mk('A');
  const c = created(run(s, connect(s, { plan: plan.P, members: [{ node: A, role: 'source' }] })), 'connection');
  expect(s.connections.get(c)).toMatchObject({ kind: 'knowledge', members: [{ node: A, role: 'source' }] });
  expect(s.connections.get(c)!.trashedAt).toBeUndefined();
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${A}`]);
  expect(checkState(s)).toEqual([]);
});

test('une connexion sans membre est refusée', () => {
  const { s, plan } = world();
  expect(refusal(() => connect(s, { plan: plan.P, members: [] }))).toBe('Une connexion doit relier au moins un nœud.');
  // Written without a command: the rule names it.
  applyOps(s, [{ t: 'connection', before: null, after: { id: 'vide', kind: 'knowledge', title: '', relation: '', tags: [], members: [] } }]);
  expect(checkState(s)).toEqual([{ code: 'members', subject: 'vide', message: 'Une connexion doit relier au moins un nœud.' }]);
});

test('retirer l’avant-dernier membre garde la connexion', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A', ['P', 'Q']), B = mk('B', ['P', 'Q']);
  const c = link('P', [A, B], ['Q']);
  run(s, removeMember(s, c, B));
  expect(s.connections.get(c)!.trashedAt).toBeUndefined();
  expect(membersOf(s, c)).toEqual([A]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${A}`, `${plan.Q}|${A}`].sort());
  expect(checkState(s)).toEqual([]);
});

test('retirer le dernier membre la met à la corbeille', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A', ['P', 'Q']), B = mk('B');
  const c = link('P', [A, B], ['Q']);
  run(s, removeMember(s, c, B));
  run(s, removeMember(s, c, A));
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  // It keeps that member, for a restoration.
  expect(membersOf(s, c)).toEqual([A]);
  expect(branchesOf(s, c)).toEqual([]);
  expect(checkState(s)).toEqual([]);
  run(s, restoreConnection(s, c));
  expect(membersOf(s, c)).toEqual([A]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${A}`, `${plan.Q}|${A}`].sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// A node to the trash leaves its connections: « Supprimer partout », or out of its last plan (« Cacher », « Ici seulement »)

const departures = [
  { how: 'supprimer partout', go: (s: State, _plan: Record<string, Id>, X: Id) => deleteEverywhere(s, X) },
  { how: 'retirer de son dernier plan', go: (s: State, plan: Record<string, Id>, X: Id) => removeFromPlan(s, plan.P, X) },
] as const;

test.each(departures)('$how un nœud d’une connexion de deux la jette, sans lui, au moment où il part', ({ go }) => {
  const { s, plan, mk, link } = world();
  const X = mk('X'), Y = mk('Y', ['P', 'Q']);
  const c = link('P', [X, Y], ['Q']);
  // Its arm in P split: phantoms of X.
  run(s, splitArm(s, plan.P, c, X, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  at(T0, () => run(s, go(s, plan, X)));
  expect(s.nodes.get(X)!.trashedAt).toBe(T0);
  expect(s.connections.get(c)!.trashedAt).toBe(T0);
  expect(membersOf(s, c)).toEqual([Y]);
  expect(branchesOf(s, c)).toEqual([]);
  expect(phantomsOf(s, X)).toEqual([]);
  expect(checkState(s)).toEqual([]);
});

test.each(departures)('$how un nœud d’une connexion de trois la garde à deux', ({ go }) => {
  const { s, plan, mk, link } = world();
  const X = mk('X'), Y = mk('Y', ['P', 'Q']), Z = mk('Z', ['P', 'Q']);
  const c = link('P', [X, Y, Z], ['Q']);
  // In Q, X is absent: a stub put down by hand, an absent phantom.
  run(s, placeAbsent(s, plan.Q, c, X, 300, 40, 1));
  run(s, go(s, plan, X));
  expect(s.nodes.get(X)!.trashedAt).toBeDefined();
  expect(s.connections.get(c)!.trashedAt).toBeUndefined();
  expect(membersOf(s, c)).toEqual([Y, Z]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${Y}`, `${plan.P}|${Z}`, `${plan.Q}|${Y}`, `${plan.Q}|${Z}`].sort());
  expect(phantomsOf(s, X)).toEqual([]);
  expect(checkState(s)).toEqual([]);
});

test.each(departures)('$how un nœud d’une connexion d’un seul nœud la jette', ({ go }) => {
  const { s, plan, mk, link } = world();
  const X = mk('X');
  const c = link('P', [X]);
  run(s, go(s, plan, X));
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  expect(membersOf(s, c)).toEqual([]);
  expect(branchesOf(s, c)).toEqual([]);
  expect(checkState(s)).toEqual([]);
});

test('retirer un nœud d’un plan qui n’est pas son dernier ne touche pas ses connexions', () => {
  const { s, plan, mk, link } = world();
  const X = mk('X', ['P', 'Q']), Y = mk('Y');
  const c = link('P', [X, Y]);
  run(s, removeFromPlan(s, plan.P, X));
  expect(s.nodes.get(X)!.trashedAt).toBeUndefined();
  expect(membersOf(s, c)).toEqual([X, Y]);
  // Its branch stays, drawn as a stub.
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${X}`, `${plan.P}|${Y}`].sort());
});

test('une annotation qui quitte son dernier plan garde ses connexions', () => {
  const { s, plan, mk, link } = world();
  const pdf = mk('PDF'), Y = mk('Y');
  const N = created(run(s, createAnnotation(s, anchor(pdf), 'Un passage')), 'node');
  run(s, placeNode(s, plan.P, N, 0, 0, 0));
  const c = link('P', [N, Y]);
  run(s, removeFromPlan(s, plan.P, N));
  expect(s.nodes.get(N)!.trashedAt).toBeUndefined();
  expect(s.connections.get(c)!.trashedAt).toBeUndefined();
  expect(membersOf(s, c)).toEqual([N, Y]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${N}`, `${plan.P}|${Y}`].sort());
  expect(checkState(s)).toEqual([]);
});

test.each(departures)('jeter un nœud ($how) le retire aussi des connexions déjà à la corbeille', ({ go }) => {
  const { s, plan, mk, link } = world();
  const X = mk('X'), Y = mk('Y'), Z = mk('Z');
  const c = link('P', [X, Y, Z]);
  at(T0, () => run(s, deleteConnection(s, c)));
  at(T0 + 1, () => run(s, go(s, plan, X)));
  // Its time in the trash unchanged.
  expect(s.connections.get(c)!.trashedAt).toBe(T0);
  expect(membersOf(s, c)).toEqual([Y, Z]);
  expect(checkState(s)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The trash

test.each(departures)('restaurer un nœud ($how) ne lui rend pas ses connexions', ({ go }) => {
  const { s, plan, mk, link } = world();
  const X = mk('X'), Y = mk('Y'), Z = mk('Z');
  const two = link('P', [X, Y]), three = link('P', [X, Y, Z]);
  run(s, go(s, plan, X));
  run(s, restoreNode(s, X, plan.P, 0, 0, 0));
  expect(s.connections.get(two)!.trashedAt).toBeDefined();
  expect(membersOf(s, two)).toEqual([Y]);
  expect(s.connections.get(three)!.trashedAt).toBeUndefined();
  expect(membersOf(s, three)).toEqual([Y, Z]);
  expect([...s.branches].some((b) => b.node === X)).toBe(false);
  expect(checkState(s)).toEqual([]);
});

test('restaurer une connexion d’un membre vivant : une branche dans chaque plan où ce nœud est placé, un document à part', () => {
  const { s, plan, mk, link } = world();
  const X = mk('X'), Y = mk('Y', ['P', 'Q', 'D']);
  const c = link('P', [X, Y]);
  run(s, deleteEverywhere(s, X));
  expect(membersOf(s, c)).toEqual([Y]);
  const a = run(s, restoreConnection(s, c));
  expect(s.connections.get(c)!.trashedAt).toBeUndefined();
  expect(membersOf(s, c)).toEqual([Y]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${Y}`, `${plan.Q}|${Y}`].sort());
  expect(checkState(s)).toEqual([]);
  expect(a.label).toBe('Restaurer la connexion de « Y »');
});

test('restaurer une connexion sans membre : RESTORE_CONNECTION_LOST', () => {
  const { s, plan, mk, link } = world();
  const X = mk('X');
  const c = link('P', [X]);
  run(s, removeFromPlan(s, plan.P, X));
  expect(membersOf(s, c)).toEqual([]);
  expect(RESTORE_CONNECTION_LOST).toBe('Il ne reste aucun nœud à cette connexion : elle ne peut pas revenir.');
  expect(refusal(() => restoreConnection(s, c))).toBe(RESTORE_CONNECTION_LOST);
});

test('restaurer une connexion dont tous les membres sont à la corbeille : refusé', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A'), B = mk('B');
  const c = link('P', [A, B]);
  run(s, deleteConnection(s, c));
  // A base of an older version: its nodes thrown away without leaving their connections.
  for (const n of [A, B]) {
    applyOps(s, [
      { t: 'placement', before: s.placements.get(placementKey(plan.P, n))!, after: null },
      { t: 'node', before: s.nodes.get(n)!, after: { ...s.nodes.get(n)!, trashedAt: T0 } },
    ]);
  }
  expect(membersOf(s, c)).toEqual([A, B]);
  expect(refusal(() => restoreConnection(s, c))).toBe('Ses nœuds sont à la corbeille : restaure-les d’abord.');
});

// ---------------------------------------------------------------------------------------------------------------------
// The sync (D3), drawn at random: two PCs, two commands among those that throw a node away, bring a connection back,
// or change its members, in the four orders. The PCs end in the server's state, valid (crossed); no node the crossing
// threw away is left in a live connection, nor shown by one; a PC that received the other write before sending its
// own replays it into what the server would have made of it (informed).

test('synchro au hasard : 300 paires de commandes croisées, dans les quatre ordres : un nœud jeté ne reste dans aucune connexion vivante', () => {
  const r = rng(61);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  let pairs = 0, crossings = 0;
  while (pairs < 300) {
    const { s, plan, mk, link } = world();
    const X = mk('X'), Y = mk('Y', ['P', 'Q']), Z = mk('Z'), W = mk('W', ['P', 'Q']);
    const nodes = [X, Y, Z, W];
    const conns = [link('P', [X, Y], ['Q']), link('P', [X, Y, Z]), link('P', [Y]), link('P', [X]), link('P', [Z, W, X], ['Q'])];
    run(s, deleteConnection(s, conns[1]));
    run(s, splitArm(s, plan.P, conns[0], X, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
    run(s, placeAbsent(s, plan.Q, conns[4], X, 300, 40, 1));
    const draws: ((x: State) => Action)[] = [
      (x) => deleteEverywhere(x, pick(nodes)),
      (x) => removeFromPlan(x, plan.P, pick(nodes)),
      (x) => restoreConnection(x, pick(conns)),
      (x) => addMember(x, plan.P, pick(conns), { node: pick(nodes), role: 'target' }),
      (x) => removeMember(x, pick(conns), pick(nodes)),
      (x) => setRole(x, pick(conns), pick(nodes), 'associate'),
      (x) => editConnection(x, pick(conns), { title: 'Titre' }),
      (x) => deleteConnection(x, pick(conns)),
      (x) => setBranches(x, pick(conns), [{ plan: plan.Q, node: pick(nodes) }], r() < 0.5),
      (x) => restoreNode(x, pick(nodes), plan.Q, 0, 0, 0),
    ];
    // Each command drawn once, its arguments fixed: an action computed on the base, replayed as is on each PC's copy.
    const draw = (): Action | null => { try { return pick(draws)(s); } catch (e) { if (e instanceof CommandError) return null; throw e; } };
    const a = draw(), b = draw();
    if (!a || !b || a.ops.length === 0 || b.ops.length === 0) continue;
    pairs++;
    const alive = new Set(nodes.filter((n) => s.nodes.get(n)!.trashedAt === undefined));
    for (const { order, at: when } of [
      { order: 'mine first', at: { mine: 1, theirs: 2 } }, { order: 'mine first', at: { mine: 2, theirs: 1 } },
      { order: 'theirs first', at: { mine: 1, theirs: 2 } }, { order: 'theirs first', at: { mine: 2, theirs: 1 } },
    ] as const) {
      crossings++;
      const tag = `${a.label} / ${b.label} (${order}, ${when.mine})`;
      const { server } = crossed(s, () => a, () => b, order, when);
      for (const n of alive) {
        if (server.nodes.get(n)!.trashedAt === undefined) continue;
        for (const c of server.connections.values()) {
          if (c.kind === 'knowledge' && c.trashedAt === undefined) expect(c.members.some((m) => m.node === n), tag).toBe(false);
        }
        expect([...server.branches].some((x) => x.node === n && server.connections.get(x.connection)!.kind === 'knowledge'), tag).toBe(false);
        expect([...server.phantoms.values()].some((p) => p.of.node === n), tag).toBe(false);
      }
      expect(image(informed(s, () => a, () => b, order, when)), tag).toBe(image(server));
    }
  }
  expect(crossings).toBe(1200);
});
