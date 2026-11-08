import {
  type Action, applyOps, CommandError, decodeState, encodeState, type Id, type Op, type Reconciliation, reconcile, type RemoteUnit, type State, type Unit,
  UndoConflictError, UndoStack, uuidv7,
} from '@cirrus/core';
import type { Committed } from '../main/sync/host.ts';

export type { Committed };

export type Result = { ok: true; action: Action; plans: Id[] } | { ok: false; message: string };

/** The plans an action changes the layout of (content changes concern every plan). */
export function plansOf(a: Action): Id[] {
  const plans = new Set<Id>();
  for (const op of a.ops) {
    if (op.t === 'placement' || op.t === 'connLayout' || op.t === 'phantom') {
      const r = op.after ?? op.before;
      if (r) plans.add(r.plan);
    } else if (op.t === 'branch') plans.add(op.key.plan);
  }
  return [...plans];
}

/** The message of an error coming back from IPC ("Error invoking remote method 'x': Error: message"). */
export const messageOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const i = m.lastIndexOf('Error: ');
  return i >= 0 ? m.slice(i + 'Error: '.length) : m;
};

/**
 * What cirrus:load sends: a snapshot, the journal's operations after it (JSON), and the journal number they reach; the
 * pending writes (JSON: all of them with a server paired, none otherwise, plan 5a) and this PC's identifier.
 */
export interface Loaded { data: ArrayBuffer; tail: string; seq: number; pending: string; pc: string }

/**
 * The state the interface opens with (plan 3c, decision 4): `seq`, the journal number it covers; `stale`, whether the
 * snapshot did not cover all of it (the journal's tail was replayed: one is due); `fallback`, why the snapshot sent
 * first could not be used, when the state had to be read from the base's tables instead. `pending`, the base's pending
 * writes (with a server paired), and `pc`, this PC's identifier (plan 5a).
 */
export interface Opened { state: State; seq: number; stale: boolean; fallback?: string; pending: Unit[]; pc: string }

/**
 * Decodes the snapshot and replays the journal after it, each operation checked against the state (applyOps). Anything
 * wrong in them (a damaged snapshot, one that does not cover what it claims) asks the main process for the state of
 * its tables instead (`load(true)`), so nothing is lost; that one failing too rejects.
 */
export async function openState(load: (fromTables: boolean) => Promise<Loaded>): Promise<Opened> {
  const open = (l: Loaded): Opened => {
    const state = decodeState(l.data), ops = JSON.parse(l.tail) as Op[];
    applyOps(state, ops);
    return { state, seq: l.seq, stale: ops.length > 0, pending: JSON.parse(l.pending) as Unit[], pc: l.pc };
  };
  let fallback: string;
  try {
    return open(await load(false));
  } catch (e) {
    fallback = messageOf(e);
  }
  return { ...open(await load(true)), fallback };
}

/** What a reconciliation leaves to say (plan 5a): the writes dropped, the other notifications, each a sentence in French. */
export interface Reconciled { notices: string[]; dropped: string[] }

/**
 * Every edit of the interface (spec 6.4): computed by a command on the interface's copy of the state (which it leaves as
 * it found it), written by the main process, then applied to that copy in place and recorded for undo. A refused
 * command or a failed write changes nothing. Calls are queued, so two quick actions never interleave. The state object
 * stays the same (but for a reload): `rev` counts the changes applied, and tells React it changed. `seq` is the journal
 * number the copy covers: the one the main process gave the last change applied (plan 3c), which a snapshot of the copy
 * is saved with. Successive actions run with the same `merge` key, nothing written between them, are one (plan 4b, D6):
 * the saves of a .tex. This memory lasts as long as the session.
 *
 * With a server paired (plan 5a), it keeps this PC's pending writes (`follow`): each write takes its identifier here and
 * its time from the main process; the writes received are reconciled in the same queue as the actions (`reconcile`).
 */
