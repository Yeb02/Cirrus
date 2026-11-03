import { uuidv7 } from './ids.ts';
import { checkState, groupOf, touchedBy, type Violation } from './invariants.ts';
import type { BranchRec, ConnectionKind, ConnectionLayout, ConnectionRec, Id, Member, NodeRec, PhantomRec, Placement, PlanType, Role, TagValue } from './model.ts';
import type { Op } from './ops.ts';
import { normalizeTag, TagError } from './registry.ts';
import {
  applyKnown, applyOp, connectionOfRow, connId, connKind, dataOf, isCurrentConnection, layoutKey, memberOf, nodeRow, OpConflictError, phantomsIn, phantomsOf,
  placedIn, placementOf, rollback, type State,
} from './state.ts';
import { INCLUSION } from './tables.ts';

/** One user action: one undo step, one group of journal lines (spec 6.4). */
export interface Action { id: Id; label: string; ops: Op[] }

export class CommandError extends Error {}

/**
 * The transaction open on a state: every operation applied to it since it began, in order; the actions finished inside
 * it whose operations are still applied; and its open drafts, the innermost last.
 */
interface Transaction { readonly log: Op[]; readonly made: WeakSet<Action>; readonly drafts: Draft[] }
const transactions = new WeakMap<State, Transaction>();

const violationKey = (v: Violation) => `${v.code}|${v.subject}`;
const stale = (what: string) => new OpConflictError(`${what} a changé depuis : l'opération ne s'applique plus.`);

/**
 * Writes operations into the state itself (plan 3c, decision 2), each seeing the effects of the previous ones. Made by
 * transact, which undoes them when it ends. In a transaction already open on the same state, a draft joins it: what it
 * finishes stays applied until the outermost one ends. Every action is checked once: directly inside a combine, by the
 * combine's own `finish`; otherwise by its own.
 */
export class Draft {
  readonly s: State;
  private readonly tx: Transaction;
  /** Where this draft's operations begin in the transaction's log. */
  private readonly mark: number;
  /** The draft this one was opened in, if any. */
  private readonly parent: Draft | undefined;
  /** combine's draft: the actions finished directly inside it are checked by its own `finish`. */
  private readonly collects: boolean;
  /** The actions finished inside this draft, its own included: forgotten if its operations are undone. */
  private readonly kept: Action[] = [];
  private finished = false;

  private constructor(s: State, tx: Transaction, parent: Draft | undefined, collects: boolean) {
    this.s = s;
    this.tx = tx;
    this.mark = tx.log.length;
    this.parent = parent;
    this.collects = collects;
  }

  /** transact's body (see there). */
  static run<T>(s: State, fn: (d: Draft) => T): T {
    return Draft.within(s, fn, false);
  }

  /** combine's body (see there): the only draft that collects, and it always finishes or throws. */
  static combine(s: State, label: string, steps: ((s: State) => Action)[]): Action {
    return Draft.within(s, (d) => {
      for (const step of steps) {
        const a = step(s);
        if (!d.made(a)) for (const op of a.ops) d.push(op);
      }
      return d.finish(label);
    }, true);
  }

  private static within<T>(s: State, fn: (d: Draft) => T, collects: boolean): T {
    let tx = transactions.get(s);
    if (!tx) transactions.set(s, (tx = { log: [], made: new WeakSet(), drafts: [] }));
    const d = new Draft(s, tx, tx.drafts.at(-1), collects);
    tx.drafts.push(d);
    let threw = true;
    try {
      const out = fn(d);
      threw = false;
      return out;
    } finally {
      tx.drafts.pop();
      if (!d.parent) {
        transactions.delete(s);
        rollback(s, tx.log, 0);
      } else if (threw || !d.finished) {
        // Its operations undone, the actions finished inside it no longer stand for applied operations.
        rollback(s, tx.log, d.mark);
        for (const a of d.kept) tx.made.delete(a);
      } else d.parent.kept.push(...d.kept);
    }
  }

