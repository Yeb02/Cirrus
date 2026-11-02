import { type Action, applyOp, CommandError, type Id, type State, UndoConflictError, UndoStack } from '@cirrus/core';

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

/**
 * Every edit of the interface (spec 6.4): computed by a pure command on the interface's copy of the state, written by
 * the main process, then applied to the copy and recorded for undo. A refused command or a failed write changes
 * nothing. Calls are queued, so two quick actions never interleave.
 */
export class EditSession {
  private s: State;
  private readonly stack = new UndoStack();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly commit: (a: Action) => Promise<void>;
  private readonly onChange: (s: State, a: Action) => void;
  private guard: () => string | null = () => null;

  constructor(state: State, commit: (a: Action) => Promise<void>, onChange: (s: State, a: Action) => void) {
    this.s = state;
    this.commit = commit;
    this.onChange = onChange;
  }

  get state(): State {
    return this.s;
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

  /** A change written elsewhere (another PC, plan 5): applied to the copy, not undoable here. */
  receive(a: Action): void {
    this.apply(a);
  }

  private async write(a: Action): Promise<Result> {
    try {
      await this.commit(a);
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
    this.apply(a);
    return { ok: true, action: a, plans: plansOf(a) };
  }

  /** Records are immutable and replaced by operations: a new state object tells React it changed. */
  private apply(a: Action): void {
    const next: State = { ...this.s };
    next.nodes = new Map(this.s.nodes);
    next.connections = new Map(this.s.connections);
    next.plans = new Map(this.s.plans);
    next.tagKeys = new Map(this.s.tagKeys);
    next.placements = new Map(this.s.placements);
    next.branches = new Set(this.s.branches);
    next.connLayouts = new Map(this.s.connLayouts);
    next.phantoms = new Map(this.s.phantoms);
    for (const op of a.ops) applyOp(next, op);
    this.s = next;
    this.onChange(next, a);
  }

  private enqueue(job: () => Promise<Result>): Promise<Result> {
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
