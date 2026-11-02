import { expect, test } from 'vitest';
import {
  type Action, addMember, CommandError, connect, createNode, createPlan, deleteEverywhere, editNode, include, joinArm, movePhantom,
  placeNode, removeFromPlan, removeMember, restoreNode, splitArm,
} from '../src/commands.ts';
import { ancestors, groupOf } from '../src/invariants.ts';
import type { Id } from '../src/model.ts';
import { applyOp, branchKey, canonical, emptyState, placementKey, type State } from '../src/state.ts';

const run = (s: State, a: Action): Action => { for (const op of a.ops) applyOp(s, op); return a; };
const created = (a: Action, t: 'node' | 'connection' | 'plan'): Id => {
  const op = a.ops.find((o) => o.t === t && o.before === null);
  return (op as { after: { id: Id } }).after.id;
};

function world() {
  const s = emptyState();
  const p1 = created(run(s, createPlan(s, 'Thèse', 'plan')), 'plan');
  const p2 = created(run(s, createPlan(s, 'Lobby', 'lobby')), 'plan');
  const mk = (title: string, plan: Id = p1) => created(run(s, createNode(s, { plan, title, x: 0, y: 0, k: 0 })), 'node');
  return { s, p1, p2, mk };
}

test('créer un nœud le place dans le plan', () => {
  const { s, p1, mk } = world();
  const n = mk('MDL');
  expect(s.nodes.get(n)!.title).toBe('MDL');
  expect(s.placements.has(placementKey(p1, n))).toBe(true);
});

test('retirer un nœud de son dernier plan le met à la corbeille, restaurable (Review Focus 5)', () => {
  const { s, p1, mk } = world();
  const n = mk('MDL');
  run(s, removeFromPlan(s, p1, n));
  expect(s.nodes.get(n)!.trashedAt).toBeDefined();
  run(s, restoreNode(s, n, p1, 5, 5, 0));
  expect(s.nodes.get(n)!.trashedAt).toBeUndefined();
  expect(s.placements.get(placementKey(p1, n))).toMatchObject({ x: 5, y: 5 });
});

test("retirer un nœud d'un plan garde ses branches : elles deviennent des amorces", () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), b = mk('B');
  run(s, placeNode(s, p2, a, 0, 0, 0));
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, removeFromPlan(s, p1, a));
  expect(s.nodes.get(a)!.trashedAt).toBeUndefined(); // still placed in p2
  expect(s.branches.has(branchKey({ plan: p1, connection: c, node: a }))).toBe(true);
});

test('supprimer partout : connexion réduite à un membre jetée (Review Focus 5)', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, deleteEverywhere(s, a));
  expect(s.nodes.get(a)!.trashedAt).toBeDefined();
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  expect([...s.branches].some((k) => k.includes(c))).toBe(false);
});

test("retirer un groupe d'un plan garde la hiérarchie de ses membres (spec 7)", () => {
  const { s, p1, mk } = world();
  const m = mk('M'), g = mk('G'), h = mk('H');
  run(s, include(s, p1, g, h));
  run(s, include(s, p1, m, g));
  run(s, removeFromPlan(s, p1, g));
  // G is no longer shown; M's nearest ancestor present in the plan is H.
  expect(ancestors(s, p1, m)).toEqual([g, h]);
});

test('un nœud sans membres retiré sort de son groupe, et les groupes cachés devenus vides aussi', () => {
  const { s, p1, mk } = world();
  const m = mk('M'), g = mk('G'), h = mk('H');
  run(s, include(s, p1, g, h));
  run(s, include(s, p1, m, g));
  run(s, removeFromPlan(s, p1, g));
  run(s, removeFromPlan(s, p1, m));
  expect(groupOf(s, p1, m)).toBeUndefined();
  expect(groupOf(s, p1, g)).toBeUndefined();
});

test('connecter crée les branches dans le plan seulement', () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), b = mk('B');
  run(s, placeNode(s, p2, a, 0, 0, 0));
  run(s, placeNode(s, p2, b, 0, 0, 0));
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  expect(s.branches.has(branchKey({ plan: p1, connection: c, node: a }))).toBe(true);
  expect(s.branches.has(branchKey({ plan: p2, connection: c, node: a }))).toBe(false);
});

