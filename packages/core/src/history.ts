import type { Action } from './commands.ts';
import { uuidv7 } from './ids.ts';
import { invertOp } from './ops.ts';
import { applyOp, cloneState, OpConflictError, type State } from './state.ts';

/** Inverse operations in reverse order. Undoing appends this action to the journal; nothing is erased (spec 6.4). */
export function invertAction(a: Action): Action {
  return { id: uuidv7(), label: `Annuler : ${a.label}`, ops: [...a.ops].reverse().map(invertOp) };
}

export class UndoConflictError extends Error {}

function dryRun(s: State, a: Action, message: string): void {
  const draft = cloneState(s);
  try {
    for (const op of a.ops) applyOp(draft, op);
  } catch (e) {
    if (e instanceof OpConflictError) throw new UndoConflictError(message);
    throw e;
  }
}

/**
 * One stack for the whole app, kept in memory for the session (spec 6.4). prepareUndo() and prepareRedo() return the
 * action to commit without moving the stack; confirmUndo() and confirmRedo() move it once that action is written, so a
 * failed write leaves the stack where it was. undo() and redo() do both at once.
 */
export class UndoStack {
  private readonly done: Action[] = [];
  private readonly undone: Action[] = [];

  record(a: Action): void {
    this.done.push(a);
    this.undone.length = 0;
  }

  prepareUndo(s: State): Action | null {
    const a = this.done.at(-1);
    if (!a) return null;
    const inverse = invertAction(a);
    dryRun(s, inverse, `Impossible d’annuler : « ${a.label} » a été modifié depuis.`);
    return inverse;
  }

  confirmUndo(): void {
    const a = this.done.pop();
    if (a) this.undone.push(a);
  }

  prepareRedo(s: State): Action | null {
    const a = this.undone.at(-1);
    if (!a) return null;
    dryRun(s, a, `Impossible de rétablir : « ${a.label} » a été modifié depuis.`);
    return { id: uuidv7(), label: `Rétablir : ${a.label}`, ops: a.ops };
  }

  confirmRedo(): void {
    const a = this.undone.pop();
    if (a) this.done.push(a);
  }

  undo(s: State): Action | null {
    const inverse = this.prepareUndo(s);
    if (inverse) this.confirmUndo();
    return inverse;
  }

  redo(s: State): Action | null {
    const again = this.prepareRedo(s);
    if (again) this.confirmRedo();
    return again;
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
}