export class EditSession {
  private s: State;
  private revision = 0;
  private journalSeq: number;
  private diverged = false;
  /** A reconciliation applied to the state, its writing by the base awaited: the state is ahead of `seq` (plan 5a). */
  private writing = false;
  private stack = new UndoStack();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly commit: (a: Action, unit: Id) => Promise<Committed>;
  private readonly onChange: (s: State, a: Action | null, rev: number) => void;
  private guard: () => string | null = () => null;
  /** The last action written, when it ran with a `merge` key: the next one of that key joins it. */
  private merging: { key: string; id: Id } | null = null;
  /** This PC's identifier and its pending writes, in order, while a server is paired; null otherwise (none kept). */
  private sync: { pc: string; pending: Unit[] } | null;

  /**
   * `commit` writes an action as the write `unit` (its identifier, drawn here): its journal number and time. `onChange`
   * is told each change of the state: the action applied, or null when the state was read again (reload: a new object).
   */
  constructor(
    state: State, commit: (a: Action, unit: Id) => Promise<Committed>, onChange: (s: State, a: Action | null, rev: number) => void, seq = 0,
    sync: { pc: string; pending: Unit[] } | null = null,
  ) {
    this.s = state;
    this.commit = commit;
    this.onChange = onChange;
    this.journalSeq = seq;
    this.sync = sync;
  }

  get state(): State {
    return this.s;
  }

  /** The number of actions applied to the state so far. */
  get rev(): number {
    return this.revision;
  }

  /** The journal number the state covers. */
  get seq(): number {
    return this.journalSeq;
  }

  /** The step the next undo would undo, and the one the next redo would redo: their identifiers (UndoStack), null for none. */
  get nextUndo(): Id | null {
    return this.stack.nextUndo;
  }

  get nextRedo(): Id | null {
    return this.stack.nextRedo;
  }

  /**
   * Whether a change written to the base could not be applied to the copy (it no longer matches the base): its snapshot
   * must not be saved; the next start rebuilds the state from the journal, or from the tables.
   */
  get broken(): boolean {
    return this.diverged;
  }

  /**
   * Whether the state is, for now, ahead of the journal number it is said to cover: a reconciliation applied to it, its
   * writing by the base awaited (plan 5a). No snapshot is taken of it then (review of task 4, Important 2).
   */
  get busy(): boolean {
    return this.writing;
  }

  /**
   * `extend`: the action completes that earlier one, which stays a single undo step if nothing came in between.
   * `merge`: when the last action written by the session ran with the same key, and nothing has been written since (no
   * other action, no undo, no redo, no change received), this one takes its identifier — its journal lines carry the
   * same action id, so the history counts one modification — and extends its undo step (UndoStack.extend); otherwise it
   * is a new action. A refused command writes nothing, and ends nothing.
   */
  run(build: (s: State) => Action, opts: { extend?: Id; merge?: string } = {}): Promise<Result> {
    return this.enqueue(async () => {
      let a: Action;
      try {
        a = build(this.s);
      } catch (e) {
        if (e instanceof CommandError) return { ok: false, message: e.message };
        throw e;
      }
      const joined = opts.merge !== undefined && this.merging?.key === opts.merge ? this.merging.id : null;
      if (joined !== null) a = { ...a, id: joined };
      const r = await this.write(a);
      if (r.ok) {
        if (joined !== null) this.stack.extend(joined, a);
        else if (opts.extend) this.stack.extend(opts.extend, a);
        else this.stack.record(a);
        this.merging = opts.merge !== undefined ? { key: opts.merge, id: a.id } : null;
      }
      return r;
    });
  }

  /**
   * Called before an undo or a redo: it may write what is waiting (it runs first, the queue keeps the order), or refuse
   * with a message while a gesture is under way (I6 of the plan 3b review).
   */
  setGuard(guard: () => string | null): void {
    this.guard = guard;
  }

  undo(): Promise<Result> {
    const refused = this.guard();
    if (refused) return Promise.resolve({ ok: false, message: refused });
    return this.enqueue(async () => {
      let a: Action | null;
      try {
        a = this.stack.prepareUndo(this.s);
      } catch (e) {
        if (e instanceof UndoConflictError) return { ok: false, message: e.message };
        throw e;
      }
      if (!a) return { ok: false, message: 'Rien à annuler.' };
      const r = await this.write(a);
      if (r.ok) {
        this.stack.confirmUndo();
        this.merging = null;
      }
      return r;
    });
  }

