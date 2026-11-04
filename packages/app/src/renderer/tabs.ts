import type { Id, PlanRec } from '@cirrus/core';

/**
 * The open tabs and the active one, once the plans they show may be gone (an undone plan creation, plan 5's changes from
 * elsewhere): a tab whose plan no longer exists is dropped, and the active tab falls back to the lobby (F4 of the final
 * review). Nothing gone, the same array and id come back.
 */
export function liveTabs(plans: ReadonlyMap<Id, PlanRec>, open: Id[], active: Id): { open: Id[]; active: Id } {
  const kept = open.every((id) => plans.has(id)) ? open : open.filter((id) => plans.has(id));
  const shown = plans.has(active) ? active : ([...plans.values()].find((p) => p.type === 'lobby')?.id ?? active);
  return { open: kept, active: shown };
}
