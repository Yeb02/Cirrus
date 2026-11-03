import type { Id, TagValue } from './model.ts';
import type { Op } from './ops.ts';
import { normalizeTag, TagError } from './registry.ts';
import { directGroup, placedIn, type State } from './state.ts';
import { INCLUSION, KNOWLEDGE, memberNode, NO_RECORD, STRUCTURE } from './tables.ts';

export interface Violation {
  code: 'members' | 'duplicateMember' | 'branchNotMember' | 'twoGroups' | 'cycle' | 'trashedPlaced' | 'structureOutsideDocument' | 'tag';
  message: string;
  subject: Id;
}

/** The direct group of a node in a plan (spec 10: at most one), read from the index. */
export function groupOf(s: State, plan: Id, node: Id): Id | undefined {
  const p = s.tables.plans.rows.get(plan), n = s.tables.nodes.rows.get(node);
  const g = p < 0 || n < 0 ? -1 : directGroup(s, p, n);
  return g < 0 ? undefined : s.tables.nodes.rows.ids[g];
}

/**
 * From the parent up to the root; stops on a cycle. Includes groups not placed in the plan (a removed group keeps its
 * links, spec 7): a member is drawn in its nearest ancestor that is placed.
 */
export function ancestors(s: State, plan: Id, node: Id): Id[] {
  const p = s.tables.plans.rows.get(plan), n = s.tables.nodes.rows.get(node);
  if (p < 0 || n < 0) return [];
  const out: Id[] = [];
  const seen = new Set<number>([n]);
  for (let g = directGroup(s, p, n); g >= 0 && !seen.has(g); g = directGroup(s, p, g)) {
    out.push(s.tables.nodes.rows.ids[g]);
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
  const T = s.tables, C = T.conns, nodeIds = T.nodes.rows.ids;
  const scope = touched && new Set(touched);
  if (scope) for (const id of touched!) {
    const c = C.rows.get(id);
    if (c >= 0 && C.kind[c] === INCLUSION) for (const m of C.members.view(c)) scope.add(nodeIds[memberNode(m)]);
  }
  // Connection rows with a record: those in scope, or all.
  const conns: number[] = [];
  if (scope) for (const id of scope) { const c = C.rows.get(id); if (c >= 0 && C.kind[c] !== NO_RECORD) conns.push(c); }
  else for (let c = 0; c < C.rows.end; c++) if (C.kind[c] !== NO_RECORD) conns.push(c);
  const checkTags = (subject: Id, tags: readonly TagValue[]) => {
    for (const t of tags) {
      try { normalizeTag(t, s.tagKeys); } catch (e) {
        if (e instanceof TagError) out.push({ code: 'tag', subject, message: e.message });
        else throw e;
      }
    }
  };

  for (const c of conns) {
    if (!Number.isNaN(C.trashedAt[c])) continue;
    const id = C.rows.ids[c], members = C.members.view(c);
    if (C.kind[c] === KNOWLEDGE && members.length < 2) {
      out.push({ code: 'members', subject: id, message: 'Une connexion doit relier au moins deux nœuds.' });
    }
    if (new Set(Array.from(members, memberNode)).size !== members.length) {
      out.push({ code: 'duplicateMember', subject: id, message: 'Un nœud ne peut figurer qu’une fois dans une connexion.' });
    }
    checkTags(id, C.tags[c]);
  }

  const nodes = scope ? [...scope].flatMap((id) => { const n = T.nodes.rows.get(id); return n >= 0 && T.nodes.recs[n] ? [n] : []; }) : [];
  if (!scope) for (let n = 0; n < T.nodes.recs.length; n++) if (T.nodes.recs[n]) nodes.push(n);
  for (const n of nodes) {
    const rec = T.nodes.recs[n]!;
    checkTags(rec.id, rec.tags);
    if (rec.trashedAt !== undefined && Array.from(placedIn(s, n)).some((p) => T.plans.recs[p] !== undefined)) {
      out.push({ code: 'trashedPlaced', subject: rec.id, message: 'Un nœud à la corbeille ne peut pas être placé dans un plan.' });
    }
  }

  // Branches and groups depend on connections and branches only: an action touching no connection skips the rest.
  if (scope && ![...scope].some((id) => s.connections.has(id))) return dedupe(out);

  for (const c of conns) {
    const id = C.rows.ids[c], b = C.branches.view(c), members = C.members.view(c);
    for (let i = 0; i < b.length; i += 2) {
      if (C.kind[c] === STRUCTURE && T.plans.recs[b[i]]?.type !== 'document') {
        out.push({ code: 'structureOutsideDocument', subject: id, message: 'Une connexion de structure n’existe que dans un plan document.' });
      }
      if (!members.some((m) => memberNode(m) === b[i + 1])) {
        out.push({ code: 'branchNotMember', subject: id, message: 'Une branche ne peut relier qu’un membre de sa connexion.' });
      }
    }
  }

  // Per plan: one direct group, no cycle (spec 10). Without scope, every node with a group, in every plan with groups;
  // with one, the nodes in scope, in every plan.
  const groupNodes = scope ? nodes : undefined;
  s.index.groupOf.forEach((pg, p) => {
    if (!pg || (scope && T.plans.recs[p] === undefined)) return;
    const groupsIn = (n: number): readonly number[] => pg.multi.get(n) ?? (n < pg.group.length && pg.group[n] >= 0 ? [pg.group[n]] : []);
    const list = groupNodes ?? Array.from(pg.group.keys()).filter((n) => pg.group[n] >= 0);
    for (const n of list) {
      const groups = groupsIn(n);
      if (groups.length > 1) out.push({ code: 'twoGroups', subject: nodeIds[n], message: 'Ce nœud est déjà dans un groupe de ce plan.' });
      const seen = new Set<number>([n]);
      for (let g: number | undefined = groups[0]; g !== undefined; g = groupsIn(g)[0]) {
        if (seen.has(g)) {
          out.push({ code: 'cycle', subject: nodeIds[n], message: 'Un groupe ne peut pas être inclus dans lui-même ni dans un de ses descendants.' });
          break;
        }
        seen.add(g);
      }
    }
  });

  return dedupe(out);
}

/** One violation per (code, subject). */
const dedupe = (out: Violation[]): Violation[] => [...new Map(out.map((v) => [`${v.code}|${v.subject}`, v])).values()];
