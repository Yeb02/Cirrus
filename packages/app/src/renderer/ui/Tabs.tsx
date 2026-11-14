import type { Id, PlanRec } from '@cirrus/core';
import { type ReactNode, useState } from 'react';
import { AGENDA_TAB, SHEETS_TAB } from '../tabs.ts';

const KIND: Record<PlanRec['type'], string> = { lobby: '', plan: '', document: 'document' };
/** The tabs that are not plans (plan 6b, D6), in the order the « + » menu offers them. */
const VIEW_TABS: { id: Id; name: string }[] = [{ id: AGENDA_TAB, name: 'Agenda' }, { id: SHEETS_TAB, name: 'Feuillets' }];

/**
 * The lobby tab, always open, then the open tabs (spec 7: each plan opens in a tab; plan 6b, D6: the agenda and the
 * sheets too, closed as a plan is); at the right end, the synchronisation's chip (plan 5a, D8: none without a server)
 * and the settings. `active`: the tab shown — a plan's identifier, or AGENDA_TAB, SHEETS_TAB.
 */
export function Tabs(props: {
  plans: PlanRec[];
  open: Id[];
  active: Id | null;
  onSelect(id: Id): void;
  onOpen(id: Id): void;
  onClose(id: Id): void;
  settingsOpen: boolean;
  onSettings(): void;
  chip?: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const byId = new Map<Id, { id: Id; name: string; kind: string }>([
    ...props.plans.map((p) => [p.id, { id: p.id, name: p.name, kind: KIND[p.type] }] as const),
    ...VIEW_TABS.map((v) => [v.id, { ...v, kind: '' }] as const),
  ]);
  const lobby = props.plans.find((p) => p.type === 'lobby');
  const closed = props.plans
    .filter((p) => p.type !== 'lobby' && !props.open.includes(p.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const views = VIEW_TABS.filter((v) => !props.open.includes(v.id));
  const tab = (t: { id: Id; name: string; kind: string }, closable: boolean) => (
    <div key={t.id} className={`tab${t.id === props.active ? ' on' : ''}`} data-tab={t.id} onClick={() => props.onSelect(t.id)}>
      <span>{t.name}</span>
      {t.kind && <span className="kind">{t.kind}</span>}
      {closable && (
        <button className="close" aria-label={`Fermer ${t.name}`} onClick={(e) => { e.stopPropagation(); props.onClose(t.id); }}>×</button>
      )}
    </div>
  );
  const open = (id: Id) => { setMenu(false); props.onOpen(id); };
  return (
    <div className="tabs">
      {lobby && tab(byId.get(lobby.id)!, false)}
      {props.open.flatMap((id) => (byId.has(id) ? [tab(byId.get(id)!, true)] : []))}
      <div className="add">
        <button aria-label="Ouvrir un plan" onClick={() => setMenu((m) => !m)}>+</button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            {closed.length === 0 && <div className="empty">Tous les plans sont ouverts.</div>}
            {closed.map((p) => (
              <button key={p.id} onClick={() => open(p.id)}>
                {p.name}{KIND[p.type] ? ` (${KIND[p.type]})` : ''}
              </button>
            ))}
            {views.length > 0 && <div className="sep" />}
            {views.map((v) => <button key={v.id} className="view-tab" onClick={() => open(v.id)}>{v.name}</button>)}
          </div>
        )}
      </div>
      <div className="spacer" />
      {props.chip}
      <button className={`gear${props.settingsOpen ? ' on' : ''}`} aria-label="Réglages" title="Réglages" onClick={props.onSettings}>⚙</button>
    </div>
  );
}
