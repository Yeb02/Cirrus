import {
  type Action, applyOps, canonical, createNode, createPlan, decodeState, editNode, emptyState, encodeState, type Id, include, type Reconciliation, type RemoteUnit,
  type State, SyncDivergedError, toSnapshot, type Unit, uuidv7,
} from '@cirrus/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import type { SyncStatus } from '../src/main/sync/client.ts';
import type { PairResult, ServerInfo, SyncIncoming } from '../src/main/sync/host.ts';
import { type Committed, EditSession, type Opened, SnapshotSaver } from '../src/renderer/session.ts';
import { chipOf, type SyncBridge, SyncSession, type SyncView } from '../src/renderer/sync/syncSession.ts';
import { offerAction, ServerBlock } from '../src/renderer/ui/settings/ServerBlock.tsx';

// The interface's side of the synchronisation (plan 5a, task 4): the session's reconciliation, in the same queue as the
// actions; the veil and the chip; the block « Serveur » of the settings.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const created = (a: Action, t: string): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

/** Plan P and its nodes X, G and H, written straight into the state. */
function world() {
  const s = emptyState();
  const plan = createPlan(s, 'P', 'plan');
  applyOps(s, plan.ops);
  const P = created(plan, 'plan');
  const node = (title: string, x: number) => {
    const a = createNode(s, { plan: P, title, x, y: 0, k: 0 });
    applyOps(s, a.ops);
    return created(a, 'node');
  };
  return { s, P, X: node('X', 0), G: node('G', 300), H: node('H', 600) };
}

const copy = (s: State): State => decodeState(encodeState(s));
const image = (s: State) => canonical(toSnapshot(s));

/** The server's numbers, one per line, for the writes of PC B. */
let lines = 0;
/** A write of PC B made on its own copy `t` (applied there), at time `at`, numbered by the server. */
function remote(t: State, build: (t: State) => Action, at: number): RemoteUnit {
  const a = build(t);
  applyOps(t, a.ops);
  return { unit: uuidv7(), action: a.id, label: a.label, at, pc: 'pc-b', ops: a.ops, seq: (lines += a.ops.length) };
}

/**
 * PC A's session, following its pending writes: each commit recorded and numbered, at the time `clock.at` (what the
 * main process gives: its clock corrected by the server's); the scene's changes recorded; `write`, the main process
 * writing a reconciliation (its journal number), held while `hold` is set.
 */
function following(s: State, clock = { at: 1000 }) {
  const commits: { action: Action; unit: Id }[] = [], changes: (Action | null)[] = [], writes: Reconciliation[] = [];
  let seq = 0, hold: Promise<void> | null = null;
  const session = new EditSession(s, async (a, unit): Promise<Committed> => {
    commits.push({ action: a, unit });
    return { seq: (seq += a.ops.length), at: clock.at };
  }, (_st, a) => { changes.push(a); }, 0, { pc: 'pc-a', pending: [] });
  const write = async (r: Reconciliation) => {
    writes.push(r);
    if (hold) await hold;
    return (seq += r.rewind.length + r.remote.slice(r.acked.length).reduce((n, u) => n + u.ops.length, 0) + r.rebased.reduce((n, u) => n + u.ops.length, 0));
  };
  return { session, commits, changes, writes, write, holdWrites: (p: Promise<void> | null) => { hold = p; } };
}

