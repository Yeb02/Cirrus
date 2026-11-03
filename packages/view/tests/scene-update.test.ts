import {
  type Action, addMember, applyOps, combine, CommandError, connect, createNode, createPlan, deleteConnection, deleteEverywhere, editConnection, editNode, exclude,
  type Id, include, invertAction, joinArm, layoutKey, moveNodes, movePhantom, type Op, placeAbsent, placeNode, removeFromPlan, removeMember, restoreNode, type Role,
  setBranches, setLayout, setRole, splitArm, type State,
} from '@cirrus/core';
import { describe, expect, test } from 'vitest';
import { copyClip, pasteSteps } from '../src/clip.ts';
import { DEFAULT_PARAMS, type RenderParams } from '../src/params.ts';
import { buildScene, isLive, partEnds, partOf, type PlanScene } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { canonicalScene, copyOf, created, fixture, measure, P, rng, run, slotProblem } from './helpers.ts';

const base = fixture();

/** Every cached scene follows an action (Review Focus 2), and must show what a scene built anew shows. */
function follow(s: State, scenes: Map<Id, PlanScene>, ops: Op[], p: RenderParams, what: string): void {
  for (const plan of s.plans.keys()) {
    const prev = scenes.get(plan);
    if (!prev) { scenes.set(plan, buildScene(s, plan, measure, p)); continue; }
    const before = canonicalScene(prev);
    const { scene } = updateScene(prev, s, ops, measure, p);
    // The previous scene stays valid for a gesture that holds it: its columns are copied before being written.
    expect(canonicalScene(prev), `${what} : la scène précédente de ${s.plans.get(plan)!.name} a changé`).toEqual(before);
    expect(canonicalScene(scene), `${what}, plan ${s.plans.get(plan)!.name}`).toEqual(canonicalScene(buildScene(s, plan, measure, p)));
    expect(slotProblem(scene), `${what}, plan ${s.plans.get(plan)!.name}`).toBeNull();
    scenes.set(plan, scene);
  }
}

/**
 * The core's commands and pasteSteps, on nodes, connections and phantoms picked at random among those of the test base
 * (and those the actions make), in every plan: what the interface can do.
 */
