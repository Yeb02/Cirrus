/**
 * What closing the window waits for (plan 4b, final review I1). A LaTeX field being edited — a summary, a relation —
 * does not take the focus leaving the window for a leaving (LatexField), so that switching windows keeps its editor
 * open: closing the window from the taskbar, or by Alt+F4 from the field, would otherwise lose what is typed in it.
 */

/** The LaTeX fields being edited, each by its commit of what is typed: held while its editor is open. */
export class TypedFields {
  private readonly commits = new Set<() => Promise<void>>();

  /** `commit` is called at closing until the returned release (the field left its editor, or is gone). */
  hold(commit: () => Promise<void>): () => void {
    const own = () => commit();
    this.commits.add(own);
    return () => { this.commits.delete(own); };
  }

  get size(): number {
    return this.commits.size;
  }

  /** Each field's commit, one at a time, in the order they started editing (their actions are written in it); a failure is told to `warn`. */
  async commitAll(warn: (e: unknown) => void = (e) => console.error('Enregistrement d’un champ LaTeX :', e)): Promise<void> {
    for (const commit of [...this.commits]) {
      try {
        await commit();
      } catch (e) {
        warn(e);
      }
    }
  }
}

/** The app's fields (LatexField holds itself there while edited; App commits them at closing). */
export const typedFields = new TypedFields();

interface QuitSteps {
  /** The .tex typed in its full screen saved (D6). */
  workbench(): Promise<void>;
  /** What is typed in the LaTeX fields being edited committed (typedFields). */
  fields(): Promise<void>;
  /** The last snapshot, which then holds those actions. */
  snapshot(): Promise<void>;
  /** The main process may close the window. */
  ready(): void;
  /** A step that failed, said before the next one runs. */
  error(what: string, e: unknown): void;
}

/** Closing (App's onQuit), in this order, each step waited for; a failure is said, and never keeps the window open. */
export async function quitInOrder(s: QuitSteps): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ['Enregistrement du .tex à la fermeture :', s.workbench],
    ['Enregistrement d’un champ LaTeX à la fermeture :', s.fields],
    ['Instantané à la fermeture :', s.snapshot],
  ];
  try {
    for (const [what, run] of steps) {
      try {
        await run();
      } catch (e) {
        s.error(what, e);
      }
    }
  } finally {
    s.ready();
  }
}
