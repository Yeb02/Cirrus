import {
  type Action, applyOps, connect, createNode, createPlan, emptyState, type Id, include, invertAction, moveNodes, placeNode, removeFromPlan, type State,
} from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, describe, expect, test } from 'vitest';
import { fitBounds } from '../src/camera.ts';
import { DEFAULT_PARAMS, type RenderParams } from '../src/params.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { type SceneChanges, updateScene } from '../src/sceneUpdate.ts';
import { buildIndex, computeVisible, foldSignature, mergeChanges, type SceneIndex, updateIndex, type VisibleConnection } from '../src/visibility.ts';
import {
  bruteVisible, camAtTextPx, copyOf, created, fixture, indexContent, indexProblem, measure, P, randomActions, randomCameras, rng, run, visibleDifference,
} from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene, idx: SceneIndex;
const at = (id: Id) => sc.byId.get(id)!;
const conn = (vs: VisibleConnection[], from: Id, to: Id) =>
  vs.find((c) => c.conns.some((i) => {
    const members = s.connections.get(sc.connections[i].id)!.members.map((m) => m.node);
    return members.includes(from) && members.includes(to) && members.length === 2;
  }));

beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
  idx = buildIndex(sc, P);
});

test('zoom lisible : tout est ouvert, chaque connexion est statique', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 16), P);
  expect(v.items).toContain(at(ids.nodes.solomonoff));
  expect(v.groups).toContain(at(ids.nodes.groupeInduction));
  expect(v.connections.every((c) => c.fade === 'none')).toBe(true);
  expect(v.connections.length).toBeGreaterThan(10);
  // Parents before children.
  expect(v.groups.indexOf(at(ids.nodes.groupeTheorie))).toBeLessThan(v.groups.indexOf(at(ids.nodes.groupeInduction)));
});

test('dézoom : le groupe Induction se replie et ses connexions sortantes partent de son bord (évidées)', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 4), P);
  expect(v.items).not.toContain(at(ids.nodes.solomonoff));
  expect(v.groups).toContain(at(ids.nodes.groupeInduction));
  const c = conn(v.connections, ids.nodes.solomonoff, ids.nodes.universalite)!;
  expect(c.fade).toBe('none');
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: at(ids.nodes.groupeInduction), hollow: true });
  expect(c.ends.find((e) => e.role === 'target')).toMatchObject({ item: at(ids.nodes.universalite), hollow: false });
});

test('en transition, les bouts glissent vers le bord, et un seul cran est en transition', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 7), P);
  const c = conn(v.connections, ids.nodes.solomonoff, ids.nodes.universalite)!;
  expect(c.fade).toBe('slide');
  expect(c.foldK).toBe(0);
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: at(ids.nodes.solomonoff), item2: at(ids.nodes.groupeInduction), hollow: false, hollow2: true });
  expect(new Set(v.connections.filter((x) => x.fade !== 'none').map((x) => x.foldK)).size).toBe(1);
  expect(v.items).toContain(at(ids.nodes.solomonoff)); // members still drawn while they fade
});

test('connexion interne à un groupe qui se replie : en place, puis effacée', () => {
  const priore = sc.items.find((i) => i.title === 'Priore universelle')!.id;
  const fading = conn(computeVisible(sc, idx, camAtTextPx(sc, 0, 7), P).connections, priore, ids.nodes.solomonoff)!;
  expect(fading.fade).toBe('out');
  expect(fading.ends.map((e) => e.item).sort()).toEqual([at(priore), at(ids.nodes.solomonoff)].sort());
  expect(new Set(fading.ends.map((e) => e.item2))).toEqual(new Set([at(ids.nodes.groupeInduction)]));
  const closed = computeVisible(sc, idx, camAtTextPx(sc, 0, 4), P);
  expect(conn(closed.connections, priore, ids.nodes.solomonoff)).toBeUndefined();
});

