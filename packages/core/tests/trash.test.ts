import { afterEach, expect, test, vi } from 'vitest';
import {
  type Action, addMember, CommandError, connect, createAnnotation, createNode, createPlan, deleteConnection, deleteEverywhere, include, placeAbsent, placeNode, removeFromPlan,
  restoreConnection, restoreNode, setBranches,
} from '../src/commands.ts';
import { invertAction, UndoStack } from '../src/history.ts';
import { uuidv7 } from '../src/ids.ts';
import * as core from '../src/index.ts';
import { checkState, groupOf } from '../src/invariants.ts';
import type { Anchor, Id, PlanType } from '../src/model.ts';
import { applyOps, emptyState, placementKey, type State } from '../src/state.ts';
import { parseUnit, type Unit } from '../src/sync.ts';
import { created } from './helpers.ts';
import { crossed, image, informed } from './twoPcs.ts';

// The trash (plan 6a, task 4, D5): what it holds, a node put back by placing it in a plan, a connection restored with its
// branches; each one action, checked, that an undo gives back and the sync carries.

afterEach(() => { vi.restoreAllMocks(); });

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const unitOf = (a: Action): Unit => ({ unit: uuidv7(), action: a.id, label: a.label, at: Date.UTC(2026, 10, 10, 9), pc: 'pc-a', ops: a.ops });
const T0 = Date.UTC(2026, 10, 10, 9);
/** The command run at time `at` (its trashedAt). */
const at = <T>(t: number, fn: () => T): T => {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(t);
  try { return fn(); } finally { spy.mockRestore(); }
};
const branchesOf = (s: State, c: Id) => [...s.branches].filter((b) => b.connection === c).map((b) => `${b.plan}|${b.node}`).sort();

/** Plans by name and type; `mk` a node placed in the plans given (the first one creates it), `link` a connection drawn in `plan`. */
function world(plans: [string, PlanType][] = [['P', 'plan'], ['Q', 'plan']]) {
  const s = emptyState();
  const plan: Record<string, Id> = {};
  for (const [name, type] of plans) plan[name] = created(run(s, createPlan(s, name, type)), 'plan');
  let x = 0;
  const mk = (title: string, where: string[] = ['P']) => {
    const id = created(run(s, createNode(s, { plan: plan[where[0]], title, x: (x += 100), y: 0, k: 0 })), 'node');
    for (const p of where.slice(1)) run(s, placeNode(s, plan[p], id, x, 50, 0));
    return id;
  };
  const link = (where: string, nodes: Id[], title = '') =>
    created(run(s, connect(s, { plan: plan[where], title, members: nodes.map((node, i) => ({ node, role: i === 0 ? 'source' : 'target' })) })), 'connection');
  return { s, plan, mk, link };
}

/** The error a command throws: its class and message. */
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
// trashedItems

test('trashedItems : les nœuds, les annotations et les connexions de connaissance jetés, du plus récent au plus ancien ; ni ce qui vit, ni un lien de groupe ; exportés du paquet', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A'), B = mk('B'), C = mk('C'), G = mk('G'), X = mk('X');
  run(s, include(s, plan.P, B, G));
  const implies = link('P', [A, B], 'Implique'), bc = link('P', [B, C]), xa = link('P', [X, A]), ab = link('P', [A, B]);
  const note = created(run(s, createAnnotation(s, anchor(A), 'Un passage')), 'node');
  at(T0 + 1, () => run(s, deleteConnection(s, implies)));
  at(T0 + 2, () => run(s, deleteEverywhere(s, note)));
  // C leaves its last plan: to the trash, with its connection with B, left with one node (plan 6b, D2).
  at(T0 + 3, () => run(s, removeFromPlan(s, plan.P, C)));
  // G deleted everywhere: its group link goes to the trash too, and is not listed.
  at(T0 + 4, () => run(s, deleteEverywhere(s, G)));
  at(T0 + 5, () => run(s, deleteConnection(s, ab)));
  // X deleted everywhere: its connection with A, left with one member, goes at the same time; the node first.
  at(T0 + 6, () => run(s, deleteEverywhere(s, X)));
  expect(core.trashedItems(s)).toEqual([
    { id: X, kind: 'node', title: 'X', at: T0 + 6 },
    { id: xa, kind: 'connection', title: 'la connexion de « A »', at: T0 + 6 },
    { id: ab, kind: 'connection', title: 'la connexion entre « A » et « B »', at: T0 + 5 },
    { id: G, kind: 'node', title: 'G', at: T0 + 4 },
    { id: C, kind: 'node', title: 'C', at: T0 + 3 },
    { id: bc, kind: 'connection', title: 'la connexion de « B »', at: T0 + 3 },
    { id: note, kind: 'node', title: 'Un passage', at: T0 + 2 },
    { id: implies, kind: 'connection', title: '« Implique »', at: T0 + 1 },
  ]);
  for (const k of ['trashedItems', 'restoreConnection', 'restoreNode'] as const) expect(typeof core[k]).toBe('function');
});

