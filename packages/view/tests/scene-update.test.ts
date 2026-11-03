import {
  type Action, applyOps, combine, connect, createNode, createPlan, deleteConnection, type Id, include, invertAction, moveNodes, type Op, placeNode, removeFromPlan,
  type State,
} from '@cirrus/core';
import { describe, expect, test } from 'vitest';
import { copyClip, pasteSteps } from '../src/clip.ts';
import { DEFAULT_PARAMS, type RenderParams } from '../src/params.ts';
import { buildScene, isLive, partEnds, partOf, type PlanScene } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { canonicalScene, copyOf, created, fixture, KINDS, measure, P, randomActions, rng, run, sceneBooks, slotProblem } from './helpers.ts';

const base = fixture();

/**
 * Every cached scene follows an action (Review Focus 2), and must show what a scene built anew shows; the previous
 * scene stays exactly as it was, books included, for a gesture that holds it.
 */
function follow(s: State, scenes: Map<Id, PlanScene>, ops: Op[], p: RenderParams, what: string): void {
  for (const plan of s.plans.keys()) {
    const prev = scenes.get(plan);
    if (!prev) { scenes.set(plan, buildScene(s, plan, measure, p)); continue; }
    const before = canonicalScene(prev), books = sceneBooks(prev);
    const { scene } = updateScene(prev, s, ops, measure, p);
    const name = s.plans.get(plan)!.name;
    expect(canonicalScene(prev), `${what} : la scène précédente de ${name} a changé`).toEqual(before);
    expect(sceneBooks(prev), `${what} : les tables de la scène précédente de ${name} ont changé`).toEqual(books);
    expect(slotProblem(prev), `${what}, scène précédente de ${name}`).toBeNull();
    expect(canonicalScene(scene), `${what}, plan ${name}`).toEqual(canonicalScene(buildScene(s, plan, measure, p)));
    expect(slotProblem(scene), `${what}, plan ${name}`).toBeNull();
    scenes.set(plan, scene);
  }
}

describe.each([
  ['compactage par défaut', DEFAULT_PARAMS],
  ['sans compactage (chemins incrémentaux seulement)', { ...DEFAULT_PARAMS, sceneCompactShare: 1 }],
])('mise à jour par les opérations, %s', (_name, p) => {
  test('300 actions tirées au hasard, puis leur annulation : chaque scène en cache égale la scène reconstruite, dans chaque plan', () => {
    const s = copyOf(base.s), r = rng(p.sceneCompactShare === 1 ? 31 : 17);
    const scenes = new Map<Id, PlanScene>();
    follow(s, scenes, [], p, 'départ');
    const next = randomActions(s, r);
    const done: Action[] = [];
    const made = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const picked = next();
      if (!picked) continue;
      const a = picked.action;
      made.set(picked.kind, (made.get(picked.kind) ?? 0) + 1);
      applyOps(s, a.ops);
      follow(s, scenes, a.ops, p, `action ${i} (${a.label})`);
      // Undo goes through the same path (Review Focus 1): now and then at once, the rest at the end, last first.
      if (r() < 0.4) {
        const undo = invertAction(a);
        applyOps(s, undo.ops);
        follow(s, scenes, undo.ops, p, `annulation de l’action ${i} (${a.label})`);
      } else done.push(a);
    }
    for (let i = done.length - 1; i >= 0; i--) {
      const undo = invertAction(done[i]);
      applyOps(s, undo.ops);
      follow(s, scenes, undo.ops, p, `annulation finale de « ${done[i].label} »`);
    }
    expect([...made.values()].reduce((x, y) => x + y, 0)).toBeGreaterThan(150);
    // Each kind of the brief made at least once.
    if (process.env.CIRRUS_COSTS) console.log([...made].sort().map(([k, n]) => `${k} ${n}`).join(', '));
    expect(KINDS.filter((k) => !made.has(k))).toEqual([]);
    for (const plan of s.plans.keys()) expect(canonicalScene(scenes.get(plan)!)).toEqual(canonicalScene(buildScene(base.s, plan, measure, p)));
  }, 120_000);
});

test('une action sans effet sur le plan rend la scène telle quelle', () => {
  const s = copyOf(base.s), lobby = buildScene(s, base.ids.plans.lobby, measure, P);
  const a = run(s, moveNodes(s, base.ids.plans.these, [{ node: base.ids.nodes.theseOnly, x: 5, y: 7 }]));
  const r = updateScene(lobby, s, a.ops, measure, P);
  expect(r.scene).toBe(lobby);
  expect(r.changes).toEqual({ items: [], parts: [], hierarchy: false, full: false });
});

test('un déplacement ne touche que l’élément et les groupes au-dessus de lui, sans changer la hiérarchie', () => {
  const s = copyOf(base.s), lobby = buildScene(s, base.ids.plans.lobby, measure, P), { nodes } = base.ids;
  const a = run(s, moveNodes(s, base.ids.plans.lobby, [{ node: nodes.solomonoff, x: -300, y: 260 }]));
  const r = updateScene(lobby, s, a.ops, measure, P);
  const above = [nodes.solomonoff, nodes.groupeInduction, nodes.groupeComplexite, nodes.groupeTheorie].map((id) => lobby.byId.get(id)!);
  expect([...r.changes.items].sort()).toEqual([...above].sort());
  expect(r.changes).toMatchObject({ parts: [], hierarchy: false, full: false });
  expect(r.scene.byId.get(nodes.solomonoff)).toBe(lobby.byId.get(nodes.solomonoff));
});

