import type { Id, State } from '@cirrus/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { consultations, searchDraft } from '../consultations.ts';
import { DEFAULT_FILTERS, type SearchFilters, type SearchHit, type SearchIndex, type SearchWhere } from '../search/index.ts';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** The toggles, in order (D1): the fields, then « Ce plan seulement ». */
const TOGGLES: { key: keyof SearchFilters; label: string }[] = [
  { key: 'title', label: 'Titre' }, { key: 'tags', label: 'Tags' }, { key: 'summary', label: 'Résumé' }, { key: 'content', label: 'Contenu' },
  { key: 'planOnly', label: 'Ce plan seulement' },
];

/** Where a result's jump goes, as its line says it (D1): « ce plan », « lobby », another plan's name, « aucun plan ». */
export function placeLabel(hit: SearchHit, where: SearchWhere, s: State): string {
  if (hit.plan === null) return 'aucun plan';
  if (hit.plan === where.plan) return 'ce plan';
  if (hit.plan === where.lobby) return 'lobby';
  return s.plans.get(hit.plan)?.name ?? '?';
}

/** A result's title as its line shows it: an object without one says what it is. */
export const hitTitle = (hit: SearchHit): string => hit.title.trim() || (hit.kind === 'node' ? 'Nœud sans titre' : 'Connexion sans titre');

/**
 * The search of Ctrl+K (plan 6a, D1): a field at the top of the graph, the filters, and the results under it, each with
 * its place. The arrows go through the list, Entrée (or a click) jumps to the result chosen (`onPick`), Échap closes
 * (`onClose`). What it finds in this plan is told to the graph (`onFound`), which rings it. Its keys and presses are its
 * own, as the publication dialog's: the graph and the panels never see them. `index` is null while the index is being
 * built (after the first frame, by slices): the box says so, and lists once it is there. `asked` counts the Ctrl+K: one
 * more, while it is open, gives its field the focus again, what is typed selected. A search is one consultation (plan 6a,
 * D6), made when the box ends: with the result chosen (Entrée, a click), or with none if it is closed with something typed,
 * however it is closed (Échap, a click away, a full screen) — never at each keystroke.
 */
export function SearchBox(props: {
  asked: number; index: SearchIndex | null; state: State; where: SearchWhere; max: number;
  onPick(hit: SearchHit): void; onClose(): void; onFound(ids: Id[]): void;
}) {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [chosen, setChosen] = useState(0);
  const typed = useRef(text), picked = useRef(false);
  typed.current = text;
  // The box ends: a text typed and not followed by a pick is a search with no result chosen.
  useEffect(() => () => {
    const draft = picked.current ? null : searchDraft(typed.current);
    if (draft) consultations.record(draft);
  }, []);
  const pick = (hit: SearchHit) => {
    const draft = picked.current ? null : searchDraft(typed.current, hit);
    picked.current = true;
    if (draft) consultations.record(draft);
    props.onPick(hit);
  };
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const { index, where, max } = props;
  const hits = useMemo(() => (index ? index.query(text, filters, where, max) : []), [index, text, filters, where, max]);
  // A new list: its first line chosen.
  useEffect(() => setChosen(0), [text, filters]);
  const here = hits.filter((h) => h.plan === where.plan).map((h) => h.id), hereKey = here.join('|');
  useEffect(() => props.onFound(here), [hereKey]);
  useEffect(() => { list.current?.children[chosen]?.scrollIntoView({ block: 'nearest' }); }, [chosen]);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, [props.asked]);
  const at = Math.min(chosen, Math.max(0, hits.length - 1));

  const status = !index ? 'Préparation de la recherche…' : text.trim() === '' ? '' : hits.length === 0 ? 'Aucun résultat.' : '';
  return (
    <div
      className="search-box" role="dialog" aria-label="Rechercher"
      onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onContextMenu={stop} onWheel={stop}
      // Its keys are its own: the graph's (arrows, Suppr, Escape) and the panels' never see them.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); props.onClose(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (hits.length > 0) setChosen((at + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
          return;
        }
        if (e.key === 'Enter' && hits.length > 0) { e.preventDefault(); pick(hits[at]); }
      }}
    >
      <input
        ref={field} className="search-field" autoFocus value={text} spellCheck={false} placeholder="Rechercher un nœud ou une connexion"
        aria-label="Rechercher un nœud ou une connexion" onChange={(e) => setText(e.target.value)}
      />
      <div className="search-filters">
        {TOGGLES.map((t) => (
          <label key={t.key} className={filters[t.key] ? 'on' : ''}>
            <input
              type="checkbox" checked={filters[t.key]}
              onChange={() => { setFilters((f) => ({ ...f, [t.key]: !f[t.key] })); field.current?.focus(); }}
            />
            {t.label}
          </label>
        ))}
      </div>
      {status && <p className="search-status" role="status">{status}</p>}
      {hits.length > 0 && (
        <ul className="search-results" role="listbox" ref={list}>
          {hits.map((h, i) => (
            <li
              key={h.id} role="option" aria-selected={i === at} className={`${h.kind}${i === at ? ' on' : ''}`} data-id={h.id}
              onMouseMove={() => { if (i !== at) setChosen(i); }} onClick={() => pick(h)}
            >
              <span className="title">{hitTitle(h)}</span>
              <span className="where">{placeLabel(h, where, props.state)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
