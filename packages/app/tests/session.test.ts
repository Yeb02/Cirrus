import { type Action, applyOp, canonical, createNode, createPlan, decodeState, editNode, emptyState, type Id, type State, toSnapshot } from '@cirrus/core';
import { expect, test, vi } from 'vitest';
import { EditSession, plansOf, SnapshotSaver } from '../src/renderer/session.ts';

function world() {
  const s = emptyState();
  const a = createPlan(s, 'Thèse', 'plan');
  for (const op of a.ops) applyOp(s, op);
  const plan = (a.ops[0] as { after: { id: Id } }).after.id;
  return { s, plan };
}
/** A commit as the main process answers it: the journal number of the action's last line. */
const numbered = () => { let seq = 0; return async (a: Action) => (seq += a.ops.length); };
const nodeId = (a: Action) => (a.ops.find((o) => o.t === 'node' && o.before === null) as { after: { id: Id } }).after.id;

test('une action réussie s’applique, s’annule et se rétablit ; les plans touchés sont nommés', async () => {
  const { s, plan } = world();
  const written: Action[] = [];
  const changes: Action[] = [];
  const session = new EditSession(s, async (a) => { written.push(a); return written.length; }, (_st, a) => { changes.push(a); });
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

test('l’action s’applique sur l’état même, et rev augmente à chaque changement', async () => {
  const { s, plan } = world();
  const changes: [State, Action, number][] = [];
  const session = new EditSession(s, numbered(), (st, a, rev) => { changes.push([st, a, rev]); });
  expect(session.rev).toBe(0);
  const r = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  expect(session.state).toBe(s);
  expect(s.nodes.has(r.ok ? nodeId(r.action) : '')).toBe(true);
  await session.undo();
  session.receive(createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 }), 7);
  expect(changes.map(([st, a, rev]) => [st === s, a.label, rev])).toEqual([
    [true, 'Créer « A »', 1], [true, 'Annuler : Créer « A »', 2], [true, 'Créer « B »', 3],
  ]);
  expect(session.rev).toBe(3);
});

test('un commit qui échoue laisse l’état et rev inchangés', async () => {
  const { s, plan } = world();
  let calls = 0;
  const session = new EditSession(s, async () => { throw new Error('principal indisponible'); }, () => { calls++; });
  const before = canonical(toSnapshot(s));
  expect(await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }))).toEqual({ ok: false, message: 'principal indisponible' });
  expect(canonical(toSnapshot(s))).toBe(before);
  expect([session.rev, calls]).toEqual([0, 0]);
});

test('une écriture qui échoue laisse l’état intact et la pile en place', async () => {
  const { s, plan } = world();
  let fail = false;
  const session = new EditSession(s, async () => { if (fail) throw new Error('disque plein'); return 1; }, () => {});
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
  const session = new EditSession(s, async () => ++writes, () => {});
  const r = await session.run((st) => editNode(st, 'inconnu', { title: 'x' }));
  expect(r).toEqual({ ok: false, message: 'Nœud introuvable.' });
  expect(writes).toBe(0);
  expect(await session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
  expect(await session.redo()).toEqual({ ok: false, message: 'Rien à rétablir.' });
});

test('annuler après une modification venue d’ailleurs : refusé proprement (Review Focus 1)', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, numbered(), () => {});
  const r = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const id = r.ok ? nodeId(r.action) : '';
  // Another PC renames it (plan 5 will feed such changes through receive()).
  session.receive(editNode(session.state, id, { title: 'B' }), 2);
  const u = await session.undo();
  expect(u.ok).toBe(false);
  expect(!u.ok && u.message).toMatch(/Impossible d’annuler/);
  expect(session.state.nodes.get(id)!.title).toBe('B');
});

test('deux actions lancées sans attendre s’exécutent dans l’ordre', async () => {
  const { s, plan } = world();
  const order: string[] = [];
  const session = new EditSession(s, async (a) => { await new Promise((r) => setTimeout(r, a.label.includes('A') ? 20 : 0)); return order.push(a.label); }, () => {});
  const p1 = session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const p2 = session.run((st) => createNode(st, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  await Promise.all([p1, p2]);
  expect(order).toEqual(['Créer « A »', 'Créer « B »']);
});

test('plans touchés : ceux des placements, branches, dispositions et fantômes', () => {
  const { s, plan } = world();
  expect(plansOf(createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }))).toEqual([plan]);
  applyOp(s, { t: 'node', before: null, after: { id: 'n', title: 'x', summary: '', tags: [], files: [] } });
  expect(plansOf(editNode(s, 'n', { title: 'y' }))).toEqual([]);
});

test('une action complétée plus tard (répercussion plan par plan) se défait d’un seul Ctrl+Z (spec 10)', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, numbered(), () => {});
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
  const session = new EditSession(s, numbered(), () => {});
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

