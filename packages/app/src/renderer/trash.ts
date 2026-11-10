import { type Action, connRow, type Id, memberCount, type State, trashedItems } from '@cirrus/core';
import { searchWords } from './search/index.ts';

// The trash's panel, without its screen (plan 6a, D5, task 4): the rows it lists and their filter. Pure, so that the rules
// are tested apart; the panel (ui/TrashPanel.tsx) only draws them.

/**
 * An object of the trash as the panel shows it: its kind in French (an annotation is a node with an anchor), its title
 * (« Sans titre » for a node without one; a connection named by connectionName), when it was thrown away (`at`, and
 * `when` in French, short), and its title as the filter reads it (`folded`). `restorable`: false for a connection left with
 * fewer than two nodes, which the core refuses for good (CONNECTION_LOST); the row stays listed, its button off.
 */
export interface TrashRow { id: Id; kind: 'node' | 'connection'; label: 'nœud' | 'connexion' | 'annotation'; title: string; at: number; when: string; folded: string; restorable: boolean }

/** The core's refusal of a connection left with fewer than two nodes (restoreConnection), and the reason its button gives. */
export const CONNECTION_LOST = 'Il reste moins de deux nœuds à cette connexion : elle ne peut pas revenir.';
/** The core's refusal of a node that is not in the trash (restoreNode), told before a restoring node follows the cursor. */
export const NOT_IN_TRASH = 'Ce nœud n’est pas à la corbeille.';
/** What a connection restored with no branch written is told: its nodes share no plan, so it appears in none. */
export const RESTORED_WITHOUT_BRANCH = 'Connexion restaurée ; aucun plan ne réunit deux de ses nœuds.';

const WHEN = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
/** A moment as the panel says it: the French short date and time, in this PC's time — « 10/11/2026 10:05 ». */
export const trashDate = (at: number): string => WHEN.format(at);

/** A title as the filter reads it: its words without case or accents, one space between them (the search's folding). */
const folded = (text: string): string => searchWords(text).join(' ');

const NO_ROWS: ReadonlyMap<Id, TrashRow> = new Map();

/**
 * The rows of the trash, from the most recent to the oldest (trashedItems: one pass over the base, while the panel is open).
 * `previous`: the rows of the last pass by identifier (trashCache). A row whose moment, title and restorability are the same
 * is that very object again — its folding and its date, the costly part (16 to 23 ms at 2 000 rows), are not made twice —:
 * a change of the state costs trashedItems and the rows that are new.
 */
export function trashRows(s: State, previous: ReadonlyMap<Id, TrashRow> = NO_ROWS): TrashRow[] {
  return trashedItems(s).map((item) => {
    const title = item.title === '' ? 'Sans titre' : item.title;
    const restorable = item.kind === 'node' || memberCount(s, connRow(s, item.id)) >= 2;
    const old = previous.get(item.id);
    if (old !== undefined && old.kind === item.kind && old.at === item.at && old.title === title && old.restorable === restorable) return old;
    const label = item.kind === 'connection' ? 'connexion' : s.nodes.get(item.id)?.anchor !== undefined ? 'annotation' : 'nœud';
    return { id: item.id, kind: item.kind, label, title, at: item.at, when: trashDate(item.at), folded: folded(title), restorable };
  });
}

/** The rows of a pass by identifier: what the next pass takes its unchanged rows from. */
export const trashCache = (rows: readonly TrashRow[]): Map<Id, TrashRow> => new Map(rows.map((r) => [r.id, r]));

/** The rows whose title holds what is typed, without case or accents; nothing typed, the same list. */
export function filterTrash(rows: TrashRow[], text: string): TrashRow[] {
  const q = folded(text);
  return q === '' ? rows : rows.filter((r) => r.folded.includes(q));
}

/**
 * What a connection just restored is told (D5): restoreConnection gives branches in the plans where two of its nodes are
 * placed; when it wrote none, the connection is alive but drawn in no plan — said, not silent. Read from the action's
 * operations, the command is not changed. Null when a branch was written.
 */
export function restoreNotice(restored: Action): string | null {
  return restored.ops.some((o) => o.t === 'branch' && o.after) ? null : RESTORED_WITHOUT_BRANCH;
}

/** Why « Restaurer » on this node must not begin (a stale row: it is no longer in the trash); null when it may. */
export const restoreRefusal = (node: { trashedAt?: number } | undefined): string | null => (node?.trashedAt === undefined ? NOT_IN_TRASH : null);

/** Whether closing the panel (×, Escape) gives up the placement in progress: a node being restored, not another gesture. */
export const trashCloseGivesUp = (placing: { kind: string } | null): boolean => placing?.kind === 'restore';
