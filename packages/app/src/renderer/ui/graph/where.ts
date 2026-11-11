import { type Id, phantomsOf, placementKey, type State } from '@cirrus/core';

// The questions « Ici seulement / Partout » (spec 7, 11.2) are asked only when another plan is concerned (2026-11-11):
// otherwise the action is done at once, with the effect of « Partout », and Ctrl+Z undoes it as any other.

/** The plans where this member of the connection is shown (its branch there). */
export const memberPlans = (s: State, connection: Id, node: Id): Id[] =>
  [...s.plans.keys()].filter((plan) => s.branches.has({ plan, connection, node }));

/** Whether this member of the connection is shown in a plan other than `plan`. */
export const memberElsewhere = (s: State, plan: Id, connection: Id, node: Id): boolean =>
  memberPlans(s, connection, node).some((p) => p !== plan);

/** The plans where the connection is shown: a branch of one of its members there, or one of its phantoms. */
export function connectionPlans(s: State, connection: Id): Id[] {
  const c = s.connections.get(connection);
  if (!c) return [];
  const phantoms = phantomsOf(s, connection).map((id) => s.phantoms.get(id));
  return [...s.plans.keys()].filter((plan) => c.members.some((m) => s.branches.has({ plan, connection, node: m.node }))
    || phantoms.some((ph) => ph?.plan === plan));
}

/** Whether the connection is shown in a plan other than `plan`. */
export const connectionElsewhere = (s: State, plan: Id, connection: Id): boolean => connectionPlans(s, connection).some((p) => p !== plan);

/** Whether one of these nodes is placed in a plan other than `plan`. */
export const nodesElsewhere = (s: State, plan: Id, nodes: Id[]): boolean =>
  [...s.plans.keys()].some((p) => p !== plan && nodes.some((n) => s.placements.has(placementKey(p, n))));
