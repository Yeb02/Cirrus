import {
  type Action, applyOp, applyOps, combine, CommandError, connect, connId, connKind, createNode, createPlan, deleteEverywhere, directGroup, editNode, emptyState,
  exclude, groupMembers, type Id, include, invertAction, KNOWLEDGE, memberOf, moveNodes, nodeId, nodeRow, planRow, removeFromPlan, setLayout, splitArm, type State,
} from '@cirrus/core';
import { buildLargeState, forceGc } from '@cirrus/fixtures';
import { expect, test } from 'vitest';
import { copyClip, pasteSteps } from '../src/clip.ts';
import { intruders } from '../src/edit.ts';
import { buildFrame } from '../src/frame.ts';
import { buildHitIndex } from '../src/hit.ts';
import { buildScene, isLive, type PlanScene } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { buildIndex, computeVisible } from '../src/visibility.ts';
import { canonicalScene, measure, P, rng } from './helpers.ts';

// Costs at the scale the spec aims for (spec 21), on the bench's synthetic base: what runs at every edit must not
// grow with the square of the plan (C1 of the plan 3b review: intruders took 15 s at 50 000 nodes). The view's timed
// tests are all in this file, run one after the other (plan 3c, global constraints).

/** One plan, 10 000 nodes in 100 groups laid out on a grid, 50 000 local knowledge connections. */
function large(): State {
  const N = 10_000, G = 100, C = 50_000;
  const s = emptyState();
  applyOp(s, { t: 'plan', before: null, after: { id: 'p', name: 'Lobby', type: 'lobby' } });
  const node = (id: string, x: number, y: number, k: number) => {
    applyOp(s, { t: 'node', before: null, after: { id, title: `Nœud ${id}`, summary: '', tags: [], files: [] } });
    applyOp(s, { t: 'placement', before: null, after: { plan: 'p', node: id, x, y, k } });
  };
  const link = (id: string, kind: 'inclusion' | 'knowledge', a: string, b: string) => {
    applyOp(s, { t: 'connection', before: null, after: { id, kind, title: '', relation: '', tags: [], members: [{ node: a, role: 'source' }, { node: b, role: 'target' }] } });
    for (const n of [a, b]) applyOp(s, { t: 'branch', key: { plan: 'p', connection: id, node: n }, before: false, after: true });
  };
  // Group g sits in a 10×10 grid of cells 4000 wide; its 99 members on a 10×10 grid inside the cell.
  for (let g = 0; g < G; g++) node(`n${g}`, (g % 10) * 4000, Math.floor(g / 10) * 4000, 2);
  for (let i = G; i < N; i++) {
    const g = i % G, j = Math.floor(i / G);
    node(`n${i}`, (g % 10) * 4000 + (j % 10) * 300, Math.floor(g / 10) * 4000 + Math.floor(j / 10) * 300, 0);
    link(`inc${i}`, 'inclusion', `n${i}`, `n${g}`);
  }
  for (let i = 0; i < C; i++) {
    const a = G + (i * 7919) % (N - G);
    const b = (i % 5 === 0) ? G + (i * 104729 + 1) % (N - G) : G + ((a - G + G * (1 + (i % 3))) % (N - G));
    if (a !== b) link(`c${i}`, 'knowledge', `n${a}`, `n${b}`);
  }
  return s;
}

/**
 * The best of five runs after two to warm up (T3 of the registry): the machine is shared, and whatever else it does only
 * adds to a run; a cost that grew with the base would show in every run.
 */
function best<T>(fn: () => T): { ms: number; out: T } {
  let out = fn();
  out = fn();
  let ms = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    out = fn();
    ms = Math.min(ms, performance.now() - t);
  }
  return { ms, out };
}

test('grande base : scène, index, visibilité, cadre et survol rapides (10 000 nœuds, 50 000 connexions)', () => {
  const s = large();
  const built = best(() => { const scene = buildScene(s, 'p', measure, P); return { scene, index: buildIndex(scene, P) }; });
  const { scene, index } = built.out;
  expect(scene.items).toHaveLength(10_000);
  for (const [zoom, x, y] of [[0.02, 18000, 18000], [0.3, 18000, 18000], [1, 4000, 4000]] as const) {
    const cam = { x, y, zoom, widthPx: 2560, heightPx: 1600 };
    const frame = best(() => {
      const visible = computeVisible(scene, index, cam, P);
      buildHitIndex(scene, visible, buildFrame(scene, visible, cam, { x, y }, P), { x, y }, P);
      return visible;
    });
    expect(frame.ms, `zoom ${zoom}: ${frame.out.connections.length} connexions visibles`).toBeLessThan(400);
  }
  expect(built.ms).toBeLessThan(1500);
}, 120_000);

test('les intrus d’une scène de 20 000 nœuds se trouvent en moins de 150 ms', () => {
  const { state, lobby } = buildLargeState({ seed: 3, nodes: 20_000, connections: 20_000 });
  const scene = buildScene(state, lobby, measure, P);
  const t0 = performance.now();
  const found = intruders(scene);
  const ms = performance.now() - t0;
  expect(found.size).toBeGreaterThanOrEqual(0);
  expect(ms).toBeLessThan(150);
});

