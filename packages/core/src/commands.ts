import { uuidv7 } from './ids.ts';
import { checkState, touchedBy } from './invariants.ts';
import type { ConnectionKind, ConnectionRec, Id, Member, NodeRec, PhantomRec, Placement, PlanType, Role, TagValue } from './model.ts';
import type { Op } from './ops.ts';
import { normalizeTag } from './registry.ts';
import { applyOp, branchKey, cloneState, parseBranchKey, placementKey, type State } from './state.ts';

/** One user action: one undo step, one group of journal lines (spec 6.4). */
export interface Action { id: Id; label: string; ops: Op[] }

export class CommandError extends Error {}

/**
 * Collects operations against a draft copy, so each operation sees the effects of the previous ones. Before an
 * action is returned, the rules are checked on the draft: an action may not add a violation.
 */
class Draft {
  readonly s: State;
  readonly ops: Op[] = [];
  private readonly original: State;
  constructor(original: State) {
    this.original = original;
    this.s = cloneState(original);
  }
  push(op: Op): void {
    applyOp(this.s, op);
    this.ops.push(op);
  }
  node(id: Id, after: NodeRec | null): void {
    this.push({ t: 'node', before: this.s.nodes.get(id) ?? null, after });
  }
  connection(id: Id, after: ConnectionRec | null): void {
    this.push({ t: 'connection', before: this.s.connections.get(id) ?? null, after });
  }
  placement(plan: Id, node: Id, after: Placement | null): void {
    this.push({ t: 'placement', before: this.s.placements.get(placementKey(plan, node)) ?? null, after });
  }
  branch(plan: Id, connection: Id, node: Id, present: boolean): void {
    const key = { plan, connection, node };
    const before = this.s.branches.has(branchKey(key));
    if (before !== present) this.push({ t: 'branch', key, before, after: present });
  }
  phantom(id: Id, after: PhantomRec | null): void {
    this.push({ t: 'phantom', before: this.s.phantoms.get(id) ?? null, after });
  }
  finish(label: string): Action {
    const touched = touchedBy(this.ops);
    const known = new Set(checkState(this.original, touched).map((v) => `${v.code}|${v.subject}`));
    const added = checkState(this.s, touched).filter((v) => !known.has(`${v.code}|${v.subject}`));
    if (added.length > 0) throw new CommandError(added[0].message);
    return { id: uuidv7(), label, ops: this.ops };
  }
}

const need = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new CommandError(message);
  return value;
};
const nodeOf = (s: State, id: Id) => need(s.nodes.get(id), 'Nœud introuvable.');
const connectionOf = (s: State, id: Id) => need(s.connections.get(id), 'Connexion introuvable.');
const branchesOf = (s: State, pred: (plan: Id, connection: Id, node: Id) => boolean) =>
  [...s.branches].map(parseBranchKey).filter((b) => pred(b.plan, b.connection, b.node));
const placementsOf = (s: State, node: Id) => [...s.placements.values()].filter((p) => p.node === node);

export function createPlan(s: State, name: string, type: PlanType): Action {
  const d = new Draft(s);
  const id = uuidv7();
  d.push({ t: 'plan', before: null, after: { id, name, type } });
  return d.finish(`Créer le plan « ${name} »`);
}

export function createNode(s: State, a: { plan: Id; title: string; x: number; y: number; k: number; summary?: string; tags?: TagValue[] }): Action {
  need(s.plans.get(a.plan), 'Plan introuvable.');
  const d = new Draft(s);
  const id = uuidv7();
  const tags = (a.tags ?? []).map((t) => normalizeTag(t, s.tagKeys));
  d.node(id, { id, title: a.title, summary: a.summary ?? '', tags, files: [] });
  d.placement(a.plan, id, { plan: a.plan, node: id, x: a.x, y: a.y, k: a.k });
  return d.finish(`Créer « ${a.title} »`);
}

export function editNode(s: State, id: Id, patch: Partial<Pick<NodeRec, 'title' | 'summary' | 'tags' | 'files'>>): Action {
  const n = nodeOf(s, id);
  const d = new Draft(s);
  const tags = patch.tags ? patch.tags.map((t) => normalizeTag(t, s.tagKeys)) : n.tags;
  d.node(id, { ...n, ...patch, tags });
  return d.finish(`Modifier « ${patch.title ?? n.title} »`);
}

export function moveNodes(s: State, plan: Id, moves: { node: Id; x: number; y: number; k?: number }[]): Action {
  const d = new Draft(s);
  for (const m of moves) {
    const p = need(s.placements.get(placementKey(plan, m.node)), 'Ce nœud n’est pas dans ce plan.');
    d.placement(plan, m.node, { ...p, x: m.x, y: m.y, k: m.k ?? p.k });
  }
  return d.finish(moves.length === 1 ? 'Déplacer un nœud' : `Déplacer ${moves.length} nœuds`);
}