  /** An operation made elsewhere (an action computed beforehand, a dry run): its "before" is checked. */
  push(op: Op): void {
    applyOp(this.s, op);
    this.tx.log.push(op);
  }
  /** An operation of this draft, its "before" read from the state just now: nothing to check. */
  private write(op: Op): void {
    applyKnown(this.s, op);
    this.tx.log.push(op);
  }
  node(id: Id, after: NodeRec | null): void {
    this.write({ t: 'node', before: this.s.nodes.get(id) ?? null, after });
  }
  connection(id: Id, after: ConnectionRec | null): void {
    this.write({ t: 'connection', before: this.s.connections.get(id) ?? null, after });
  }
  placement(plan: Id, node: Id, after: Placement | null): void {
    this.write({ t: 'placement', before: placementOf(this.s, plan, node) ?? null, after });
  }
  branch(plan: Id, connection: Id, node: Id, present: boolean): void {
    const key = { plan, connection, node };
    const before = this.s.branches.has(key);
    if (before !== present) this.write({ t: 'branch', key, before, after: present });
  }
  phantom(id: Id, after: PhantomRec | null): void {
    this.write({ t: 'phantom', before: this.s.phantoms.get(id) ?? null, after });
  }
  /** Removes phantom `ph`, which must be its current record (OpConflictError otherwise). */
  dropPhantom(ph: PhantomRec): void {
    if (this.s.phantoms.get(ph.id) !== ph) throw stale('Le fantôme');
    this.write({ t: 'phantom', before: ph, after: null });
  }
  /** Removes the phantoms of a connection, all of them or those of one member's split arm. */
  dropPhantoms(connection: Id, node?: Id): void {
    for (const ph of phantomRecs(this.s, connection)) if (node === undefined || ph.of.node === node) this.write({ t: 'phantom', before: ph, after: null });
  }
  /**
   * A connection goes to the trash with what only shows it: its branches and phantoms in every plan. `c` must be its
   * current record (OpConflictError otherwise); `members`: those it keeps there.
   */
  trashConnection(c: ConnectionRec, members: Member[]): void {
    if (!isCurrentConnection(this.s, c)) throw stale('La connexion');
    for (const b of branchesOf(this.s, c.id)) this.write({ t: 'branch', key: b, before: true, after: false });
    this.dropPhantoms(c.id);
    this.write({ t: 'connection', before: c, after: { ...c, members, trashedAt: Date.now() } });
  }
  /** Whether `a` was finished inside this transaction and its operations are still applied. */
  private made(a: Action): boolean {
    return this.tx.made.has(a);
  }
  /**
   * The action of this draft's operations, its rules checked on what they touch: on the state with the operations
   * applied, then, if that finds violations, on the state as it was once they are undone; an action may not add a
   * violation (one already there is not its doing). Outermost, the state is left as it was received; nested, the
   * operations stay applied for the enclosing draft, and directly inside a combine the check is the combine's.
   */
  finish(label: string): Action {
    const tx = this.tx, ops = tx.log.slice(this.mark), a: Action = { id: uuidv7(), label, ops };
    this.finished = true;
    if (this.parent) {
      tx.made.add(a);
      this.kept.push(a);
      if (this.parent.collects) return a;
    }
    const touched = touchedBy(this.s, ops);
    const after = checkState(this.s, touched);
    if (after.length === 0) {
      if (!this.parent) rollback(this.s, tx.log, 0);
      return a;
    }
    rollback(this.s, tx.log, this.mark);
    const known = new Set(checkState(this.s, touched).map(violationKey));
    const added = after.find((v) => !known.has(violationKey(v)));
    if (added) throw new CommandError(added.message);
    // Nested (a preview, a dry run): applied again, for the enclosing draft.
    if (this.parent) for (const op of ops) this.write(op);
    return a;
  }
}

/**
 * Runs `fn` with a draft writing into `s` itself and returns what it returns; when it ends, normally or by an
 * exception, every operation the draft applied is undone by its inverse, the last first: `s` comes back as it was. Every
 * command goes through it and returns its action from `finish`, checked; a dry run applies, then lets the end undo.
 * Opened inside a transaction on the same state, it joins that one (see Draft); on an exception, or without `finish`,
 * only its own operations are undone.
 */
export function transact<T>(s: State, fn: (d: Draft) => T): T {
  return Draft.run(s, fn);
}

