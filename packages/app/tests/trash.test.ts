import {
  type Action, type Anchor, applyOps, connect, createAnnotation, createNode, createPlan, deleteConnection, deleteEverywhere, emptyState, groupOf, type Id, include,
  placementKey, placeNode, removeFromPlan, RESTORE_CONNECTION_LOST, RESTORE_NODE_NOT_IN_TRASH, restoreNode, type State, type Vec2,
} from '@cirrus/core';
import { buildScene, DEFAULT_PARAMS as P, offsetPolygon, type SceneItem } from '@cirrus/view';
import { afterEach, expect, test, vi } from 'vitest';
import { readableStep, restoreBuild, restoreConnectionBuild } from '../src/renderer/actions.ts';
import { EditSession } from '../src/renderer/session.ts';
import {
  filterTrash, restoreNotice, restoreRefusal, RESTORED_WITHOUT_BRANCH, trashCache, trashCloseGivesUp, trashDate, trashRows,
} from '../src/renderer/trash.ts';

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

test('trashRows : une connexion réduite à un nœud est listée mais non restaurable — le cœur la refuserait toujours — ; une connexion de deux nœuds et un nœud le sont', async () => {
  const { s, plan, mk, session } = world();
  const A = mk('A'), B = mk('B'), X = mk('X'), Y = mk('Y');
  const ab = idOf(run(s, connect(s, { plan, members: [{ node: A, role: 'source' }, { node: B, role: 'target' }] })), 'connection');
  const xy = idOf(run(s, connect(s, { plan, members: [{ node: X, role: 'source' }, { node: Y, role: 'target' }] })), 'connection');
  run(s, deleteConnection(s, ab));
  // X deleted everywhere takes its connection with it, which keeps Y alone.
  run(s, deleteEverywhere(s, X));
  expect(s.connections.get(xy)!.members.map((m) => m.node)).toEqual([Y]);
  const row = (id: Id) => trashRows(s).find((r) => r.id === id);
  expect(row(xy)).toMatchObject({ kind: 'connection', restorable: false });
  expect(row(ab)).toMatchObject({ kind: 'connection', restorable: true });
  expect(row(X)).toMatchObject({ kind: 'node', restorable: true });
  // The reason shown is the core's own refusal, word for word.
  expect(await session.run(restoreConnectionBuild(xy)!)).toEqual({ ok: false, message: RESTORE_CONNECTION_LOST });
  expect(RESTORE_CONNECTION_LOST).toBe('Il reste moins de deux nœuds à cette connexion : elle ne peut pas revenir.');
  // Two members, one of them still in the trash: it will come back once the node does (« restaure-les d’abord »).
  run(s, deleteEverywhere(s, B));
  expect(row(ab)).toMatchObject({ restorable: true });
});

