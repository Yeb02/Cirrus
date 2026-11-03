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
import { canonicalScene, copyOf, created, fixture, measure, P, rng, run, sceneBooks, slotProblem } from './helpers.ts';

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

/** A pick that makes no sense here (an empty plan, a connection without members): no action of that kind this time. */
class Skip extends Error {}
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Skip();
  return v;
};

/** The kinds the brief lists, that the 300 actions must each make at least once. */
const KINDS = [
  'déplacement', 'renommage', 'création', 'connexion', 'inclusion', 'exclusion', 'retrait d’un plan', 'suppression partout', 'scission de bras',
  'réunion de bras', 'amorce placée', 'disposition', 'collage',
];

/**
 * The core's commands and pasteSteps, on nodes, connections and phantoms picked at random among those of the test base
 * (and those the actions make), in every plan: what the interface can do. A refusal of the core (CommandError) is a
 * menu choice refused; any other error fails the test.
 */
function randomActions(s: State, r: () => number): () => { kind: string; action: Action } | null {
  const pick = <T>(xs: readonly T[]): T => need(xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]);
  const plans = () => [...s.plans.keys()];
  const nodes = () => [...s.nodes.keys()];
  const placed = (plan: Id) => [...s.placements.values()].filter((pl) => pl.plan === plan).map((pl) => pl.node);
  const conns = () => [...s.connections.keys()];
  const membersOf = (c: Id) => need(s.connections.get(c)).members;
  const phantoms = () => [...s.phantoms.values()];
  const roles: Role[] = ['source', 'target', 'associate'];
  const titles = ['Court', 'Un titre un peu plus long que la boîte', 'Encore un titre vraiment très long qui prend trois lignes au moins, sinon plus'];
  const at = () => ({ x: Math.round(r() * 2000 - 1000), y: Math.round(r() * 1400 - 700) });
  const commands: [string, () => Action][] = [
    ['déplacement', () => { const plan = pick(plans()); return moveNodes(s, plan, [{ node: pick(placed(plan)), ...at() }]); }],
    ['cran', () => { const plan = pick(plans()), node = pick(placed(plan)); return moveNodes(s, plan, [{ node, k: Math.floor(r() * 5) - 1 }]); }],
    ['renommage', () => editNode(s, pick(nodes()), { title: pick(titles) })],
    ['création', () => createNode(s, { plan: pick(plans()), title: pick(titles), ...at(), k: Math.floor(r() * 3) })],
    ['connexion', () => {
      const plan = pick(plans()), ns = placed(plan);
      return connect(s, { plan, members: [...new Set([pick(ns), pick(ns), pick(ns)])].map((node) => ({ node, role: pick(roles) })) });
    }],
    ['membre ajouté', () => addMember(s, pick(plans()), pick(conns()), { node: pick(nodes()), role: pick(roles) })],
    ['membre retiré', () => removeMember(s, pick(conns()), pick(nodes()))],
    ['titre de connexion', () => editConnection(s, pick(conns()), { title: pick(['', 'relie', 'un titre de connexion']) })],
    ['rôle', () => { const c = pick(conns()); return setRole(s, c, pick(membersOf(c)).node, pick(roles)); }],
    ['inclusion', () => { const plan = pick(plans()), ns = placed(plan); return include(s, plan, pick(ns), pick(ns)); }],
    ['exclusion', () => { const plan = pick(plans()); return exclude(s, plan, pick(placed(plan))); }],
    ['retrait d’un plan', () => { const plan = pick(plans()); return removeFromPlan(s, plan, pick(placed(plan))); }],
    ['placement', () => placeNode(s, pick(plans()), pick(nodes()), at().x, at().y, 0)],
    ['suppression partout', () => deleteEverywhere(s, pick(nodes()))],
    ['restauration', () => restoreNode(s, pick(nodes()), pick(plans()), at().x, at().y, 0)],
    ['branches', () => { const c = pick(conns()); return setBranches(s, c, [{ plan: pick(plans()), node: pick(membersOf(c)).node }], r() < 0.5); }],
    ['scission de bras', () => {
      const b = pick([...s.branches]);
      return splitArm(s, b.plan, b.connection, b.node, { ...at(), k: 0 }, { ...at(), k: Math.floor(r() * 2) });
    }],
    ['réunion de bras', () => { const ph = pick(phantoms().filter((x) => x.of.kind !== 'absent')); return joinArm(s, ph.plan, ph.connection, ph.of.node); }],
    ['amorce placée', () => {
      const b = pick([...s.branches].filter((x) => !s.placements.has(`${x.plan}|${x.node}`)));
      return placeAbsent(s, b.plan, b.connection, b.node, at().x, at().y, 0);
    }],
    ['fantôme déplacé', () => {
      const ph = pick(phantoms()), groups = placed(ph.plan);
      return movePhantom(s, ph.id, at().x, at().y, r() < 0.3 && groups.length > 0 ? pick(groups) : r() < 0.5 ? null : undefined, r() < 0.3 ? ph.k + 1 : undefined);
    }],
    ['disposition', () => {
      const plan = pick(plans()), c = pick(conns());
      const handles = Object.fromEntries(membersOf(c).slice(0, 2).map((m) => [m.node, { b1: at(), b2: at() }]));
      const reset = r() < 0.3 && s.connLayouts.has(layoutKey(plan, c));
      return setLayout(s, plan, c, reset ? null : { handles, ...(r() < 0.5 ? { marker: at() } : {}), ...(r() < 0.5 ? { angle: r() * 3 } : {}) });
    }],
    ['connexion supprimée', () => deleteConnection(s, pick(conns()))],
    ['collage', () => {
      // Copied from one plan, pasted into another (spec 7): a group with its content, the connections that follow.
      const from = pick(plans()), to = pick(plans()), sc = buildScene(s, from, measure, P);
      if (sc.items.length === 0) throw new Skip();
      const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * sc.items.length)).filter((i) => isLive(sc, i));
      const clip = need(copyClip(s, sc, items, 1) ?? undefined);
      return combine(s, 'Coller', pasteSteps(s, clip, to, at(), 1, null, P).steps);
    }],
    ['répercussion', () => {
      // « Partout » (spec 10): one node changes group in two plans at once.
      const [p1, p2] = [pick(plans()), pick(plans())], node = pick(placed(p1)), group = pick(placed(p1));
      return combine(s, 'Répercuter', [(x) => include(x, p1, node, group), (x) => include(x, p2, node, group)]);
    }],
    ['plan créé', () => createPlan(s, 'Nouveau', pick(['plan', 'document'] as const))],
  ];
  return () => {
    const [kind, command] = pick(commands);
    try {
      return { kind, action: command() };
    } catch (e) {
      if (e instanceof CommandError || e instanceof Skip) return null;
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
