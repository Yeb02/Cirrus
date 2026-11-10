import { validAnchor } from './annotation.ts';
import { uuidv7 } from './ids.ts';
import { checkState, groupOf, touchedBy, type Violation } from './invariants.ts';
import type {
  Anchor, BranchRec, ConnectionKind, ConnectionLayout, ConnectionRec, FileRef, Id, Member, NodeRec, PhantomRec, Placement, PlanType, Role, TagKeyDef, TagValue,
} from './model.ts';
import { MAX_ID_CHARS, type Op, truncateLabel } from './ops.ts';
import { normalizeTag, PROTECTED_TAG_KEYS, TagError, type TagKeyShape, tagValueFits, tagValuesFit } from './registry.ts';
import {
  applyKnown, applyOp, canonical, connectionOfRow, connId, connKind, dataOf, isCurrentConnection, layoutKey, memberOf, nodeRow, OpConflictError, phantomsIn,
  phantomsOf, placedIn, placementOf, preambleText, rollback, type State, taggedWith,
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
class Draft {
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
  tagKey(key: string, after: TagKeyDef | null): void {
    this.write({ t: 'tagKey', before: this.s.tagKeys.get(key) ?? null, after });
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
   * The action of this draft's operations, its rules checked on what they touch (addedViolation): an action may not
   * add a violation. Outermost, the state is left as it was received; nested, the operations stay applied for the
   * enclosing draft, and directly inside a combine the check is the combine's. Its label within MAX_LABEL_CHARS (R20).
   */
  finish(label: string): Action {
    const tx = this.tx, ops = tx.log.slice(this.mark), a: Action = { id: uuidv7(), label: truncateLabel(label), ops };
    this.finished = true;
    if (this.parent) {
      tx.made.add(a);
      this.kept.push(a);
      if (this.parent.collects) return a;
    }
    const added = addedViolation(this.s, ops);
    if (added) throw new CommandError(added.message);
    if (!this.parent) rollback(this.s, tx.log, 0);
    return a;
  }
}

/**
 * The rule every action is checked by: the violation that `ops`, just applied to `s` (the last operations written,
 * nothing after them), add; null when they add none. Checked on what they touch: on the state with them, then, if that
 * finds violations, on the state without them, undone and applied again — one already there is not their doing. `s` is
 * left with the operations applied. A command's (Draft.finish), a write replayed by a reconciliation's and a write the
 * server accepts' (plan 5a, D1 and D4).
 */
export function addedViolation(s: State, ops: readonly Op[]): Violation | null {
  const touched = touchedBy(s, ops);
  const after = checkState(s, touched);
  if (after.length === 0) return null;
  rollback(s, [...ops], 0);
  let known: Set<string>;
  try {
    known = new Set(checkState(s, touched).map(violationKey));
  } finally {
    for (const op of ops) applyKnown(s, op);
  }
  return after.find((v) => !known.has(violationKey(v))) ?? null;
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

/** A node placed in `plan`; `files`: already in the store (an imported publication's, plan 4c). */
export function createNode(
  s: State, a: { plan: Id; title: string; x: number; y: number; k: number; summary?: string; tags?: TagValue[]; files?: FileRef[] },
): Action {
  planOf(s, a.plan);
  const tags = normalizeTags(s, a.tags ?? []);
  return transact(s, (d) => {
    const id = uuidv7();
    d.node(id, { id, title: a.title, summary: a.summary ?? '', tags, files: a.files ? [...a.files] : [] });
    d.placement(a.plan, id, { plan: a.plan, node: id, x: a.x, y: a.y, k: a.k });
    return d.finish(`Créer « ${a.title} »`);
  });
}

/**
 * A PDF annotation (plan 4c, D1): a node that keeps its own copy of `a`, placed in no plan — nothing is placed for the
 * user (spec 12 [C]): it is listed in the PDF's reader and pop-up, and dropped into a plan from there. `title`: the
 * start of the passage (annotationTitle). Refused when the anchor is out of its bounds, or the PDF's node is gone or in
 * the trash. Once made, it is a node like any other: renamed, summarised, placed, grouped.
 */
export function createAnnotation(s: State, a: Anchor, title: string): Action {
  if (!validAnchor(a)) throw new CommandError('Ce passage ne peut pas être annoté.');
  const pdf = need(s.nodes.get(a.pdf), 'Le PDF à annoter n’existe pas.');
  if (pdf.trashedAt !== undefined) throw new CommandError('Le PDF à annoter est à la corbeille.');
  const anchor: Anchor = { pdf: a.pdf, file: a.file, hash: a.hash, page: a.page, rects: a.rects.map(([x0, y0, x1, y1]): Anchor['rects'][number] => [x0, y0, x1, y1]), text: a.text };
  return transact(s, (d) => {
    const id = uuidv7();
    d.node(id, { id, title, summary: '', tags: [], files: [], anchor });
    return d.finish(`Annoter « ${title} », p. ${a.page}`);
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
 * members leaves its group, and so do the hidden groups this leaves empty. Leaving its last plan sends it to the trash,
 * except a PDF annotation (plan 4c, D1: born in no plan, kept under its PDF; controller's ruling, task 3): it stays,
 * in no plan, listed under its PDF; « Supprimer partout » (deleteEverywhere) trashes it.
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
    if (placementsOf(s, node).length === 0 && n.anchor === undefined) d.node(node, { ...n, trashedAt: Date.now() });
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

/**
 * The global LaTeX preamble (spec 5.6, D5), refused when it is the one in effect. DEFAULT_PREAMBLE set again is written
 * as such, not as null: the history keeps what was chosen.
 */
export function setPreamble(s: State, text: string): Action {
  if (text === preambleText(s)) throw new CommandError('Le préambule est déjà celui-ci.');
  return transact(s, (d) => {
    d.push({ t: 'preamble', before: s.preamble, after: { text } });
    return d.finish('Modifier le préambule LaTeX');
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The tag registry (plan 6a, D4): a key created or changed, renamed everywhere, taken out of the registry, an
// enumeration's value renamed. Each is one action, checked as any other (Draft.finish, then the server's parseUnit and
// rules); the carriers of a key are read from the index (taggedWith), trash included, never by a scan of the base.

/**
 * A tag key's name (D4): 1 to MAX_ID_CHARS characters, as the server bounds a key a write adds (R32); no « : » and no
 * space around it, since parseTag, which splits at the first colon and trims, could never give one.
 */
function checkKeyName(key: string): void {
  if (key.trim() === '') throw new CommandError('Le nom du tag est vide.');
  if (key.length > MAX_ID_CHARS) throw new CommandError(`Le nom d’un tag compte ${MAX_ID_CHARS} caractères au plus (ici ${key.length}).`);
  if (key.includes(':') || key.trim() !== key) throw new CommandError('Un nom de tag ne contient pas « : », et ne commence ni ne finit par une espace.');
}

const sameShape = (a: TagKeyShape, b: TagKeyShape): boolean => a.type === b.type && a.scope === b.scope && a.multi === b.multi;

/** A node or a connection that carries a key, with its kind (the index lists both, identifiers being unique across kinds). */
type Carrier = { rec: NodeRec; kind: 'node' } | { rec: ConnectionRec; kind: 'connection' };
const carrierOf = (s: State, id: Id): Carrier => {
  const n = s.nodes.get(id);
  return n ? { rec: n, kind: 'node' } : { rec: s.connections.get(id)!, kind: 'connection' };
};
const valuesOf = (tags: readonly TagValue[], key: string) => tags.filter((t) => t.key === key).map((t) => t.value);
/** Its record with these tags, written by the draft. */
function retag(d: Draft, c: Carrier, tags: TagValue[]): void {
  if (c.kind === 'node') d.node(c.rec.id, { ...c.rec, tags });
  else d.connection(c.rec.id, { ...c.rec, tags });
}

/** The carriers among `ids` whose values of `def`'s key it does not accept (tagValuesFit). */
function misfits(s: State, def: TagKeyDef, ids: Iterable<Id>): Carrier[] {
  const out: Carrier[] = [];
  for (const id of ids) {
    const c = carrierOf(s, id);
    if (!tagValuesFit(def, c.kind, valuesOf(c.rec.tags, def.key))) out.push(c);
  }
  return out;
}

const french = new Intl.Collator('fr');

/**
 * Refuses a change of the registry that the values of `bad` would no longer respect (D4): how many objects, and the
 * first — one alive before one in the trash, one with a title before one without, then in French order.
 */
function refuseMisfits(bad: Carrier[]): void {
  if (bad.length === 0) return;
  const rank = (c: Carrier) => (c.rec.trashedAt !== undefined ? 2 : 0) + (c.rec.title === '' ? 1 : 0);
  let first = bad[0];
  for (const c of bad) {
    const d = rank(c) - rank(first) || french.compare(c.rec.title, first.rec.title) || (c.rec.id < first.rec.id ? -1 : 0);
    if (d < 0) first = c;
  }
  const nodes = bad.filter((c) => c.kind === 'node').length;
  const [one, many] = nodes === bad.length ? ['nœud', 'nœuds'] : nodes === 0 ? ['connexion', 'connexions'] : ['objet', 'objets'];
  const name = `« ${first.rec.title || 'Sans titre'} »${first.rec.trashedAt !== undefined ? ' (à la corbeille)' : ''}`;
  throw new CommandError(bad.length === 1
    ? `1 ${one} porte une valeur que ce changement rendrait invalide : ${name}.`
    : `${bad.length} ${many} portent une valeur que ce changement rendrait invalide, dont ${name}.`);
}

/** A definition as the registry keeps it: its own fields only, the values of an enumeration for an enumeration only, copied. */
function definition(def: TagKeyDef): TagKeyDef {
  const out: TagKeyDef = { key: def.key, type: def.type, scope: def.scope, multi: def.multi, required: def.required };
  if (def.defaultValue !== undefined) out.defaultValue = def.defaultValue;
  if (def.type === 'enum') out.enumValues = (def.enumValues ?? []).map((e) => ({ name: e.name, rank: e.rank }));
  return out;
}

/** An enumeration's values each named, with a finite rank, no name nor rank twice (normalizeTag reads either); a default the definition accepts. */
function checkDefinition(def: TagKeyDef): void {
  const names = new Set<string>(), ranks = new Set<number>();
  for (const e of def.enumValues ?? []) {
    if (e.name.trim() === '') throw new CommandError('Une valeur de l’énumération n’a pas de nom.');
    if (!Number.isFinite(e.rank)) throw new CommandError(`Le rang de la valeur « ${e.name} » n’est pas un nombre.`);
    if (names.has(e.name)) throw new CommandError(`Deux valeurs de l’énumération s’appellent « ${e.name} ».`);
    if (ranks.has(e.rank)) throw new CommandError(`Deux valeurs de l’énumération ont le rang ${e.rank}.`);
    names.add(e.name);
    ranks.add(e.rank);
  }
  if (def.defaultValue !== undefined && !tagValueFits(def, def.defaultValue)) {
    throw new CommandError(`La valeur par défaut « ${def.defaultValue} » ne convient pas au tag « ${def.key} ».`);
  }
}

/**
 * Creates a key of the registry, or changes its definition (D4). Refused when a value already carried (trash included)
 * would no longer fit: its type, its scope (node, connection), one value or several, an enumeration's values. A key
 * Cirrus reads (PROTECTED_TAG_KEYS) keeps the shape Cirrus gives it, or the one it has: only whether it is required and
 * its default change.
 */
export function defineTagKey(s: State, def: TagKeyDef): Action {
  checkKeyName(def.key);
  const next = definition(def), key = next.key, old = s.tagKeys.get(key), shape = PROTECTED_TAG_KEYS.get(key);
  if (shape && !sameShape(next, shape) && !(old && sameShape(next, old))) {
    throw new CommandError(`Cirrus se sert du tag « ${key} » : seuls son caractère obligatoire et sa valeur par défaut se changent.`);
  }
  checkDefinition(next);
  if (old && canonical(old) === canonical(next)) throw new CommandError(`La définition du tag « ${key} » est déjà celle-ci.`);
  // Whether it is required and its default never make a carried value wrong.
  if (!old || !sameShape(old, next) || canonical(old.enumValues ?? null) !== canonical(next.enumValues ?? null)) refuseMisfits(misfits(s, next, taggedWith(s, key)));
  return transact(s, (d) => {
    d.tagKey(key, next);
    return d.finish(old ? `Modifier le tag « ${key} »` : `Créer le tag « ${key} »`);
  });
}

/**
 * A record's tags with key `from` renamed `to`, each in its place (D4). When the record carries `to` already, a key of
 * one value (`single`) keeps the old key's value — it is the one renamed into place —, and any other unites the values
 * of both keys, without duplicates (the number 3 and the text « 3 » are two values).
 */
function renamedTags(tags: readonly TagValue[], from: string, to: string, single: boolean): TagValue[] {
  const renamed = (t: TagValue): TagValue => (t.value === undefined ? { key: to } : { key: to, value: t.value });
  if (!tags.some((t) => t.key === to)) return tags.map((t) => (t.key === from ? renamed(t) : t));
  const out: TagValue[] = [], seen = new Set<string>();
  for (const t of tags) {
    if (t.key !== from && t.key !== to) out.push(t);
    else if (single) {
      if (t.key === from) out.push(renamed(t));
    } else {
      const v = JSON.stringify(t.value ?? null);
      if (!seen.has(v)) {
        seen.add(v);
        out.push(renamed(t));
      }
    }
  }
  return out;
}

/**
 * Renames a key everywhere (D4), in one action: its definition, moved to the new name, and every node and connection
 * that carries it, trash included. A key with no definition (only carried) is renamed too, and the action writes none;
 * renamed into a key the registry declares, it comes under that definition — how a key a sync brought back undeclared
 * is put away. Refused: a key Cirrus reads; a bad name; a new name another definition holds; a value the definition
 * would newly judge and not accept (one already carried under the new name, or one coming under its definition).
 */
export function renameTagKey(s: State, from: string, to: string): Action {
  if (PROTECTED_TAG_KEYS.has(from)) throw new CommandError(`Cirrus se sert du tag « ${from} » : il ne se renomme pas.`);
  checkKeyName(to);
  if (to === from) throw new CommandError(`Le tag s’appelle déjà « ${to} ».`);
  const def = s.tagKeys.get(from), target = s.tagKeys.get(to);
  const carriers = Array.from(taggedWith(s, from), (id) => carrierOf(s, id));
  if (!def && carriers.length === 0) throw new CommandError(`Aucun tag ne s’appelle « ${from} ».`);
  if (def && target) throw new CommandError(`Le tag « ${to} » existe déjà dans le registre.`);
  const moved: TagKeyDef | undefined = def && { ...def, key: to }, shape = PROTECTED_TAG_KEYS.get(to);
  if (moved && shape && !sameShape(moved, shape)) {
    throw new CommandError(`Cirrus se sert du tag « ${to} » : « ${from} » n’a pas le type, la portée ou la multiplicité qu’il lui donne.`);
  }
  // The definition the values come under: the key's own, moved; or the one the new name has.
  const rule = moved ?? target, single = rule !== undefined && !rule.multi;
  const tags = carriers.map((c) => renamedTags(c.rec.tags, from, to, single));
  if (moved) {
    // What the definition newly judges: the values already carried under `to` — all of a record's that did not carry
    // `from`; with several values, those united with the renamed ones (one value: the old key's is kept).
    const bad: Carrier[] = [];
    for (const id of taggedWith(s, to)) {
      const c = carrierOf(s, id), olds = valuesOf(c.rec.tags, to), renamedHere = c.rec.tags.some((t) => t.key === from);
      const fits = renamedHere ? single || olds.every((v) => tagValueFits(moved, v)) : tagValuesFit(moved, c.kind, olds);
      if (!fits) bad.push(c);
    }
    refuseMisfits(bad);
  } else if (target) refuseMisfits(carriers.filter((c, i) => !tagValuesFit(target, c.kind, valuesOf(tags[i], to))));
  return transact(s, (d) => {
    if (moved) {
      d.tagKey(from, null);
      d.tagKey(to, moved);
    }
    carriers.forEach((c, i) => retag(d, c, tags[i]));
    return d.finish(`Renommer le tag « ${from} » en « ${to} »`);
  });
}

/** Takes a key out of the registry (D4): its tags stay on the objects, as a key the registry does not declare (spec 5.4). */
export function deleteTagKey(s: State, key: string): Action {
  if (!s.tagKeys.has(key)) throw new CommandError(`Le tag « ${key} » n’est pas dans le registre.`);
  if (PROTECTED_TAG_KEYS.has(key)) throw new CommandError(`Cirrus se sert du tag « ${key} » : il ne se supprime pas.`);
  return transact(s, (d) => {
    d.tagKey(key, null);
    return d.finish(`Retirer le tag « ${key} » du registre`);
  });
}

/**
 * Renames a value of an enumeration (D4), in one action: in its definition (its rank kept, the default following it),
 * and on every node and connection that carries it by its name, trash included; one carrying its rank still designates it.
 */
export function renameEnumValue(s: State, key: string, from: string, to: string): Action {
  const def = s.tagKeys.get(key);
  if (def?.type !== 'enum') throw new CommandError(`Le tag « ${key} » n’est pas une énumération du registre.`);
  const values = def.enumValues ?? [];
  if (!values.some((e) => e.name === from)) throw new CommandError(`Le tag « ${key} » n’a pas de valeur « ${from} ».`);
  if (to.trim() === '') throw new CommandError('Le nom de la valeur est vide.');
  if (to === from) throw new CommandError(`La valeur s’appelle déjà « ${to} ».`);
  if (values.some((e) => e.name === to)) throw new CommandError(`Le tag « ${key} » a déjà une valeur « ${to} ».`);
  const next: TagKeyDef = { ...def, enumValues: values.map((e) => (e.name === from ? { name: to, rank: e.rank } : e)) };
  if (def.defaultValue === from) next.defaultValue = to;
  const has = (t: TagValue) => t.key === key && t.value === from;
  const carriers = Array.from(taggedWith(s, key), (id) => carrierOf(s, id)).filter((c) => c.rec.tags.some(has));
  return transact(s, (d) => {
    d.tagKey(key, next);
    for (const c of carriers) retag(d, c, c.rec.tags.map((t) => (has(t) ? { key, value: to } : t)));
    return d.finish(`Renommer la valeur « ${from} » du tag « ${key} » en « ${to} »`);
  });
}