/** Adds an existing node to a plan (paste, add to the lobby). */
export function placeNode(s: State, plan: Id, node: Id, x: number, y: number, k: number): Action {
  need(s.plans.get(plan), 'Plan introuvable.');
  const n = nodeOf(s, node);
  if (n.trashedAt !== undefined) throw new CommandError('Ce nœud est à la corbeille.');
  if (s.placements.has(placementKey(plan, node))) throw new CommandError('Ce nœud est déjà dans ce plan.');
  const d = new Draft(s);
  d.placement(plan, node, { plan, node, x, y, k });
  return d.finish(`Placer « ${n.title} »`);
}

/**
 * "Here only" removal (spec 7): the node leaves this plan, with its group links in this plan; its knowledge branches
 * stay and are drawn as stubs. Leaving its last plan sends it to the trash.
 */
export function removeFromPlan(s: State, plan: Id, node: Id): Action {
  const n = nodeOf(s, node);
  need(s.placements.get(placementKey(plan, node)), 'Ce nœud n’est pas dans ce plan.');
  const d = new Draft(s);
  d.placement(plan, node, null);
  for (const b of branchesOf(d.s, (p, c) => p === plan && d.s.connections.get(c)?.kind === 'inclusion')) {
    const c = d.s.connections.get(b.connection)!;
    if (c.members.some((m) => m.node === node)) for (const m of c.members) d.branch(plan, c.id, m.node, false);
  }
  if (placementsOf(d.s, node).length === 0) d.node(node, { ...n, trashedAt: Date.now() });
  return d.finish(`Retirer « ${n.title} » de ce plan`);
}

/** "Everywhere" deletion: out of every plan and every connection; connections left with fewer than two members go to the trash. */
export function deleteEverywhere(s: State, node: Id): Action {
  const n = nodeOf(s, node);
  const d = new Draft(s);
  for (const p of placementsOf(d.s, node)) d.placement(p.plan, node, null);
  for (const c of [...d.s.connections.values()]) {
    if (c.trashedAt !== undefined || !c.members.some((m) => m.node === node)) continue;
    const members = c.members.filter((m) => m.node !== node);
    for (const b of branchesOf(d.s, (_p, conn, nd) => conn === c.id && nd === node)) d.branch(b.plan, c.id, node, false);
    if (c.kind !== 'knowledge' || members.length < 2) {
      for (const b of branchesOf(d.s, (_p, conn) => conn === c.id)) d.branch(b.plan, c.id, b.node, false);
      d.connection(c.id, { ...c, members, trashedAt: Date.now() });
    } else d.connection(c.id, { ...c, members });
  }
  for (const ph of [...d.s.phantoms.values()]) if (ph.of.node === node) d.phantom(ph.id, null);
  d.node(node, { ...n, trashedAt: Date.now() });
  return d.finish(`Supprimer « ${n.title} » partout`);
}

export function restoreNode(s: State, node: Id, plan: Id, x: number, y: number, k: number): Action {
  const n = nodeOf(s, node);
  if (n.trashedAt === undefined) throw new CommandError('Ce nœud n’est pas à la corbeille.');
  const d = new Draft(s);
  const { trashedAt: _trashed, ...rest } = n;
  d.node(node, rest);
  d.placement(plan, node, { plan, node, x, y, k });
  return d.finish(`Restaurer « ${n.title} »`);
}

/** A new connection, shown in this plan only ("here only", spec 11.1). */
export function connect(s: State, a: { plan: Id; members: Member[]; title?: string; relation?: string; kind?: ConnectionKind; tags?: TagValue[] }): Action {
  need(s.plans.get(a.plan), 'Plan introuvable.');
  for (const m of a.members) nodeOf(s, m.node);
  const d = new Draft(s);
  const id = uuidv7();
  const tags = (a.tags ?? []).map((t) => normalizeTag(t, s.tagKeys));
  d.connection(id, { id, kind: a.kind ?? 'knowledge', title: a.title ?? '', relation: a.relation ?? '', tags, members: a.members });
  for (const m of a.members) d.branch(a.plan, id, m.node, true);
  return d.finish('Créer une connexion');
}

export function addMember(s: State, plan: Id, connection: Id, member: Member): Action {
  const c = connectionOf(s, connection);
  nodeOf(s, member.node);
  if (c.members.some((m) => m.node === member.node)) throw new CommandError('Ce nœud fait déjà partie de la connexion.');
  const d = new Draft(s);
  d.connection(connection, { ...c, members: [...c.members, member] });
  d.branch(plan, connection, member.node, true);
  return d.finish('Ajouter un nœud à la connexion');
}

