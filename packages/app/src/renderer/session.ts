import { type Action, applyOps, CommandError, decodeState, encodeState, type Id, type Op, type State, UndoConflictError, UndoStack } from '@cirrus/core';

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
const messageOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const i = m.lastIndexOf('Error: ');
  return i >= 0 ? m.slice(i + 'Error: '.length) : m;
};

/** What cirrus:load sends: a snapshot, the journal's operations after it (JSON), and the journal number they reach. */
export interface Loaded { data: ArrayBuffer; tail: string; seq: number }

/**
 * The state the interface opens with (plan 3c, decision 4): `seq`, the journal number it covers; `stale`, whether the
 * snapshot did not cover all of it (the journal's tail was replayed: one is due); `fallback`, why the snapshot sent
 * first could not be used, when the state had to be read from the base's tables instead.
 */
export interface Opened { state: State; seq: number; stale: boolean; fallback?: string }

/**
 * Decodes the snapshot and replays the journal after it, each operation checked against the state (applyOps). Anything
 * wrong in them (a damaged snapshot, one that does not cover what it claims) asks the main process for the state of
 * its tables instead (`load(true)`), so nothing is lost; that one failing too rejects.
 */
export async function openState(load: (fromTables: boolean) => Promise<Loaded>): Promise<Opened> {
  const open = (l: Loaded): Opened => {
    const state = decodeState(l.data), ops = JSON.parse(l.tail) as Op[];
    applyOps(state, ops);
    return { state, seq: l.seq, stale: ops.length > 0 };
  };
  let fallback: string;
  try {
    return open(await load(false));
  } catch (e) {
    fallback = messageOf(e);
  }
  return { ...open(await load(true)), fallback };
}

/**
 * Every edit of the interface (spec 6.4): computed by a command on the interface's copy of the state (which it leaves as
 * it found it), written by the main process, then applied to that copy in place and recorded for undo. A refused
 * command or a failed write changes nothing. Calls are queued, so two quick actions never interleave. The state object
 * stays the same: `rev` counts the actions applied, and tells React it changed. `seq` is the journal number the copy
 * covers: the one the main process gave the last action applied (plan 3c), which a snapshot of the copy is saved with.
 */
export class EditSession {
  private readonly s: State;
  private revision = 0;
  private journalSeq: number;
  private diverged = false;
  private readonly stack = new UndoStack();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly commit: (a: Action) => Promise<number>;
  private readonly onChange: (s: State, a: Action, rev: number) => void;
  private guard: () => string | null = () => null;

  constructor(state: State, commit: (a: Action) => Promise<number>, onChange: (s: State, a: Action, rev: number) => void, seq = 0) {
    this.s = state;
    this.commit = commit;
    this.onChange = onChange;
    this.journalSeq = seq;
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

  /**
   * Whether a change written to the base could not be applied to the copy (it no longer matches the base): its snapshot
   * must not be saved; the next start rebuilds the state from the journal, or from the tables.
   */
  get broken(): boolean {
    return this.diverged;
  }

  /** `extend`: the action completes that earlier one, which stays a single undo step if nothing came in between. */
  run(build: (s: State) => Action, opts: { extend?: Id } = {}): Promise<Result> {
    return this.enqueue(async () => {
      let a: Action;
      try {
        a = build(this.s);
      } catch (e) {
        if (e instanceof CommandError) return { ok: false, message: e.message };
        throw e;
      }
      const r = await this.write(a);
      if (r.ok) {
        if (opts.extend) this.stack.extend(opts.extend, a);
        else this.stack.record(a);
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
      if (r.ok) this.stack.confirmUndo();
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
      if (r.ok) this.stack.confirmRedo();
      return r;
    });
  }

  /** A change written elsewhere (another PC, plan 5), already in the journal at `seq`: applied to the copy, not undoable here. */
  receive(a: Action, seq: number): void {
    this.apply(a, seq);
  }

  private async write(a: Action): Promise<Result> {
    let seq: number;
    try {
      seq = await this.commit(a);
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
    this.apply(a, seq);
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

  private enqueue(job: () => Promise<Result>): Promise<Result> {
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
 * is unsaved. Never from a broken session. The state is encoded at once, between two actions: what is sent is exactly
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
