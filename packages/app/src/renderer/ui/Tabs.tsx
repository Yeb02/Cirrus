import type { Id, PlanRec } from '@cirrus/core';
import { useState } from 'react';

const KIND: Record<PlanRec['type'], string> = { lobby: '', plan: '', document: 'document' };

/** The lobby tab, always open, then the open plans (spec 7: each plan opens in a tab). */
export function Tabs(props: {
  plans: PlanRec[];
  open: Id[];
  active: Id | null;
  onSelect(id: Id): void;
  onOpen(id: Id): void;
  onClose(id: Id): void;
  settingsOpen: boolean;
  onSettings(): void;
}) {
  const [menu, setMenu] = useState(false);
  const byId = new Map(props.plans.map((p) => [p.id, p]));
  const lobby = props.plans.find((p) => p.type === 'lobby');
  const closed = props.plans
    .filter((p) => p.type !== 'lobby' && !props.open.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const tab = (p: PlanRec, closable: boolean) => (
    <div key={p.id} className={`tab${p.id === props.active ? ' on' : ''}`} onClick={() => props.onSelect(p.id)}>
      <span>{p.name}</span>
      {KIND[p.type] && <span className="kind">{KIND[p.type]}</span>}
      {closable && (
        <button className="close" aria-label={`Fermer ${p.name}`} onClick={(e) => { e.stopPropagation(); props.onClose(p.id); }}>×</button>
      )}
    </div>
  );
  return (
    <div className="tabs">
      {lobby && tab(lobby, false)}
      {props.open.flatMap((id) => (byId.has(id) ? [tab(byId.get(id)!, true)] : []))}
      <div className="add">
        <button aria-label="Ouvrir un plan" onClick={() => setMenu((m) => !m)}>+</button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            {closed.length === 0 && <div className="empty">Tous les plans sont ouverts.</div>}
            {closed.map((p) => (
              <button key={p.id} onClick={() => { setMenu(false); props.onOpen(p.id); }}>
                {p.name}{KIND[p.type] ? ` (${KIND[p.type]})` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="spacer" />
      <button className={`gear${props.settingsOpen ? ' on' : ''}`} aria-label="Réglages" title="Réglages" onClick={props.onSettings}>⚙</button>
    </div>
  );
}