/** Removes a member everywhere; a connection left with fewer than two members goes to the trash. */
export function removeMember(s: State, connection: Id, node: Id): Action {
  const c = connectionOf(s, connection);
  const d = new Draft(s);
  const members = c.members.filter((m) => m.node !== node);
  for (const b of branchesOf(d.s, (_p, conn, nd) => conn === connection && nd === node)) d.branch(b.plan, connection, node, false);
  if (members.length < 2) {
    for (const b of branchesOf(d.s, (_p, conn) => conn === connection)) d.branch(b.plan, connection, b.node, false);
    d.connection(connection, { ...c, members, trashedAt: Date.now() });
  } else d.connection(connection, { ...c, members });
  return d.finish('Retirer un nœud de la connexion');
}

export function setRole(s: State, connection: Id, node: Id, role: Role): Action {
  const c = connectionOf(s, connection);
  if (!c.members.some((m) => m.node === node)) throw new CommandError('Ce nœud ne fait pas partie de la connexion.');
  const d = new Draft(s);
  d.connection(connection, { ...c, members: c.members.map((m) => (m.node === node ? { ...m, role } : m)) });
  return d.finish('Changer le rôle d’un nœud');
}

/** Removes the node's own group links in this plan. */
function leaveGroup(d: Draft, plan: Id, node: Id): void {
  for (const c of [...d.s.connections.values()]) {
    if (c.kind !== 'inclusion' || c.members.find((m) => m.role === 'source')?.node !== node) continue;
    for (const m of c.members) d.branch(plan, c.id, m.node, false);
  }
}

/** Puts a node in a group, in this plan only; it replaces the node's current group there (spec 10). */
export function include(s: State, plan: Id, node: Id, group: Id): Action {
  const n = nodeOf(s, node);
  const g = nodeOf(s, group);
  if (node === group) throw new CommandError('Un groupe ne peut pas être inclus dans lui-même ni dans un de ses descendants.');
  const d = new Draft(s);
  leaveGroup(d, plan, node);
  let link = [...d.s.connections.values()].find((c) =>
    c.kind === 'inclusion' && c.members.some((m) => m.role === 'source' && m.node === node) && c.members.some((m) => m.role === 'target' && m.node === group));
  if (!link) {
    const id = uuidv7();
    link = { id, kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node, role: 'source' }, { node: group, role: 'target' }] };
    d.connection(id, link);
  } else if (link.trashedAt !== undefined) {
    const { trashedAt: _trashed, ...rest } = link;
    d.connection(link.id, rest);
  }
  d.branch(plan, link.id, node, true);
  d.branch(plan, link.id, group, true);
  return d.finish(`Mettre « ${n.title} » dans « ${g.title} »`);
}

export function exclude(s: State, plan: Id, node: Id): Action {
  const n = nodeOf(s, node);
  const d = new Draft(s);
  leaveGroup(d, plan, node);
  return d.finish(`Sortir « ${n.title} » de son groupe`);
}

/** Split arm (spec 8.5): the branch leaves the plan, replaced by a phantom of the far node near the bundle and a phantom of the centre near that node. */
export function splitArm(s: State, plan: Id, connection: Id, node: Id, near: { x: number; y: number; k: number }, far: { x: number; y: number; k: number }): Action {
  connectionOf(s, connection);
  if (!s.branches.has(branchKey({ plan, connection, node }))) throw new CommandError('Cette branche n’est pas affichée dans ce plan.');
  const d = new Draft(s);
  d.branch(plan, connection, node, false);
  const a = uuidv7(), b = uuidv7();
  d.phantom(a, { id: a, plan, connection, of: { kind: 'node', node }, ...near });
  d.phantom(b, { id: b, plan, connection, of: { kind: 'center', node }, ...far });
  return d.finish('Scinder ce bras');
}

export function joinArm(s: State, plan: Id, connection: Id, node: Id): Action {
  const phantoms = [...s.phantoms.values()].filter((p) => p.plan === plan && p.connection === connection && p.of.kind !== 'absent' && p.of.node === node);
  if (phantoms.length === 0) throw new CommandError('Ce bras n’est pas scindé.');
  const d = new Draft(s);
  for (const p of phantoms) d.phantom(p.id, null);
  d.branch(plan, connection, node, true);
  return d.finish('Réunir ce bras');
}

/** A phantom moves like a node and may sit in a group (spec 8.5). */
export function movePhantom(s: State, phantom: Id, x: number, y: number, group?: Id | null): Action {
  const p = need(s.phantoms.get(phantom), 'Fantôme introuvable.');
  const d = new Draft(s);
  const next: PhantomRec = { ...p, x, y };
  if (group === null) delete next.group;
  else if (group !== undefined) next.group = group;
  d.phantom(phantom, next);
  return d.finish('Déplacer un fantôme');
}
