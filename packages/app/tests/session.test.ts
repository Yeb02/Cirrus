import { type Action, applyOp, createNode, createPlan, editNode, emptyState, type Id, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { EditSession, plansOf } from '../src/renderer/session.ts';

function world() {
  const s = emptyState();
  const a = createPlan(s, 'Thèse', 'plan');
  for (const op of a.ops) applyOp(s, op);
  const plan = (a.ops[0] as { after: { id: Id } }).after.id;
  return { s, plan };
}
const nodeId = (a: Action) => (a.ops.find((o) => o.t === 'node' && o.before === null) as { after: { id: Id } }).after.id;

test('une action réussie s’applique, s’annule et se rétablit ; les plans touchés sont nommés', async () => {
  const { s, plan } = world();
  const written: Action[] = [];
  const changes: Action[] = [];
  const session = new EditSession(s, async (a) => { written.push(a); }, (_st, a) => { changes.push(a); });
  const r = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  expect(r.ok).toBe(true);
  const id = r.ok ? nodeId(r.action) : '';
  expect(session.state.nodes.has(id)).toBe(true);
  expect(r.ok && r.plans).toEqual([plan]);
  expect((await session.undo()).ok).toBe(true);
  expect(session.state.nodes.has(id)).toBe(false);
  expect((await session.redo()).ok).toBe(true);
  expect(session.state.nodes.has(id)).toBe(true);
  expect(written).toHaveLength(3);
  expect(changes).toHaveLength(3);
});

test('une écriture qui échoue laisse l’état intact et la pile en place', async () => {
  const { s, plan } = world();
  let fail = false;
  const session = new EditSession(s, async () => { if (fail) throw new Error('disque plein'); }, () => {});
  const r = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const id = r.ok ? nodeId(r.action) : '';
  fail = true;
  const failed = await session.run((st) => createNode(st, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  expect(failed).toEqual({ ok: false, message: 'disque plein' });
  expect(session.state.nodes.size).toBe(1);
  const undoFailed = await session.undo();
  expect(undoFailed.ok).toBe(false);
  expect(session.state.nodes.has(id)).toBe(true);
  fail = false;
  expect((await session.undo()).ok).toBe(true); // the stack did not move on the failed write
  expect(session.state.nodes.has(id)).toBe(false);
});

test('une commande refusée devient un message, sans écriture', async () => {
  const { s } = world();
  let writes = 0;
  const session = new EditSession(s, async () => { writes++; }, () => {});
  const r = await session.run((st) => editNode(st, 'inconnu', { title: 'x' }));
  expect(r).toEqual({ ok: false, message: 'Nœud introuvable.' });
  expect(writes).toBe(0);
  expect(await session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
  expect(await session.redo()).toEqual({ ok: false, message: 'Rien à rétablir.' });
});

test('annuler après une modification venue d’ailleurs : refusé proprement (Review Focus 1)', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, async () => {}, () => {});
  const r = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const id = r.ok ? nodeId(r.action) : '';
  // Another PC renames it (plan 5 will feed such changes through receive()).
  session.receive(editNode(session.state, id, { title: 'B' }));
  const u = await session.undo();
  expect(u.ok).toBe(false);
  expect(!u.ok && u.message).toMatch(/Impossible d’annuler/);
  expect(session.state.nodes.get(id)!.title).toBe('B');
});

test('deux actions lancées sans attendre s’exécutent dans l’ordre', async () => {
  const { s, plan } = world();
  const order: string[] = [];
  const session = new EditSession(s, async (a) => { await new Promise((r) => setTimeout(r, a.label.includes('A') ? 20 : 0)); order.push(a.label); }, () => {});
  const p1 = session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const p2 = session.run((st) => createNode(st, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  await Promise.all([p1, p2]);
  expect(order).toEqual(['Créer « A »', 'Créer « B »']);
});

test('plans touchés : ceux des placements, branches, dispositions et fantômes', () => {
  const { s, plan } = world();
  expect(plansOf(createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }))).toEqual([plan]);
  expect(plansOf(editNode({ ...s, nodes: new Map([['n', { id: 'n', title: 'x', summary: '', tags: [], files: [] }]]) } as State, 'n', { title: 'y' }))).toEqual([]);
});

test('une action complétée plus tard (répercussion plan par plan) se défait d’un seul Ctrl+Z (spec 10)', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, async () => {}, () => {});
  const first = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const id = first.ok ? first.action.id : '';
  const more = await session.run((st) => createNode(st, { plan, title: 'B', x: 0, y: 0, k: 0 }), { extend: id });
  expect(more.ok).toBe(true);
  expect(session.state.nodes.size).toBe(2);
  expect((await session.undo()).ok).toBe(true);
  expect(session.state.nodes.size).toBe(0);
  // An id no longer on top of the stack: the step is recorded on its own.
  const c = await session.run((st) => createNode(st, { plan, title: 'C', x: 0, y: 0, k: 0 }));
  await session.run((st) => createNode(st, { plan, title: 'D', x: 0, y: 0, k: 0 }));
  await session.run((st) => createNode(st, { plan, title: 'E', x: 0, y: 0, k: 0 }), { extend: c.ok ? c.action.id : '' });
  await session.undo();
  expect([...session.state.nodes.values()].map((n) => n.title).sort()).toEqual(['C', 'D']);
});

test('une garde passe avant Ctrl+Z et Ctrl+Y : elle peut écrire ce qui attend, ou refuser pendant un geste (I6 de la relecture 3b)', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, async () => {}, () => {});
  await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  let busy = true;
  session.setGuard(() => (busy ? 'Un geste est en cours.' : null));
  expect(await session.undo()).toEqual({ ok: false, message: 'Un geste est en cours.' });
  expect(session.state.nodes.size).toBe(1);
  // What waits (a Ctrl+wheel gesture before its pause) is written first, then undone.
  busy = false;
  session.setGuard(() => { void session.run((st) => createNode(st, { plan, title: 'B', x: 0, y: 0, k: 0 })); return null; });
  expect((await session.undo()).ok).toBe(true);
  expect([...session.state.nodes.values()].map((n) => n.title)).toEqual(['A']);
});
