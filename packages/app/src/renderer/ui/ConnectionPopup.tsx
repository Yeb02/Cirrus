import { type Id, placementKey, type Role, type State } from '@cirrus/core';
import { nodeSuggestions, type RenderParams } from '@cirrus/view';
import { useMemo, useRef, useState } from 'react';
import { type Build, connectionTagsBuild, connectionTextBuild, roleBuild } from '../actions.ts';
import type { LatexRegistry, Origin } from '../latex/registry.ts';
import { LatexField } from './latex/LatexField.tsx';
import { FloatingPanel, type Frame } from './panels/FloatingPanel.tsx';
import { Tags } from './Tags.tsx';

const ROLES: { value: Role; label: string }[] = [
  { value: 'source', label: 'source' }, { value: 'target', label: 'cible' }, { value: 'associate', label: 'associé' },
];

/**
 * The connection's pop-up (spec 8.5, 11.2), a floating panel as a node's (Panels, `frame`: the user's feedback of
 * 2026-11-12): its title in the header, the relation compiled and edited in place with its
 * preview under it (LatexField, plan 4b, task 6; a link in it opens its node's pop-up beside this one, `onNodeLink`),
 * its tags, as a node's (Tags; the registry's keys of scope connection or both are suggested, plan 6a, D4), the members
 * with their roles, those not shown in the plan shown greyed (`plan`). Adding or removing a member goes through the
 * graph, which asks « partout ou ici seulement ». `onEdit` resolves with whether the edit was written.
 */
export function ConnectionPopup(props: {
  frame: Frame; state: State; plan: Id; connection: Id; registry: LatexRegistry | null; params: RenderParams;
  onEdit(build: Build): Promise<boolean>; onAddMember(connection: Id, node: Id): void; onRemoveMember(connection: Id, node: Id): void;
  onNodeLink(node: Id): void;
}) {
  const current = props.connection;
  const [adding, setAdding] = useState<string | null>(null);
  const relation = useMemo<Origin>(() => ({ kind: 'relation', connection: current }), [current]);
  const s = props.state;
  const rec = s.connections.get(current);
  const c = rec && rec.trashedAt === undefined ? rec : null;
  // The last title seen stays in the header once the connection is gone, as a node's pop-up does.
  const lastTitle = useRef('');
  if (c) lastTitle.current = c.title;
  const title = c
    ? (
      <input
        key={`t${c.title}`} className="title" defaultValue={c.title} placeholder="Titre (facultatif)" spellCheck={false}
        onBlur={(e) => { const t = e.target.value.trim(); if (t !== c.title) void props.onEdit(connectionTextBuild(c.id, { title: t })); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          // Escape gives up what was typed, as in a node's pop-up; the panel stays (its default prevented).
          else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.value = c.title; e.currentTarget.blur(); }
        }}
      />
    )
    : <span className="title gone">{lastTitle.current}</span>;

  const body = (() => {
    if (!c) return <p className="dim">Cette connexion n’existe plus.</p>;
    const members = new Set(c.members.map((m) => m.node));
    const found = adding === null ? [] : nodeSuggestions(s, adding, members, 8);
    return (
      <>
        <LatexField
          key={c.id} origin={relation} value={c.relation} placeholder="Relation (LaTeX)" rows={3} state={s} registry={props.registry} params={props.params}
          onCommit={(t) => props.onEdit(connectionTextBuild(c.id, { relation: t }))} onNodeLink={props.onNodeLink}
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
                  // Escape gives up the addition; the panel stays (its default prevented).
                  if (e.key === 'Escape') { e.preventDefault(); setAdding(null); }
                }} />
              {found.map((f) => <button key={f.id} className="pick" onClick={() => { props.onAddMember(c.id, f.id); setAdding(null); }}>{f.title}</button>)}
            </div>
          )}
      </>
    );
  })();
  return <FloatingPanel frame={props.frame} className="connection-popup" title={title}>{body}</FloatingPanel>;
}
