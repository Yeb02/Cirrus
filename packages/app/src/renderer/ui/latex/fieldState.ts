/**
 * A LaTeX field's states (plan 4b, task 6), without React: a node's summary or a connection's relation, shown compiled
 * (`view`), or typed in its editor (`edit`, with the draft typed so far).
 */
export type FieldState = { mode: 'view' } | { mode: 'edit'; draft: string };

/** The field shown compiled. */
export const VIEW: FieldState = { mode: 'view' };

/**
 * What happens to the field; `value` is the text saved, as it is now:
 * - `click`: a click on the field that selects nothing, `link` when it was on what takes its own clicks — a link, a
 *   button (« Journal »), the log, the editor;
 * - `key`: a key pressed while the field itself has the focus (not its editor, nor a link of it);
 * - `input`: the draft as typed;
 * - `leave`: the focus left the field and its preview;
 * - `escape`: Escape in the editor, that nothing in it took (its suggestions, its log).
 */
export type FieldEvent =
  | { kind: 'click'; link: boolean; value: string }
  | { kind: 'key'; key: string; value: string }
  | { kind: 'input'; text: string }
  | { kind: 'leave'; value: string }
  | { kind: 'escape' };

/**
 * The field's next state, the text to commit if any, and whether its editor takes the focus back. Shown compiled, a
 * click elsewhere than on a link, Enter or F2 open the editor on the saved value. In the editor, the focus that leaves
 * commits the draft if it differs from the saved value, then shows it compiled; Escape gives the draft up and shows
 * the saved value, without committing; a click on the draft's preview or its status line gives the focus back to the
 * editor, its caret where it was (`focusEditor`: the field itself would hold it, and the keys typed would be lost, a
 * Ctrl+Z going to the base: review, round 1). Any other event keeps the state as it is (the same object).
 */
export function fieldReducer(state: FieldState, event: FieldEvent): { state: FieldState; commit?: string; focusEditor?: true } {
  if (state.mode === 'view') {
    const opens = (event.kind === 'click' && !event.link) || (event.kind === 'key' && (event.key === 'Enter' || event.key === 'F2'));
    return opens && 'value' in event ? { state: { mode: 'edit', draft: event.value } } : { state };
  }
  switch (event.kind) {
    case 'click': return event.link ? { state } : { state, focusEditor: true };
    case 'input': return event.text === state.draft ? { state } : { state: { mode: 'edit', draft: event.text } };
    case 'leave': return event.value === state.draft ? { state: VIEW } : { state: VIEW, commit: state.draft };
    case 'escape': return { state: VIEW };
    default: return { state };
  }
}
