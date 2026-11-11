import { connId, connKind, type Id, INCLUSION, memberOf, nodeRow, phantomsOf, placementKey, type State } from '@cirrus/core';

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

/**
 * Whether one of these nodes figures in a plan other than `plan` (ronde 1 of the review): placed there, or shown there
 * as a stub (a branch of one of its connections, inclusions aside: those are not drawn) or by a phantom; an annotation
 * always does, since it lives under its PDF (« ici seulement » keeps it there).
 */
export function nodesElsewhere(s: State, plan: Id, nodes: Id[]): boolean {
  const others = [...s.plans.keys()].filter((p) => p !== plan);
  return nodes.some((n) => {
    if (s.nodes.get(n)?.anchor !== undefined) return true;
    if (others.some((p) => s.placements.has(placementKey(p, n)))) return true;
    const row = nodeRow(s, n);
    if (row < 0) return false;
    for (const c of memberOf(s, row)) {
      const connection = connId(s, c);
      if (connKind(s, c) !== INCLUSION && others.some((p) => s.branches.has({ plan: p, connection, node: n }))) return true;
      if (phantomsOf(s, connection).some((id) => { const ph = s.phantoms.get(id); return ph !== undefined && ph.of.node === n && ph.plan !== plan; })) return true;
    }
    return false;
  });
}
