// Test oracle: the rule checks of the object model (src/invariants.ts before plan 3c), copied as is.
import type { ConnectionRec, Id } from '../../src/model.ts';
import type { Op } from '../../src/ops.ts';
import { normalizeTag, TagError } from '../../src/registry.ts';
import { branchKey, parseBranchKey, placementKey, type State } from './state.ts';

export interface Violation {
  code: 'members' | 'duplicateMember' | 'branchNotMember' | 'twoGroups' | 'cycle' | 'trashedPlaced' | 'structureOutsideDocument' | 'tag';
  message: string;
  subject: Id;
}

/** Direct groups per plan, then per member node. */
export type GroupIndex = Map<Id, Map<Id, Id[]>>;

/** The group an inclusion connection puts `node` in, in this plan: both of its branches are shown there. */
function groupVia(s: State, plan: Id, c: ConnectionRec, node: Id): Id | undefined {
  if (c.kind !== 'inclusion' || c.trashedAt !== undefined) return undefined;
  const member = c.members.find((m) => m.role === 'source');
  const group = c.members.find((m) => m.role === 'target');
  if (!member || !group || member.node !== node) return undefined;
  const shown = (n: Id) => s.branches.has(branchKey({ plan, connection: c.id, node: n }));
  return shown(node) && shown(group.node) ? group.node : undefined;
}

/** Every direct group of every node in every plan, in one pass over the branches. For bulk queries (renderer). */
export function groupIndex(s: State): GroupIndex {
  const index: GroupIndex = new Map();
  for (const key of s.branches) {
    const b = parseBranchKey(key);
    const c = s.connections.get(b.connection);
    const g = c && groupVia(s, b.plan, c, b.node);
    if (g === undefined) continue;
    let byNode = index.get(b.plan);
    if (!byNode) index.set(b.plan, (byNode = new Map()));
    const groups = byNode.get(b.node);
    if (groups) groups.push(g);
    else byNode.set(b.node, [g]);
  }
  return index;
}

/** The direct group of a node in a plan (spec 10: at most one). Without an index, scans the connections. */
export function groupOf(s: State, plan: Id, node: Id, index?: GroupIndex): Id | undefined {
  if (index) return index.get(plan)?.get(node)?.[0];
  for (const c of s.connections.values()) {
    const g = groupVia(s, plan, c, node);
    if (g !== undefined) return g;
  }
  return undefined;
}

/**
 * From the parent up to the root; stops on a cycle. Includes groups not placed in the plan (a removed group keeps its
 * links, spec 7): a member is drawn in its nearest ancestor that is placed.
 */
export function ancestors(s: State, plan: Id, node: Id, index?: GroupIndex): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>([node]);
  for (let g = groupOf(s, plan, node, index); g !== undefined && !seen.has(g); g = groupOf(s, plan, g, index)) {
    out.push(g);
    seen.add(g);
  }
  return out;
}

/** The objects an action's operations can make wrong; undefined when everything must be checked (a plan or the tag registry changed). */
export function touchedBy(ops: Op[]): Set<Id> | undefined {
  const touched = new Set<Id>();
  for (const op of ops) {
    switch (op.t) {
      case 'plan':
      case 'tagKey':
        return undefined;
      case 'node':
        touched.add((op.after ?? op.before)!.id);
        break;
      case 'connection':
        for (const r of [op.before, op.after]) if (r) for (const id of [r.id, ...r.members.map((m) => m.node)]) touched.add(id);
        break;
      case 'placement':
        touched.add((op.after ?? op.before)!.node);
        break;
      case 'branch':
        touched.add(op.key.connection);
        touched.add(op.key.node);
        break;
    }
  }
  return touched;
}

/**
 * Every violated rule. With `touched`, only violations about those objects (and the members of touched inclusion
 * connections), and only those are computed: commands pay for what they touch, not for the size of the base.
 */
