import { connKind, connRow, connTrashed, type Id, KNOWLEDGE, nodeAt, nodeRow, phantomsOf, placedIn, placementKey, planId, type State } from '@cirrus/core';
import type { Hit } from './hit.ts';
import type { PlanScene } from './scene.ts';

/** What a connection drawn from a node would reach (spec 11.1): another node, or the core of a connection. */
export type ConnectTarget = { kind: 'node'; item: number } | { kind: 'connection'; conn: number };

/**
 * The valid target under the cursor while a connection is drawn from `from` (spec 11.1), or null. A box under the
 * cursor decides alone: another node or a group that does not contain `from`; never `from` itself, its groups or a
 * phantom. Otherwise `core` (scene connection index whose marker is under the cursor) is a target unless `from` is
 * already one of its members. The background, an open group's included, is never a target.
 */
export function connectTarget(s: State, scene: PlanScene, from: number, hit: Hit, core: number | null): ConnectTarget | null {
  if (hit.kind === 'item') {
    const it = scene.items[hit.item];
    if (hit.item === from || it.kind === 'phantom') return null;
    for (let a = scene.items[from].parent; a >= 0; a = scene.items[a].parent) if (a === hit.item) return null;
    return { kind: 'node', item: hit.item };
  }
  if (core === null) return null;
  const sc = scene.connections[core];
  const c = sc && sc.part === 'main' ? s.connections.get(sc.id) : undefined;
  if (!c || c.kind !== 'knowledge' || c.members.some((m) => m.node === scene.items[from].node)) return null;
  return { kind: 'connection', conn: core };
}

/**
 * Where « partout » would also show it (spec 11.1, 11.2): the other plans, documents aside, where every one of `nodes`
 * is placed — and, for an existing connection, where it is already shown (a plan without it does not change).
 */
export function otherPlans(s: State, plan: Id, nodes: Id[], connection?: Id): Id[] {
  // Where the connection has branches, from its own (BranchSet.plansOf).
  const shownIn = new Set(connection === undefined ? [] : s.branches.plansOf(connection));
  return [...s.plans.values()]
    .filter((p) => p.id !== plan && p.type !== 'document' && nodes.every((n) => s.placements.has(placementKey(p.id, n))))
    .filter((p) => connection === undefined || shownIn.has(p.id))
    .map((p) => p.id);
}

/**
 * The plans an object is shown in (plan 6a, D3): a node, by its placements; a knowledge connection, by its branches and
 * its phantoms — what a jump to it can frame (the revealer). Empty for an object gone or in the trash, and for a
 * connection of structure. The lobby is a plan like the others; the order is the state's.
 */
export function plansShowing(s: State, kind: 'node' | 'connection', id: Id): Id[] {
  if (kind === 'node') {
    const row = nodeRow(s, id);
    return row < 0 || nodeAt(s, row)?.trashedAt !== undefined ? [] : Array.from(placedIn(s, row), (p) => planId(s, p));
  }
  const row = connRow(s, id);
  if (row < 0 || connKind(s, row) !== KNOWLEDGE || connTrashed(s, row)) return [];
  const plans = s.branches.plansOf(id);
  for (const ph of phantomsOf(s, id)) {
    const p = s.phantoms.get(ph)?.plan;
    if (p !== undefined && !plans.includes(p)) plans.push(p);
  }
  return plans;
}

/** The two French ligatures, which NFD keeps whole: « œ » and « æ » are typed « oe » and « ae » on a French keyboard. */
const LIGATURES = /[œæ]/g;

/**
 * Text as a search compares it, without case or accents: NFD, the marks dropped, lower case, and « œ », « æ » as their
 * two letters (plan 6a, D1: « noeud » finds « Nœud »). One for the app: the node suggestions, the settings' search and
 * the search of Ctrl+K.
 */
export const fold = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(LIGATURES, (l) => (l === 'œ' ? 'oe' : 'ae'));

/**
 * Nodes whose title contains what is typed, without accents or case (the « + » of a connection's pop-up, spec 11.2):
 * titles starting with it first, then the shorter ones; neither `exclude` nor the trash.
 */
export function nodeSuggestions(s: State, typed: string, exclude: Set<Id>, max: number): { id: Id; title: string }[] {
  const q = fold(typed.trim());
  if (!q) return [];
  const found: { id: Id; title: string; rank: number }[] = [];
  for (const n of s.nodes.values()) {
    if (n.trashedAt !== undefined || exclude.has(n.id)) continue;
    const at = fold(n.title).indexOf(q);
    if (at >= 0) found.push({ id: n.id, title: n.title, rank: at === 0 ? 0 : 1 });
  }
  return found.sort((a, b) => a.rank - b.rank || a.title.length - b.title.length).slice(0, max).map(({ id, title }) => ({ id, title }));
}