const need = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new CommandError(message);
  return value;
};
const nodeOf = (s: State, id: Id) => need(s.nodes.get(id), 'Nœud introuvable.');
const planOf = (s: State, id: Id) => need(s.plans.get(id), 'Plan introuvable.');
/** A node that can be linked or placed: not in the trash. */
const liveNodeOf = (s: State, id: Id) => {
  const n = nodeOf(s, id);
  if (n.trashedAt !== undefined) throw new CommandError('Ce nœud est à la corbeille.');
  return n;
};
const placementIn = (s: State, plan: Id, node: Id, message: string) => need(placementOf(s, plan, node), message);
const connectionOf = (s: State, id: Id) => need(s.connections.get(id), 'Connexion introuvable.');
/** Every branch of a connection, in every plan, from its row. */
const branchesOf = (s: State, connection: Id): BranchRec[] => {
  const T = dataOf(s).tables, c = T.conns.rows.get(connection), out: BranchRec[] = [];
  if (c < 0) return out;
  const v = T.conns.branches.view(c), plans = T.plans.rows.ids, nodes = T.nodes.rows.ids;
  for (let i = 0; i < v.length; i += 2) out.push({ plan: plans[v[i]], connection, node: nodes[v[i + 1]] });
  return out;
};
/** The connections a node is a member of (trash included), of one kind (INCLUSION…) or all, from the index. */
const connectionsOf = (s: State, node: Id, kind?: number): ConnectionRec[] => {
  const n = nodeRow(s, node), out: ConnectionRec[] = [];
  if (n >= 0) for (const c of memberOf(s, n)) if (kind === undefined || connKind(s, c) === kind) out.push(connectionOfRow(s, c));
  return out;
};
const placementsOf = (s: State, node: Id): Placement[] => {
  const n = nodeRow(s, node);
  return n < 0 ? [] : Array.from(placedIn(s, n), (p) => dataOf(s).tables.plans.placements[p]!.get(n)!);
};
/** The phantoms standing for `node` (its split arms, their centres, its absences), through its connections: a copy. */
const phantomsFor = (s: State, node: Id): PhantomRec[] => {
  const n = nodeRow(s, node), out: PhantomRec[] = [];
  if (n >= 0) for (const c of memberOf(s, n)) for (const id of phantomsOf(s, connId(s, c))) { const ph = s.phantoms.get(id)!; if (ph.of.node === node) out.push(ph); }
  return out;
};
/** The phantoms of a connection, as records: a copy. */
const phantomRecs = (s: State, connection: Id): PhantomRec[] => phantomsOf(s, connection).map((id) => s.phantoms.get(id)!);
/** Enumeration values stored by name; an unknown value is a user error like any other refused command. */
const normalizeTags = (s: State, tags: TagValue[]): TagValue[] => {
  try {
    return tags.map((t) => normalizeTag(t, s.tagKeys));
  } catch (e) {
    if (e instanceof TagError) throw new CommandError(e.message);
    throw e;
  }
};

export function createPlan(s: State, name: string, type: PlanType): Action {
  return transact(s, (d) => {
    d.push({ t: 'plan', before: null, after: { id: uuidv7(), name, type } });
    return d.finish(`Créer le plan « ${name} »`);
  });
}

export function createNode(s: State, a: { plan: Id; title: string; x: number; y: number; k: number; summary?: string; tags?: TagValue[] }): Action {
  planOf(s, a.plan);
  const tags = normalizeTags(s, a.tags ?? []);
  return transact(s, (d) => {
    const id = uuidv7();
    d.node(id, { id, title: a.title, summary: a.summary ?? '', tags, files: [] });
    d.placement(a.plan, id, { plan: a.plan, node: id, x: a.x, y: a.y, k: a.k });
    return d.finish(`Créer « ${a.title} »`);
  });
}

export function editNode(s: State, id: Id, patch: Partial<Pick<NodeRec, 'title' | 'summary' | 'tags' | 'files'>>): Action {
  const n = nodeOf(s, id);
  const tags = patch.tags ? normalizeTags(s, patch.tags) : n.tags;
  return transact(s, (d) => {
    d.node(id, { ...n, ...patch, tags });
    return d.finish(`Modifier « ${patch.title ?? n.title} »`);
  });
}

/** Moves and/or rescales placed nodes; an omitted field keeps its value (a group's position is derived from its members). */
export function moveNodes(s: State, plan: Id, moves: { node: Id; x?: number; y?: number; k?: number }[]): Action {
  return transact(s, (d) => {
    for (const m of moves) {
      const p = placementIn(s, plan, m.node, 'Ce nœud n’est pas dans ce plan.');
      d.placement(plan, m.node, { ...p, x: m.x ?? p.x, y: m.y ?? p.y, k: m.k ?? p.k });
    }
    return d.finish(moves.length === 1 ? 'Déplacer un nœud' : `Déplacer ${moves.length} nœuds`);
  });
}