test('plusieurs membres d’une même connexion fusionnent en une branche une fois repliés', () => {
  // « Déduction jointe » : Kolmogorov, Solomonoff, MDL → Occam. With Complexité et induction closed, the three sources
  // become one hollow branch from the group.
  const v = computeVisible(sc, idx, camAtTextPx(sc, 1, 4), P);
  const c = v.connections.find((x) => x.conns.some((i) => sc.connections[i].title === 'Déduction jointe'))!;
  expect(c.fade).toBe('none');
  expect(c.ends).toHaveLength(2);
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: at(ids.nodes.groupeTheorie), hollow: true });
});

test('deux connexions entre les mêmes extrémités repliées fusionnent en « 2 connexions »', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), a = node('A', 0, 0), b = node('B', 0, 200), c = node('C', 2000, 100);
  run(st, include(st, plan, a, g));
  run(st, include(st, plan, b, g));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: c, role: 'target' }] }));
  run(st, connect(st, { plan, members: [{ node: b, role: 'source' }, { node: c, role: 'target' }] }));
  const scene = buildScene(st, plan, measure, P);
  const v = computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 3), P);
  expect(v.connections).toHaveLength(1);
  expect(v.connections[0].conns).toHaveLength(2);
  const open = computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 16), P);
  expect(open.connections).toHaveLength(2);
});

test('hors écran : rien n’est visible loin du plan', () => {
  const cam = { ...camAtTextPx(sc, 0, 16), x: 1e7, y: -1e7 };
  const v = computeVisible(sc, idx, cam, P);
  expect(v.items).toEqual([]);
  expect(v.connections).toEqual([]);
});

test('une connexion reste visible si un seul de ses nœuds est à l’écran (spec 8.5)', () => {
  // Camera centred on Monde, narrow screen: Universalité → Monde must stay, Kraft → Code préfixe must not.
  const m = sc.items[at(ids.nodes.monde)];
  const cam = { x: m.x, y: m.y + 150, zoom: 1, widthPx: 600, heightPx: 400 };
  const v = computeVisible(sc, idx, cam, { ...P, viewMarginPx: 0 });
  expect(conn(v.connections, ids.nodes.universalite, ids.nodes.monde)).toBeDefined();
  expect(v.connections.some((c) => c.conns.some((i) => sc.connections[i].ends.some((e) => sc.items[e.item].title === 'Inégalité de Kraft')))).toBe(false);
});

test('la partie lointaine d’un bras scindé est visible près d’Universalité', () => {
  const v = computeVisible(sc, idx, camAtTextPx(sc, 0, 16), P);
  const far = v.connections.find((c) => c.center !== undefined)!;
  expect(sc.items[far.center!].id).toBe(ids.phantoms.center);
  expect(sc.items[far.ends[0].item].id).toBe(ids.nodes.universalite);
});

test('signature de repli : change seulement quand un niveau change d’état', () => {
  const a = foldSignature(idx, camAtTextPx(sc, 0, 16).zoom, P);
  expect(foldSignature(idx, camAtTextPx(sc, 0, 15).zoom, P)).toBe(a);
  expect(foldSignature(idx, camAtTextPx(sc, 0, 7).zoom, P)).not.toBe(a);
  expect(computeVisible(sc, idx, camAtTextPx(sc, 0, 16), P).signature).toBe(a);
});

// ———— Topological index (plan 3c, task 6)

test('computeVisible égale la force brute de sa règle : 50 caméras par plan de la base de test, et un plan vide (Review Focus 3)', () => {
  const st = copyOf(s);
  run(st, createPlan(st, 'Vide', 'plan'));
  const r = rng(61);
  let compared = 0, seenParts = 0;
  for (const plan of st.plans.keys()) {
    const scene = buildScene(st, plan, measure, P), index = buildIndex(scene, P);
    expect(indexProblem(index, scene), st.plans.get(plan)!.name).toBeNull();
    for (const cam of randomCameras(scene, 50, r, 0.02, 8)) {
      const v = computeVisible(scene, index, cam, P);
      expect(visibleDifference(v, bruteVisible(scene, cam)), `${st.plans.get(plan)!.name}, caméra ${JSON.stringify(cam)}`).toBeNull();
      compared++;
      seenParts += v.connections.length;
    }
  }
  expect(compared).toBe(50 * st.plans.size);
  expect(seenParts).toBeGreaterThan(100);
});

