import { expect, test } from 'vitest';
import { textOwnsKeys } from '../src/renderer/keys.ts';
import { type FieldEvent, fieldReducer, type FieldState, VIEW } from '../src/renderer/ui/latex/fieldState.ts';
import { linkTarget, nodeLinkOf } from '../src/renderer/ui/latex/links.ts';

const ID = '0192f0c3-7a1b-7c2d-8e3f-a1b2c3d4e5f6';
const SAVED = 'Énonce que le meilleur modèle compresse le plus.';
const edit = (draft: string): FieldState => ({ mode: 'edit', draft });

test('nodeLinkOf : l’identifiant d’un lien cirrus://node/<id> ; null sans identifiant, pour une autre adresse, ou un identifiant de 35 caractères', () => {
  expect(nodeLinkOf(`cirrus://node/${ID}`)).toBe(ID);
  for (const url of [
    'cirrus://node/', 'cirrus://node', 'cirrus://autre/x', `cirrus://autre/${ID}`, `https://example.org/${ID}`, 'https://example.org',
    `cirrus://node/${ID.slice(1)}`, `cirrus://node/${ID}0`, `cirrus://node/${ID}/`, `cirrus://node/${ID}?x=1`, `cirrus://node/${ID.toUpperCase()}`,
    `CIRRUS://node/${ID}`, `cirrus-file://node/${ID}`, ` cirrus://node/${ID}`, '', 'pas une adresse',
  ]) {
    expect(nodeLinkOf(url), url).toBeNull();
  }
  expect(ID.slice(1)).toHaveLength(35);
});