  redo(): Promise<Result> {
    const refused = this.guard();
    if (refused) return Promise.resolve({ ok: false, message: refused });
    return this.enqueue(async () => {
      let a: Action | null;
      try {
        a = this.stack.prepareRedo(this.s);
      } catch (e) {
        if (e instanceof UndoConflictError) return { ok: false, message: e.message };
        throw e;
      }
      if (!a) return { ok: false, message: 'Rien à rétablir.' };
      const r = await this.write(a);
      if (r.ok) {
        this.stack.confirmRedo();
        this.merging = null;
      }
      return r;
    });
  }

  /** A change written elsewhere, already in the journal at `seq`: applied to the copy, not undoable here. */
  receive(a: Action, seq: number): void {
    this.merging = null;
    this.apply(a, seq);
  }

  /** This PC's pending writes, in order (plan 5a); none without a server. */
  get pending(): readonly Unit[] {
    return this.sync?.pending ?? [];
  }

  /**
   * Keeps this PC's pending writes from now on (a server paired, plan 5a): the list `pending` gives, asked in the queue
   * (no write is under way, so the main process reads them all), then each write's.
   */
  follow(pc: string, pending: () => Promise<Unit[]>): Promise<void> {
    return this.enqueue(async () => { this.sync = { pc, pending: await pending() }; });
  }

  /** No longer kept (unpaired): the writes stay pending in the base, unsent. */
  unfollow(): Promise<void> {
    return this.enqueue(async () => { this.sync = null; });
  }

  /**
   * Reconciles the writes the server numbered, and those it refused (plan 5a, D4), in the queue: an action started
   * meanwhile is written after it. The state is reconciled in place (the core's reconcile), written by the main process
   * (`write`: its journal number), then the pending writes are those replayed; a write rewritten or dropped leaves the
   * undo stack (D5); the scene is told one change: the inverses, the writes received and the replayed ones. Rejects with
   * SyncDivergedError, the state as it was, when a received write does not apply; with `write`'s error when the base
   * did not write it, the state then ahead of the base (broken) until `reload`.
   */
  reconcile(units: RemoteUnit[], refused: { unit: Id; message: string }[], write: (r: Reconciliation) => Promise<number>): Promise<Reconciled> {
    return this.enqueue(async () => {
      const before = this.sync?.pending ?? [];
      const r = reconcile(this.s, before, units, refused);
      let seq: number;
      this.writing = true;
      try {
        seq = await write(r);
      } catch (e) {
        this.diverged = true;
        throw e;
      } finally {
        this.writing = false;
      }
      if (this.sync) this.sync.pending = r.rebased;
      // An acknowledged write, or one replayed unchanged (the same object), stays undoable; any other was rewritten,
      // dropped, received after another PC's writes, or vanished.
      const kept = new Set<Unit>(r.rebased), acked = new Set(r.acked);
      for (const u of before) if (!acked.has(u.unit) && !kept.has(u)) this.stack.forget(u.action);
      const received = r.remote.slice(r.acked.length);
      const ops = [...r.rewind, ...received.flatMap((u) => u.ops), ...(r.rewind.length > 0 ? r.rebased.flatMap((u) => u.ops) : [])];
      this.journalSeq = seq;
      if (ops.length > 0) {
        this.merging = null;
        this.revision++;
        this.onChange(this.s, { id: uuidv7(), label: 'Synchronisation', ops }, this.revision);
      }
      return { notices: r.notices, dropped: r.dropped.map((d) => d.message) };
    });
  }

  /**
   * The state read again from the base (`load`), in the queue: after a reconciliation the base could not write, or a
   * divergence (plan 5a). A new state object, its journal number and pending writes; the undo stack emptied; the scene
   * told (null: made anew).
   */
  reload(load: () => Promise<Opened>): Promise<void> {
    return this.enqueue(async () => {
      const opened = await load();
      this.s = opened.state;
      this.journalSeq = opened.seq;
      this.diverged = false;
      this.stack = new UndoStack();
      this.merging = null;
      if (this.sync) this.sync.pending = opened.pending;
      this.revision++;
      this.onChange(this.s, null, this.revision);
    });
  }

