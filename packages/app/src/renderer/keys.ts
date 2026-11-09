/** A key's target, as the app's shortcuts read it (an Element, in the window). */
interface KeyTarget { tagName: string; isContentEditable: boolean; closest(selector: string): unknown }

/**
 * Whether a key belongs to the text being typed, not to the app's shortcuts (Ctrl+Z, Ctrl+Y: spec 6.4): a field —
 * input, text area, list, editable element — or anything inside a LaTeX field being edited (plan 4b, task 6): its
 * draft's preview, its status line, its log, the field itself, which may hold the focus while its editor does not.
 */
export function textOwnsKeys(t: KeyTarget | null): boolean {
  return t !== null && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.closest('.latex-field.edit') !== null);
}
