import { AGENDA_NODES, type AgendaEntryRec, type Id, type State, uuidv7 } from '@cirrus/core';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { agendaBuild, type Build, deleteAgendaBuild } from '../actions.ts';
import { agendaMonths, agendaRefusal, dayLabel, dayOf, linkedNode, type LinkedNode } from '../agenda.ts';
import type { SearchFilters, SearchIndex, SearchWhere } from '../search/index.ts';

/** The linked-node field searches the titles only (D6), everywhere. */
const TITLES: SearchFilters = { title: true, tags: false, summary: false, content: false, planOnly: false };
const GONE = { trash: '(à la corbeille)', missing: '(disparu)' } as const;

/** What the search of Ctrl+K gives the linked-node field (App's): its index, null while it is being built. */
export interface AgendaSearch { index: SearchIndex | null; where: SearchWhere | null; max: number; want(): void }

/** A node linked by an entry: a button that goes to it (App's goToNode); a node gone, struck and said. */
function NodeLink({ node, onGo }: { node: LinkedNode; onGo(id: Id): void }) {
  if (node.gone) return <span className="node-link gone" data-id={node.id}><s>{node.title}</s> {GONE[node.gone]}</span>;
  return <button className="node-link" data-id={node.id} title="Aller au nœud" onClick={() => onGo(node.id)}>{node.title}</button>;
}

/**
 * An entry's form (D6): its date (today by default), its title, its text, and its nodes, added by a field that searches
 * the titles in the index of Ctrl+K. Entrée in the title saves; Escape gives up. A refusal is said here, in plain French,
 * before the core is asked (agendaRefusal); a form that changes nothing writes nothing (agendaBuild).
 */
function EntryForm(props: {
  state: State; initial: AgendaEntryRec; search: AgendaSearch; onSave(e: AgendaEntryRec): Promise<boolean>; onCancel(): void;
}) {
  const [e, setE] = useState(props.initial);
  const [query, setQuery] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const { index, where, max } = props.search;
  const hits = useMemo(
    () => (index && where && query.trim() !== '' ? index.query(query, TITLES, where, max).filter((h) => h.kind === 'node' && !e.nodes.includes(h.id)) : []),
    [index, where, max, query, e.nodes],
  );
  const status = query.trim() === '' ? '' : !index ? 'Préparation de la recherche…' : hits.length === 0 ? 'Aucun résultat.' : '';
  const add = (id: Id) => {
    if (e.nodes.length >= AGENDA_NODES) { setRefusal(`Une entrée lie au plus ${AGENDA_NODES} nœuds.`); return; }
    setE({ ...e, nodes: [...e.nodes, id] });
    setQuery('');
    setRefusal(null);
  };
  const save = () => {
    const why = agendaRefusal(e);
    if (why) { setRefusal(why); return; }
    void props.onSave(e).then((ok) => { if (!ok) setRefusal('L’entrée n’a pas pu être enregistrée.'); });
  };
  return (
    <form
      className="entry-form" onSubmit={(ev) => { ev.preventDefault(); save(); }}
      // Escape gives the form up, and nothing else (a side panel's Escape waits: its default is prevented). Entrée in the
      // date or the title saves (the node field's adds the first node found; the text's is a new line).
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); props.onCancel(); return; }
        if (ev.key === 'Enter' && (ev.target as Element).matches('input.day, input.title')) { ev.preventDefault(); save(); }
      }}
    >
      <label className="field"><span>Date</span>
        <input type="date" className="day" value={e.day} required onChange={(ev) => setE({ ...e, day: ev.target.value })} />
      </label>
      <label className="field"><span>Titre</span>
        <input type="text" className="title" autoFocus value={e.title} onChange={(ev) => setE({ ...e, title: ev.target.value })} />
      </label>
      <label className="field"><span>Texte</span>
        <textarea className="text" rows={3} value={e.text} onChange={(ev) => setE({ ...e, text: ev.target.value })} />
      </label>
      <div className="field"><span>Nœuds liés</span>
        {e.nodes.length > 0 && (
          <ul className="linked">
            {e.nodes.map((id) => {
              const n = linkedNode(props.state, id);
              return (
                <li key={id} data-id={id}>
                  {n.gone ? <><s>{n.title}</s> {GONE[n.gone]}</> : n.title}
                  <button type="button" className="unlink" aria-label={`Retirer ${n.title}`} onClick={() => setE({ ...e, nodes: e.nodes.filter((x) => x !== id) })}>×</button>
                </li>
              );
            })}
          </ul>
        )}
        <input
          type="search" className="node-search" placeholder="Chercher un nœud par son titre" value={query}
          onFocus={props.search.want} onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (hits.length > 0) add(hits[0].id); } }}
        />
        {status && <p className="status">{status}</p>}
        {hits.length > 0 && (
          <ul className="hits">
            {hits.map((h) => <li key={h.id}><button type="button" data-id={h.id} onClick={() => add(h.id)}>{h.title.trim() || 'Nœud sans titre'}</button></li>)}
          </ul>
        )}
      </div>
      {refusal && <p className="refusal">{refusal}</p>}
      <div className="actions">
        <button type="submit" className="act primary">Enregistrer</button>
        <button type="button" className="act cancel" onClick={props.onCancel}>Annuler</button>
      </div>
    </form>
  );
}

