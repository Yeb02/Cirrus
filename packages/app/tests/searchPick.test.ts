import {
  type Action, type Anchor, applyOps, connect, createAnnotation, createNode, createPlan, deleteConnection, deleteEverywhere, emptyState, type Id, placeNode, removeFromPlan,
  restoreConnection, type State,
} from '@cirrus/core';
import { expect, test } from 'vitest';
import { DEFAULT_FILTERS, SearchIndex } from '../src/renderer/search/index.ts';
import { CONNECTION_NO_PLAN, pickWithoutPlan } from '../src/renderer/search/pick.ts';
import { OBJECT_GONE } from '../src/renderer/ui/graph/jumps.ts';

// What choosing a result that no plan shows does (plan 6a, final review): an annotation opens its pop-up; a live connection
// that no plan shows says so; an object really gone says that. The decision is pure.

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const idOf = (a: Action, t: 'plan' | 'node' | 'connection'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
const anchor = (pdf: Id): Anchor => ({ pdf, file: 'chapitre.pdf', hash: '0123456789abcdef'.repeat(4), page: 1, rects: [[72, 581, 300, 594.8]], text: 'Un passage souligné' });

/** A and B joined by « zorglub lien » in P, then thrown away and restored with A moved to the lobby: no plan shows the connection. */
function world() {
  const s = emptyState();
  const lobby = idOf(run(s, createPlan(s, 'Lobby', 'lobby')), 'plan'), plan = idOf(run(s, createPlan(s, 'P', 'plan')), 'plan');
  const A = idOf(run(s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 })), 'node'), B = idOf(run(s, createNode(s, { plan, title: 'B', x: 400, y: 0, k: 0 })), 'node');
  const link = idOf(run(s, connect(s, { plan, title: 'zorglub lien', members: [{ node: A, role: 'source' }, { node: B, role: 'target' }] })), 'connection');
  run(s, deleteConnection(s, link));
  run(s, placeNode(s, lobby, A, 0, 0, 0));
  run(s, removeFromPlan(s, plan, A));
  run(s, restoreConnection(s, link));
  return { s, lobby, plan, A, B, link };
}

const found = (s: State, lobby: Id, query: string) => SearchIndex.build(s, new Map()).query(query, DEFAULT_FILTERS, { plan: lobby, lobby, tabs: [] }, 10);

test('pickWithoutPlan : une connexion vivante que aucun plan ne montre le dit, au lieu de « jetée » ; le message est celui de la restauration sans branche', () => {
  const { s, lobby, link } = world();
  // Ctrl+K finds it, and no plan is where its jump goes.
  const hits = found(s, lobby, 'zorglub');
  expect(hits.map((h) => [h.id, h.kind, h.plan])).toEqual([[link, 'connection', null]]);
  expect(pickWithoutPlan(s, hits[0])).toEqual({ say: CONNECTION_NO_PLAN });
  expect(CONNECTION_NO_PLAN).toBe('Cette connexion n’est dans aucun plan : aucun plan ne réunit deux de ses nœuds.');
  expect(CONNECTION_NO_PLAN).not.toBe(OBJECT_GONE);
});

test('pickWithoutPlan : un objet vraiment disparu — jeté, ou inconnu — garde le message « n’est plus là », un seul pour tout le logiciel', () => {
  const { s, lobby, A, link } = world();
  const hit = found(s, lobby, 'zorglub')[0];
  // The connection thrown away since it was listed; a connection that never was.
  run(s, deleteConnection(s, link));
  expect(pickWithoutPlan(s, hit)).toEqual({ say: OBJECT_GONE });
  expect(pickWithoutPlan(s, { id: 'inconnu' as Id, kind: 'connection' })).toEqual({ say: OBJECT_GONE });
  // A node: thrown away, or unknown.
  run(s, deleteEverywhere(s, A));
  expect(pickWithoutPlan(s, { id: A, kind: 'node' })).toEqual({ say: OBJECT_GONE });
  expect(pickWithoutPlan(s, { id: 'inconnu' as Id, kind: 'node' })).toEqual({ say: OBJECT_GONE });
  expect(OBJECT_GONE).toBe('Cet objet n’est plus là : il a été jeté, ou retiré de ce plan.');
});

test('pickWithoutPlan : une annotation (un nœud d’aucun plan) ouvre son pop-up', () => {
  const { s, lobby, B } = world();
  const note = idOf(run(s, createAnnotation(s, anchor(B), 'Un passage souligné')), 'node');
  const hit = found(s, lobby, 'souligne')[0];
  expect([hit.id, hit.kind, hit.plan]).toEqual([note, 'node', null]);
  expect(pickWithoutPlan(s, hit)).toEqual({ popup: note });
});