  private async write(a: Action): Promise<Result> {
    const unit = uuidv7();
    let done: Committed;
    try {
      done = await this.commit(a, unit);
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
    this.apply(a, done.seq);
    this.sync?.pending.push({ unit, action: a.id, label: a.label, at: done.at, pc: this.sync.pc, ops: a.ops });
    return { ok: true, action: a, plans: plansOf(a) };
  }

  /** Applied in place, all or nothing; then one revision more. Written but refused by the copy: the session is broken. */
  private apply(a: Action, seq: number): void {
    try {
      applyOps(this.s, a.ops);
    } catch (e) {
      this.diverged = true;
      throw e;
    }
    this.journalSeq = seq;
    this.revision++;
    this.onChange(this.s, a, this.revision);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

/** When the snapshot is saved (RenderParams). */
export interface SnapshotTiming { snapshotAfterActions: number; snapshotIdleMs: number }

/**
 * When the interface sends its state to be kept as the base's snapshot (plan 3c, decision 4; R16). A snapshot is due
 * once `snapshotAfterActions` actions are unsaved, or when the one found at load was stale (the journal's tail was
 * replayed); a due snapshot is taken at rest only, once nothing has happened for `snapshotIdleMs` (no action, no input:
 * touch), never inside an action, and not before the first frame (start). Closing (flush) takes one whenever anything
 * is unsaved. Never from a broken session, nor while a reconciliation is being written (busy: the state is ahead of
 * `seq`); a due one waits for rest again. The state is encoded at once, between two actions: what is sent is exactly
 * the state at `seq`.
 */
export class SnapshotSaver {
  private readonly session: EditSession;
  private readonly save: (data: ArrayBuffer, seq: number) => Promise<void>;
  private readonly timing: () => SnapshotTiming;
  /** Actions applied since the last snapshot sent. */
  private unsaved = 0;
  /** The snapshot found at load did not cover the whole state. */
  private stale: boolean;
  /** The first frame is drawn: a due snapshot may wait for rest. */
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();

  constructor(session: EditSession, save: (data: ArrayBuffer, seq: number) => Promise<void>, timing: () => SnapshotTiming, stale: boolean) {
    this.session = session;
    this.save = save;
    this.timing = timing;
    this.stale = stale;
  }

  /** The first frame is drawn (the app calls it once): from now on a due snapshot waits for rest. */
  start(): void {
    this.started = true;
    if (this.due()) this.rearm();
  }

  /** An action was applied to the session's state: at most, the wait for rest starts again. */
  applied(): void {
    this.unsaved++;
    if (this.started && this.due()) this.rearm();
  }

  /** The user did something (pointer, wheel, keys): the wait for rest starts again. */
  touch(): void {
    if (this.timer !== null) this.rearm();
  }

  /** At closing: the snapshot if anything is unsaved; resolves once the main process has it (or refused it). */
  flush(): Promise<void> {
    return this.saveNow();
  }

  private due(): boolean {
    return this.stale || this.unsaved >= this.timing().snapshotAfterActions;
  }

  private rearm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.saveNow(); }, this.timing().snapshotIdleMs);
  }

  private saveNow(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if ((this.unsaved === 0 && !this.stale) || this.session.broken) return this.sending;
    // A reconciliation is being written: its state is not yet that of `seq`. Tried again at rest.
    if (this.session.busy) {
      if (this.started) this.rearm();
      return this.sending;
    }
    const seq = this.session.seq, count = this.unsaved, stale = this.stale;
    // Not kept, whatever failed: the journal still has everything, the next snapshot will cover it.
    const warn = (e: unknown) => console.warn(`Instantané de la base non enregistré : ${messageOf(e)}`);
    let data: ArrayBuffer;
    try {
      data = encodeState(this.session.state);
    } catch (e) {
      warn(e);
      return this.sending;
    }
    this.unsaved = 0;
    this.stale = false;
    this.sending = this.sending.then(() => this.save(data, seq)).catch((e: unknown) => {
      this.unsaved += count;
      this.stale ||= stale;
      warn(e);
    });
    return this.sending;
  }
}
