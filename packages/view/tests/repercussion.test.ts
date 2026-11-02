import { createNode, createPlan, emptyState, type Id, include, placeNode, type State } from '@cirrus/core';
import { expect, test } from 'vitest';
import { repercussion } from '../src/repercussion.ts';
import { created, measure, P, run } from './helpers.ts';

/**
 * A node A moved, in P1, from group G into group H (H is in HP there). Elsewhere:
 * P2: A in G, H present far from A: changed, to place by hand. P3: A free, H absent but HP present around A: joins HP.
 * P4: A in a third group K: untouched, reported. P5: A in G, H inside A: a loop, reported. P6: A in G, no target
 * present: leaves G, but still sits inside G's envelope (Z): to place. P7: A already in H: nothing. Doc: a document plan.
 */
function world() {
  const s = emptyState();
  const plan = (name: string, type: 'plan' | 'document' = 'plan') => created(run(s, createPlan(s, name, type)), 'plan');
  const [P1, P2, P3, P4, P5, P6, P7, Doc] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'Doc'].map((n) => plan(n, n === 'Doc' ? 'document' : 'plan'));
  const node = (title: string, at: Id, x = 0, y = 0) => created(run(s, createNode(s, { plan: at, title, x, y, k: 0 })), 'node');
  const put = (n: Id, at: Id, x = 0, y = 0) => run(s, placeNode(s, at, n, x, y, 0));
  const A = node('A', P1, 0, 0), G = node('G', P1), H = node('H', P1, 500, 0), HP = node('HP', P1), X = node('X', P1, 500, 40);
  const K = node('K', P4), Z = node('Z', P6, 0, 0), Y = node('Y', P3, 0, 20);
  run(s, include(s, P1, A, G));
  run(s, include(s, P1, X, H));
  run(s, include(s, P1, H, HP));
  // P2: A in G, H (with X) far away.
  put(A, P2, 1000, 0); put(G, P2); put(H, P2, 0, 0); put(X, P2, 0, 50);
  run(s, include(s, P2, A, G)); run(s, include(s, P2, X, H));
  // P3: A free, next to HP's member Y; H absent.
  put(A, P3, 10, 30); put(HP, P3);
  run(s, include(s, P3, Y, HP));
  // P4: A in K.
  put(A, P4); run(s, include(s, P4, A, K));
  // P5: A in G, and H inside A.
  put(A, P5); put(G, P5); put(H, P5, 50, 0);
  run(s, include(s, P5, A, G)); run(s, include(s, P5, H, A));
  // P6: A in G with Z, nothing of H's chain.
  put(A, P6, 5, 5); put(G, P6);
  run(s, include(s, P6, A, G)); run(s, include(s, P6, Z, G));
  // P7: already in H.
  put(A, P7); put(H, P7); run(s, include(s, P7, A, H));
  put(A, Doc); put(G, Doc);
  return { s: s as State, P1, P2, P3, P4, P5, P6, P7, Doc, A, G, H, HP };
}

test('« partout » : plans changés (et ceux à placer à la main), troisième groupe signalé, boucle signalée (spec 10)', () => {
  const w = world();
  const r = repercussion(w.s, w.P1, w.A, w.G, w.H, measure, P);
  const byPlan = new Map(r.changed.map((c) => [c.plan, c]));
  expect([...byPlan.keys()].sort()).toEqual([w.P2, w.P3, w.P6].sort());
  expect(byPlan.get(w.P2)).toEqual({ plan: w.P2, to: w.H, manual: true });
  expect(byPlan.get(w.P3)).toEqual({ plan: w.P3, to: w.HP, manual: false });
  expect(byPlan.get(w.P6)).toEqual({ plan: w.P6, to: null, manual: true });
  expect(r.third).toEqual([w.P4]);
  expect(r.loops).toEqual([w.P5]);
});

test('une simple sortie : seuls les plans où le nœud était dans le groupe quitté changent', () => {
  const w = world();
  const r = repercussion(w.s, w.P1, w.A, w.G, null, measure, P);
  expect(r.changed.map((c) => c.plan).sort()).toEqual([w.P2, w.P5, w.P6].sort());
  expect(r.changed.every((c) => c.to === null)).toBe(true);
  expect(r.changed.find((c) => c.plan === w.P6)!.manual).toBe(true); // still inside G's envelope, around Z
  expect(r.changed.find((c) => c.plan === w.P2)!.manual).toBe(false); // G has no other member there: no envelope left
  expect(r.third.sort()).toEqual([w.P4, w.P7].sort()); // in K, in H: unrelated to the group left
});

test('descendre dans un sous-groupe du groupe quitté : rester dans l’enveloppe du groupe quitté est normal', () => {
  const s = emptyState();
  const P1 = created(run(s, createPlan(s, 'P1', 'plan')), 'plan'), P2 = created(run(s, createPlan(s, 'P2', 'plan')), 'plan');
  const node = (title: string, x = 0, y = 0) => created(run(s, createNode(s, { plan: P1, title, x, y, k: 0 })), 'node');
  const A = node('A', 0, 0), G = node('G'), H = node('H', 40, 40), Z = node('Z', 30, 0);
  run(s, include(s, P1, A, G)); run(s, include(s, P1, H, G)); run(s, include(s, P1, Z, H));
  for (const [n, x, y] of [[A, 0, 0], [G, 0, 0], [H, 0, 0], [Z, 20, 10]] as const) run(s, placeNode(s, P2, n, x, y, 0));
  run(s, include(s, P2, A, G)); run(s, include(s, P2, H, G)); run(s, include(s, P2, Z, H));
  const r = repercussion(s, P1, A, G, H, measure, P);
  expect(r.changed).toEqual([{ plan: P2, to: H, manual: false }]);
});
