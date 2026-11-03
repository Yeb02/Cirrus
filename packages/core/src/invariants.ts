import type { Id, TagValue } from './model.ts';
import type { Op } from './ops.ts';
import { normalizeTag, TagError } from './registry.ts';
import { dataOf, directGroup, nodeId, nodeRow, planRow, type State } from './state.ts';
import { INCLUSION, KNOWLEDGE, memberNode, NO_RECORD, STRUCTURE } from './tables.ts';

export interface Violation {
  code: 'members' | 'duplicateMember' | 'branchNotMember' | 'twoGroups' | 'cycle' | 'trashedPlaced' | 'structureOutsideDocument' | 'tag';
  message: string;
  subject: Id;
}

/** The direct group of a node in a plan (spec 10: at most one), read from the index. */
export function groupOf(s: State, plan: Id, node: Id): Id | undefined {
  const p = planRow(s, plan), n = nodeRow(s, node);
  const g = p < 0 || n < 0 ? -1 : directGroup(s, p, n);
  return g < 0 ? undefined : nodeId(s, g);
}

/**
 * From the parent up to the root; stops on a cycle. Includes groups not placed in the plan (a removed group keeps its
 * links, spec 7): a member is drawn in its nearest ancestor that is placed.
 */
export function ancestors(s: State, plan: Id, node: Id): Id[] {
  const p = planRow(s, plan), n = nodeRow(s, node);
  if (p < 0 || n < 0) return [];
  const out: Id[] = [];
  const seen = new Set<number>([n]);
  for (let g = directGroup(s, p, n); g >= 0 && !seen.has(g); g = directGroup(s, p, g)) {
    out.push(nodeId(s, g));
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
        for (const r of [op.before, op.after]) {
          if (!r) continue;
          touched.add(r.id);
          for (const m of r.members) touched.add(m.node);
        }
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
 * Every violated rule. With `touched`, exactly the violations about those objects and the members of touched inclusion
 * connections, and only those are computed, from the indices: commands pay for what they touch, not for the size of
 * the base.
 */
export function checkState(s: State, touched?: Set<Id>): Violation[] {
  const out: Violation[] = [];
  const { tables: T, index: I } = dataOf(s), C = T.conns, N = T.nodes, nodeIds = N.rows.ids;
  const scope = touched && new Set(touched);
  if (scope) for (const id of touched!) {
    const c = C.rows.get(id);
    if (c >= 0 && C.kind[c] === INCLUSION) for (const m of C.members.view(c)) scope.add(nodeIds[memberNode(m)]);
  }
  // Rows in scope, or all: connections with a record, nodes with a row (a record or only references).
  const conns: number[] = [], nodeRows: number[] = [];
  if (scope) {
    for (const id of scope) {
      const c = C.rows.get(id), n = N.rows.get(id);
      if (c >= 0 && C.kind[c] !== NO_RECORD) conns.push(c);
      if (n >= 0) nodeRows.push(n);
    }
  } else {
    for (let c = 0; c < C.rows.end; c++) if (C.kind[c] !== NO_RECORD) conns.push(c);
    for (let n = 0; n < N.rows.end; n++) if (nodeIds[n] !== '') nodeRows.push(n);
  }
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

  for (const n of nodeRows) {
    const rec = N.recs[n];
    if (!rec) continue;
    checkTags(rec.id, rec.tags);
    if (rec.trashedAt !== undefined && I.placedIn.view(n).some((p) => T.plans.recs[p] !== undefined)) {
      out.push({ code: 'trashedPlaced', subject: rec.id, message: 'Un nœud à la corbeille ne peut pas être placé dans un plan.' });
    }
  }

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

  // Per plan: one direct group, no cycle (spec 10), for each node with a group there, in every plan with groups (with a
  // record or only references). A node's first group is `group` (multi lists it first): its chain follows that one.
  const chain: number[] = [];
  I.groupOf.forEach((pg) => {
    if (!pg) return;
    const groups = pg.group, first = (n: number) => (n < groups.length ? groups[n] : -1);
    for (const n of scope ? nodeRows : groups.keys()) {
      const g0 = first(n);
      if (g0 < 0) continue;
      if (pg.multi.has(n)) out.push({ code: 'twoGroups', subject: nodeIds[n], message: 'Ce nœud est déjà dans un groupe de ce plan.' });
      chain.length = 0;
      chain.push(n);
      for (let g = g0; g >= 0; g = first(g)) {
        if (chain.includes(g)) {
          out.push({ code: 'cycle', subject: nodeIds[n], message: 'Un groupe ne peut pas être inclus dans lui-même ni dans un de ses descendants.' });
          break;
        }
        chain.push(g);
      }
    }
  });

  return dedupe(out);
}

/** One violation per (code, subject). */
const dedupe = (out: Violation[]): Violation[] => [...new Map(out.map((v) => [`${v.code}|${v.subject}`, v])).values()];