function randomActions(s: State, r: () => number): () => Action | null {
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]);
  const plans = () => [...s.plans.keys()];
  const nodes = () => [...s.nodes.keys()];
  const placed = (plan: Id) => [...s.placements.values()].filter((pl) => pl.plan === plan).map((pl) => pl.node);
  const conns = () => [...s.connections.keys()];
  const phantoms = () => [...s.phantoms.values()];
  const roles: Role[] = ['source', 'target', 'associate'];
  const titles = ['Court', 'Un titre un peu plus long que la boîte', 'Encore un titre vraiment très long qui prend trois lignes au moins, sinon plus'];
  const at = () => ({ x: Math.round(r() * 2000 - 1000), y: Math.round(r() * 1400 - 700) });
  const commands: (() => Action)[] = [
    () => { const plan = pick(plans())!; return moveNodes(s, plan, [{ node: pick(placed(plan))!, ...at() }]); },
    () => { const plan = pick(plans())!, node = pick(placed(plan))!; return moveNodes(s, plan, [{ node, k: Math.floor(r() * 5) - 1 }]); },
    () => editNode(s, pick(nodes())!, { title: pick(titles)! }),
    () => createNode(s, { plan: pick(plans())!, title: pick(titles)!, ...at(), k: Math.floor(r() * 3) }),
    () => { const plan = pick(plans())!, ns = placed(plan); return connect(s, { plan, members: [...new Set([pick(ns)!, pick(ns)!, pick(ns)!])].map((node) => ({ node, role: pick(roles)! })) }); },
    () => addMember(s, pick(plans())!, pick(conns())!, { node: pick(nodes())!, role: pick(roles)! }),
    () => removeMember(s, pick(conns())!, pick(nodes())!),
    () => editConnection(s, pick(conns())!, { title: pick(['', 'relie', 'un titre de connexion'])! }),
    () => { const c = pick(conns())!; return setRole(s, c, pick(s.connections.get(c)!.members)!.node, pick(roles)!); },
    () => { const plan = pick(plans())!, ns = placed(plan); return include(s, plan, pick(ns)!, pick(ns)!); },
    () => { const plan = pick(plans())!; return exclude(s, plan, pick(placed(plan))!); },
    () => { const plan = pick(plans())!; return removeFromPlan(s, plan, pick(placed(plan))!); },
    () => placeNode(s, pick(plans())!, pick(nodes())!, at().x, at().y, 0),
    () => deleteEverywhere(s, pick(nodes())!),
    () => restoreNode(s, pick(nodes())!, pick(plans())!, at().x, at().y, 0),
    () => { const c = pick(conns())!; return setBranches(s, c, [{ plan: pick(plans())!, node: pick(s.connections.get(c)!.members)!.node }], r() < 0.5); },
    () => {
      const b = pick([...s.branches])!;
      return splitArm(s, b.plan, b.connection, b.node, { ...at(), k: 0 }, { ...at(), k: Math.floor(r() * 2) });
    },
    () => { const ph = pick(phantoms().filter((x) => x.of.kind !== 'absent'))!; return joinArm(s, ph.plan, ph.connection, ph.of.node); },
    () => { const b = pick([...s.branches].filter((x) => !s.placements.has(`${x.plan}|${x.node}`)))!; return placeAbsent(s, b.plan, b.connection, b.node, at().x, at().y, 0); },
    () => {
      const ph = pick(phantoms())!, groups = placed(ph.plan);
      return movePhantom(s, ph.id, at().x, at().y, r() < 0.3 ? pick(groups) : r() < 0.5 ? null : undefined, r() < 0.3 ? ph.k + 1 : undefined);
    },
    () => {
      const plan = pick(plans())!, c = pick(conns())!, members = s.connections.get(c)!.members;
      const handles = Object.fromEntries(members.slice(0, 2).map((m) => [m.node, { b1: at(), b2: at() }]));
      const reset = r() < 0.3 && s.connLayouts.has(layoutKey(plan, c));
      return setLayout(s, plan, c, reset ? null : { handles, ...(r() < 0.5 ? { marker: at() } : {}), ...(r() < 0.5 ? { angle: r() * 3 } : {}) });
    },
    () => deleteConnection(s, pick(conns())!),
    () => {
      // Copied from one plan, pasted into another (spec 7): a group with its content, the connections that follow.
      const from = pick(plans())!, to = pick(plans())!, sc = buildScene(s, from, measure, P);
      const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * sc.items.length)).filter((i) => isLive(sc, i));
      const clip = copyClip(s, sc, items, 1);
      if (!clip) throw new CommandError('rien à copier');
      return combine(s, 'Coller', pasteSteps(s, clip, to, at(), 1, null, P).steps);
    },
    () => {
      // « Partout » (spec 10): one node changes group in two plans at once.
      const [p1, p2] = [pick(plans())!, pick(plans())!], node = pick(placed(p1))!, group = pick(placed(p1))!;
      return combine(s, 'Répercuter', [(x) => include(x, p1, node, group), (x) => include(x, p2, node, group)]);
    },
    () => {
      const a = createPlan(s, 'Nouveau', pick(['plan', 'document'] as const)!);
      return a;
    },
  ];
  return () => {
    const command = pick(commands)!;
    try {
      return command();
    } catch (e) {
      // A pick that makes no sense (an absent node, a rule broken): refused like a menu choice would be.
      if (e instanceof CommandError || e instanceof TypeError) return null;
      throw e;
    }
  };
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
    let applied = 0;
    for (let i = 0; i < 300; i++) {
      const a = next();
      if (!a) continue;
      applyOps(s, a.ops);
      applied++;
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
    expect(applied).toBeGreaterThan(150);
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