test('une connexion interne vue seulement par son groupe en fondu, ses deux bouts hors de la vue, n’est plus dessinée (règle de la tâche 6)', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), a = node('A', -2000, 0), b = node('B', 2000, 0);
  run(st, include(st, plan, a, g));
  run(st, include(st, plan, b, g));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] }));
  const scene = buildScene(st, plan, measure, P), index = buildIndex(scene, P), p = { ...P, viewMarginPx: 0 };
  // Between A and B, in G's envelope, on a narrow screen, at a zoom where G fades.
  const cam = { ...camAtTextPx(scene, 0, 7, p), x: 0, y: 0, widthPx: 200, heightPx: 200 };
  const v = computeVisible(scene, index, cam, p);
  expect(v.groups).toEqual([scene.byId.get(g)]);
  expect(v.connections).toEqual([]);
  expect(visibleDifference(v, bruteVisible(scene, cam, p))).toBeNull();
  // Seen once an end is in the view.
  const near = computeVisible(scene, index, { ...cam, x: -2000 }, p);
  expect(near.connections).toHaveLength(1);
  expect(near.connections[0].fade).toBe('out');
});

/** Cameras that look at a scene as a whole, at the fold of its first groups, and up close; around the origin when it is empty. */
const camerasOf = (scene: PlanScene): ReturnType<typeof camAtTextPx>[] => {
  if (!scene.bounds) return [{ x: 0, y: 0, zoom: 1, widthPx: 2560, heightPx: 1600 }];
  return [fitBounds(scene.bounds, 2560, 1600, P), camAtTextPx(scene, 0, 7), camAtTextPx(scene, 0, 16), camAtTextPx(scene, 1, 5)];
};

describe.each([
  ['réglages par défaut', DEFAULT_PARAMS],
  ['arbre des racines souvent reconstruit, scène jamais reconstruite', { ...DEFAULT_PARAMS, indexDirtyMax: 2, sceneCompactShare: 1 }],
  ['arbre des racines jamais reconstruit', { ...DEFAULT_PARAMS, indexDirtyMax: 1e6, sceneCompactShare: 1 }],
] as [string, RenderParams][])('updateIndex, %s', (_name, p) => {
  test('300 actions tirées au hasard, puis leur annulation : l’index tenu à jour égale l’index construit sur la même scène, dans chaque plan', () => {
    const st = copyOf(s), r = rng(p.indexDirtyMax === 2 ? 43 : p.indexDirtyMax > 1000 ? 47 : 41);
    const held = new Map<Id, { scene: PlanScene; index: SceneIndex; behind: SceneChanges | null }>();
    let updates = 0;
    const follow = (ops: Action['ops'], what: string) => {
      for (const plan of st.plans.keys()) {
        const h = held.get(plan);
        if (!h) { const scene = buildScene(st, plan, measure, p); held.set(plan, { scene, index: buildIndex(scene, p), behind: null }); continue; }
        const { scene, changes } = updateScene(h.scene, st, ops, measure, p);
        // Now and then an index stays behind for an action and follows two at once (a view that skipped a render).
        const behind = h.behind ? mergeChanges(h.behind, changes) : changes;
        if (r() < 0.15) { held.set(plan, { ...h, scene, behind }); continue; }
        const index = updateIndex(h.index, scene, behind, p), fresh = buildIndex(scene, p), name = `${what}, plan ${st.plans.get(plan)!.name}`;
        expect(indexContent(index, scene), name).toEqual(indexContent(fresh, scene));
        expect(indexProblem(index, scene), name).toBeNull();
        for (const cam of camerasOf(scene)) {
          const v = computeVisible(scene, index, cam, p);
          expect(v, name).toEqual(computeVisible(scene, fresh, cam, p));
          expect(visibleDifference(v, bruteVisible(scene, cam, p)), name).toBeNull();
        }
        held.set(plan, { scene, index, behind: null });
        updates++;
      }
    };
    follow([], 'départ');
    const next = randomActions(st, r), done: Action[] = [];
    for (let i = 0; i < 300; i++) {
      const picked = next();
      if (!picked) continue;
      applyOps(st, picked.action.ops);
      follow(picked.action.ops, `action ${i} (${picked.action.label})`);
      if (r() < 0.4) {
        const undo = invertAction(picked.action);
        applyOps(st, undo.ops);
        follow(undo.ops, `annulation de l’action ${i}`);
      } else done.push(picked.action);
    }
    for (let i = done.length - 1; i >= 0; i--) {
      const undo = invertAction(done[i]);
      applyOps(st, undo.ops);
      follow(undo.ops, `annulation finale de « ${done[i].label} »`);
    }
    expect(updates).toBeGreaterThan(500);
  }, 300_000);
});

