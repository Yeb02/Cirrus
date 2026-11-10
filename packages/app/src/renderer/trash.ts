import { type Id, type State, trashedItems } from '@cirrus/core';
import { searchWords } from './search/index.ts';

// The trash's panel, without its screen (plan 6a, D5, task 4): the rows it lists and their filter. Pure, so that the rules
// are tested apart; the panel (ui/TrashPanel.tsx) only draws them.

/**
 * An object of the trash as the panel shows it: its kind in French (an annotation is a node with an anchor), its title
 * (« Sans titre » for a node without one; a connection named by connectionName), when it was thrown away (`at`, and
 * `when` in French, short), and its title as the filter reads it (`folded`).
 */
export interface TrashRow { id: Id; kind: 'node' | 'connection'; label: 'nœud' | 'connexion' | 'annotation'; title: string; at: number; when: string; folded: string }

const WHEN = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
/** A moment as the panel says it: the French short date and time, in this PC's time — « 10/11/2026 10:05 ». */
export const trashDate = (at: number): string => WHEN.format(at);

/** A title as the filter reads it: its words without case or accents, one space between them (the search's folding). */
const folded = (text: string): string => searchWords(text).join(' ');

/** The rows of the trash, from the most recent to the oldest (trashedItems: one pass over the base, while the panel is open). */
export function trashRows(s: State): TrashRow[] {
  return trashedItems(s).map((item) => {
    const label = item.kind === 'connection' ? 'connexion' : s.nodes.get(item.id)?.anchor !== undefined ? 'annotation' : 'nœud';
    const title = item.title === '' ? 'Sans titre' : item.title;
    return { id: item.id, kind: item.kind, label, title, at: item.at, when: trashDate(item.at), folded: folded(title) };
  });
}

/** The rows whose title holds what is typed, without case or accents; nothing typed, the same list. */
export function filterTrash(rows: TrashRow[], text: string): TrashRow[] {
  const q = folded(text);
  return q === '' ? rows : rows.filter((r) => r.folded.includes(q));
}
