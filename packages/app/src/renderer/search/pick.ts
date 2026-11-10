import type { Id, State } from '@cirrus/core';
import { objectAlive } from '@cirrus/view';
import { OBJECT_GONE } from '../ui/graph/jumps.ts';
import type { SearchHit } from './index.ts';

/** What a live connection that no plan shows is told when its result is chosen: restored (or left) with no two members in a plan. */
export const CONNECTION_NO_PLAN = 'Cette connexion n’est dans aucun plan : aucun plan ne réunit deux de ses nœuds.';

/** What choosing a result with no plan does: the pop-up of an annotation opens; otherwise a notice says why nothing is shown. */
export type NoPlanPick = { popup: Id } | { say: string };

/**
 * A result whose jump goes nowhere (`plan` null, plan 6a, D2): an annotation — a node placed in no plan — opens its
 * pop-up; a live connection that no plan shows (restored from the trash with no branch) says that; an object gone since it
 * was listed — in the trash, or unknown — says OBJECT_GONE, as every jump to one does.
 */
export function pickWithoutPlan(s: State, hit: Pick<SearchHit, 'id' | 'kind'>): NoPlanPick {
  if (!objectAlive(s, hit.kind, hit.id)) return { say: OBJECT_GONE };
  return hit.kind === 'node' ? { popup: hit.id } : { say: CONNECTION_NO_PLAN };
}