test('plan vide, retrait du dernier élément, emplacement recyclé : l’index ne garde rien d’un emplacement libéré (Review Focus 3)', () => {
  for (const p of [P, { ...P, sceneCompactShare: 1 }]) {
    const st = copyOf(s);
    const plan = created(run(st, createPlan(st, 'Seul', 'plan')), 'plan');
    let scene = buildScene(st, plan, measure, p), index = buildIndex(scene, p);
    expect(computeVisible(scene, index, camerasOf(scene)[0], p)).toMatchObject({ items: [], groups: [], connections: [] });
    const step = (a: Action) => {
      const u = updateScene(scene, st, a.ops, measure, p);
      scene = u.scene;
      index = updateIndex(index, scene, u.changes, p);
      expect(indexContent(index, scene)).toEqual(indexContent(buildIndex(scene, p), scene));
      expect(indexProblem(index, scene)).toBeNull();
    };
    const one = created(run(st, createNode(st, { plan, title: 'Unique', x: 10, y: 20, k: 0 })), 'node');
    run(st, placeNode(st, ids.plans.lobby, one, 0, 0, 0));
    scene = buildScene(st, plan, measure, p);
    index = buildIndex(scene, p);
    const two = run(st, createNode(st, { plan, title: 'Second', x: 400, y: 20, k: 0 }));
    step(two);
    step(run(st, connect(st, { plan, members: [{ node: one, role: 'source' }, { node: created(two, 'node'), role: 'target' }] })));
    expect(computeVisible(scene, index, camerasOf(scene)[0], p).connections).toHaveLength(1);
    step(run(st, removeFromPlan(st, plan, created(two, 'node'))));
    step(run(st, removeFromPlan(st, plan, one)));
    expect(scene.roots).toEqual([]);
    expect(index.byTop.size + index.incident.size).toBe(0);
    expect(computeVisible(scene, index, { x: 10, y: 20, zoom: 1, widthPx: 2560, heightPx: 1600 }, p)).toMatchObject({ items: [], groups: [], connections: [] });
    // A node comes back in a freed slot (sceneCompactShare 1) or in a scene built anew.
    step(run(st, createNode(st, { plan, title: 'Revenu', x: 0, y: 0, k: 0 })));
    step(run(st, moveNodes(st, plan, [{ node: [...st.placements.values()].find((pl) => pl.plan === plan)!.node, x: 50, y: 60 }])));
    expect(computeVisible(scene, index, { x: 50, y: 60, zoom: 1, widthPx: 2560, heightPx: 1600 }, p).items).toHaveLength(1);
  }
});

test('deux connexions parallèles ouvertes restent distinctes ; elles ne fusionnent que repliées (I5 de la relecture)', () => {
  const st = emptyState();
  const plan = created(run(st, createPlan(st, 'P', 'plan')), 'plan');
  const node = (title: string, x: number, y: number) => created(run(st, createNode(st, { plan, title, x, y, k: 0 })), 'node');
  const g = node('G', 0, 0), a = node('A', 0, 0), b = node('B', 2000, 0);
  run(st, include(st, plan, a, g));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], title: 'cite' }));
  run(st, connect(st, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }], title: 'contredit' }));
  const scene = buildScene(st, plan, measure, P);
  expect(computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 16), P).connections).toHaveLength(2);
  const folded = computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 3), P);
  expect(folded.connections).toHaveLength(1);
  expect(folded.connections[0].conns).toHaveLength(2);
});