test('la session tient seq : le numéro rendu par le commit de la dernière action appliquée, ou celui d’un changement reçu', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, numbered(), () => {}, 40);
  expect(session.seq).toBe(40);
  await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  expect(session.seq).toBe(2);
  session.receive(createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 }), 9);
  expect(session.seq).toBe(9);
  // A failed write leaves it as it was.
  const failing = new EditSession(s, async () => { throw new Error('non'); }, () => {}, 9);
  await failing.run((st) => createNode(st, { plan, title: 'C', x: 0, y: 0, k: 0 }));
  expect(failing.seq).toBe(9);
});

test('une action écrite qui ne s’applique plus à la copie : la session est rompue, et ne garde pas ce numéro', async () => {
  const { s, plan } = world();
  const session = new EditSession(s, numbered(), () => {}, 1);
  const r = await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const id = r.ok ? nodeId(r.action) : '';
  expect(session.broken).toBe(false);
  // The same creation again, received: its "before" (absent) no longer holds.
  expect(() => session.receive(r.ok ? r.action : (null as never), 5)).toThrow();
  expect([session.broken, session.seq, s.nodes.has(id)]).toEqual([true, 2, true]);
});

/** A saver over a session, its snapshots recorded; timers are vitest's. */
function saving(stale = false, timing = { snapshotAfterActions: 3, snapshotIdleMs: 2000 }) {
  const { s, plan } = world();
  const saved: { state: State; seq: number }[] = [];
  let saver: SnapshotSaver | null = null;
  const session = new EditSession(s, numbered(), () => saver!.applied(), 0);
  saver = new SnapshotSaver(session, async (data, seq) => { saved.push({ state: decodeState(data), seq }); }, () => timing, stale);
  const act = (title: string) => session.run((st) => createNode(st, { plan, title, x: 0, y: 0, k: 0 }));
  return { s, session, saver, saved, act };
}

test('instantané après snapshotAfterActions actions, avec le numéro couvert, et l’état décodé égal à celui de la session', async () => {
  vi.useFakeTimers();
  try {
    const { s, saved, act } = saving();
    await act('A');
    await act('B');
    expect(saved).toHaveLength(0);
    await act('C');
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.map((x) => x.seq)).toEqual([6]);
    expect(canonical(toSnapshot(saved[0].state))).toBe(canonical(toSnapshot(s)));
  } finally {
    vi.useRealTimers();
  }
});

test('instantané au repos : snapshotIdleMs sans action ni saisie ; une saisie relance l’attente ; rien quand rien n’a changé', async () => {
  vi.useFakeTimers();
  try {
    const { saver, saved, act } = saving();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saved).toHaveLength(0);
    await act('A');
    await vi.advanceTimersByTimeAsync(1500);
    saver.touch();
    await vi.advanceTimersByTimeAsync(1500);
    expect(saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(saved.map((x) => x.seq)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saved).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test('à la fermeture : instantané si quelque chose a changé, sinon rien ; un instantané périmé au chargement est refait au repos', async () => {
  vi.useFakeTimers();
  try {
    const { saver, saved, act } = saving();
    await saver.flush();
    expect(saved).toHaveLength(0);
    await act('A');
    await saver.flush();
    expect(saved.map((x) => x.seq)).toEqual([2]);
    await saver.flush();
    expect(saved).toHaveLength(1);
    const stale = saving(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stale.saved.map((x) => x.seq)).toEqual([0]);
  } finally {
    vi.useRealTimers();
  }
});

test('une session rompue n’envoie plus d’instantané', async () => {
  const { session, saver, saved, act } = saving();
  const r = await act('A');
  expect(() => session.receive(r.ok ? r.action : (null as never), 5)).toThrow();
  await saver.flush();
  expect(saved).toHaveLength(0);
});

test('un instantané que le principal n’a pas pu garder est refait : rien n’est oublié', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { s, plan } = world();
    let fail = true;
    const saved: number[] = [];
    let saver: SnapshotSaver | null = null;
    const session = new EditSession(s, numbered(), () => saver!.applied(), 0);
    saver = new SnapshotSaver(session, async (_data, seq) => { if (fail) throw new Error('disque plein'); saved.push(seq); }, () => ({ snapshotAfterActions: 100, snapshotIdleMs: 2000 }), false);
    await session.run((st) => createNode(st, { plan, title: 'A', x: 0, y: 0, k: 0 }));
    await saver.flush();
    expect([saved, warn.mock.calls.length]).toEqual([[], 1]);
    fail = false;
    await saver.flush();
    expect(saved).toEqual([2]);
  } finally {
    warn.mockRestore();
  }
});