/** Adds an existing node to a plan (paste, add to the lobby, import from a stub); it replaces its absent phantoms there. */
export function placeNode(s: State, plan: Id, node: Id, x: number, y: number, k: number): Action {
  planOf(s, plan);
  const n = liveNodeOf(s, node);
  if (placementOf(s, plan, node)) throw new CommandError('Ce nœud est déjà dans ce plan.');
  return transact(s, (d) => {
    d.placement(plan, node, { plan, node, x, y, k });
    for (const ph of phantomsFor(s, node)) if (ph.plan === plan && ph.of.kind === 'absent') d.dropPhantom(ph);
    return d.finish(`Placer « ${n.title} »`);
  });
}

/** Nodes or phantoms placed in this group, in this plan. */
const hasMembers = (s: State, plan: Id, group: Id): boolean =>
  connectionsOf(s, group, INCLUSION).some((c) => c.members.some((m) => m.role === 'target' && m.node === group)
    && c.members.every((m) => s.branches.has({ plan, connection: c.id, node: m.node })))
  || phantomsIn(s, group).some((id) => s.phantoms.get(id)!.plan === plan);

/**
 * "Here only" removal (spec 7): the node leaves this plan; its knowledge branches stay and are drawn as stubs. A group
 * keeps its links, hidden, so that its members show in their nearest ancestor present in the plan; a node with no
 * members leaves its group, and so do the hidden groups this leaves empty. Leaving its last plan sends it to the trash.
 */
export function removeFromPlan(s: State, plan: Id, node: Id): Action {
  const n = nodeOf(s, node);
  placementIn(s, plan, node, 'Ce nœud n’est pas dans ce plan.');
  return transact(s, (d) => {
    d.placement(plan, node, null);
    for (let x: Id | undefined = node; x !== undefined && !placementOf(s, plan, x) && !hasMembers(s, plan, x);) {
      const parent = groupOf(s, plan, x);
      leaveGroup(d, plan, x);
      x = parent;
    }
    if (placementsOf(s, node).length === 0) d.node(node, { ...n, trashedAt: Date.now() });
    return d.finish(`Retirer « ${n.title} » de ce plan`);
  });
}

/** "Everywhere" deletion: out of every plan and every connection; connections left with fewer than two members go to the trash. */
export function deleteEverywhere(s: State, node: Id): Action {
  const n = nodeOf(s, node);
  return transact(s, (d) => {
    // Found while the node is still a member of its connections (memberOf).
    const phantoms = phantomsFor(s, node);
    for (const p of placementsOf(s, node)) d.placement(p.plan, node, null);
    for (const c of connectionsOf(s, node)) {
      if (c.trashedAt !== undefined) continue;
      const members = c.members.filter((m) => m.node !== node);
      if (c.kind !== 'knowledge' || members.length < 2) d.trashConnection(c, members);
      else {
        for (const b of branchesOf(s, c.id)) if (b.node === node) d.branch(b.plan, c.id, node, false);
        d.connection(c.id, { ...c, members });
      }
    }
    // Those of the connections it stays in (the others went with their connection to the trash).
    for (const ph of phantoms) if (s.phantoms.get(ph.id) === ph) d.dropPhantom(ph);
    d.node(node, { ...n, trashedAt: Date.now() });
    return d.finish(`Supprimer « ${n.title} » partout`);
  });
}

export function restoreNode(s: State, node: Id, plan: Id, x: number, y: number, k: number): Action {
  const n = nodeOf(s, node);
  if (n.trashedAt === undefined) throw new CommandError('Ce nœud n’est pas à la corbeille.');
  planOf(s, plan);
  return transact(s, (d) => {
    const { trashedAt: _trashed, ...rest } = n;
    d.node(node, rest);
    d.placement(plan, node, { plan, node, x, y, k });
    return d.finish(`Restaurer « ${n.title} »`);
  });
}

/** A new connection, shown in this plan only ("here only", spec 11.1). */
export function connect(s: State, a: { plan: Id; members: Member[]; title?: string; relation?: string; kind?: ConnectionKind; tags?: TagValue[] }): Action {
  planOf(s, a.plan);
  for (const m of a.members) liveNodeOf(s, m.node);
  const tags = normalizeTags(s, a.tags ?? []);
  return transact(s, (d) => {
    const id = uuidv7();
    d.connection(id, { id, kind: a.kind ?? 'knowledge', title: a.title ?? '', relation: a.relation ?? '', tags, members: a.members });
    for (const m of a.members) d.branch(a.plan, id, m.node, true);
    return d.finish('Créer une connexion');
  });
}