test('inclure remplace le groupe direct dans ce plan seulement', () => {
  const { s, p1, p2, mk } = world();
  const n = mk('N'), g = mk('G'), h = mk('H');
  for (const id of [n, g, h]) run(s, placeNode(s, p2, id, 0, 0, 0));
  run(s, include(s, p1, n, g));
  run(s, include(s, p2, n, g));
  run(s, include(s, p1, n, h));
  expect(groupOf(s, p1, n)).toBe(h);
  expect(groupOf(s, p2, n)).toBe(g);
});

test('inclure dans un descendant lève CommandError', () => {
  const { s, p1, mk } = world();
  const g = mk('G'), n = mk('N');
  run(s, include(s, p1, n, g));
  expect(() => include(s, p1, g, n)).toThrow(CommandError);
  expect(() => include(s, p1, g, n)).toThrow(/descendants/);
});

test('scinder un bras crée deux fantômes et retire la branche ; réunir rétablit', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, splitArm(s, p1, c, b, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  expect(s.branches.has(branchKey({ plan: p1, connection: c, node: b }))).toBe(false);
  const kinds = [...s.phantoms.values()].map((p) => p.of.kind).sort();
  expect(kinds).toEqual(['center', 'node']);
  run(s, joinArm(s, p1, c, b));
  expect(s.phantoms.size).toBe(0);
  expect(s.branches.has(branchKey({ plan: p1, connection: c, node: b }))).toBe(true);
});

test('retirer un membre supprime les fantômes de son bras scindé', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B'), c2 = mk('C');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }, { node: c2, role: 'target' }] })), 'connection');
  run(s, splitArm(s, p1, c, b, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  run(s, removeMember(s, c, b));
  expect(s.phantoms.size).toBe(0);
});

test('une connexion jetée perd tous ses fantômes', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, splitArm(s, p1, c, b, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  run(s, deleteEverywhere(s, a));
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  expect(s.phantoms.size).toBe(0);
});

test('un nœud à la corbeille ne peut pas être connecté', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B'), t = mk('T');
  run(s, removeFromPlan(s, p1, t));
  expect(() => connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: t, role: 'target' }] })).toThrow(CommandError);
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  expect(() => addMember(s, p1, c, { node: t, role: 'target' })).toThrow(/corbeille/);
});

test('un plan inconnu est refusé', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B'), g = mk('G'), t = mk('T');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  expect(() => addMember(s, 'pas-de-plan', c, { node: g, role: 'target' })).toThrow(/Plan introuvable/);
  run(s, removeFromPlan(s, p1, t));
  expect(() => restoreNode(s, t, 'pas-de-plan', 0, 0, 0)).toThrow(/Plan introuvable/);
});

test("on n'inclut que dans un groupe présent dans le plan", () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), g = mk('G'), t = mk('T');
  run(s, removeFromPlan(s, p1, t));
  expect(() => include(s, p1, a, t)).toThrow(CommandError);
  run(s, placeNode(s, p2, a, 0, 0, 0));
  expect(() => include(s, p2, a, g)).toThrow(/pas dans ce plan/);
  const b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, splitArm(s, p1, c, b, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  const phantom = [...s.phantoms.values()][0].id;
  expect(() => movePhantom(s, phantom, 0, 0, t)).toThrow(/pas dans ce plan/);
});

test("une valeur de tag inconnue est refusée par une CommandError", () => {
  const { s, p1, mk } = world();
  applyOp(s, { t: 'tagKey', before: null, after: { key: 'pertinence', type: 'enum', scope: 'node', multi: false, required: false, enumValues: [{ name: 'central', rank: 5 }] } });
  const tags = [{ key: 'pertinence', value: 'centrale' }];
  expect(() => createNode(s, { plan: p1, title: 'A', x: 0, y: 0, k: 0, tags })).toThrow(CommandError);
  expect(() => editNode(s, mk('B'), { tags })).toThrow(/inconnue/);
  expect(() => connect(s, { plan: p1, members: [{ node: mk('C'), role: 'source' }, { node: mk('D'), role: 'target' }], tags })).toThrow(CommandError);
});

test("une commande ne modifie jamais l'état reçu", () => {
  const { s, p1, mk } = world();
  const a = mk('A');
  const before = canonical({ nodes: [...s.nodes], placements: [...s.placements], branches: [...s.branches] });
  removeFromPlan(s, p1, a);
  deleteEverywhere(s, a);
  expect(canonical({ nodes: [...s.nodes], placements: [...s.placements], branches: [...s.branches] })).toBe(before);
});
