import { expect, test } from 'vitest';
import {
  type Action, addMember, combine, CommandError, connect, createNode, createPlan, deleteConnection, deleteEverywhere, editConnection, editNode, include, joinArm,
  movePhantom, placeAbsent, placeNode, removeFromPlan, removeMember, restoreNode, setBranches, setLayout, setPreamble, splitArm,
} from '../src/commands.ts';
import { ancestors, groupOf } from '../src/invariants.ts';
import { DEFAULT_PREAMBLE } from '../src/latex.ts';
import type { Id } from '../src/model.ts';
import { invertAction } from '../src/history.ts';
import { flowOf, MAX_LABEL_CHARS, subjectOf, truncateLabel } from '../src/ops.ts';
import { applyOp, canonical, emptyState, layoutKey, OpConflictError, placementKey, preambleText, type State } from '../src/state.ts';

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

test('créer un nœud avec ses fichiers, déjà au magasin (une publication importée, plan 4c) : une opération ; sa liste est une copie', () => {
  const { s, p1 } = world();
  const files = [{ name: 'li2008.bib', hash: 'a'.repeat(64), size: 42 }];
  const a = run(s, createNode(s, { plan: p1, title: 'Livre', x: 0, y: 0, k: 0, files }));
  expect(a.ops.filter((o) => o.t === 'node')).toHaveLength(1);
  const n = s.nodes.get(created(a, 'node'))!;
  expect(n.files).toEqual(files);
  expect(n.files).not.toBe(files);
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
  expect(s.branches.has({ plan: p1, connection: c, node: a })).toBe(true);
});

test('supprimer partout : connexion réduite à un membre jetée (Review Focus 5)', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, deleteEverywhere(s, a));
  expect(s.nodes.get(a)!.trashedAt).toBeDefined();
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  expect([...s.branches].some((b) => b.connection === c)).toBe(false);
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
  expect(s.branches.has({ plan: p1, connection: c, node: a })).toBe(true);
  expect(s.branches.has({ plan: p2, connection: c, node: a })).toBe(false);
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
  expect(s.branches.has({ plan: p1, connection: c, node: b })).toBe(false);
  const kinds = [...s.phantoms.values()].map((p) => p.of.kind).sort();
  expect(kinds).toEqual(['center', 'node']);
  run(s, joinArm(s, p1, c, b));
  expect(s.phantoms.size).toBe(0);
  expect(s.branches.has({ plan: p1, connection: c, node: b })).toBe(true);
});

test('éditer une connexion change son titre et sa relation, rien d’autre', () => {
  const { s, p1, mk } = world();
  const a = mk('A'), b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, editConnection(s, c, { title: 'Implique', relation: 'A \\Rightarrow B' }));
  expect(s.connections.get(c)).toMatchObject({ title: 'Implique', relation: 'A \\Rightarrow B', members: [{ node: a }, { node: b }] });
  expect(() => editConnection(s, 'inconnue', { title: 'x' })).toThrow(CommandError);
});

test('montrer une connexion dans d’autres plans ajoute ses branches ; les ôter d’un plan ôte aussi les fantômes du bras', () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), b = mk('B'), x = mk('X');
  for (const n of [a, b]) run(s, placeNode(s, p2, n, 0, 0, 0));
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, setBranches(s, c, [{ plan: p2, node: a }, { plan: p2, node: b }], true));
  expect(s.branches.has({ plan: p2, connection: c, node: b })).toBe(true);
  expect(() => setBranches(s, c, [{ plan: p2, node: x }], true)).toThrow(/membre/);
  run(s, splitArm(s, p1, c, b, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  run(s, setBranches(s, c, [{ plan: p1, node: b }], false));
  expect([...s.phantoms.values()].filter((ph) => ph.plan === p1)).toHaveLength(0);
  expect(s.branches.has({ plan: p2, connection: c, node: b })).toBe(true);
  expect(s.connections.get(c)!.members).toHaveLength(2); // still a member, elsewhere
});

