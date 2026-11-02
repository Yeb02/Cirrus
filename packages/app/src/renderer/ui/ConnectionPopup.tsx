import { branchKey, type Id, placementKey, type Role, type State } from '@cirrus/core';
import { nodeSuggestions } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { type Build, connectionTextBuild, roleBuild } from '../actions.ts';

const ROLES: { value: Role; label: string }[] = [
  { value: 'source', label: 'source' }, { value: 'target', label: 'cible' }, { value: 'associate', label: 'associé' },
];
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * The connection's pop-up (spec 8.5, 11.2), at the click: title, relation as plain text (its LaTeX preview comes with
 * plan 4), the members with their roles, those not shown in this plan greyed. A line standing for several connections
 * lists them first. Adding or removing a member goes through the graph, which asks « partout ou ici seulement ».
 */
export function ConnectionPopup(props: {
  state: State; plan: Id; connections: Id[]; x: number; y: number;
  onEdit(build: Build): void; onAddMember(connection: Id, node: Id): void; onRemoveMember(connection: Id, node: Id): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<Id | null>(props.connections.length === 1 ? props.connections[0] : null);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    // A click elsewhere closes it, except in the question it asked.
    const away = (e: PointerEvent) => { const t = e.target as Element; if (!ref.current?.contains(t) && !t.closest?.('.ask')) props.onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', away, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', away, true); };
  }, []);

  const s = props.state;
  const c = current ? s.connections.get(current) : undefined;
  const body = (() => {
    if (!current) {
      return (
        <>
          <h4>{props.connections.length} connexions</h4>
          {props.connections.map((id) => (
            <button key={id} className="pick" onClick={() => setCurrent(id)}>{s.connections.get(id)?.title || 'Sans titre'}</button>
          ))}
        </>
      );
    }
    if (!c || c.trashedAt !== undefined) return <p className="dim">Cette connexion n’existe plus.</p>;
    const commit = (patch: { title?: string; relation?: string }) => {
      const changed = (patch.title !== undefined && patch.title !== c.title) || (patch.relation !== undefined && patch.relation !== c.relation);
      if (changed) props.onEdit(connectionTextBuild(c.id, patch));
    };
    const members = new Set(c.members.map((m) => m.node));
    const found = adding === null ? [] : nodeSuggestions(s, adding, members, 8);
    return (
      <>
        <input key={`t${c.title}`} className="title" defaultValue={c.title} placeholder="Titre (facultatif)"
          onBlur={(e) => commit({ title: e.target.value.trim() })} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <textarea key={`r${c.relation}`} defaultValue={c.relation} placeholder="Relation (LaTeX)" rows={3}
          onBlur={(e) => commit({ relation: e.target.value })} />
        <h4>Membres</h4>
        <ul>
          {c.members.map((m) => {
            const shown = s.branches.has(branchKey({ plan: props.plan, connection: c.id, node: m.node }));
            const placed = s.placements.has(placementKey(props.plan, m.node));
            return (
              <li key={m.node} className={shown ? '' : 'dim'} title={shown ? undefined : 'Pas affiché dans ce plan'}>
                <span className="name">{s.nodes.get(m.node)?.title ?? '?'}{shown && !placed ? ' (amorce)' : ''}</span>
                <select value={m.role} onChange={(e) => props.onEdit(roleBuild(c.id, m.node, e.target.value as Role))}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <button className="remove" title="Retirer de la connexion" onClick={() => props.onRemoveMember(c.id, m.node)}>×</button>
              </li>
            );
          })}
        </ul>
        {adding === null
          ? <button className="add" onClick={() => setAdding('')}>+ Ajouter un nœud</button>
          : (
            <div className="adding">
              <input autoFocus value={adding} placeholder="Titre d’un nœud…" onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && found.length > 0) { props.onAddMember(c.id, found[0].id); setAdding(null); }
                  if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); }
                }} />
              {found.map((f) => <button key={f.id} className="pick" onClick={() => { props.onAddMember(c.id, f.id); setAdding(null); }}>{f.title}</button>)}
            </div>
          )}
      </>
    );
  })();
  return (
    <div ref={ref} className="popup" style={{ left: props.x, top: props.y }} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onKeyDown={stop}>
      <button className="close" onClick={props.onClose} title="Fermer">×</button>
      {body}
    </div>
  );
}