export function addMember(s: State, plan: Id, connection: Id, member: Member): Action {
  const c = connectionOf(s, connection);
  planOf(s, plan);
  liveNodeOf(s, member.node);
  if (c.members.some((m) => m.node === member.node)) throw new CommandError('Ce nœud fait déjà partie de la connexion.');
  return transact(s, (d) => {
    d.connection(connection, { ...c, members: [...c.members, member] });
    d.branch(plan, connection, member.node, true);
    return d.finish('Ajouter un nœud à la connexion');
  });
}

/** Removes a member everywhere; a connection left with fewer than two members goes to the trash. */
export function removeMember(s: State, connection: Id, node: Id): Action {
  const c = connectionOf(s, connection);
  return transact(s, (d) => {
    const members = c.members.filter((m) => m.node !== node);
    for (const b of branchesOf(s, connection)) if (b.node === node) d.branch(b.plan, connection, node, false);
    d.dropPhantoms(connection, node);
    if (members.length < 2) d.trashConnection(c, members);
    else d.connection(connection, { ...c, members });
    return d.finish('Retirer un nœud de la connexion');
  });
}

export function editConnection(s: State, id: Id, patch: Partial<Pick<ConnectionRec, 'title' | 'relation' | 'tags'>>): Action {
  const c = connectionOf(s, id);
  const tags = patch.tags ? normalizeTags(s, patch.tags) : c.tags;
  return transact(s, (d) => {
    d.connection(id, { ...c, ...patch, tags });
    return d.finish('Modifier une connexion');
  });
}

/**
 * Shows or hides members of a connection in given plans (spec 11.1, 11.2: « partout » or « ici seulement »); the
 * membership itself does not change. Hiding a branch takes the phantoms of that member's arm in that plan with it.
 */
export function setBranches(s: State, connection: Id, branches: { plan: Id; node: Id }[], present: boolean): Action {
  const c = connectionOf(s, connection);
  return transact(s, (d) => {
    for (const b of branches) {
      planOf(s, b.plan);
      if (!c.members.some((m) => m.node === b.node)) throw new CommandError('Ce nœud n’est pas membre de la connexion.');
      d.branch(b.plan, connection, b.node, present);
      if (!present) for (const ph of phantomRecs(s, connection)) if (ph.plan === b.plan && ph.of.node === b.node) d.dropPhantom(ph);
    }
    return d.finish(present ? 'Montrer la connexion' : 'Ôter de ce plan');
  });
}

/** A stub moved by hand (spec 8.5, 11.3): the absent member gets a phantom where it was put down. */
export function placeAbsent(s: State, plan: Id, connection: Id, node: Id, x: number, y: number, k: number): Action {
  connectionOf(s, connection);
  if (!s.branches.has({ plan, connection, node })) throw new CommandError('Cette branche n’est pas affichée dans ce plan.');
  if (placementOf(s, plan, node)) throw new CommandError('Ce nœud est déjà dans ce plan.');
  if (phantomRecs(s, connection).some((p) => p.plan === plan && p.of.kind === 'absent' && p.of.node === node)) {
    throw new CommandError('Cette amorce a déjà sa place.');
  }
  return transact(s, (d) => {
    const id = uuidv7();
    d.phantom(id, { id, plan, connection, of: { kind: 'absent', node }, x, y, k });
    return d.finish('Déplacer une amorce');
  });
}

/** « Partout » for a connection (spec 7): to the trash, with its branches and phantoms in every plan. */
export function deleteConnection(s: State, id: Id): Action {
  const c = connectionOf(s, id);
  if (c.trashedAt !== undefined) throw new CommandError('Cette connexion est déjà à la corbeille.');
  return transact(s, (d) => {
    d.trashConnection(c, c.members);
    return d.finish('Supprimer la connexion');
  });
}

export function setRole(s: State, connection: Id, node: Id, role: Role): Action {
  const c = connectionOf(s, connection);
  if (!c.members.some((m) => m.node === node)) throw new CommandError('Ce nœud ne fait pas partie de la connexion.');
  return transact(s, (d) => {
    d.connection(connection, { ...c, members: c.members.map((m) => (m.node === node ? { ...m, role } : m)) });
    return d.finish('Changer le rôle d’un nœud');
  });
}

/** Removes the node's own group links in this plan. */
function leaveGroup(d: Draft, plan: Id, node: Id): void {
  for (const c of connectionsOf(d.s, node, INCLUSION)) {
    if (c.members.find((m) => m.role === 'source')?.node !== node) continue;
    for (const m of c.members) d.branch(plan, c.id, m.node, false);
  }
}