test('trashRows : avec les lignes d’avant, une ligne dont l’heure, le titre et la restaurabilité n’ont pas changé est reprise telle quelle (le même objet), une autre refaite', () => {
  const { s, plan, mk } = world();
  const A = mk('A'), B = mk('B'), C = mk('C');
  at(T0, () => run(s, removeFromPlan(s, plan, A)));
  at(T0 + 1000, () => run(s, removeFromPlan(s, plan, B)));
  const first = trashRows(s), cache = trashCache(first);
  expect(first.map((r) => r.id)).toEqual([B, A]);
  // C is thrown away, and B comes back from a synchronisation retitled (a change from another PC), A as it was.
  at(T0 + 2000, () => run(s, removeFromPlan(s, plan, C)));
  const rec = s.nodes.get(B)!;
  applyOps(s, [{ t: 'node', before: rec, after: { ...rec, title: 'B bis' } }]);
  const next = trashRows(s, cache);
  const was = (id: Id) => first.find((r) => r.id === id), now = (id: Id) => next.find((r) => r.id === id);
  expect(next.map((r) => r.id)).toEqual([C, B, A]);
  expect(now(A)).toBe(was(A));
  expect(now(B)).not.toBe(was(B));
  expect(now(B)).toMatchObject({ title: 'B bis', at: T0 + 1000 });
  expect(now(C)).toMatchObject({ title: 'C', label: 'nœud' });
  // Nothing changed since: every row is the one before.
  const again = trashRows(s, trashCache(next));
  expect(again).toHaveLength(3);
  again.forEach((r, i) => expect(r).toBe(next[i]));
  // The rows of an object that left the trash are not kept; one thrown away anew, at another moment, is made again.
  run(s, restoreNode(s, A, plan, 0, 900, 0));
  at(T0 + 5000, () => run(s, removeFromPlan(s, plan, A)));
  const back = trashRows(s, trashCache(again));
  expect(back.map((r) => r.id)).toEqual([A, C, B]);
  expect(back[0]).not.toBe(again.find((r) => r.id === A));
  expect(back[0].at).toBe(T0 + 5000);
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

test('restoreNotice : une connexion rendue sans branche — ses nœuds ne partagent aucun plan — le dit ; avec une branche, rien', async () => {
  const { s, lobby, plan, mk, session } = world();
  const A = mk('A'), B = mk('B'), C = mk('C');
  const link = (members: Id[]) => idOf(run(s, connect(s, { plan, members: members.map((node, i) => ({ node, role: i === 0 ? 'source' : 'target' })) })), 'connection');
  const ab = link([A, B]), bc = link([B, C]);
  run(s, deleteConnection(s, ab));
  run(s, deleteConnection(s, bc));
  // A goes to the lobby and leaves P: A and B share no plan any more; B and C still do.
  run(s, placeNode(s, lobby, A, 0, 0, 0));
  run(s, removeFromPlan(s, plan, A));
  const alone = await session.run(restoreConnectionBuild(ab)!);
  expect(alone.ok).toBe(true);
  expect(branchesOf(s, ab)).toEqual([]);
  expect(alone.ok && restoreNotice(alone.action)).toBe(RESTORED_WITHOUT_BRANCH);
  expect(RESTORED_WITHOUT_BRANCH).toBe('Connexion restaurée ; aucun plan ne réunit deux de ses nœuds.');
  const shown = await session.run(restoreConnectionBuild(bc)!);
  expect(branchesOf(s, bc)).toEqual([`${plan}|${B}`, `${plan}|${C}`].sort());
  expect(shown.ok && restoreNotice(shown.action)).toBeNull();
});

test('restoreRefusal : un nœud qui n’est plus à la corbeille — ou qui n’est plus là — est refusé avant toute pose, du message même du cœur', async () => {
  const { s, plan, mk, session } = world();
  const A = mk('A');
  run(s, removeFromPlan(s, plan, A));
  expect(restoreRefusal(s.nodes.get(A))).toBeNull();
  const sc = buildScene(s, plan, measure, P);
  expect((await session.run(restoreBuild(sc, A, { x: 0, y: 900 }, 1, P)!)).ok).toBe(true);
  // A stale row: the node is back in a plan, no ghost must follow the cursor.
  expect(restoreRefusal(s.nodes.get(A))).toBe(RESTORE_NODE_NOT_IN_TRASH);
  expect(restoreRefusal(undefined)).toBe(RESTORE_NODE_NOT_IN_TRASH);
  expect(await session.run(restoreBuild(sc, A, { x: 0, y: 1800 }, 1, P)!)).toEqual({ ok: false, message: RESTORE_NODE_NOT_IN_TRASH });
});

test('trashCloseGivesUp : fermer le panneau abandonne la pose d’un nœud restauré, non celle d’un autre geste', () => {
  expect(trashCloseGivesUp({ kind: 'restore' })).toBe(true);
  for (const kind of ['newNode', 'exclude', 'connect', 'import', 'paste', 'repercussion', 'split', 'bib']) expect(trashCloseGivesUp({ kind })).toBe(false);
  expect(trashCloseGivesUp(null)).toBe(false);
});
