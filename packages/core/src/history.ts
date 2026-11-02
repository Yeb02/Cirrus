import type { Action } from './commands.ts';
import { uuidv7 } from './ids.ts';
import { invertOp } from './ops.ts';
import { applyOp, cloneState, OpConflictError, type State } from './state.ts';

/** Inverse operations in reverse order. Undoing appends this action to the journal; nothing is erased (spec 6.4). */
export function invertAction(a: Action): Action {
  return { id: uuidv7(), label: `Annuler : ${a.label}`, ops: [...a.ops].reverse().map(invertOp) };
}

export class UndoConflictError extends Error {}

function dryRun(s: State, a: Action, label: string): void {
  const draft = cloneState(s);
  try {
    for (const op of a.ops) applyOp(draft, op);
  } catch (e) {
    if (e instanceof OpConflictError) throw new UndoConflictError(`Impossible d’annuler : « ${label} » a été modifié depuis.`);
    throw e;
  }
}

/**
 * One stack for the whole app, kept in memory for the session (spec 6.4). undo() and redo() return the action to
 * commit; the stack only moves once the action is known to apply.
 */
export class UndoStack {
  private readonly done: Action[] = [];
  private readonly undone: Action[] = [];

  record(a: Action): void {
    this.done.push(a);
    this.undone.length = 0;
  }

  undo(s: State): Action | null {
    const a = this.done.at(-1);
    if (!a) return null;
    const inverse = invertAction(a);
    dryRun(s, inverse, a.label);
    this.done.pop();
    this.undone.push(a);
    return inverse;
  }

  redo(s: State): Action | null {
    const a = this.undone.at(-1);
    if (!a) return null;
    dryRun(s, a, a.label);
    this.undone.pop();
    this.done.push(a);
    return { id: uuidv7(), label: `Rétablir : ${a.label}`, ops: a.ops };
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
}
