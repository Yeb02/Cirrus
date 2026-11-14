import type { Action, Id } from '@cirrus/core';

/** What the main area shows (plan 6b, D6): the graph of the plan `active`, or the agenda's or the sheets' tab. */
export type View = 'graph' | 'agenda' | 'sheets';

/**
 * What an undone or redone step says (spec 6.4), `verb` its « Annulé » or « Rétabli »: where it acted, when that is not
 * shown — null when it is. From the graph: the agenda or the sheets for a step made of their records only (they have no
 * plan; final review of plan 6b, I2), else the plans it changed when the plan shown is not one of them. From the agenda
 * or the sheets: nothing for a step that touches their records, the other tab for a step that touches only its records,
 * else the plans it changed — none of them is shown — or no place at all for a content step (`plans` empty).
 */
export function stepNotice(verb: string, action: Action, plans: readonly Id[], active: Id | null, view: View, planName: (id: Id) => string): string | null {
  const records = new Set<Exclude<View, 'graph'>>();
  let other = false;
  for (const op of action.ops) {
    if (op.t === 'agenda') records.add('agenda');
    else if (op.t === 'sheet') records.add('sheets');
    else other = true;
  }
  const said = (where: string) => `${verb}${where} : ${action.label}`;
  const inRecords = () => (records.size > 1 ? ' dans l’agenda et les feuillets' : records.has('agenda') ? ' dans l’agenda' : ' dans les feuillets');
  const inPlans = (ps: readonly Id[]) => ` dans ${ps.length > 1 ? 'les plans' : 'le plan'} ${ps.map((p) => `« ${planName(p)} »`).join(', ')}`;
  if (view === 'graph') {
    if (!other && records.size > 0) return said(inRecords());
    const elsewhere = plans.filter((p) => p !== active);
    return elsewhere.length > 0 && (active === null || !plans.includes(active)) ? said(inPlans(elsewhere)) : null;
  }
  if (records.has(view)) return null;
  if (records.size > 0) return said(inRecords());
  return said(plans.length > 0 ? inPlans(plans) : '');
}