test('le retrait du dernier élément d’un plan donne une scène vide cohérente (Review Focus 3)', () => {
  for (const p of [P, { ...P, sceneCompactShare: 1 }]) {
    const s = copyOf(base.s);
    const plan = created(run(s, createPlan(s, 'Seul', 'plan')), 'plan');
    const node = created(run(s, createNode(s, { plan, title: 'Unique', x: 10, y: 20, k: 0 })), 'node');
    run(s, placeNode(s, base.ids.plans.lobby, node, 0, 0, 0));
    const one = buildScene(s, plan, measure, p);
    const a = run(s, removeFromPlan(s, plan, node));
    const { scene, changes } = updateScene(one, s, a.ops, measure, p);
    expect(scene.items.filter((_it, i) => isLive(scene, i))).toEqual([]);
    expect(scene.roots).toEqual([]);
    expect(scene.bounds).toBeNull();
    expect(scene.connections.filter((c) => c.id !== '')).toEqual([]);
    expect(slotProblem(scene)).toBeNull();
    expect(canonicalScene(scene)).toEqual(canonicalScene(buildScene(s, plan, measure, p)));
    expect(changes.full).toBe(p.sceneCompactShare < 1);
  }
});

test('un emplacement libéré est recyclé par l’élément suivant, sans rien qui pointe encore sur son ancien occupant', () => {
  const p = { ...P, sceneCompactShare: 1 };
  const s = copyOf(base.s), plan = base.ids.plans.lobby;
  let sc = buildScene(s, plan, measure, p);
  const freed = sc.byId.get(base.ids.nodes.monde)!;
  sc = updateScene(sc, s, run(s, removeFromPlan(s, plan, base.ids.nodes.monde)).ops, measure, p).scene;
  expect(sc.freeItems).toEqual([freed]);
  expect(isLive(sc, freed)).toBe(false);
  const a = run(s, createNode(s, { plan, title: 'Nouveau', x: 3000, y: 0, k: 0 }));
  sc = updateScene(sc, s, a.ops, measure, p).scene;
  expect(sc.byId.get(created(a, 'node'))).toBe(freed);
  expect(sc.freeItems).toEqual([]);
  expect(slotProblem(sc)).toBeNull();
  expect(canonicalScene(sc)).toEqual(canonicalScene(buildScene(s, plan, measure, p)));
});

test('les parties libérées sont recyclées quand les colonnes doivent grandir', () => {
  const p = { ...P, sceneCompactShare: 1 };
  const s = copyOf(base.s), plan = base.ids.plans.lobby;
  let sc = buildScene(s, plan, measure, p);
  const nodes = [...s.placements.values()].filter((pl) => pl.plan === plan).map((pl) => pl.node);
  const gone = partOf(sc, base.ids.connections.mdlSolomonoff);
  sc = updateScene(sc, s, run(s, deleteConnection(s, base.ids.connections.mdlSolomonoff)).ops, measure, p).scene;
  expect(sc.freeParts).toEqual(gone);
  // New connections go to the end of the shared columns until they must grow; then the free slots are taken first.
  for (let i = 0; i < 400 && sc.freeParts.length > 0; i++) {
    const [a, b] = [nodes[i % nodes.length], nodes[(i * 7 + 3) % nodes.length]];
    if (a === b) continue;
    sc = updateScene(sc, s, run(s, connect(s, { plan, members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] })).ops, measure, p).scene;
  }
  expect(sc.freeParts).toEqual([]);
  expect(slotProblem(sc)).toBeNull();
  expect(canonicalScene(sc)).toEqual(canonicalScene(buildScene(s, plan, measure, p)));
});

test('au-delà de 25 % d’emplacements libres, la scène est reconstruite', () => {
  const s = copyOf(base.s);
  const plan = created(run(s, createPlan(s, 'Huit', 'plan')), 'plan');
  const ids = Array.from({ length: 8 }, (_v, i) => created(run(s, createNode(s, { plan, title: `N${i}`, x: i * 300, y: 0, k: 0 })), 'node'));
  for (const id of ids) run(s, placeNode(s, base.ids.plans.lobby, id, 0, 0, 0));
  let sc = buildScene(s, plan, measure, P);
  const fulls: boolean[] = [];
  for (const id of ids.slice(0, 3)) {
    const r = updateScene(sc, s, run(s, removeFromPlan(s, plan, id)).ops, measure, P);
    fulls.push(r.changes.full);
    sc = r.scene;
  }
  // 1 then 2 free slots of 8 (12.5 %, 25 %): kept; 3 of 8 (37.5 %): rebuilt, without free slots.
  expect(fulls).toEqual([false, false, true]);
  expect(sc.freeItems).toEqual([]);
  expect(sc.items).toHaveLength(5);
});