test('chaque écriture tire son identifiant et le passe au commit ; en attente avec l’heure du principal, ce PC ; deux de même clé : deux écritures, une action', async () => {
  const { s, X, G } = world();
  const { session, commits } = following(s, { at: 1234 });
  const r = await session.run((st) => editNode(st, X, { title: 'A' }));
  expect(r.ok).toBe(true);
  expect(commits[0].unit).toMatch(/^[0-9a-f-]{36}$/);
  expect(session.pending).toEqual([{ unit: commits[0].unit, action: commits[0].action.id, label: commits[0].action.label, at: 1234, pc: 'pc-a', ops: commits[0].action.ops }]);
  await session.run((st) => editNode(st, G, { title: 'G1' }), { merge: 'tex' });
  await session.run((st) => editNode(st, G, { title: 'G2' }), { merge: 'tex' });
  expect(session.pending.map((u) => u.action)).toEqual([commits[0].action.id, commits[1].action.id, commits[1].action.id]);
  expect(new Set(session.pending.map((u) => u.unit)).size).toBe(3);
  // A refused command or a failed write leaves nothing pending.
  expect((await session.run((st) => editNode(st, 'inconnu', { title: 'x' }))).ok).toBe(false);
  expect(session.pending).toHaveLength(3);
  // Without a server (no pending list given): nothing is kept.
  const alone = new EditSession(world().s, async () => ({ seq: 1, at: 0 }), () => {});
  await alone.run((st) => editNode(st, [...st.nodes.keys()][0], { title: 'B' }));
  expect(alone.pending).toEqual([]);
});

test('accusé de réception : l’écriture en attente, revenue telle quelle, quitte la liste ; l’état ne bouge pas, elle reste annulable', async () => {
  const { s, X } = world();
  const { session, changes, writes, write } = following(s);
  await session.run((st) => editNode(st, X, { title: 'A' }));
  const before = image(s);
  const out = await session.reconcile([{ ...session.pending[0], seq: 2 }], [], write);
  expect(out).toEqual({ notices: [], dropped: [] });
  expect(writes[0]).toMatchObject({ acked: [writes[0].remote[0].unit], rewind: [], rebased: [] });
  expect([session.pending, image(s), changes.length]).toEqual([[], before, 1]);
  expect((await session.undo()).ok).toBe(true);
  expect(s.nodes.get(X)!.title).toBe('X');
});

test('une écriture reçue sans rien en attente s’applique comme une action locale : une action pour la scène, ses opérations, rev + 1, le numéro du journal', async () => {
  const { s, X } = world();
  const { session, changes, write } = following(s);
  await session.run((st) => editNode(st, X, { title: 'A' }), { merge: 'k' });
  await session.reconcile([{ ...session.pending[0], seq: 2 }], [], write);
  // B has A's write, as the server numbered it, then renames X.
  const t = copy(s);
  const u = remote(t, (st) => editNode(st, X, { title: 'B' }), 5000);
  const rev = session.rev;
  await session.reconcile([u], [], write);
  expect(s.nodes.get(X)!.title).toBe('B');
  expect(changes.at(-1)!.ops).toEqual(u.ops);
  expect(session.rev).toBe(rev + 1);
  // The journal's lines: A's write, then B's (the acknowledgement numbered A's in place).
  expect(session.seq).toBe(2);
  // A change received separates two actions of the same merge key.
  const next = await session.run((st) => editNode(st, X, { title: 'C' }), { merge: 'k' });
  expect(next.ok && next.action.id).not.toBe(changes[0]!.id);
});

