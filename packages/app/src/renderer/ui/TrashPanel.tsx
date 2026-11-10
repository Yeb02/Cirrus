import { type Id, RESTORE_CONNECTION_LOST, type State } from '@cirrus/core';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { filterTrash, type TrashRow, trashCache, trashRows } from '../trash.ts';
import { usePanelEscape } from './panelEscape.ts';

/** Two rows that show the same: a row is drawn again only when what it shows changes, not at each action (a long trash). */
const sameRow = (a: { row: TrashRow; onRestore: unknown }, b: { row: TrashRow; onRestore: unknown }) =>
  a.onRestore === b.onRestore && a.row.id === b.row.id && a.row.label === b.row.label && a.row.title === b.row.title && a.row.at === b.row.at && a.row.restorable === b.row.restorable;

/**
 * An object of the trash: its kind, its title, when it was thrown away, and « Restaurer » — off, its reason as its title,
 * for a connection left with fewer than two nodes, which the core refuses for good.
 */
const Row = memo(function Row({ row, onRestore }: { row: TrashRow; onRestore(row: TrashRow): void }) {
  return (
    <li className="item" data-id={row.id} data-kind={row.kind}>
      <span className="what">
        <span className="title">{row.title}</span>
        <span className="meta">{row.label} · {row.when}</span>
      </span>
      <button
        className="act restore" onClick={() => onRestore(row)} disabled={!row.restorable}
        title={!row.restorable ? RESTORE_CONNECTION_LOST : row.kind === 'node' ? 'Le poser dans ce plan, d’un clic' : 'La rendre aux plans où ses nœuds sont'}
      >
        Restaurer
      </button>
    </li>
  );
}, sameRow);

/**
 * The « Corbeille » panel (plan 6a, D5; spec 6.3, 7), a side panel like the tag registry's, opened from the graph's
 * background menu: the nodes, annotations and connections thrown away, the most recent first, each with its kind and
 * its date; a filter by title. « Restaurer » a node makes it follow the cursor in the plan shown until a click puts it
 * down (`onRestoreNode`: the graph's placing, Escape gives it up); a connection comes back at once with its branches
 * (`onRestoreConnection`: a refusal is told in a toast, and so is a return that no plan shows). Each is one action,
 * undone by Ctrl+Z. The panel stays open, for the next one, and follows the state (`rev`: a restore, an undo, a sync); it
 * computes its list only while open, from the rows of its last pass: those that did not change are not made again. Nothing
 * is emptied here (D5). Escape closes it as it closes the registry (usePanelEscape).
 */
export function TrashPanel(props: { state: State; rev: number; onRestoreConnection(connection: Id): void; onRestoreNode(node: Id): void; onClose(): void }) {
  usePanelEscape(props.onClose);
  const [filter, setFilter] = useState('');
  // One pass over the base per change of the state, not per keystroke of the filter; the rows of the last pass are kept
  // (a pass is pure, the cache only saves its folding and its dates: folding twice gives the same rows).
  const cache = useRef<Map<Id, TrashRow>>(new Map());
  const rows = useMemo(() => {
    const made = trashRows(props.state, cache.current);
    cache.current = trashCache(made);
    return made;
  }, [props.state, props.rev]);
  const shown = useMemo(() => filterTrash(rows, filter), [rows, filter]);
  // The rows' handler stays the same object: they are not drawn again for it.
  const latest = useRef(props);
  latest.current = props;
  const restore = useCallback((row: TrashRow) => {
    if (row.kind === 'node') latest.current.onRestoreNode(row.id);
    else latest.current.onRestoreConnection(row.id);
  }, []);
  return (
    <aside className="trash" aria-label="Corbeille">
      <header>
        <h2>Corbeille</h2>
        <button className="close" aria-label="Fermer la corbeille" onClick={props.onClose}>×</button>
      </header>
      <input
        type="search" className="search" autoFocus placeholder="Filtrer par titre" aria-label="Filtrer la corbeille" value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {shown.length === 0
        ? <p className="none">{rows.length === 0 ? 'La corbeille est vide.' : 'Aucun objet ne correspond.'}</p>
        : <ul className="items">{shown.map((r) => <Row key={r.id} row={r} onRestore={restore} />)}</ul>}
    </aside>
  );
}
