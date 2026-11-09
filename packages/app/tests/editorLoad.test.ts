import { history, redo, undo, undoDepth } from '@codemirror/commands';
import { Compartment, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { expect, test } from 'vitest';
import { loadText, replacingText } from '../src/renderer/ui/latex/editorLoad.ts';

// A text from elsewhere loaded into an editor (plan 5b, task 5, fix round 1 of the review, Important 1), without a DOM:
// CodeMirror's state and history, as LatexEditor and the comparison's original have them. Ctrl+Z after a load never
// brings back the text before it, whatever was typed before or right after it.

/** An editor's state over `doc`, its history in a compartment, as the editors build it; `typed` and `undo` act on it. */
function editor(doc: string) {
  const hist = new Compartment();
  let state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [hist.of(history())] });
  let clock = 0;
  const apply = (spec: TransactionSpec) => { state = state.update(spec).state; };
  return {
    hist,
    get state() { return state; },
    get text() { return state.doc.toString(); },
    /** Typed by the user, `ms` after the last change: joined to its history event under 500 ms. */
    typed(changes: TransactionSpec['changes'], ms = 0) {
      clock += ms;
      apply({ changes, userEvent: 'input.type', annotations: Transaction.time.of(clock) });
    },
    /** The text loaded, `ms` after the last change, as LatexEditor.load and CompareView dispatch it. */
    load(text: string, ms = 0) {
      clock += ms;
      for (const spec of loadText(state, text, hist, history(), [Transaction.time.of(clock)])) apply(spec);
    },
    undo: () => undo({ state, dispatch: (tr) => { state = tr.state; } }),
    redo: () => redo({ state, dispatch: (tr) => { state = tr.state; } }),
    cursor: () => state.selection.main.head,
  };
}

test('après un chargement, Ctrl+Z ne rend jamais le texte d’avant : le chargement n’est pas un pas, et l’historique d’avant est vidé', () => {
  const e = editor('mine v0\n');
  e.typed({ from: 7, insert: ' typed' });
  e.load('theirs v1\nmore lines from the other PC\n', 5000);
  expect([e.text, undoDepth(e.state)]).toEqual(['theirs v1\nmore lines from the other PC\n', 0]);
  expect(e.undo()).toBe(false);
  expect(e.text).toBe('theirs v1\nmore lines from the other PC\n');
});

test('une frappe aussitôt après un chargement (moins de 500 ms) ne s’y joint pas : un Ctrl+Z la défait seule, le second ne fait rien', () => {
  const e = editor('mine v0\n');
  e.typed({ from: 7, insert: ' typed' });
  e.load('theirs v1\n', 5000);
  e.typed({ from: 3, insert: 'Z' }, 10);
  expect(e.text).toBe('theZirs v1\n');
  expect(e.undo()).toBe(true);
  expect(e.text).toBe('theirs v1\n');
  expect(e.undo()).toBe(false);
  expect(e.text).toBe('theirs v1\n');
  // Redone, the keystroke comes back; nothing older.
  expect(e.redo()).toBe(true);
  expect(e.text).toBe('theZirs v1\n');
});

test('aux bords du texte aussi : une frappe défaite en fin de texte, ou un texte vidé, ne reviennent pas après un chargement (addToHistory seul les rendait)', () => {
  // Typed at the end, then taken back: the text is the one saved, nothing unsaved.
  const end = editor('abc');
  end.typed({ from: 3, insert: 'def' });
  end.typed({ from: 3, to: 6 }, 2000);
  end.load('v1', 5000);
  expect(end.undo()).toBe(false);
  expect(end.text).toBe('v1');
  // An empty file, typed in then emptied.
  const empty = editor('');
  empty.typed({ from: 0, insert: 'abc' });
  empty.typed({ from: 0, to: 3 }, 2000);
  empty.load('v1 text', 5000);
  expect(empty.undo()).toBe(false);
  expect(empty.text).toBe('v1 text');
  // Without emptying the history, CodeMirror would map those steps onto the new text's edges.
  const leak = EditorState.create({ doc: 'abc', extensions: [history()] })
    .update({ changes: { from: 3, insert: 'def' }, userEvent: 'input.type', annotations: Transaction.time.of(0) }).state
    .update({ changes: { from: 3, to: 6 }, userEvent: 'delete', annotations: Transaction.time.of(2000) }).state
    .update({ changes: { from: 0, to: 3, insert: 'v1' }, annotations: [Transaction.addToHistory.of(false), Transaction.time.of(5000)] }).state;
  let after = leak;
  undo({ state: leak, dispatch: (tr) => { after = tr.state; } });
  expect(after.doc.toString()).toBe('v1def');
});

test('le curseur reste sur sa ligne et à sa colonne, bornées au nouveau texte ; le chargement porte les annotations données', () => {
  const e = editor('ligne 1\nligne 2 assez longue\nligne 3\n');
  e.typed({ from: 0, insert: '' });
  const at = e.state.doc.line(2).from + 15;
  const s = e.state.update({ selection: { anchor: at } }).state;
  // Same line, same column.
  const [change] = loadText(s, 'autre 1\nautre 2 encore plus longue\n', e.hist, history());
  const next = s.update(change).state;
  expect(next.selection.main.head).toBe(next.doc.line(2).from + 15);
  // A shorter line: its end; fewer lines: the last one.
  const short = s.update(loadText(s, 'a\nb\n', e.hist, history())[0]).state;
  expect(short.selection.main.head).toBe(short.doc.line(2).to);
  const one = s.update(loadText(s, 'seule', e.hist, history())[0]).state;
  expect(one.selection.main.head).toBe(5);
  // The annotations given ride on the change.
  const mark = Transaction.userEvent.of('dehors');
  const tr = s.update(loadText(s, 'x', e.hist, history(), [mark])[0]);
  expect([tr.annotation(Transaction.userEvent), tr.annotation(Transaction.addToHistory)]).toEqual(['dehors', false]);
});

test('replacingText : le texte remplacé, le curseur gardé, dans l’historique (le préambule, un résumé : leur valeur donnée du dehors)', () => {
  const e = editor('un\ndeux\n');
  e.typed({ from: 0, insert: 'x' });
  const s = e.state.update({ selection: { anchor: 6 } }).state;
  const next = s.update(replacingText(s, 'one\ntwo three\n')).state;
  expect([next.doc.toString(), next.selection.main.head]).toEqual(['one\ntwo three\n', next.doc.line(2).from + 2]);
  // A step of the history: Ctrl+Z gives the text back.
  let back = next;
  undo({ state: next, dispatch: (tr) => { back = tr.state; } });
  expect(back.doc.toString()).toBe('xun\ndeux\n');
});
