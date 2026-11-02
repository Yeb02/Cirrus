import type { Id } from './model.ts';
import { normalizeTag, TagError } from './registry.ts';
import { branchKey, parseBranchKey, type State } from './state.ts';

export interface Violation {
  code: 'members' | 'duplicateMember' | 'twoGroups' | 'cycle' | 'trashedPlaced' | 'structureOutsideDocument' | 'tag';
  message: string;
  subject: Id;
}

/** Direct groups of a node in a plan: inclusion connections whose two branches are shown in that plan. */
function groupsOf(s: State, plan: Id, node: Id): Id[] {
  const groups: Id[] = [];
  for (const c of s.connections.values()) {
    if (c.kind !== 'inclusion' || c.trashedAt !== undefined) continue;
    const member = c.members.find((m) => m.role === 'source');
    const group = c.members.find((m) => m.role === 'target');
    if (!member || !group || member.node !== node) continue;
    if (s.branches.has(branchKey({ plan, connection: c.id, node })) && s.branches.has(branchKey({ plan, connection: c.id, node: group.node }))) {
      groups.push(group.node);
    }
  }
  return groups;
}

/** The direct group of a node in a plan (spec 10: at most one). */
export function groupOf(s: State, plan: Id, node: Id): Id | undefined {
  return groupsOf(s, plan, node)[0];
}

/** From the parent up to the root; stops on a cycle. */
export function ancestors(s: State, plan: Id, node: Id): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>([node]);
  for (let g = groupOf(s, plan, node); g !== undefined && !seen.has(g); g = groupOf(s, plan, g)) {
    out.push(g);
    seen.add(g);
  }
  return out;
}

/** Every violated rule; with `touched`, only violations about those objects. */
export function checkState(s: State, touched?: Set<Id>): Violation[] {
  const out: Violation[] = [];

  for (const c of s.connections.values()) {
    if (c.trashedAt !== undefined) continue;
    if (c.kind === 'knowledge' && c.members.length < 2) {
      out.push({ code: 'members', subject: c.id, message: 'Une connexion doit relier au moins deux nœuds.' });
    }
    if (new Set(c.members.map((m) => m.node)).size !== c.members.length) {
      out.push({ code: 'duplicateMember', subject: c.id, message: 'Un nœud ne peut figurer qu’une fois dans une connexion.' });
    }
    for (const t of c.tags) {
      try { normalizeTag(t, s.tagKeys); } catch (e) {
        if (e instanceof TagError) out.push({ code: 'tag', subject: c.id, message: e.message });
        else throw e;
      }
    }
  }

  for (const n of s.nodes.values()) {
    for (const t of n.tags) {
      try { normalizeTag(t, s.tagKeys); } catch (e) {
        if (e instanceof TagError) out.push({ code: 'tag', subject: n.id, message: e.message });
        else throw e;
      }
    }
  }

  for (const p of s.placements.values()) {
    if (s.nodes.get(p.node)?.trashedAt !== undefined) {
      out.push({ code: 'trashedPlaced', subject: p.node, message: 'Un nœud à la corbeille ne peut pas être placé dans un plan.' });
    }
  }

  // Group hierarchy, per plan: one direct group, no cycle (spec 10).
  const membersByPlan = new Map<Id, Set<Id>>();
  for (const key of s.branches) {
    const b = parseBranchKey(key);
    const c = s.connections.get(b.connection);
    if (!c) continue;
    if (c.kind === 'inclusion') {
      if (!membersByPlan.has(b.plan)) membersByPlan.set(b.plan, new Set());
      membersByPlan.get(b.plan)!.add(b.node);
    }
    if (c.kind === 'structure' && s.plans.get(b.plan)?.type !== 'document') {
      out.push({ code: 'structureOutsideDocument', subject: c.id, message: 'Une connexion de structure n’existe que dans un plan document.' });
    }
  }
  for (const [plan, nodes] of membersByPlan) {
    for (const node of nodes) {
      if (groupsOf(s, plan, node).length > 1) {
        out.push({ code: 'twoGroups', subject: node, message: 'Ce nœud est déjà dans un groupe de ce plan.' });
      }
      const seen = new Set<Id>([node]);
      for (let g = groupOf(s, plan, node); g !== undefined; g = groupOf(s, plan, g)) {
        if (seen.has(g)) {
          out.push({ code: 'cycle', subject: node, message: 'Un groupe ne peut pas être inclus dans lui-même ni dans un de ses descendants.' });
          break;
        }
        seen.add(g);
      }
    }
  }

  // One violation per (code, subject).
  const unique = [...new Map(out.map((v) => [`${v.code}|${v.subject}`, v])).values()];
  return touched ? unique.filter((v) => touched.has(v.subject)) : unique;
}