test('linkTarget : un lien vers un nœud (que pdf.js ne valide pas : unsafeUrl), une adresse http, https ou mailto, une destination ; tout autre lien n’en est pas un', () => {
  expect(linkTarget({ unsafeUrl: `cirrus://node/${ID}` })).toEqual({ node: ID });
  expect(linkTarget({ url: 'https://example.org/a', unsafeUrl: 'https://example.org/a' })).toEqual({ url: 'https://example.org/a' });
  expect(linkTarget({ url: 'mailto:a@b.fr' })).toEqual({ url: 'mailto:a@b.fr' });
  expect(linkTarget({ dest: 'equation.1' })).toEqual({ dest: 'equation.1' });
  expect(linkTarget({ dest: [{ num: 3, gen: 0 }, { name: 'XYZ' }, 0, 700, null] })).toEqual({ dest: [{ num: 3, gen: 0 }, { name: 'XYZ' }, 0, 700, null] });
  // Never the system: a cirrus: address that is no node, the store's scheme, a file, a script, an unknown scheme.
  for (const unsafeUrl of ['cirrus://autre/x', 'cirrus://node/', `cirrus-file://blob/${'a'.repeat(64)}/x.pdf`, 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ftp://x.org/y']) {
    expect(linkTarget({ unsafeUrl }), unsafeUrl).toBeNull();
    expect(linkTarget({ url: unsafeUrl, unsafeUrl }), unsafeUrl).toBeNull();
  }
  expect(linkTarget({})).toBeNull();
  expect(linkTarget({ dest: null })).toBeNull();
});

test('fieldReducer : un clic passe en modification, avec la valeur enregistrée pour brouillon ; un clic sur un lien n’y passe pas', () => {
  expect(fieldReducer(VIEW, { kind: 'click', link: false, value: SAVED })).toEqual({ state: edit(SAVED) });
  const onLink = fieldReducer(VIEW, { kind: 'click', link: true, value: SAVED });
  expect(onLink).toEqual({ state: VIEW });
  expect(onLink.state).toBe(VIEW);
  // In edit, a click stays in the editor (the same state).
  const s = edit('x');
  expect(fieldReducer(s, { kind: 'click', link: false, value: SAVED }).state).toBe(s);
});

test('fieldReducer : Entrée et F2 passent en modification ; une autre touche, non', () => {
  for (const key of ['Enter', 'F2']) expect(fieldReducer(VIEW, { kind: 'key', key, value: SAVED }), key).toEqual({ state: edit(SAVED) });
  for (const key of ['a', ' ', 'Escape', 'Tab', 'F1']) expect(fieldReducer(VIEW, { kind: 'key', key, value: SAVED }).state, key).toBe(VIEW);
  // In edit, Enter belongs to the editor.
  const s = edit('x');
  expect(fieldReducer(s, { kind: 'key', key: 'Enter', value: SAVED }).state).toBe(s);
});

test('fieldReducer : Échap rend la valeur enregistrée et revient à la vue, sans commit', () => {
  const typed = fieldReducer(edit(SAVED), { kind: 'input', text: `${SAVED} Ajout.` });
  expect(typed).toEqual({ state: edit(`${SAVED} Ajout.`) });
  const r = fieldReducer(typed.state, { kind: 'escape' });
  expect(r).toEqual({ state: VIEW });
  expect(r.commit).toBeUndefined();
});

test('fieldReducer : le focus qui quitte le champ fait un commit si le brouillon diffère, puis revient à la vue', () => {
  const r = fieldReducer(edit(`${SAVED} Ajout.`), { kind: 'leave', value: SAVED });
  expect(r).toEqual({ state: VIEW, commit: `${SAVED} Ajout.` });
  // Emptied: committed too (an empty summary is a value).
  expect(fieldReducer(edit(''), { kind: 'leave', value: SAVED })).toEqual({ state: VIEW, commit: '' });
});

test('fieldReducer : le focus qui quitte le champ sans changement ne fait pas de commit', () => {
  const r = fieldReducer(edit(SAVED), { kind: 'leave', value: SAVED });
  expect(r).toEqual({ state: VIEW });
  expect(r.commit).toBeUndefined();
  // Typed, then erased: nothing to commit; changed elsewhere meanwhile to the draft's text: nothing either.
  const back = fieldReducer(fieldReducer(edit(SAVED), { kind: 'input', text: `${SAVED}x` }).state, { kind: 'input', text: SAVED });
  expect(fieldReducer(back.state, { kind: 'leave', value: SAVED }).commit).toBeUndefined();
  expect(fieldReducer(edit('nouveau'), { kind: 'leave', value: 'nouveau' }).commit).toBeUndefined();
});

test('fieldReducer : en vue, ce qui n’est ni un clic ni Entrée ni F2 ne change rien', () => {
  const events: FieldEvent[] = [{ kind: 'input', text: 'x' }, { kind: 'leave', value: SAVED }, { kind: 'escape' }];
  for (const e of events) {
    const r = fieldReducer(VIEW, e);
    expect(r.state, e.kind).toBe(VIEW);
    expect(r.commit, e.kind).toBeUndefined();
  }
});

test('fieldReducer : en modification, un clic ailleurs que sur un lien, un bouton, le journal ou l’éditeur rend le focus à l’éditeur (revue, tour 1)', () => {
  const s = edit('brouillon');
  // The draft's preview, its status line: the caret goes back to the editor, the state stays.
  expect(fieldReducer(s, { kind: 'click', link: false, value: SAVED })).toEqual({ state: s, focusEditor: true });
  expect(fieldReducer(s, { kind: 'click', link: false, value: SAVED }).state).toBe(s);
  // A link, a button, the log, the editor itself take their own click.
  expect(fieldReducer(s, { kind: 'click', link: true, value: SAVED })).toEqual({ state: s });
  // Shown compiled, a click opens the editor, which takes the focus by itself.
  expect(fieldReducer(VIEW, { kind: 'click', link: false, value: SAVED }).focusEditor).toBeUndefined();
});

/** A key's target as the shortcuts read it: its tag, whether it is editable, and the selectors it is inside of. */
const target = (tagName: string, inside: string[] = [], isContentEditable = false) => ({
  tagName, isContentEditable, closest: (sel: string) => (inside.includes(sel) ? {} : null),
});

test('textOwnsKeys : un champ de texte, ou un champ LaTeX en modification, garde ses touches ; ailleurs, les raccourcis de l’app agissent (revue, tour 1)', () => {
  for (const t of [target('INPUT'), target('TEXTAREA'), target('SELECT'), target('DIV', [], true)]) expect(textOwnsKeys(t), t.tagName).toBe(true);
  // The field's root, its draft's preview, its log, while it is typed in: Ctrl+Z belongs to the text (spec 6.4).
  expect(textOwnsKeys(target('DIV', ['.latex-field.edit']))).toBe(true);
  expect(textOwnsKeys(target('SPAN', ['.latex-field.edit']))).toBe(true);
  // Shown compiled, the field is no text being typed: the base's undo acts.
  for (const t of [target('DIV', ['.latex-field.view']), target('CANVAS'), target('BODY'), null]) expect(textOwnsKeys(t)).toBe(false);
});
