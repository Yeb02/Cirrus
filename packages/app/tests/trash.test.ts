import {
  type Action, type Anchor, applyOps, connect, createAnnotation, createNode, createPlan, deleteConnection, deleteEverywhere, emptyState, groupOf, type Id, include,
  placementKey, removeFromPlan, type State, type Vec2,
} from '@cirrus/core';
import { buildScene, DEFAULT_PARAMS as P, offsetPolygon, type SceneItem } from '@cirrus/view';
import { afterEach, expect, test, vi } from 'vitest';
import { readableStep, restoreBuild, restoreConnectionBuild } from '../src/renderer/actions.ts';
import { EditSession } from '../src/renderer/session.ts';
import { filterTrash, trashDate, trashRows } from '../src/renderer/trash.ts';

// The trash's panel (plan 6a, task 4, D5), without its screen: the rows it lists and their filter, and the builds of its
// « Restaurer » — a node put down in the plan shown, a connection given back its branches. The panel itself, and the ghost
// that follows the cursor, are driven by the interface scenario.

afterEach(() => { vi.restoreAllMocks(); });

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const idOf = (a: Action, t: 'plan' | 'node' | 'connection'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
/** A commit as the main process answers it: the journal number of the action's last line. */
const numbered = () => { let seq = 0; return async (a: Action) => ({ seq: (seq += a.ops.length), at: 0 }); };
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));
const T0 = Date.UTC(2026, 10, 10, 9, 5);
/** The command run at time `t` (its trashedAt). */
const at = <T>(t: number, fn: () => T): T => {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(t);
  try { return fn(); } finally { spy.mockRestore(); }
};
/** A point of a group's padding, under its members: a node put down there enters it. */
const inPadding = (g: SceneItem): Vec2 => {
  const outer = offsetPolygon(g.hull!, g.pad!), inner = offsetPolygon(g.hull!, g.pad! * 0.4);
  return inner[outer.reduce((best, v, j) => (v.y > outer[best].y ? j : best), 0)];
};
const branchesOf = (s: State, c: Id) => [...s.branches].filter((b) => b.connection === c).map((b) => `${b.plan}|${b.node}`).sort();

/** Plan P and the lobby; `mk` a node placed in P; a session over the state. */
function world() {
  const s = emptyState();
  const lobby = idOf(run(s, createPlan(s, 'Lobby', 'lobby')), 'plan'), plan = idOf(run(s, createPlan(s, 'P', 'plan')), 'plan');
  let x = 0;
  const mk = (title: string, where = plan) => idOf(run(s, createNode(s, { plan: where, title, x: (x += 400), y: 0, k: 0 })), 'node');
  const session = new EditSession(s, numbered(), () => {});
  return { s, lobby, plan, mk, session };
}

const anchor = (pdf: Id): Anchor => ({ pdf, file: 'chapitre.pdf', hash: '0123456789abcdef'.repeat(4), page: 1, rects: [[72, 581, 300, 594.8]], text: 'Un passage souligné' });

// ---------------------------------------------------------------------------------------------------------------------
// The list

test('trashRows : chaque objet jeté avec son genre — nœud, connexion, annotation —, son titre et sa date courte, du plus récent au plus ancien', () => {
  const { s, plan, mk } = world();
  const A = mk('Énoncé'), B = mk('Preuve'), C = mk('');
  const ab = idOf(run(s, connect(s, { plan, members: [{ node: A, role: 'source' }, { node: B, role: 'target' }] })), 'connection');
  const note = idOf(run(s, createAnnotation(s, anchor(A), 'Un passage souligné')), 'node');
  at(T0, () => run(s, deleteConnection(s, ab)));
  at(T0 + 60_000, () => run(s, deleteEverywhere(s, note)));
  at(T0 + 120_000, () => run(s, removeFromPlan(s, plan, C)));
  const rows = trashRows(s);
  expect(rows.map((r) => [r.id, r.kind, r.label, r.title])).toEqual([
    [C, 'node', 'nœud', 'Sans titre'],
    [note, 'node', 'annotation', 'Un passage souligné'],
    [ab, 'connection', 'connexion', 'la connexion entre « Énoncé » et « Preuve »'],
  ]);
  expect(rows.map((r) => r.at)).toEqual([T0 + 120_000, T0 + 60_000, T0]);
  expect(rows[2].when).toBe(trashDate(T0));
});

test('trashDate : la date et l’heure courtes, à la française, à l’heure de ce PC', () => {
  const d = new Date(T0), two = (n: number) => String(n).padStart(2, '0');
  expect(trashDate(T0)).toBe(`${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`);
});

test('filterTrash : par le titre, sans casse ni accents ; rien de tapé, toute la liste', () => {
  const { s, plan, mk } = world();
  for (const t of ['Énoncé du théorème', 'Preuve', 'Cœur de l’argument']) run(s, removeFromPlan(s, plan, mk(t)));
  const rows = trashRows(s);
  const titles = (text: string) => filterTrash(rows, text).map((r) => r.title).sort();
  expect(titles('')).toEqual(['Cœur de l’argument', 'Preuve', 'Énoncé du théorème']);
  expect(titles('ENONCE')).toEqual(['Énoncé du théorème']);
  expect(titles('theor')).toEqual(['Énoncé du théorème']);
  expect(titles('coeur')).toEqual(['Cœur de l’argument']);
  expect(titles('  preuve  ')).toEqual(['Preuve']);
  expect(titles('rien')).toEqual([]);
});