/**
 * The agenda's tab (plan 6b, D6; spec 17): a vertical timeline, from the oldest at the top to the furthest at the bottom,
 * grouped by month; a line marks today, and the view is placed on it when it opens. Each entry shows its date, its title,
 * its text and its linked nodes — a click goes to one as « Aller au nœud » does (`onGoToNode`); one in the trash or gone
 * is struck and said. « Nouvelle entrée » opens a form; each entry is changed (« Modifier ») and deleted (« Supprimer »)
 * from its line, each one action. No reminder.
 */
export function AgendaView(props: {
  state: State; rev: number; search: AgendaSearch; onEdit(build: Build): Promise<boolean>; onGoToNode(node: Id): void;
}) {
  const today = dayOf(Date.now());
  const months = useMemo(() => agendaMonths(props.state, today), [props.state, props.rev, today]);
  /** The form open: a new entry's, or the one of the entry being changed. */
  const [form, setForm] = useState<{ entry: AgendaEntryRec; fresh: boolean } | null>(null);
  const line = useRef<HTMLLIElement>(null);
  useEffect(() => { line.current?.scrollIntoView({ block: 'center' }); }, []);
  const save = async (e: AgendaEntryRec): Promise<boolean> => {
    const build = agendaBuild(props.state, e);
    const ok = build === null || await props.onEdit(build);
    if (ok) setForm(null);
    return ok;
  };
  const formOf = (f: { entry: AgendaEntryRec }) => (
    <EntryForm key={f.entry.id} state={props.state} initial={f.entry} search={props.search} onSave={save} onCancel={() => setForm(null)} />
  );
  return (
    <section className="page-view agenda" aria-label="Agenda">
      <header>
        <h2>Agenda</h2>
        <button
          className="act new" onClick={() => setForm({ entry: { id: uuidv7(), day: today, title: '', text: '', nodes: [] }, fresh: true })}
        >
          Nouvelle entrée
        </button>
      </header>
      {form?.fresh && formOf(form)}
      <div className="timeline">
        {months.map((m) => (
          <Fragment key={m.key}>
            <h3 className="month">{m.label}</h3>
            <ol className="entries">
              {m.rows.map((r) => {
                if (r.kind === 'today') return <li key="today" ref={line} className="today-line"><span>Aujourd’hui</span></li>;
                const e = r.entry;
                if (form && !form.fresh && form.entry.id === e.id) return <li key={e.id} className="entry editing">{formOf(form)}</li>;
                return (
                  <li key={e.id} className={`entry${e.day < today ? ' past' : ''}`} data-id={e.id}>
                    <div className="when">{dayLabel(e.day)}</div>
                    <div className="body">
                      <div className="title">{e.title}</div>
                      {e.text && <div className="text">{e.text}</div>}
                      {r.nodes.length > 0 && (
                        <ul className="links">{r.nodes.map((n) => <li key={n.id}><NodeLink node={n} onGo={props.onGoToNode} /></li>)}</ul>
                      )}
                    </div>
                    <div className="actions">
                      <button className="act" onClick={() => setForm({ entry: e, fresh: false })}>Modifier</button>
                      <button className="act" onClick={() => void props.onEdit(deleteAgendaBuild(e.id))}>Supprimer</button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Fragment>
        ))}
      </div>
    </section>
  );
}