/**
 * Puts a node in a group, in this plan only; it replaces the node's current group there (spec 10). An inclusion of
 * the node in that group that exists already (in another plan, or in the trash) is shown here again: the one of
 * smallest identifier when there are several, as for the groups of the index.
 */
export function include(s: State, plan: Id, node: Id, group: Id): Action {
  const n = nodeOf(s, node);
  const g = nodeOf(s, group);
  if (node === group) throw new CommandError('Un groupe ne peut pas être inclus dans lui-même ni dans un de ses descendants.');
  // Placed implies not in the trash (rule trashedPlaced).
  placementIn(s, plan, node, 'Ce nœud n’est pas dans ce plan.');
  placementIn(s, plan, group, 'Ce groupe n’est pas dans ce plan.');
  return transact(s, (d) => {
    leaveGroup(d, plan, node);
    let link: ConnectionRec | undefined;
    for (const c of connectionsOf(s, node, INCLUSION)) {
      if ((!link || c.id < link.id) && c.members.some((m) => m.role === 'source' && m.node === node) && c.members.some((m) => m.role === 'target' && m.node === group)) link = c;
    }
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
  });
}

export function exclude(s: State, plan: Id, node: Id): Action {
  const n = nodeOf(s, node);
  return transact(s, (d) => {
    leaveGroup(d, plan, node);
    return d.finish(`Sortir « ${n.title} » de son groupe`);
  });
}

/** Split arm (spec 8.5): the branch leaves the plan, replaced by a phantom of the far node near the bundle and a phantom of the centre near that node. */
export function splitArm(s: State, plan: Id, connection: Id, node: Id, near: { x: number; y: number; k: number }, far: { x: number; y: number; k: number }): Action {
  connectionOf(s, connection);
  if (!s.branches.has({ plan, connection, node })) throw new CommandError('Cette branche n’est pas affichée dans ce plan.');
  return transact(s, (d) => {
    d.branch(plan, connection, node, false);
    const a = uuidv7(), b = uuidv7();
    d.phantom(a, { id: a, plan, connection, of: { kind: 'node', node }, ...near });
    d.phantom(b, { id: b, plan, connection, of: { kind: 'center', node }, ...far });
    return d.finish('Scinder ce bras');
  });
}

export function joinArm(s: State, plan: Id, connection: Id, node: Id): Action {
  const phantoms = phantomRecs(s, connection).filter((p) => p.plan === plan && p.of.kind !== 'absent' && p.of.node === node);
  if (phantoms.length === 0) throw new CommandError('Ce bras n’est pas scindé.');
  return transact(s, (d) => {
    for (const p of phantoms) d.dropPhantom(p);
    d.branch(plan, connection, node, true);
    return d.finish('Réunir ce bras');
  });
}

/** A phantom moves like a node, changes its step like one, and may sit in a group (spec 8.5). */
export function movePhantom(s: State, phantom: Id, x: number, y: number, group?: Id | null, k?: number): Action {
  const p = need(s.phantoms.get(phantom), 'Fantôme introuvable.');
  if (group) placementIn(s, p.plan, group, 'Ce groupe n’est pas dans ce plan.');
  return transact(s, (d) => {
    const next: PhantomRec = { ...p, x, y, k: k ?? p.k };
    if (group === null) delete next.group;
    else if (group !== undefined) next.group = group;
    d.phantom(phantom, next);
    return d.finish('Déplacer un fantôme');
  });
}

/**
 * Several commands as one action (spec 6.4: a complete gesture is one undo step), in one transaction: each step sees
 * the state left by the previous ones, and the rules are checked once, on the whole. A step may also return an action
 * computed beforehand, or one whose operations were undone since (made in a preview): its operations are applied here.
 * A refused step refuses the whole action, and the state comes back as it was received. Nested directly in a combine,
 * it leaves the check to that one.
 */
export function combine(s: State, label: string, steps: ((s: State) => Action)[]): Action {
  return Draft.combine(s, label, steps);
}

/** The layout of a connection in one plan (spec 5.5, 8.5): marker, trunk angle, Bézier handles; null restores the automatic one. */
export function setLayout(s: State, plan: Id, connection: Id, layout: Omit<ConnectionLayout, 'plan' | 'connection'> | null): Action {
  planOf(s, plan);
  connectionOf(s, connection);
  return transact(s, (d) => {
    d.push({ t: 'connLayout', before: s.connLayouts.get(layoutKey(plan, connection)) ?? null, after: layout && { plan, connection, ...layout } });
    return d.finish(layout ? 'Disposer une connexion' : 'Rétablir la disposition automatique');
  });
}
