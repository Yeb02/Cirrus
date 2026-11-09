import {
  type Action, CITE_KEY_TAG, type CompileRequest, type ConnectionRec, DEFAULT_PREAMBLE, type FileRef, type Id, LABEL_TAG, type NodeRec, type PreambleRec,
  type State,
} from '@cirrus/core';
import { fileKind } from '../files/kind.ts';
import { isSynced } from '../session.ts';
import { AUTHOR_TAG, DATE_TAG, type LatexRegistry, type Origin, slotOf, tagName } from './registry.ts';
import { buildRequest } from './request.ts';
import { knownLabels } from './scheduler.ts';

// What a synchronisation changed, compiled in the background (plan 5b, D1). The interface notes what each one changed
// (SyncedChanges, as the session applies it); at the next build of the registry, once the .tex it changed are read, it
// finds the sources whose compile request changed (backgroundOrigins) and sends their requests to the main process,
// which compiles them when the user's compilations leave it room: a view opened later finds its PDF in the cache.

/**
 * What a synchronisation changed that a compilation reads: the nodes, each with its record before the change (null: it
 * did not exist), whose files and tags tell what it defined and held; the connections, whose relation is one source,
 * read as it was in the registry before; whether the preamble changed.
 */
export interface SyncChange { nodes: Map<Id, NodeRec | null>; connections: Set<Id>; preamble: boolean }

/** The tags a compilation reads: a title's label, a citation key, and what a key's short citation shows. */
const READ_TAGS: ReadonlySet<string> = new Set([LABEL_TAG, CITE_KEY_TAG, AUTHOR_TAG, DATE_TAG]);

const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean) => a.length === b.length && a.every((x, i) => same(x, b[i]));
const sameFile = (a: FileRef, b: FileRef) => a.name === b.name && a.hash === b.hash;
const readTags = (n: NodeRec) => n.tags.filter((t) => READ_TAGS.has(t.key));
const trashed = (r: { trashedAt?: number }) => r.trashedAt !== undefined;
/** A record the registry read: there, and outside the trash. */
const live = <T extends { trashedAt?: number }>(r: T | null | undefined): r is T => r !== null && r !== undefined && !trashed(r);

/** Whether two versions of a node compile the same: its summary, files, title, trash, and the tags a compilation reads. */
function sameNode(a: NodeRec | null, b: NodeRec | null): boolean {
  if (a === null || b === null) return a === b;
  return a.summary === b.summary && a.title === b.title && trashed(a) === trashed(b) && sameList(a.files, b.files, sameFile)
    && sameList(readTags(a), readTags(b), (x, y) => x.key === y.key && x.value === y.value);
}

/** Whether two versions of a connection compile the same: its relation, its title (that of its labels), its trash. */
function sameConnection(a: ConnectionRec | null, b: ConnectionRec | null): boolean {
  if (a === null || b === null) return a === b;
  return a.relation === b.relation && a.title === b.title && trashed(a) === trashed(b);
}

/** A subject's first « before » and last « after » in an action. */
function track<T>(seen: Map<Id, [T | null, T | null]>, id: Id, before: T | null, after: T | null): void {
  const s = seen.get(id);
  if (s) s[1] = after;
  else seen.set(id, [before, after]);
}

const preambleOf = (p: PreambleRec | null) => p?.text ?? DEFAULT_PREAMBLE;

/**
 * What the action `a` of a synchronisation changed that a compilation reads (D1). Such an action holds the
 * reconciliation's inverses, then the writes received, then the pending ones replayed: for each subject, its first
 * « before » is compared with its last « after », and a summary rewound then replayed as it was changed nothing. A
 * change the compilations do not read (a placement, another tag) is left out.
 */