test('la liste suit l’état : une restauration, son Ctrl+Z, une écriture reçue d’un autre PC', async () => {
  const { s, plan, mk, session } = world();
  const A = mk('A'), B = mk('B');
  run(s, removeFromPlan(s, plan, A));
  expect(trashRows(s).map((r) => r.id)).toEqual([A]);
  const sc = buildScene(s, plan, measure, P);
  expect((await session.run(restoreBuild(sc, A, { x: 0, y: 900 }, 1, P)!)).ok).toBe(true);
  expect(trashRows(s)).toEqual([]);
  expect((await session.undo()).ok).toBe(true);
  expect(trashRows(s).map((r) => r.id)).toEqual([A]);
  // What a synchronisation applies: an action of another PC's.
  at(T0, () => run(s, deleteEverywhere(s, B)));
  expect(trashRows(s).map((r) => r.id).sort()).toEqual([A, B].sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// « Restaurer »

test('restoreBuild : le nœud jeté posé dans le plan actuel, au cran lisible à ce zoom, comme un collage ; une action, qu’un Ctrl+Z défait', async () => {
  const { s, lobby, plan, mk, session } = world();
  const A = mk('A', lobby);
  run(s, removeFromPlan(s, lobby, A));
  const sc = buildScene(s, plan, measure, P), where = { x: 5000, y: 5000 };
  const r = await session.run(restoreBuild(sc, A, where, 0.25, P)!);
  expect(r.ok && r.action.label).toBe('Restaurer « A »');
  expect(s.nodes.get(A)!.trashedAt).toBeUndefined();
  expect(s.placements.get(placementKey(plan, A))).toMatchObject({ x: 5000, y: 5000, k: readableStep(0.25, P) });
  expect(readableStep(0.25, P)).toBe(2);
  // Not where it was: the plan shown.
  expect(s.placements.has(placementKey(lobby, A))).toBe(false);
  expect((await session.undo()).ok).toBe(true);
  expect(s.nodes.get(A)!.trashedAt).toBeDefined();
  expect(s.placements.has(placementKey(plan, A))).toBe(false);
});

test('restoreBuild : posé dans l’enveloppe d’un groupe, il y entre, dans la même action ; un Ctrl+Z rend tout', async () => {
  const { s, plan, mk, session } = world();
  const G = mk('Groupe'), M = mk('Membre'), A = mk('A');
  run(s, include(s, plan, M, G));
  run(s, removeFromPlan(s, plan, A));
  const sc = buildScene(s, plan, measure, P), g = sc.items[sc.byId.get(G)!];
  expect(g.kind).toBe('group');
  const r = await session.run(restoreBuild(sc, A, inPadding(g), 1, P)!);
  expect(r.ok && r.action.label).toBe('Restaurer « A »');
  expect(groupOf(s, plan, A)).toBe(G);
  expect((await session.undo()).ok).toBe(true);
  expect(s.nodes.get(A)!.trashedAt).toBeDefined();
  expect(groupOf(s, plan, A)).toBeUndefined();
});

test('restoreBuild : un nœud qui n’est plus à la corbeille quand la pose se fait (rendu ailleurs entre-temps) est refusé, rien n’est écrit', async () => {
  const { s, plan, mk, session } = world();
  const A = mk('A');
  run(s, removeFromPlan(s, plan, A));
  const sc = buildScene(s, plan, measure, P), late = restoreBuild(sc, A, { x: 0, y: 900 }, 1, P)!;
  expect((await session.run(restoreBuild(sc, A, { x: 0, y: 1800 }, 1, P)!)).ok).toBe(true);
  const rev = session.rev;
  expect(await session.run(late)).toEqual({ ok: false, message: 'Ce nœud n’est pas à la corbeille.' });
  expect(session.rev).toBe(rev);
});

test('restoreConnectionBuild : la connexion revient avec ses branches là où ses nœuds sont ; refusée, le message du cœur ; un Ctrl+Z la rejette', async () => {
  const { s, plan, mk, session } = world();
  const A = mk('A'), B = mk('B');
  const ab = idOf(run(s, connect(s, { plan, title: 'Implique', members: [{ node: A, role: 'source' }, { node: B, role: 'target' }] })), 'connection');
  run(s, deleteConnection(s, ab));
  const r = await session.run(restoreConnectionBuild(ab)!);
  expect(r.ok && r.action.label).toBe('Restaurer « Implique »');
  expect(branchesOf(s, ab)).toEqual([`${plan}|${A}`, `${plan}|${B}`].sort());
  expect((await session.undo()).ok).toBe(true);
  expect(s.connections.get(ab)!.trashedAt).toBeDefined();
  expect(branchesOf(s, ab)).toEqual([]);
  // A node of it thrown away meanwhile: refused, said in French.
  run(s, deleteEverywhere(s, B));
  expect(await session.run(restoreConnectionBuild(ab)!)).toEqual({ ok: false, message: 'Ses nœuds sont à la corbeille : restaure-les d’abord.' });
});
