import { type Id, placementKey, type Role, type State } from '@cirrus/core';
import { nodeSuggestions, type RenderParams } from '@cirrus/view';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Build, connectionTagsBuild, connectionTextBuild, roleBuild } from '../actions.ts';
import type { LatexRegistry, Origin } from '../latex/registry.ts';
import { LatexField } from './latex/LatexField.tsx';
import type { Rect } from './panels/geometry.ts';
import { Tags } from './Tags.tsx';

const ROLES: { value: Role; label: string }[] = [
  { value: 'source', label: 'source' }, { value: 'target', label: 'cible' }, { value: 'associate', label: 'associé' },
];
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * The connection's pop-up (spec 8.5, 11.2), at the click: title, relation compiled and edited in place with its
 * preview under it (LatexField, plan 4b, task 6; a link in it opens its node's pop-up beside this one, `onNodeLink`),
 * its tags, as a node's (Tags; the registry's keys of scope connection or both are suggested, plan 6a, D4), the members
 * with their roles, those not shown in this plan greyed. Adding or removing a member goes through the graph, which asks
 * « partout ou ici seulement ». `onEdit` resolves with whether the edit was written.
 */
export function ConnectionPopup(props: {
  state: State; plan: Id; connection: Id; x: number; y: number; registry: LatexRegistry | null; params: RenderParams;
  onEdit(build: Build): Promise<boolean>; onAddMember(connection: Id, node: Id): void; onRemoveMember(connection: Id, node: Id): void; onClose(): void;
  onNodeLink(node: Id, near: Rect): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = props.connection;
  const [adding, setAdding] = useState<string | null>(null);
  const relation = useMemo<Origin>(() => ({ kind: 'relation', connection: current }), [current]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    // A click elsewhere closes it, except in the question it asked.
    const away = (e: PointerEvent) => { const t = e.target as Element; if (!ref.current?.contains(t) && !t.closest?.('.ask')) props.onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', away, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', away, true); };
  }, []);
  /** A link clicked in the relation: its node's pop-up beside this one. */
  const nodeLink = (node: Id) => {
    const r = ref.current?.getBoundingClientRect();
    props.onNodeLink(node, r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: props.x, y: props.y, w: 0, h: 0 });
  };

  const s = props.state;
  const c = s.connections.get(current);
  const body = (() => {
    if (!c || c.trashedAt !== undefined) return <p className="dim">Cette connexion n’existe plus.</p>;
    const commit = (patch: { title?: string; relation?: string }) => {
      const changed = (patch.title !== undefined && patch.title !== c.title) || (patch.relation !== undefined && patch.relation !== c.relation);
      if (changed) void props.onEdit(connectionTextBuild(c.id, patch));
    };
    const members = new Set(c.members.map((m) => m.node));
    const found = adding === null ? [] : nodeSuggestions(s, adding, members, 8);
    return (
      <>
        <input key={`t${c.title}`} className="title" defaultValue={c.title} placeholder="Titre (facultatif)"
          onBlur={(e) => commit({ title: e.target.value.trim() })} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <LatexField
          key={c.id} origin={relation} value={c.relation} placeholder="Relation (LaTeX)" rows={3} state={s} registry={props.registry} params={props.params}
          onCommit={(t) => props.onEdit(connectionTextBuild(c.id, { relation: t }))} onNodeLink={nodeLink}
        />
        <h4>Tags</h4>
        <Tags s={s} scope="connection" tags={c.tags} suggested={props.params.tagSuggestions} onChange={(change) => props.onEdit(connectionTagsBuild(c.id, change))} />
        <h4>Membres</h4>
        <ul>
          {c.members.map((m) => {
            const shown = s.branches.has({ plan: props.plan, connection: c.id, node: m.node });
            const placed = s.placements.has(placementKey(props.plan, m.node));
            return (
              <li key={m.node} className={shown ? '' : 'dim'} title={shown ? undefined : 'Pas affiché dans ce plan'}>
                <span className="name">{s.nodes.get(m.node)?.title ?? '?'}{shown && !placed ? ' (amorce)' : ''}</span>
                <select value={m.role} onChange={(e) => void props.onEdit(roleBuild(c.id, m.node, e.target.value as Role))}>
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