test('une amorce posée devient un fantôme « absent » ; importer le nœud l’efface', () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), x = mk('X'), b = mk('B', p2);
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: x, role: 'target' }] })), 'connection');
  run(s, setBranches(s, c, [], true)); // nothing to do is not an error
  run(s, addMember(s, p1, c, { node: b, role: 'target' }));
  run(s, placeAbsent(s, p1, c, b, 300, 40, 1));
  const ph = [...s.phantoms.values()].find((x) => x.plan === p1)!;
  expect(ph).toMatchObject({ connection: c, of: { kind: 'absent', node: b }, x: 300, y: 40, k: 1 });
  expect(() => placeAbsent(s, p1, c, a, 0, 0, 0)).toThrow(/déjà dans ce plan/);
  expect(() => placeAbsent(s, p1, c, b, 0, 0, 0)).toThrow(/déjà/);
  run(s, placeNode(s, p1, b, 300, 40, 1));
  expect(s.phantoms.has(ph.id)).toBe(false);
});

test('supprimer une connexion la met à la corbeille avec ses branches et ses fantômes, dans tous les plans', () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), b = mk('B');
  for (const n of [a, b]) run(s, placeNode(s, p2, n, 0, 0, 0));
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, setBranches(s, c, [{ plan: p2, node: a }, { plan: p2, node: b }], true));
  run(s, splitArm(s, p1, c, b, { x: 10, y: 0, k: 0 }, { x: 900, y: 0, k: 0 }));
  const action = run(s, deleteConnection(s, c));
  expect(s.connections.get(c)!.trashedAt).toBeDefined();
  expect([...s.branches].some((b) => b.connection === c)).toBe(false);
  expect(s.phantoms.size).toBe(0);
  for (const op of invertAction(action).ops) applyOp(s, op);
  expect(s.connections.get(c)!.trashedAt).toBeUndefined();
  expect(s.branches.has({ plan: p2, connection: c, node: b })).toBe(true);
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
  run(s, movePhantom(s, phantom, 7, 8, undefined, 3));
  expect(s.phantoms.get(phantom)).toMatchObject({ x: 7, y: 8, k: 3 }); // its step can change too (I14 of the plan 3b review)
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

test('combine : plusieurs commandes forment une seule action, défaite d’un seul coup', () => {
  const { s, p1, mk } = world();
  const a = mk('A');
  let b = '';
  const action = combine(s, 'Créer et relier', [
    (st) => { const x = createNode(st, { plan: p1, title: 'B', x: 0, y: 0, k: 0 }); b = created(x, 'node'); return x; },
    (st) => connect(st, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] }),
  ]);
  expect(action.label).toBe('Créer et relier');
  const before = canonical({ nodes: [...s.nodes], connections: [...s.connections], branches: [...s.branches] });
  run(s, action);
  expect(s.nodes.has(b)).toBe(true);
  expect([...s.connections.values()].some((c) => c.members.some((m) => m.node === b))).toBe(true);
  run(s, invertAction(action));
  expect(canonical({ nodes: [...s.nodes], connections: [...s.connections], branches: [...s.branches] })).toBe(before);
});

test('combine : une étape refusée interrompt tout, l’état reçu reste intact', () => {
  const { s, p1, mk } = world();
  const a = mk('A');
  const before = canonical({ nodes: [...s.nodes], placements: [...s.placements] });
  expect(() => combine(s, 'x', [
    (st) => createNode(st, { plan: p1, title: 'B', x: 0, y: 0, k: 0 }),
    (st) => include(st, p1, a, a),
  ])).toThrow(CommandError);
  expect(canonical({ nodes: [...s.nodes], placements: [...s.placements] })).toBe(before);
});

test('disposition d’une connexion propre au plan : écrite, modifiée, effacée', () => {
  const { s, p1, p2, mk } = world();
  const a = mk('A'), b = mk('B');
  const c = created(run(s, connect(s, { plan: p1, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })), 'connection');
  run(s, setLayout(s, p1, c, { marker: { x: 5, y: 6 }, handles: {} }));
  expect(s.connLayouts.get(layoutKey(p1, c))).toEqual({ plan: p1, connection: c, marker: { x: 5, y: 6 }, handles: {} });
  expect(s.connLayouts.has(layoutKey(p2, c))).toBe(false);
  run(s, setLayout(s, p1, c, { angle: 1, handles: { [a]: { b1: { x: 1, y: 0 }, b2: { x: 0, y: 0 } } } }));
  expect(s.connLayouts.get(layoutKey(p1, c))!.angle).toBe(1);
  run(s, setLayout(s, p1, c, null));
  expect(s.connLayouts.has(layoutKey(p1, c))).toBe(false);
  expect(() => setLayout(s, p1, 'inconnue', null)).toThrow(/Connexion introuvable/);
});