export function checkState(s: State, touched?: Set<Id>): Violation[] {
  const out: Violation[] = [];
  const scope = touched && new Set(touched);
  if (scope) for (const id of touched!) {
    const c = s.connections.get(id);
    if (c?.kind === 'inclusion') for (const m of c.members) scope.add(m.node);
  }
  const inScope = (id: Id) => !scope || scope.has(id);
  const pick = <V>(map: Map<Id, V>): V[] => (scope ? [...scope].flatMap((id) => { const v = map.get(id); return v ? [v] : []; }) : [...map.values()]);
  const checkTags = (subject: Id, tags: { key: string; value?: string | number }[]) => {
    for (const t of tags) {
      try { normalizeTag(t, s.tagKeys); } catch (e) {
        if (e instanceof TagError) out.push({ code: 'tag', subject, message: e.message });
        else throw e;
      }
    }
  };

  for (const c of pick(s.connections)) {
    if (c.trashedAt !== undefined) continue;
    if (c.kind === 'knowledge' && c.members.length < 2) {
      out.push({ code: 'members', subject: c.id, message: 'Une connexion doit relier au moins deux nœuds.' });
    }
    if (new Set(c.members.map((m) => m.node)).size !== c.members.length) {
      out.push({ code: 'duplicateMember', subject: c.id, message: 'Un nœud ne peut figurer qu’une fois dans une connexion.' });
    }
    checkTags(c.id, c.tags);
  }

  for (const n of pick(s.nodes)) {
    checkTags(n.id, n.tags);
    if (n.trashedAt !== undefined && [...s.plans.keys()].some((plan) => s.placements.has(placementKey(plan, n.id)))) {
      out.push({ code: 'trashedPlaced', subject: n.id, message: 'Un nœud à la corbeille ne peut pas être placé dans un plan.' });
    }
  }

  const structureOutside = (c: ConnectionRec) =>
    out.push({ code: 'structureOutsideDocument', subject: c.id, message: 'Une connexion de structure n’existe que dans un plan document.' });
  // Per plan: one direct group, no cycle (spec 10).
  const hierarchy = (nodes: Iterable<Id>, groupsIn: (node: Id) => Id[]) => {
    for (const node of nodes) {
      const groups = groupsIn(node);
      if (groups.length > 1) out.push({ code: 'twoGroups', subject: node, message: 'Ce nœud est déjà dans un groupe de ce plan.' });
      const seen = new Set<Id>([node]);
      for (let g: Id | undefined = groups[0]; g !== undefined; g = groupsIn(g)[0]) {
        if (seen.has(g)) {
          out.push({ code: 'cycle', subject: node, message: 'Un groupe ne peut pas être inclus dans lui-même ni dans un de ses descendants.' });
          break;
        }
        seen.add(g);
      }
    }
  };

  // Branches and groups depend on connections and branches only: an action touching no connection skips the rest.
  if (scope && ![...scope].some((id) => s.connections.has(id))) return dedupe(out);

  for (const key of s.branches) {
    const b = parseBranchKey(key);
    const c = inScope(b.connection) ? s.connections.get(b.connection) : undefined;
    if (!c) continue;
    if (c.kind === 'structure' && s.plans.get(b.plan)?.type !== 'document') structureOutside(c);
    if (!c.members.some((m) => m.node === b.node)) {
      out.push({ code: 'branchNotMember', subject: c.id, message: 'Une branche ne peut relier qu’un membre de sa connexion.' });
    }
  }

  if (!scope) {
    for (const byNode of groupIndex(s).values()) hierarchy(byNode.keys(), (n) => byNode.get(n) ?? []);
  } else {
    // Only the chains of the touched nodes, through an index of inclusions by member.
    const bySource = new Map<Id, ConnectionRec[]>();
    for (const c of s.connections.values()) {
      const m = c.kind === 'inclusion' ? c.members.find((r) => r.role === 'source') : undefined;
      if (m) bySource.set(m.node, [...(bySource.get(m.node) ?? []), c]);
    }
    const nodes = [...scope].filter((id) => s.nodes.has(id));
    for (const plan of s.plans.keys()) hierarchy(nodes, (n) => (bySource.get(n) ?? []).flatMap((c) => groupVia(s, plan, c, n) ?? []));
  }

  return dedupe(out);
}

/** One violation per (code, subject). */
const dedupe = (out: Violation[]): Violation[] => [...new Map(out.map((v) => [`${v.code}|${v.subject}`, v])).values()];
