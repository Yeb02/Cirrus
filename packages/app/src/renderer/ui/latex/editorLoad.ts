import { type Annotation, type Compartment, type EditorState, type Extension, Transaction, type TransactionSpec } from '@codemirror/state';

// A text given to a CodeMirror editor from outside, without a DOM: the LaTeX editor's (LatexEditor) and the comparison's
// original (CompareView). Plan 5b, task 5, fix round 1 of the review (Important 1).

/**
 * The whole text replaced by `text`, the cursor kept as well as it can be: on its line, at its column, each clamped to
 * the new text. A step of the history, as any change (a value given from outside: the preamble, a summary).
 */
export function replacingText(state: EditorState, text: string, annotations: readonly Annotation<unknown>[] = []): TransactionSpec {
  const head = state.selection.main.head, line = state.doc.lineAt(head), doc = state.toText(text);
  const at = doc.line(Math.min(line.number, doc.lines));
  return { changes: { from: 0, to: state.doc.length, insert: doc }, selection: { anchor: at.from + Math.min(head - line.from, at.length) }, annotations: [...annotations] };
}

/**
 * A version from elsewhere loaded (plan 5b, D6): the text replaced as replacingText has it, out of the history, which
 * is emptied — its compartment `history` set to nothing with the change, then given `extension` (its history) again.
 * Two transactions, which the caller dispatches at once, one after the other, nothing between them: Ctrl+Z after a load
 * never brings back the text before it — not the load itself, nor an older step that CodeMirror would otherwise map onto
 * the new text's edges (one typed at the end then taken back, say) —, and a keystroke right after it starts a step of
 * its own.
 */
export function loadText(
  state: EditorState, text: string, history: Compartment, extension: Extension, annotations: readonly Annotation<unknown>[] = [],
): [TransactionSpec, TransactionSpec] {
  const change = replacingText(state, text, [...annotations, Transaction.addToHistory.of(false)]);
  return [{ ...change, effects: history.reconfigure([]) }, { effects: history.reconfigure(extension) }];
}