/** The scene of the lobby of the reference base, measured on 2026-11-03 (object model): 283 MB. */
const SCENE_STEP0_BYTES = 283e6;
/**
 * The plan aims at 400 ms to build the lobby's scene (3.8 s before): 394 ms at best, 430–550 ms usually, measured while
 * the user's programs held 7 to 9 logical processors of 16. The gate is three times the best measure (R12, R15 of
 * the registry); the target stays the plan's.
 */
const BUILD_CEILING_MS = 1200;
/** The JS heap and the typed arrays' buffers, after two full collections. */
const memory = () => { forceGc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
const show = (what: string, ms: number) => { if (process.env.CIRRUS_COSTS) console.log(`${what} ${ms.toFixed(3)} ms`); };

let ref: { s: State; lobby: Id; scene: PlanScene } | null = null;
/** The reference base and its lobby's scene, built once for the tests below. */
function reference(): { s: State; lobby: Id; scene: PlanScene } {
  if (!ref) {
    const { state: s, lobby } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
    ref = { s, lobby, scene: buildScene(s, lobby, measure, P) };
  }
  return ref;
}

test('base de référence : la scène du lobby se construit d’un passage (cible 400 ms) et tient en 30 % de la mesure du 2026-11-03', () => {
  const { s, lobby } = reference();
  const built = best(() => buildScene(s, lobby, measure, P));
  const before = memory();
  const scene = buildScene(s, lobby, measure, P);
  const bytes = memory() - before;
  show('buildScene', built.ms);
  if (process.env.CIRRUS_COSTS) console.log(`tas de la scène ${(bytes / 1e6).toFixed(1)} Mo (${scene.items.length} éléments, ${scene.partCount} parties)`);
  expect(scene.partCount).toBeGreaterThan(500_000);
  expect(built.ms).toBeLessThan(BUILD_CEILING_MS);
  expect(bytes).toBeLessThan(0.3 * SCENE_STEP0_BYTES);
}, 180_000);

/**
 * The best of seven updates after two to warm up, for the action and for its undo (Review Focus 1: an inverse action
 * goes the same way): the action is applied and the scene updated (timed), then the action undone and the scene
 * updated again (timed), so that every pass starts from the same state.
 */
function cost(s: State, scene: PlanScene, a: Action): { ms: number; undoMs: number; scene: PlanScene } {
  const undo = invertAction(a);
  let sc = scene, best = Infinity, bestUndo = Infinity;
  for (let i = 0; i < 9; i++) {
    applyOps(s, a.ops);
    let t = performance.now();
    const r = updateScene(sc, s, a.ops, measure, P);
    const ms = performance.now() - t;
    applyOps(s, undo.ops);
    t = performance.now();
    const back = updateScene(r.scene, s, undo.ops, measure, P);
    const undoMs = performance.now() - t;
    if (i >= 2) { best = Math.min(best, ms); bestUndo = Math.min(bestUndo, undoMs); }
    expect([r.changes.full, back.changes.full]).toEqual([false, false]);
    sc = back.scene;
  }
  return { ms: best, undoMs: bestUndo, scene: sc };
}

test('base de référence : updateScene coûte ce que l’action touche, pas la taille de la base', () => {
  const { s, lobby } = reference();
  let { scene } = reference();
  const p = planRow(s, lobby);
  // Two leaves in different groups; a group of at least 200 elements with its content, not too large.
  let leaf = -1, far = -1;
  for (let n = 0; n < scene.itemOfNode.length && far < 0; n++) {
    const g = directGroup(s, p, n);
    if (g < 0 || groupMembers(s, p, n).length > 0) continue;
    if (leaf < 0) leaf = n;
    else if (g !== directGroup(s, p, leaf)) far = n;
  }
  const subtree = (i: number): number => scene.items[i].children.reduce((a, c) => a + subtree(c), 1);
  let big = -1;
  scene.items.forEach((it, i) => { if (isLive(scene, i) && it.kind === 'group' && subtree(i) >= 200 && (big < 0 || subtree(i) < subtree(big))) big = i; });
  const node = nodeId(s, leaf), other = nodeId(s, far), group = nodeId(s, directGroup(s, p, far));
  const costs: Record<string, number> = {}, undos: Record<string, number> = {};
  const time = (name: string, a: Action) => {
    const c = cost(s, scene, a);
    costs[name] = c.ms;
    undos[name] = c.undoMs;
    scene = c.scene;
    show(name, c.ms);
    show(`  son annulation`, c.undoMs);
  };
  time('déplacement', moveNodes(s, lobby, [{ node, x: 1, y: 2 }]));
  time('renommage', editNode(s, node, { title: 'Un titre renommé, plus long que le précédent' }));
  time('création', createNode(s, { plan: lobby, title: 'Nouveau', x: 0, y: 0, k: 0 }));
  time('connexion', connect(s, { plan: lobby, members: [{ node, role: 'source' }, { node: other, role: 'target' }] }));
  time('inclusion', include(s, lobby, node, group));
  // The group and everything it contains, deepest first, out of the lobby (« ici, avec le contenu »).
  const content: number[] = [];
  const take = (i: number) => { content.push(i); for (const c of scene.items[i].children) take(c); };
  take(big);
  const ids = content.sort((a, b) => scene.items[b].depth - scene.items[a].depth).filter((i) => scene.items[i].kind !== 'phantom').map((i) => scene.items[i].id);
  time(`suppression d’un groupe de ${content.length} éléments`, combine(s, 'Supprimer', ids.map((id) => (x: State) => removeFromPlan(x, lobby, id))));
  // Other inverse paths that free rows or bring many back: a node deleted everywhere, a paste into another plan.
  time('suppression partout', deleteEverywhere(s, other));
  const second = createPlan(s, 'Second', 'plan');
  applyOps(s, second.ops);
  const plan2 = (second.ops[0] as { after: { id: Id } }).after.id;
  const clip = copyClip(s, scene, [scene.byId.get(node)!, scene.byId.get(other)!], 1)!;
  time('collage dans un autre plan', combine(s, 'Coller', pasteSteps(s, clip, plan2, { x: 0, y: 0 }, 1, null, P).steps));
  expect(content.length).toBeGreaterThanOrEqual(200);
  // The brief's thresholds, for the action and for its undo alike; a node deleted everywhere (no threshold in the brief:
  // three times its measure, 2.4–2.7 ms) so that neither falls into a scan of the plan unseen.
  const limits: Record<string, number> = {
    déplacement: 1, renommage: 1, création: 2, connexion: 2, inclusion: 5, [`suppression d’un groupe de ${content.length} éléments`]: 20, 'suppression partout': 8,
  };
  // Two undos sit near the brief's threshold on a loaded machine (connection 1.6–1.8 ms, group 14.7–19.1 ms): their
  // gate is three times the best measure (R24), the threshold stays the target in the registry.
  const undoLimits: Record<string, number> = { ...limits, connexion: 5, [`suppression d’un groupe de ${content.length} éléments`]: 45 };
  for (const [name, limit] of Object.entries(limits)) {
    expect(costs[name], name).toBeLessThanOrEqual(limit);
    expect(undos[name], `annulation : ${name}`).toBeLessThanOrEqual(undoLimits[name]);
  }
  ref!.scene = scene;
}, 180_000);

test('base de référence : après 30 actions, la scène mise à jour égale la scène reconstruite', () => {
  const { s, lobby } = reference();
  let { scene } = reference();
  const r = rng(23), rows = scene.itemOfNode.length;
  const node = (): Id => { for (;;) { const id = nodeId(s, Math.floor(r() * rows)); if (id && s.placements.has(`${lobby}|${id}`)) return id; } };
  const at = () => ({ x: Math.round(r() * 1e5), y: Math.round(r() * 1e5) });
  /** One of the node's knowledge connections. */
  const knowledgeOf = (n: Id): Id => {
    const c = [...memberOf(s, nodeRow(s, n))].find((x) => connKind(s, x) === KNOWLEDGE);
    if (c === undefined) throw new CommandError('aucune connexion');
    return connId(s, c);
  };
  let second: Id | null = null;
  const commands: (() => Action)[] = [
    () => moveNodes(s, lobby, [{ node: node(), ...at() }]),
    () => moveNodes(s, lobby, [{ node: node(), k: Math.floor(r() * 4) }]),
    () => editNode(s, node(), { title: r() < 0.5 ? 'Court' : 'Un titre bien plus long que la largeur d’une boîte de nœud' }),
    () => createNode(s, { plan: lobby, title: 'Nouveau', ...at(), k: 0 }),
    () => connect(s, { plan: lobby, members: [{ node: node(), role: 'source' }, { node: node(), role: 'target' }] }),
    () => include(s, lobby, node(), node()),
    () => exclude(s, lobby, node()),
    () => removeFromPlan(s, lobby, node()),
    () => { const n = node(); return splitArm(s, lobby, knowledgeOf(n), n, { ...at(), k: 0 }, { ...at(), k: 0 }); },
    () => setLayout(s, lobby, knowledgeOf(node()), { handles: {}, marker: at() }),
    () => {
      // Pasted into a second plan: the lobby's scene follows the inclusions and branches written there (Review Focus 2).
      if (!second) { const a = createPlan(s, 'Second', 'plan'); second = (a.ops[0] as { after: { id: Id } }).after.id; return a; }
      const clip = copyClip(s, scene, [scene.byId.get(node())!, scene.byId.get(node())!], 1)!;
      return combine(s, 'Coller', pasteSteps(s, clip, second, at(), 1, null, P).steps);
    },
  ];
  let applied = 0;
  for (let i = 0; i < 60 && applied < 30; i++) {
    let a: Action;
    try { a = commands[Math.floor(r() * commands.length)](); } catch (e) { if (e instanceof CommandError) continue; throw e; }
    applyOps(s, a.ops);
    scene = updateScene(scene, s, a.ops, measure, P).scene;
    applied++;
  }
  expect(applied).toBe(30);
  expect(canonicalScene(scene)).toEqual(canonicalScene(buildScene(s, lobby, measure, P)));
}, 600_000);
