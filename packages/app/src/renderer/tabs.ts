import type { Id, PlanRec } from '@cirrus/core';

const TABS_KEY = 'cirrus.tabs';

/**
 * The tabs that are not plans (plan 6b, D6), kept with the others under these reserved identifiers: no plan has one
 * (a plan's identifier is a uuidv7).
 */
export const AGENDA_TAB = '@agenda';
export const SHEETS_TAB = '@feuillets';
/** Whether `id` is the agenda's tab or the sheets'. */
export const isViewTab = (id: Id): boolean => id === AGENDA_TAB || id === SHEETS_TAB;

/** Open tabs are a per-PC convenience: kept in localStorage, which may be unavailable. */
export function loadTabs(): Id[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function saveTabs(tabs: Id[]): void {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* not kept */ }
}

/**
 * The open tabs and the active one, once the plans they show may be gone (an undone plan creation, plan 5's changes from
 * elsewhere): a tab whose plan no longer exists is dropped, and the active tab falls back to the lobby (F4 of the final
 * review). The agenda's and the sheets' tabs stay (plan 6b, D6). Nothing gone, the same array and id come back.
 */
export function liveTabs(plans: ReadonlyMap<Id, PlanRec>, open: Id[], active: Id): { open: Id[]; active: Id } {
  const live = (id: Id) => plans.has(id) || isViewTab(id);
  const kept = open.every(live) ? open : open.filter(live);
  const shown = plans.has(active) ? active : ([...plans.values()].find((p) => p.type === 'lobby')?.id ?? active);
  return { open: kept, active: shown };
}