test('trashedItems : une corbeille vide, une liste vide ; ce qui en sort n’y est plus', () => {
  const { s, plan, mk } = world();
  expect(core.trashedItems(s)).toEqual([]);
  const A = mk('A');
  run(s, removeFromPlan(s, plan.P, A));
  expect(core.trashedItems(s).map((i) => i.id)).toEqual([A]);
  run(s, restoreNode(s, A, plan.Q, 0, 0, 0));
  expect(core.trashedItems(s)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// restoreNode: put down in a plan (D5), whatever plan it left

test('restoreNode : posé dans un autre plan que celui d’où il est parti, même disparu ; ses fantômes « absents » de ce plan s’en vont, comme pour placeNode ; un Ctrl+Z rend la corbeille', () => {
  const { s, plan, mk, link } = world();
  const R = created(run(s, createPlan(s, 'R', 'plan')), 'plan');
  const X = mk('X'), Y = mk('Y', ['P', 'Q']);
  run(s, placeNode(s, R, X, 0, 0, 0));
  const c = link('P', [X, Y]);
  // In Q, X is absent: a stub put down by hand, an absent phantom.
  run(s, setBranches(s, c, [{ plan: plan.Q, node: X }, { plan: plan.Q, node: Y }], true));
  run(s, placeAbsent(s, plan.Q, c, X, 300, 40, 1));
  run(s, removeFromPlan(s, plan.P, X));
  // Out of R, its last plan, by an older version: to the trash without leaving its connections (since plan 6b, D2,
  // removeFromPlan takes it out of them, its phantoms with it).
  applyOps(s, [{ t: 'placement', before: s.placements.get(placementKey(R, X))!, after: null }, { t: 'node', before: s.nodes.get(X)!, after: { ...s.nodes.get(X)!, trashedAt: T0 } }]);
  expect(s.nodes.get(X)!.trashedAt).toBeDefined();
  // The plan it left last is gone (its creation undone, or another PC's).
  const gone = s.plans.get(R)!;
  applyOps(s, [{ t: 'plan', before: gone, after: null }]);
  expect(s.plans.has(R)).toBe(false);
  const phantoms = [...s.phantoms.values()].filter((p) => p.of.node === X);
  expect(phantoms).toHaveLength(1);
  const stack = new UndoStack();
  const a = run(s, restoreNode(s, X, plan.Q, 300, 40, 1));
  stack.record(a);
  expect(a.label).toBe('Restaurer « X »');
  expect(s.nodes.get(X)!.trashedAt).toBeUndefined();
  expect(s.placements.get(placementKey(plan.Q, X))).toMatchObject({ x: 300, y: 40, k: 1 });
  expect(s.phantoms.has(phantoms[0].id)).toBe(false);
  expect(checkState(s)).toEqual([]);
  expect(parseUnit(wire(unitOf(a))).ops).toHaveLength(a.ops.length);
  // Ctrl+Z: back in the trash, out of Q, its absent phantom back.
  run(s, stack.undo(s)!);
  expect(s.nodes.get(X)!.trashedAt).toBeDefined();
  expect(s.placements.has(placementKey(plan.Q, X))).toBe(false);
  expect(s.phantoms.get(phantoms[0].id)).toEqual(phantoms[0]);
  expect(checkState(s)).toEqual([]);
});

test('restoreNode : refusé pour un nœud hors de la corbeille, inconnu, ou un plan inconnu', () => {
  const { s, plan, mk } = world();
  const A = mk('A');
  expect(refusal(() => restoreNode(s, A, plan.Q, 0, 0, 0))).toBe('Ce nœud n’est pas à la corbeille.');
  expect(refusal(() => restoreNode(s, 'inconnu', plan.Q, 0, 0, 0))).toBe('Nœud introuvable.');
  run(s, removeFromPlan(s, plan.P, A));
  expect(refusal(() => restoreNode(s, A, 'pas-de-plan', 0, 0, 0))).toBe('Plan introuvable.');
});

// ---------------------------------------------------------------------------------------------------------------------
// restoreConnection

test('restoreConnection : ses branches dans chaque plan où deux de ses membres au moins sont placés, pour ceux qui y sont ; un document n’en reçoit pas ; une action, qu’un Ctrl+Z défait', () => {
  const { s, plan, mk, link } = world([['P', 'plan'], ['Q', 'plan'], ['R', 'plan'], ['L', 'lobby'], ['D', 'document']]);
  const A = mk('A', ['P', 'Q', 'L', 'D']), B = mk('B', ['P', 'Q', 'D']), C = mk('C', ['P', 'R', 'L']), E = mk('E', ['R']);
  const c = link('P', [A, B, C], 'Trois');
  run(s, deleteConnection(s, c));
  expect(branchesOf(s, c)).toEqual([]);
  const stack = new UndoStack();
  const a = run(s, restoreConnection(s, c));
  stack.record(a);
  expect(a.label).toBe('Restaurer « Trois »');
  expect(s.connections.get(c)).toEqual({
    id: c, kind: 'knowledge', title: 'Trois', relation: '', tags: [], members: [{ node: A, role: 'source' }, { node: B, role: 'target' }, { node: C, role: 'target' }],
  });
  // P: the three; Q: A and B (C is not there); the lobby: A and C; R: C alone, nothing; the document: nothing.
  expect(branchesOf(s, c)).toEqual([`${plan.L}|${A}`, `${plan.L}|${C}`, `${plan.P}|${A}`, `${plan.P}|${B}`, `${plan.P}|${C}`, `${plan.Q}|${A}`, `${plan.Q}|${B}`].sort());
  expect(branchesOf(s, c).some((b) => b.endsWith(`|${E}`))).toBe(false);
  expect(checkState(s)).toEqual([]);
  // What the server checks first: the write's shape and each operation's.
  expect(parseUnit(wire(unitOf(a))).ops).toHaveLength(a.ops.length);
  // Ctrl+Z: back in the trash, shown nowhere.
  run(s, stack.undo(s)!);
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  expect(branchesOf(s, c)).toEqual([]);
  expect(core.trashedItems(s).map((i) => i.id)).toEqual([c]);
  expect(checkState(s)).toEqual([]);
});

test('restoreConnection : un nœud jeté quitte aussi la connexion à la corbeille, qui revient sans lui, à un nœud s’il ne lui en reste qu’un ; deux membres vivants dans deux plans, elle ne s’affiche nulle part ; un membre jeté par une version ancienne reste membre, sans branche', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D', ['Q']), E = mk('E'), F = mk('F');
  const c = link('P', [A, B, C]);
  run(s, deleteConnection(s, c));
  // C deleted everywhere while the connection is in the trash: it leaves it (plan 6b, D2).
  run(s, deleteEverywhere(s, C));
  expect(s.connections.get(c)!.members.map((m) => m.node)).toEqual([A, B]);
  const back = run(s, restoreConnection(s, c));
  expect(s.connections.get(c)!.members.map((m) => m.node)).toEqual([A, B]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${A}`, `${plan.P}|${B}`].sort());
  expect(checkState(s)).toEqual([]);
  run(s, invertAction(back));
  // B deleted everywhere too: the connection comes back with A alone, in A's plan.
  run(s, deleteEverywhere(s, B));
  run(s, restoreConnection(s, c));
  expect(s.connections.get(c)!.members.map((m) => m.node)).toEqual([A]);
  expect(branchesOf(s, c)).toEqual([`${plan.P}|${A}`]);
  expect(checkState(s)).toEqual([]);
  // A in P, D in Q: no plan has two of its members, it comes back shown nowhere.
  const ad = link('P', [A, D]);
  run(s, deleteConnection(s, ad));
  run(s, restoreConnection(s, ad));
  expect(s.connections.get(ad)!.trashedAt).toBeUndefined();
  expect(branchesOf(s, ad)).toEqual([]);
  // F thrown away by an older version, without leaving its connection: still a member, shown nowhere.
  const aef = link('P', [A, E, F]);
  run(s, deleteConnection(s, aef));
  applyOps(s, [{ t: 'placement', before: s.placements.get(placementKey(plan.P, F))!, after: null }, { t: 'node', before: s.nodes.get(F)!, after: { ...s.nodes.get(F)!, trashedAt: T0 } }]);
  run(s, restoreConnection(s, aef));
  expect(s.connections.get(aef)!.members.map((m) => m.node)).toEqual([A, E, F]);
  expect(branchesOf(s, aef)).toEqual([`${plan.P}|${A}`, `${plan.P}|${E}`].sort());
  expect(checkState(s)).toEqual([]);
});

test('restoreConnection : une connexion sans nœud ne revient pas ; refusée hors de la corbeille, inconnue, ou d’un autre genre que la connaissance', () => {
  const { s, plan, mk, link } = world();
  const A = mk('A'), B = mk('B'), G = mk('G'), X = mk('X'), Y = mk('Y');
  // X deleted everywhere: its connection with Y goes to the trash with Y alone; Y deleted everywhere, it has none left.
  const xy = link('P', [X, Y]);
  run(s, deleteEverywhere(s, X));
  expect(s.connections.get(xy)!.members.map((m) => m.node)).toEqual([Y]);
  run(s, deleteEverywhere(s, Y));
  expect(s.connections.get(xy)!.members).toEqual([]);
  expect(refusal(() => restoreConnection(s, xy))).toBe('Il ne reste aucun nœud à cette connexion : elle ne peut pas revenir.');
  const ab = link('P', [A, B]);
  expect(refusal(() => restoreConnection(s, ab))).toBe('Cette connexion n’est pas à la corbeille.');
  expect(refusal(() => restoreConnection(s, 'inconnue'))).toBe('Connexion introuvable.');
  // A group link thrown with its group: not a connection of the trash's.
  const inc = created(run(s, include(s, plan.P, A, G)), 'connection');
  run(s, deleteEverywhere(s, G));
  expect(s.connections.get(inc)!.trashedAt).toBeDefined();
  expect(refusal(() => restoreConnection(s, inc))).toBe('Seules les connexions de connaissance se restaurent.');
  expect(groupOf(s, plan.P, A)).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------------------------------
// The sync (plan 6b, D3): a node thrown away on one PC — deleted everywhere, or out of its last plan — while another
// restores a connection that held it, or adds it to one. The departure wins: the connection merged has neither the
// node, nor its branches, nor its phantoms, and goes to the trash when it is left with one node.

const ORDERS = [
  { order: 'mine first', at: { mine: 1, theirs: 2 } },
  { order: 'mine first', at: { mine: 2, theirs: 1 } },
  { order: 'theirs first', at: { mine: 1, theirs: 2 } },
  { order: 'theirs first', at: { mine: 2, theirs: 1 } },
] as const;
const DEPARTURES = [
  { how: 'supprimé partout', go: (s: State, _p: Id, X: Id) => deleteEverywhere(s, X) },
  { how: 'retiré de son dernier plan', go: (s: State, p: Id, X: Id) => removeFromPlan(s, p, X) },
] as const;
const OTHERS = [
  // The connection [X, Y(, Z)] in the trash, restored.
  { what: 'la restauration de la connexion', make: (link: (nodes: Id[]) => Id, s: State, X: Id, rest: Id[]) => {
    const c = link([X, ...rest]);
    run(s, deleteConnection(s, c));
    return { c, other: (x: State, _p: Id) => restoreConnection(x, c) };
  } },
  // The connection [Y(, Z)] alive, X added.
  { what: 'l’ajout du nœud à la connexion', make: (link: (nodes: Id[]) => Id, _s: State, X: Id, rest: Id[]) => {
    const c = link(rest);
    return { c, other: (x: State, p: Id) => addMember(x, p, c, { node: X, role: 'target' }) };
  } },
] as const;

test.each(ORDERS.flatMap((o) => DEPARTURES.flatMap((d) => OTHERS.map((w) => ({ ...o, ...d, ...w })))))(
  'synchro : un nœud $how sur un PC, croisé avec $what sur l’autre ($order, la mienne à $at.mine) : son départ l’emporte, rien n’est écarté, les deux PC égaux',
  ({ order, at: when, go, make }) => {
    for (const three of [false, true]) {
      const { s, plan, mk, link } = world();
      const X = mk('X'), Y = mk('Y'), Z = mk('Z');
      const { c, other } = make((nodes) => link('P', nodes), s, X, three ? [Y, Z] : [Y]);
      // Mine: the other change; theirs: the departure (crossed checks that both PCs end in the server's state).
      const { server, dropped } = crossed(s, (x) => other(x, plan.P), (x) => go(x, plan.P, X), order, when);
      const tag = `${three ? 'trois' : 'deux'}`;
      expect(dropped, tag).toEqual([]);
      expect(server.nodes.get(X)!.trashedAt, tag).toBeDefined();
      expect(server.placements.has(placementKey(plan.P, X)), tag).toBe(false);
      const conn = server.connections.get(c)!;
      expect(conn.members.map((m) => m.node), tag).toEqual(three ? [Y, Z] : [Y]);
      expect([...server.branches].some((b) => b.node === X), tag).toBe(false);
      expect([...server.phantoms.values()].some((p) => p.of.node === X), tag).toBe(false);
      if (three) {
        expect(conn.trashedAt, tag).toBeUndefined();
        expect(branchesOf(server, c), tag).toEqual([`${plan.P}|${Y}`, `${plan.P}|${Z}`].sort());
      } else {
        // With X: its time in the trash.
        expect(conn.trashedAt, tag).toBe(server.nodes.get(X)!.trashedAt);
        expect(branchesOf(server, c), tag).toEqual([]);
      }
    }
  },
);

test.each(ORDERS.flatMap((o) => DEPARTURES.flatMap((d) => OTHERS.map((w) => ({ ...o, ...d, ...w })))))(
  'synchro : un nœud $how, croisé avec $what ($order, la mienne à $at.mine) : le PC qui reçoit l’autre écriture avant d’envoyer la sienne la rejoue jusqu’au même état que celui où le serveur complète',
  ({ order, at: when, go, make }) => {
    // One time for every command: the states compare whole, times in the trash included.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10);
    for (const three of [false, true]) {
      const { s, plan, mk, link } = world();
      const X = mk('X'), Y = mk('Y'), Z = mk('Z');
      const { other } = make((nodes) => link('P', nodes), s, X, three ? [Y, Z] : [Y]);
      const mine = (x: State) => other(x, plan.P), theirs = (x: State) => go(x, plan.P, X);
      expect(image(informed(s, mine, theirs, order, when)), three ? 'trois' : 'deux').toBe(image(crossed(s, mine, theirs, order, when).server));
    }
  },
);

test.each(['mine first', 'theirs first'] as const)('synchro : la même connexion restaurée sur deux PC (%s) converge, une seule fois', (order) => {
  const { s, plan, mk, link } = world();
  const X = mk('X'), Y = mk('Y');
  const c = link('P', [X, Y]);
  run(s, deleteConnection(s, c));
  const { server, dropped } = crossed(s, (x) => restoreConnection(x, c), (x) => restoreConnection(x, c), order, { mine: 1, theirs: 2 });
  expect(dropped).toEqual([]);
  expect(server.connections.get(c)!.trashedAt).toBeUndefined();
  expect(branchesOf(server, c)).toEqual([`${plan.P}|${X}`, `${plan.P}|${Y}`].sort());
});