test('rejouer : la plus récente gagne ; une écriture réécrite quitte la pile, une écriture rejouée telle quelle y reste ; la scène reçoit inverses, reçues et rejouées en une action', async () => {
  const { s, X, G } = world();
  const t = copy(s);
  const { session, changes, writes, write } = following(s, { at: 3000 });
  await session.run((st) => editNode(st, X, { title: 'A' }));
  await session.run((st) => editNode(st, G, { title: 'G2' }));
  const [onX, onG] = session.pending;
  // B renamed X before A did (2000 < 3000): A's rename wins, rebased on B's.
  const u = remote(t, (st) => editNode(st, X, { title: 'B' }), 2000);
  expect(await session.reconcile([u], [], write)).toEqual({ notices: [], dropped: [] });
  const r = writes[0];
  expect(s.nodes.get(X)!.title).toBe('A');
  expect(session.pending).toEqual(r.rebased);
  expect(session.pending[0]).not.toBe(onX);
  expect(session.pending[1]).toBe(onG);
  expect(changes.at(-1)!.ops).toEqual([...r.rewind, ...u.ops, ...r.rebased.flatMap((x) => x.ops)]);
  // The rewritten rename left the stack: Ctrl+Z undoes G's edit, then nothing.
  expect((await session.undo()).ok).toBe(true);
  expect(s.nodes.get(G)!.title).toBe('G');
  expect(await session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
  // B renamed X later still: A's pending rename (now « A » over « B ») loses, and vanishes without a word.
  const v = remote(t, (st) => editNode(st, X, { title: 'B2' }), 9000);
  await session.reconcile([v], [], write);
  expect(s.nodes.get(X)!.title).toBe('B2');
  expect(session.pending.map((x) => x.label)).toEqual(['Modifier « G2 »', 'Annuler : Modifier « G2 »']);
});

test('écarter : une inclusion rejouée qui ajouterait une violation, ou une écriture refusée par le serveur, est nommée et quitte la pile', async () => {
  const { s, P, X, G, H } = world();
  const t = copy(s);
  const { session, write } = following(s, { at: 3000 });
  await session.run((st) => include(st, P, X, G));
  const u = remote(t, (st) => include(st, P, X, H), 2000);
  const out = await session.reconcile([u], [], write);
  expect(out.dropped).toEqual(['« Mettre « X » dans « G » » écartée : « X » est déjà dans le groupe « H », depuis un autre PC.']);
  expect(session.pending).toEqual([]);
  expect(await session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
  // Refused by the server: dropped, its change taken back.
  await session.run((st) => editNode(st, G, { title: 'Refusé' }));
  const { unit, label } = session.pending[0];
  const refused = await session.reconcile([], [{ unit, message: 'Refus du serveur.' }], write);
  expect(refused.dropped).toEqual([`« ${label} » écartée : Refus du serveur.`]);
  expect([s.nodes.get(G)!.title, session.pending]).toEqual(['G', []]);
  expect(await session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
});

test('une action locale lancée pendant une réconciliation passe après elle : écrite une fois la réconciliation écrite, en attente derrière', async () => {
  const { s, X, G } = world();
  const t = copy(s);
  const { session, commits, writes, write, holdWrites } = following(s);
  let release!: () => void;
  holdWrites(new Promise<void>((r) => { release = r; }));
  const u = remote(t, (st) => editNode(st, X, { title: 'B' }), 500);
  const reconciled = session.reconcile([u], [], write);
  const local = session.run((st) => editNode(st, G, { title: 'G2' }));
  await new Promise((r) => setTimeout(r, 20));
  expect([writes.length, commits.length]).toEqual([1, 0]);
  release();
  await Promise.all([reconciled, local]);
  expect(commits.map((c) => c.action.label)).toEqual(['Modifier « G2 »']);
  expect(session.pending.map((x) => x.label)).toEqual(['Modifier « G2 »']);
  expect([s.nodes.get(X)!.title, s.nodes.get(G)!.title]).toEqual(['B', 'G2']);
});

test('divergence : une écriture reçue qui ne s’applique pas lève SyncDivergedError ; état et écritures en attente intacts, rien d’écrit', async () => {
  const { s, X } = world();
  const { session, writes, write } = following(s);
  await session.run((st) => editNode(st, X, { title: 'A' }));
  const pending = session.pending, before = image(s);
  const bad: RemoteUnit = {
    unit: uuidv7(), action: uuidv7(), label: 'Ailleurs', at: 1, pc: 'pc-b', seq: 1,
    ops: [{ t: 'node', before: { ...s.nodes.get(X)!, title: 'jamais' }, after: { ...s.nodes.get(X)!, title: 'B' } }],
  };
  await expect(session.reconcile([bad], [], write)).rejects.toBeInstanceOf(SyncDivergedError);
  expect([writes.length, session.pending, image(s), session.broken]).toEqual([0, pending, before, false]);
});

test('une réconciliation que la base n’a pas pu écrire rompt la session ; reload relit l’état de la base, ses écritures en attente, pile vide, nouvel état pour la scène', async () => {
  const { s, X } = world();
  const t = copy(s);
  const fresh = copy(s);
  const { session, changes } = following(s);
  await session.run((st) => editNode(st, X, { title: 'A' }));
  const u = remote(t, (st) => editNode(st, X, { title: 'B' }), 500);
  await expect(session.reconcile([u], [], async () => { throw new Error('disque plein'); })).rejects.toThrow('disque plein');
  expect(session.broken).toBe(true);
  const kept: Unit = { unit: 'u-1', action: 'a-1', label: 'Gardée', at: 1, pc: 'pc-a', ops: [] };
  const rev = session.rev;
  await session.reload(async (): Promise<Opened> => ({ state: fresh, seq: 77, stale: false, pending: [kept], pc: 'pc-a' }));
  expect([session.state === fresh, session.broken, session.seq, session.pending, session.rev]).toEqual([true, false, 77, [kept], rev + 1]);
  expect(changes.at(-1)).toBeNull();
  expect(await session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
});

test('follow et unfollow : la liste des écritures en attente prise du principal dans la file des actions, puis lâchée', async () => {
  const { s, X } = world();
  const session = new EditSession(s, async () => ({ seq: 1, at: 5 }), () => {});
  const first: Unit = { unit: 'u-lobby', action: 'a-lobby', label: 'Créer le plan « Lobby »', at: 1, pc: 'pc-a', ops: [] };
  let asked = 0;
  const running = session.run((st) => editNode(st, X, { title: 'A' }));
  await session.follow('pc-a', async () => { asked++; return [first]; });
  await running;
  // Asked once the action before it was written: the list holds it (the main process read it after), then the next ones.
  expect(asked).toBe(1);
  await session.run((st) => editNode(st, X, { title: 'B' }));
  expect(session.pending.map((u) => u.unit)).toEqual(['u-lobby', session.pending[1].unit]);
  expect(session.pending[1]).toMatchObject({ at: 5, pc: 'pc-a', label: 'Modifier « B »' });
  await session.unfollow();
  expect(session.pending).toEqual([]);
});

test('la pastille : rien sans serveur ; « À jour », « Envoi de n actions… », « Hors ligne » (réessayer), « Serveur : raison » ; l’horloge en infobulle', () => {
  expect(chipOf({ state: 'off' }, false)).toBeNull();
  expect(chipOf({ state: 'live', pending: 0 }, false)).toMatchObject({ text: 'À jour', retry: false });
  expect(chipOf({ state: 'live', pending: 1 }, false)).toMatchObject({ text: 'Envoi de 1 action…', retry: false });
  expect(chipOf({ state: 'live', pending: 3 }, false)).toMatchObject({ text: 'Envoi de 3 actions…' });
  expect(chipOf({ state: 'offline', pending: 2 }, false)).toMatchObject({ text: 'Hors ligne', retry: true });
  expect(chipOf({ state: 'refused', message: 'Jeton révoqué.' }, false)).toMatchObject({ text: 'Serveur : Jeton révoqué.', retry: true });
  expect(chipOf({ state: 'catching-up', behind: 40 }, false)).toMatchObject({ text: 'Synchronisation…', retry: false });
  // Connecting after the veil gave up: « Hors ligne » (D8).
  expect(chipOf({ state: 'connecting' }, true)).toMatchObject({ text: 'Hors ligne', retry: true });
  expect(chipOf({ state: 'connecting' }, false)).toMatchObject({ text: 'Connexion…', retry: false });
  const warn = 'L\'horloge de ce PC diffère de celle du serveur de 7 minutes : règle-la.';
  expect(chipOf({ state: 'live', pending: 0, clockWarning: warn }, false)!.title).toContain(warn);
});

/** A bridge as the preload gives it, its calls recorded; the main process's messages sent by the test. */
function fakeBridge(o: { pending?: Unit[]; pair?: PairResult; first?: PairResult } = {}) {
  const calls: string[] = [];
  const reconciled: { id: number; outcome: unknown }[] = [];
  const listeners = { incoming: [] as ((m: SyncIncoming) => void)[], status: [] as ((s: SyncStatus) => void)[], veil: [] as (() => void)[] };
  const on = <K extends keyof typeof listeners>(k: K) => (fn: (typeof listeners)[K][number]) => {
    (listeners[k] as unknown[]).push(fn);
    return () => {};
  };
  let seq = 100;
  const bridge: SyncBridge = {
    syncStart: async () => { calls.push('start'); return { state: 'connecting' }; },
    syncRetry: () => { calls.push('retry'); },
    syncReconciled: async (id, outcome) => { reconciled.push({ id, outcome }); return 'reconciliation' in outcome ? ++seq : null; },
    syncPending: async () => { calls.push('pending'); return JSON.stringify(o.pending ?? []); },
    syncPair: async (url, code, name) => { calls.push(`pair ${url} ${code} ${name}`); return o.pair ?? { ok: true }; },
    syncFirst: async (choice) => { calls.push(`first ${choice}`); return o.first ?? { ok: true }; },
    syncUnpair: async () => { calls.push('unpair'); },
    syncServer: async (): Promise<ServerInfo> => ({ paired: false, url: '', name: 'PORTABLE' }),
    onSyncIncoming: on('incoming'),
    onSyncStatus: on('status'),
    onSyncVeil: on('veil'),
  };
  return {
    bridge, calls, reconciled,
    status: (s: SyncStatus) => { for (const fn of listeners.status) fn(s); },
    incoming: (m: SyncIncoming) => { for (const fn of listeners.incoming) fn(m); },
    veil: () => { for (const fn of listeners.veil) fn(); },
  };
}

/** The interface's SyncSession over a session of world(), its views and toasts recorded. */
function syncing(o: { pending?: Unit[]; pair?: PairResult; first?: PairResult; timeoutMs?: number } = {}) {
  const w = world();
  const fake = fakeBridge(o);
  const views: SyncView[] = [], toasts: string[] = [];
  let seq = 0;
  const session = new EditSession(w.s, async () => ({ seq: ++seq, at: 10 }), () => {});
  const reloads: number[] = [];
  const sync = new SyncSession({
    bridge: fake.bridge, session, timeoutMs: () => o.timeoutMs ?? 4000, toast: (t) => toasts.push(t), onView: (v) => views.push(v),
    load: async () => { reloads.push(1); return { state: copy(w.s), seq: 0, stale: false, pending: [], pc: 'pc-a' }; },
  });
  return { ...w, ...fake, session, sync, views, toasts, reloads, view: () => views.at(-1)! };
}

test('sans serveur jumelé, rien ne change : ni voile, ni pastille, ni démarrage', async () => {
  const { sync, calls, views } = syncing();
  await sync.open({ paired: false, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  expect(calls).toEqual([]);
  expect(views.every((v) => !v.veil && v.chip === null)).toBe(true);
});

test('jumelé au démarrage : le voile, jusqu’à « à jour » ; puis la pastille ; un clic sur « Hors ligne » réessaie', async () => {
  const { sync, calls, status, view, session } = syncing();
  const kept: Unit = { unit: 'u1', action: 'a1', label: 'x', at: 1, pc: 'pc-a', ops: [] };
  await sync.open({ paired: true, pc: 'pc-a', pending: [kept], timeoutMs: 4000 });
  expect(session.pending).toEqual([kept]);
  expect(calls).toEqual(['start']);
  expect(view().veil).toBe(true);
  status({ state: 'catching-up', behind: 30 });
  expect(view().veil).toBe(true);
  status({ state: 'live', pending: 0 });
  expect(view()).toMatchObject({ veil: false, chip: { text: 'À jour' } });
  status({ state: 'live', pending: 2 });
  expect(view().chip!.text).toBe('Envoi de 2 actions…');
  status({ state: 'offline', pending: 2 });
  expect(view().chip).toMatchObject({ text: 'Hors ligne', retry: true });
  sync.retry();
  expect(calls).toEqual(['start', 'retry']);
});

test('le voile se lève après syncConnectTimeoutMs sans réponse : la pastille dit « Hors ligne » ; au réveil, il revient, et « off » ne le lève pas', async () => {
  vi.useFakeTimers();
  const { sync, status, view, veil } = syncing({ timeoutMs: 4000 });
  await sync.open({ paired: true, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  status({ state: 'connecting' });
  await vi.advanceTimersByTimeAsync(3999);
  expect(view().veil).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(view()).toMatchObject({ veil: false, chip: { text: 'Hors ligne' } });
  status({ state: 'live', pending: 0 });
  // Waking up: the veil, while the client stops (off) and starts again.
  veil();
  expect(view().veil).toBe(true);
  status({ state: 'off' });
  status({ state: 'connecting' });
  expect(view().veil).toBe(true);
  status({ state: 'live', pending: 0 });
  expect(view().veil).toBe(false);
  // A refusal lifts it at once.
  veil();
  status({ state: 'refused', message: 'Format.' });
  expect(view()).toMatchObject({ veil: false, chip: { text: 'Serveur : Format.' } });
});

test('reçu : réconcilié par la session, écrit par le principal ; les écartées et les notifications en messages ; l’horloge dite une fois', async () => {
  const { sync, incoming, reconciled, toasts, status, s, X, P, G, H, session } = syncing();
  await sync.open({ paired: true, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  const t = copy(s);
  await session.run((st) => include(st, P, X, G));
  const u = remote(t, (st) => include(st, P, X, H), 0);
  incoming({ id: 7, units: [u], refused: [] });
  await vi.waitFor(() => expect(reconciled).toHaveLength(1));
  expect(reconciled[0]).toMatchObject({ id: 7 });
  // The received writes go back as their identifiers and numbers only (review of task 4, Minor 4): main has them.
  expect((reconciled[0].outcome as { reconciliation: { remote: unknown[] } }).reconciliation.remote).toEqual([{ unit: u.unit, seq: u.seq }]);
  await vi.waitFor(() => expect(toasts).toEqual(['« Mettre « X » dans « G » » écartée : « X » est déjà dans le groupe « H », depuis un autre PC.']));
  const warn = 'L\'horloge de ce PC diffère de celle du serveur de 7 minutes : règle-la.';
  status({ state: 'live', pending: 0, clockWarning: warn });
  status({ state: 'live', pending: 1, clockWarning: warn });
  expect(toasts.filter((x) => x === warn)).toHaveLength(1);
});

test('reçu qui diverge : le principal le sait (diverged), puis l’état refusé « diverged » fait relire l’état de la base', async () => {
  const { sync, incoming, reconciled, status, reloads, s, X } = syncing();
  await sync.open({ paired: true, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  const bad: RemoteUnit = {
    unit: uuidv7(), action: uuidv7(), label: 'Ailleurs', at: 1, pc: 'pc-b', seq: 1,
    ops: [{ t: 'node', before: { ...s.nodes.get(X)!, title: 'jamais' }, after: { ...s.nodes.get(X)!, title: 'B' } }],
  };
  incoming({ id: 3, units: [bad], refused: [] });
  await vi.waitFor(() => expect(reconciled).toHaveLength(1));
  expect(reconciled[0].outcome).toMatchObject({ diverged: expect.stringMatching(/^La base de ce PC ne suit plus celle du serveur/) });
  expect(reloads).toEqual([]);
  status({ state: 'refused', message: 'La base de ce PC ne suit plus celle du serveur : …', diverged: true });
  await vi.waitFor(() => expect(reloads).toEqual([1]));
});

test('jumeler : le principal jumelle, la session prend la liste des écritures en attente, puis la synchro démarre ; un refus est rendu ; dissocier', async () => {
  const lobby: Unit = { unit: 'u-lobby', action: 'a-lobby', label: 'Créer le plan « Lobby »', at: 1, pc: 'pc-a', ops: [] };
  const ok = syncing({ pending: [lobby] });
  await ok.sync.open({ paired: false, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  expect(await ok.sync.pair(' http://127.0.0.1:7310 ', 'ABCD-EFGH', 'Portable')).toEqual({ ok: true });
  expect(ok.calls).toEqual(['pair  http://127.0.0.1:7310  ABCD-EFGH Portable', 'pending', 'start']);
  expect(ok.session.pending).toEqual([lobby]);
  await ok.sync.unpair();
  expect(ok.calls.at(-1)).toBe('unpair');
  expect(ok.session.pending).toEqual([]);
  const no = syncing({ pair: { ok: false, message: 'Code de jumelage inconnu.' } });
  await no.sync.open({ paired: false, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  expect(await no.sync.pair('http://127.0.0.1:7310', 'X', 'P')).toEqual({ ok: false, message: 'Code de jumelage inconnu.' });
  expect(no.calls).toEqual(['pair http://127.0.0.1:7310 X P']);
});

test('le bloc « Serveur » : non jumelé, l’adresse, le code, le nom de ce PC et « Jumeler » ; jumelé, l’état et « Dissocier ce PC »', () => {
  const none = renderToStaticMarkup(createElement(ServerBlock, {
    info: { paired: false, url: '', name: 'PORTABLE' }, status: { state: 'off' }, onPair: async (): Promise<PairResult> => ({ ok: true }), onFirst: async (): Promise<PairResult> => ({ ok: true }), onUnpair: async () => {},
  }));
  for (const text of ['Adresse du serveur', 'Code de jumelage', 'Nom de ce PC', 'Jumeler', 'value="http://127.0.0.1:7310"', 'value="PORTABLE"']) expect(none).toContain(text);
  expect(none).not.toContain('Dissocier');
  const paired = renderToStaticMarkup(createElement(ServerBlock, {
    info: { paired: true, url: 'http://127.0.0.1:7310', name: 'Portable' }, status: { state: 'live', pending: 0 }, onPair: async (): Promise<PairResult> => ({ ok: true }), onFirst: async (): Promise<PairResult> => ({ ok: true }), onUnpair: async () => {},
  }));
  for (const text of ['http://127.0.0.1:7310', 'Portable', 'À jour', 'Dissocier ce PC']) expect(paired).toContain(text);
  expect(paired).not.toContain('Code de jumelage');
});

test('le premier jumelage (D7, tâche 5) : les boutons de l’offre et leurs nombres ; « Envoyer » fait suivre la session et démarre la synchro, « Prendre » attend le redémarrage', async () => {
  expect(offerAction({ kind: 'seed', nodes: 2, files: 1 })).toMatchObject({ choice: 'seed', label: 'Envoyer la base de ce PC au serveur (2 nœuds, 1 fichier)' });
  expect(offerAction({ kind: 'adopt', nodes: 1, archive: 'base-avant-jumelage-2026-11-08' })).toMatchObject({ choice: 'adopt', label: 'Prendre la base du serveur (1 nœud)' });
  expect(offerAction({ kind: 'replace', nodes: 0, local: 3, archive: 'base-avant-jumelage-2026-11-08' })).toMatchObject({ choice: 'adopt', label: 'Remplacer la base de ce PC par celle du serveur (0 nœud)' });
  // The question as the main process holds it (info.offer): the block shows it in place of the form.
  const asking = renderToStaticMarkup(createElement(ServerBlock, {
    info: { paired: false, url: 'http://127.0.0.1:7310', name: 'Portable', offer: { message: 'Le serveur tient déjà une base : ce PC peut la prendre.', offer: { kind: 'adopt', nodes: 3, archive: 'base-avant-jumelage-2026-11-08' } } },
    status: { state: 'off' }, onPair: async (): Promise<PairResult> => ({ ok: true }), onFirst: async (): Promise<PairResult> => ({ ok: true }), onUnpair: async () => {},
  }));
  for (const text of ['Le serveur tient déjà une base : ce PC peut la prendre.', 'Prendre la base du serveur (3 nœuds)', 'Annuler', '« base-avant-jumelage-2026-11-08 »']) expect(asking).toContain(text);
  expect(asking).not.toContain('Code de jumelage');
  const offer = { kind: 'seed', nodes: 2, files: 1 } as const;
  const asked = syncing({ pair: { ok: false, message: 'Le serveur ne tient encore aucune base.', offer } });
  await asked.sync.open({ paired: false, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  expect(await asked.sync.pair('http://127.0.0.1:7310', 'X', 'P')).toEqual({ ok: false, message: 'Le serveur ne tient encore aucune base.', offer });
  expect(asked.calls).toEqual(['pair http://127.0.0.1:7310 X P']);
  expect(await asked.sync.first('seed')).toEqual({ ok: true });
  expect(asked.calls).toEqual(['pair http://127.0.0.1:7310 X P', 'first seed', 'pending', 'start']);
  const taking = syncing({ first: { ok: true, restarting: true } });
  await taking.sync.open({ paired: false, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  expect(await taking.sync.first('adopt')).toEqual({ ok: true, restarting: true });
  expect(taking.calls).toEqual(['first adopt']);
});

test('revue, Important 2 : un instantané demandé pendant l’écriture d’une réconciliation ne se prend pas ; il se prend ensuite, au nouveau numéro, de l’état réconcilié', async () => {
  const { s, X, G } = world();
  const t = copy(s);
  let seq = 0, hold: Promise<void> | null = null, release!: () => void, saver: SnapshotSaver | null = null;
  const writes: Reconciliation[] = [];
  const session = new EditSession(s, async (a): Promise<Committed> => ({ seq: (seq += a.ops.length), at: 1 }), () => saver!.applied(), 0, { pc: 'pc-a', pending: [] });
  const saved: { state: State; seq: number }[] = [];
  saver = new SnapshotSaver(session, async (data, at) => { saved.push({ state: decodeState(data), seq: at }); }, () => ({ snapshotAfterActions: 100, snapshotIdleMs: 60_000 }), false);
  await session.run((st) => editNode(st, G, { title: 'G2' }));
  hold = new Promise<void>((r) => { release = r; });
  const u = remote(t, (st) => editNode(st, X, { title: 'B' }), 5000);
  const reconciled = session.reconcile([u], [], async (r) => {
    writes.push(r);
    await hold;
    return (seq += 10);
  });
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  // The state is reconciled, the base has not written it yet: no snapshot of it under the old number.
  await saver.flush();
  expect(saved).toEqual([]);
  release();
  await reconciled;
  await saver.flush();
  expect(saved.map((x) => x.seq)).toEqual([session.seq]);
  expect(image(saved[0].state)).toBe(image(s));
});

test('revue, Important 3 : le voile du démarrage dure le syncConnectTimeoutMs chargé, pas celui d’avant le chargement', async () => {
  vi.useFakeTimers();
  // The getter answers what App's ref holds before its first render with the settings: the defaults.
  const { sync, view } = syncing({ timeoutMs: 4000 });
  await sync.open({ paired: true, pc: 'pc-a', pending: [], timeoutMs: 1500 });
  await vi.advanceTimersByTimeAsync(1499);
  expect(view().veil).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(view().veil).toBe(false);
});

test('revue, Minor 3 : jumelé par le principal, mais la liste des écritures en attente ou le démarrage échoue : le jumelage reste dit fait, l’échec en message', async () => {
  const w = syncing();
  w.bridge.syncPending = async () => { throw new Error('IPC rompu'); };
  await w.sync.open({ paired: false, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  expect(await w.sync.pair('http://127.0.0.1:7310', 'CODE', 'Portable')).toEqual({ ok: true });
  expect(w.toasts.some((x) => x.includes('IPC rompu'))).toBe(true);
});

test('revue, Minor 5 : une vue de la synchro identique à la précédente n’est pas redonnée', async () => {
  const { sync, status, views } = syncing();
  await sync.open({ paired: true, pc: 'pc-a', pending: [], timeoutMs: 4000 });
  status({ state: 'live', pending: 0 });
  const n = views.length;
  status({ state: 'live', pending: 0 });
  status({ state: 'live', pending: 0 });
  expect(views.length).toBe(n);
  status({ state: 'live', pending: 1 });
  expect(views.length).toBe(n + 1);
});