export function changedBySync(a: Action): SyncChange {
  const nodes = new Map<Id, [NodeRec | null, NodeRec | null]>(), connections = new Map<Id, [ConnectionRec | null, ConnectionRec | null]>();
  let preamble: [PreambleRec | null, PreambleRec | null] | null = null;
  for (const op of a.ops) {
    if (op.t === 'node') track(nodes, (op.after ?? op.before)!.id, op.before, op.after);
    else if (op.t === 'connection') track(connections, (op.after ?? op.before)!.id, op.before, op.after);
    else if (op.t === 'preamble') {
      if (preamble) preamble[1] = op.after;
      else preamble = [op.before, op.after];
    }
  }
  const out: SyncChange = { nodes: new Map(), connections: new Set(), preamble: preamble !== null && preambleOf(preamble[0]) !== preambleOf(preamble[1]) };
  for (const [id, [before, after]] of nodes) if (!sameNode(before, after)) out.nodes.set(id, before);
  for (const [id, [before, after]] of connections) if (!sameConnection(before, after)) out.connections.add(id);
  return out;
}

type Definition = ReturnType<LatexRegistry['definitions']>[number];
const definedAt = (d: Definition) => (d.origin.kind === 'title' ? `title:${d.origin.node}` : slotOf(d.origin));
/** Whether a label's definitions tell its citers the same: their number, then each one's title, node and place. */
const sameDefinitions = (a: Definition[], b: Definition[]) =>
  sameList(a, b, (x, y) => x.title === y.title && x.node === y.node && definedAt(x) === definedAt(y));

/** What a source citing `key` is told of it (buildRequest): the nodes holding it, and the first one's short citation. */
function citation(r: LatexRegistry, key: string): string {
  const nodes = r.citeNodes(key);
  return nodes.length === 0 ? '' : `${nodes.join(' ')}\n${r.citationOf(nodes[0])}`;
}

/** The names of the node's tags `key` (a title's label, a citation key), as the registry reads them. */
function tagNames(n: NodeRec, key: string, out: Set<string>): void {
  for (const t of n.tags) {
    if (t.key !== key) continue;
    const name = tagName(t);
    if (name !== '') out.add(name);
  }
}

/** The labels the source `o` defined when `r` was built: its analysis there. */
function labelsIn(r: LatexRegistry, o: Origin, out: Set<string>): void {
  const text = r.textOf(o);
  if (text !== undefined) for (const m of r.scanOf(o, text).labels) out.add(m.name);
}

/** The labels the node `n` defines in `r`: its title's tag, its summary, its .tex. */
function nodeLabels(r: LatexRegistry, n: NodeRec, out: Set<string>): void {
  tagNames(n, LABEL_TAG, out);
  labelsIn(r, { kind: 'summary', node: n.id }, out);
  for (const f of n.files) if (fileKind(f.name) === 'tex') labelsIn(r, { kind: 'file', node: n.id, name: f.name }, out);
}

/**
 * The sources whose compile request a synchronisation changed (D1): `previous`, the registry built before it; `next`,
 * the one built after, from the state `s` and the texts `texts` of its .tex. Each once, the summaries and relations
 * first, then the .tex, each in the order found:
 * - a changed node's summary and .tex, and a changed connection's relation, when their text or the node's files (their
 *   resources) changed: a title alone leaves its own sources as they were;
 * - the sources citing a label whose definitions changed (a title, a source, the trash), or a key whose holders or first
 *   short citation changed. The labels and keys come from the records before and after the change, and the analyses
 *   the two registries made of their sources; their citers, from `next`'s index: never by going through every source;
 * - every source when the preamble changed, but a standalone .tex, compiled without it.
 * A summary or a relation of blanks is left out: its view does not compile it.
 */