test('la façade des connexions matérialise chaque partie comme ses colonnes, et sa sentinelle vaut pour une partie retirée', () => {
  const s = copyOf(base.s), plan = base.ids.plans.lobby, p = { ...P, sceneCompactShare: 1 };
  let sc = buildScene(s, plan, measure, p);
  const [i] = partOf(sc, base.ids.connections.twoToTwo);
  const c = sc.connections[i];
  expect(c).toMatchObject({ index: i, id: base.ids.connections.twoToTwo, part: 'main', ends: partEnds(sc, i) });
  expect(sc.connections.length).toBe(sc.partCount);
  sc = updateScene(sc, s, run(s, deleteConnection(s, base.ids.connections.twoToTwo)).ops, measure, p).scene;
  expect(sc.connections[i]).toMatchObject({ id: '', ends: [], stubs: [] });
  expect(Object.isFrozen(sc.connections[i])).toBe(true);
  expect(partOf(sc, base.ids.connections.twoToTwo)).toEqual([]);
  expect(sc.connections.some((x) => x.id === base.ids.connections.twoToTwo)).toBe(false);
});

test('une action sur un autre plan (collage, répercussion) laisse exacte la scène en cache du lobby (Review Focus 2)', () => {
  const s = copyOf(base.s), { lobby, these } = base.ids.plans;
  const scenes = new Map<Id, PlanScene>([[lobby, buildScene(s, lobby, measure, P)], [these, buildScene(s, these, measure, P)]]);
  const sc = scenes.get(lobby)!;
  const clip = copyClip(s, sc, [sc.byId.get(base.ids.nodes.groupeInduction)!, sc.byId.get(base.ids.nodes.monde)!], 1)!;
  const paste = run(s, combine(s, 'Coller', pasteSteps(s, clip, these, { x: 4000, y: 0 }, 0.5, null, P).steps));
  follow(s, scenes, paste.ops, P, 'collage dans Thèse');
  const rep = run(s, combine(s, 'Répercuter', [(x) => include(x, these, base.ids.nodes.monde, base.ids.nodes.groupeInduction)]));
  follow(s, scenes, rep.ops, P, 'inclusion dans Thèse');
  const back = invertAction(rep);
  applyOps(s, back.ops);
  follow(s, scenes, back.ops, P, 'annulation dans Thèse');
});

test('deux scènes tirées de la même scène précédente, par deux actions différentes, sont justes, et la précédente ne change pas', () => {
  const s = copyOf(base.s), plan = base.ids.plans.lobby, { nodes } = base.ids;
  const prev = buildScene(s, plan, measure, P);
  const before = canonicalScene(prev), books = sceneBooks(prev);
  // Both add a part at the end of the shared columns: the second finds the end taken by the first, and copies.
  const first = run(s, connect(s, { plan, members: [{ node: nodes.mdl, role: 'source' }, { node: nodes.monde, role: 'target' }] }));
  const one = updateScene(prev, s, first.ops, measure, P).scene, oneExpected = canonicalScene(buildScene(s, plan, measure, P));
  // Its books checked while the state is its own: a scene finds identifiers through the state's rows (R of the task).
  expect(slotProblem(one)).toBeNull();
  applyOps(s, invertAction(first).ops);
  const second = run(s, connect(s, { plan, members: [{ node: nodes.occam, role: 'source' }, { node: nodes.biais, role: 'target' }] }));
  const two = updateScene(prev, s, second.ops, measure, P).scene;
  expect(canonicalScene(two)).toEqual(canonicalScene(buildScene(s, plan, measure, P)));
  // The first, untouched by the second (which found the end of the shared columns taken, and copied them).
  expect(canonicalScene(one)).toEqual(oneExpected);
  expect([slotProblem(two), slotProblem(prev)]).toEqual([null, null]);
  expect(canonicalScene(prev)).toEqual(before);
  expect(sceneBooks(prev)).toEqual(books);
});

test('un fantôme dont le « of » et la connexion changent (une opération reçue, plan 5) est redessiné en entier', () => {
  const s = copyOf(base.s), plan = base.ids.plans.lobby;
  const sc = buildScene(s, plan, measure, P);
  const ph = s.phantoms.get(base.ids.phantoms.node)!;
  // It now stands for another member, as absent, in another connection of that member.
  const other = s.connections.get(base.ids.connections.mdlSolomonoff)!;
  const after = { ...ph, connection: other.id, of: { kind: 'absent' as const, node: other.members[1].node } };
  const op: Op = { t: 'phantom', before: ph, after };
  applyOps(s, [op]);
  const { scene } = updateScene(sc, s, [op], measure, P);
  const it = scene.items[scene.byId.get(ph.id)!];
  expect([it.node, it.phantom, it.connection]).toEqual([after.of.node, 'absent', other.id]);
  expect(canonicalScene(scene)).toEqual(canonicalScene(buildScene(s, plan, measure, P)));
  expect(slotProblem(scene)).toBeNull();
});