test('préambule LaTeX (plan 4b, D5) : setPreamble le change, l’annuler rend le défaut, un même texte est refusé', () => {
  const s = emptyState();
  expect([s.preamble, preambleText(s)]).toEqual([null, DEFAULT_PREAMBLE]);
  const same = (text: string) => {
    expect(() => setPreamble(s, text)).toThrow(CommandError);
    expect(() => setPreamble(s, text)).toThrow('Le préambule est déjà celui-ci.');
  };
  // The default is in effect without being stored: setting it is setting the same text.
  same(DEFAULT_PREAMBLE);
  const text = `${DEFAULT_PREAMBLE}\\usepackage{tikz}\n`;
  const a = setPreamble(s, text);
  expect(s.preamble).toBeNull(); // computed, not applied
  run(s, a);
  expect(a.label).toBe('Modifier le préambule LaTeX');
  expect(a.ops).toEqual([{ t: 'preamble', before: null, after: { text } }]);
  expect([subjectOf(a.ops[0]), flowOf(a.ops[0])]).toEqual(['preamble', 'content']);
  expect(preambleText(s)).toBe(text);
  same(text);
  run(s, invertAction(a));
  expect([s.preamble, preambleText(s)]).toEqual([null, DEFAULT_PREAMBLE]);
});

test('remettre exactement le préambule par défaut l’écrit tel quel, et non null : l’historique garde ce qui a été choisi', () => {
  const s = emptyState();
  const mine = '\\documentclass{article}\n';
  run(s, setPreamble(s, mine));
  const back = run(s, setPreamble(s, DEFAULT_PREAMBLE));
  expect(back.ops).toEqual([{ t: 'preamble', before: { text: mine }, after: { text: DEFAULT_PREAMBLE } }]);
  expect(s.preamble).toEqual({ text: DEFAULT_PREAMBLE });
  expect(() => setPreamble(s, DEFAULT_PREAMBLE)).toThrow('Le préambule est déjà celui-ci.');
});

test('une opération de préambule au « avant » périmé, ou à l’enregistrement invalide, est refusée sans rien changer', () => {
  const s = emptyState();
  applyOp(s, { t: 'preamble', before: null, after: { text: 'A' } });
  expect(() => applyOp(s, { t: 'preamble', before: null, after: { text: 'B' } })).toThrow(OpConflictError);
  expect(() => applyOp(s, { t: 'preamble', before: { text: 'autre' }, after: null })).toThrow(OpConflictError);
  expect(() => applyOp(s, { t: 'preamble', before: { text: 'A' }, after: { text: 3 } as never })).toThrow(/invalid/);
  expect(() => applyOp(s, { t: 'preamble', before: null, after: null })).toThrow(/empty/);
  expect(s.preamble).toEqual({ text: 'A' });
});

test('R20 : le libellé d’une action est coupé à MAX_LABEL_CHARS, terminé par « … », sans couper un caractère en deux', () => {
  const { s, mk } = world();
  const X = mk('X');
  const a = editNode(s, X, { title: 'T'.repeat(MAX_LABEL_CHARS * 2) });
  expect(a.label).toHaveLength(MAX_LABEL_CHARS);
  expect(a.label.endsWith('…')).toBe(true);
  expect(a.label.startsWith('Modifier « TTT')).toBe(true);
  // A character outside the basic plane (two UTF-16 units) at the cut is not split.
  const cut = truncateLabel(`${'a'.repeat(MAX_LABEL_CHARS - 2)}😀😀`);
  expect(cut).toBe(`${'a'.repeat(MAX_LABEL_CHARS - 2)}…`);
  expect(truncateLabel('court')).toBe('court');
  expect(truncateLabel('x'.repeat(MAX_LABEL_CHARS))).toBe('x'.repeat(MAX_LABEL_CHARS));
});

test('R20 : annuler et rétablir une action au libellé le plus long gardent un libellé dans la borne', () => {
  const { s, mk } = world();
  const X = mk('X');
  const a = run(s, editNode(s, X, { title: 'T'.repeat(MAX_LABEL_CHARS * 2) }));
  const undo = invertAction(a);
  expect(undo.label.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
  expect(undo.label.startsWith('Annuler : Modifier')).toBe(true);
});