export function backgroundOrigins(change: SyncChange, previous: LatexRegistry, next: LatexRegistry, s: State, texts: ReadonlyMap<string, string>): Origin[] {
  const snippets = new Map<string, Origin>(), pages = new Map<string, Origin>();
  const add = (o: Origin) => {
    const text = next.textOf(o);
    if (text === undefined) return;
    if (o.kind === 'file') pages.set(slotOf(o), o);
    else if (text.trim() !== '') snippets.set(slotOf(o), o);
  };
  if (change.preamble) for (const o of next.origins()) if (o.kind !== 'file' || !next.scanOf(o, next.textOf(o)!).standalone) add(o);
  // The labels and keys the changed nodes and connections defined or held, before or after.
  const labels = new Set<string>(), keys = new Set<string>();
  for (const [id, before] of change.nodes) {
    if (live(before)) {
      nodeLabels(previous, before, labels);
      tagNames(before, CITE_KEY_TAG, keys);
    }
    const n = s.nodes.get(id);
    if (!live(n)) continue;
    nodeLabels(next, n, labels);
    tagNames(n, CITE_KEY_TAG, keys);
    const files = !live(before) || !sameList(before.files, n.files, sameFile);
    const summary: Origin = { kind: 'summary', node: id };
    if (files || previous.textOf(summary) !== n.summary) add(summary);
    for (const f of n.files) {
      if (fileKind(f.name) !== 'tex') continue;
      const tex: Origin = { kind: 'file', node: id, name: f.name };
      if (files || previous.textOf(tex) !== texts.get(f.hash)) add(tex);
    }
  }
  for (const id of change.connections) {
    const relation: Origin = { kind: 'relation', connection: id };
    labelsIn(previous, relation, labels);
    labelsIn(next, relation, labels);
    if (previous.textOf(relation) !== next.textOf(relation)) add(relation);
  }
  for (const label of labels) if (!sameDefinitions(previous.definitions(label), next.definitions(label))) for (const o of next.citers(label)) add(o);
  for (const key of keys) if (citation(previous, key) !== citation(next, key)) for (const o of next.citersOfKey(key)) add(o);
  return [...snippets.values(), ...pages.values()];
}

/** Whether the .tex of the changed nodes are read: the registry built with `texts` knows their labels and citations. */
function texRead(change: SyncChange, s: State, texts: ReadonlyMap<string, string>): boolean {
  for (const id of change.nodes.keys()) {
    const n = s.nodes.get(id);
    if (live(n) && n.files.some((f) => fileKind(f.name) === 'tex' && !texts.has(f.hash))) return false;
  }
  return true;
}

/**
 * What the synchronisations changed since the registry last took it (D1): noted as the session applies each action
 * (App's onChange), taken at a build of the registry (useLatexRegistry). An action of this PC is not noted: its open
 * views compile what it changes. The state read again (a base taken from the server) forgets it, as the start does.
 */
export class SyncedChanges {
  private change: SyncChange | null = null;
  /** The registry built before the first change noted: the next builds are compared with it. */
  private before: LatexRegistry | null = null;

  /** An action applied to the state; null: the state was read again. */
  note(a: Action | null): void {
    if (a === null) {
      this.change = null;
      this.before = null;
      return;
    }
    if (!isSynced(a)) return;
    const c = changedBySync(a);
    if (c.nodes.size === 0 && c.connections.size === 0 && !c.preamble) return;
    if (!this.change) {
      this.change = c;
      return;
    }
    // Each subject keeps its record before the first change noted.
    for (const [id, before] of c.nodes) if (!this.change.nodes.has(id)) this.change.nodes.set(id, before);
    for (const id of c.connections) this.change.connections.add(id);
    this.change.preamble ||= c.preamble;
  }

  /**
   * At a build of the registry, `previous` the one before and `next` the new one: the sources to compile in the
   * background. None until the .tex of the changed nodes are read (`texts`): the changes are kept, compared still with
   * the registry built before the first of them. Without a registry before it (the start), none. Taken, the changes
   * are forgotten, even if the computation fails: it is never tried again at each build.
   */
  take(previous: LatexRegistry | null, next: LatexRegistry, s: State, texts: ReadonlyMap<string, string>): Origin[] {
    const change = this.change;
    if (!change) return [];
    this.before ??= previous;
    const before = this.before;
    if (before !== null && !texRead(change, s, texts)) return [];
    this.change = null;
    this.before = null;
    return before === null ? [] : backgroundOrigins(change, before, next, s, texts);
  }
}

/**
 * The compile requests of `origins` as their views build them (buildRequest), from the registry `r` and the state `s`:
 * the text the registry read, the slot's last labels as a hint, the snippets' width `widthCm` (latexSnippetWidthCm).
 * The same request as the view's, the same PDF in the cache.
 */
export function backgroundRequests(origins: Origin[], s: State, r: LatexRegistry, widthCm: number): CompileRequest[] {
  return origins.map((origin) => buildRequest({ origin, source: r.textOf(origin)!, s, registry: r, known: knownLabels(slotOf(origin)), widthCm }));
}
