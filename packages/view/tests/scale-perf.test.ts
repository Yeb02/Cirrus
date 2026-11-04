import { readFileSync } from 'node:fs';
import {
  type Action, applyOp, applyOps, combine, CommandError, connect, connId, connKind, createNode, createPlan, deleteEverywhere, directGroup, editNode, emptyState,
  exclude, fromSnapshot, groupMembers, type Id, include, invertAction, KNOWLEDGE, memberOf, moveNodes, nodeId, nodeRow, planRow, removeFromPlan, setLayout, splitArm,
  type State, toSnapshot,
} from '@cirrus/core';
import { buildLargeState, forceGc } from '@cirrus/fixtures';
import { expect, test } from 'vitest';
import { benchPath, cameraAt } from '../src/benchPath.ts';
import type { Camera } from '../src/camera.ts';
import { copyClip, pasteSteps } from '../src/clip.ts';
import { intruders, visibleIntruders } from '../src/edit.ts';
import { buildHitIndex } from '../src/hit.ts';
import { type EnvelopeMeshes, newEnvelopeMeshes } from '../src/geometry/envelope.ts';
import { buildInstances, itemTexels, SIMPLE_INTS, SLOT_FLOATS } from '../src/instances.ts';
import { patchEdit, patchPreview, previewEnvelopes, previewSlots, previewSplit, type PreviewSplit, type Shown } from '../src/preview.ts';
import { buildScene, isLive, type PlanScene, withOffsets } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { GLYPH_FLOATS, parseBmFont } from '../src/text.ts';
import { buildIndex, computeVisible, updateIndex } from '../src/visibility.ts';
import { bruteVisible, canonicalScene, indexContent, measure, P, rng, visibleDifference } from './helpers.ts';

// Costs at the scale the spec aims for (spec 21), on the bench's synthetic base: what runs at every edit must not
// grow with the square of the plan (C1 of the plan 3b review: intruders took 15 s at 50 000 nodes). The view's timed
// tests are all in this file, run one after the other (plan 3c, global constraints).

/** The app's MSDF font: the instances' costs include the titles' glyphs (plan 3c task 8). */
const font = parseBmFont(readFileSync(new URL('../../app/src/renderer/public/font/inter-msdf.fnt', import.meta.url), 'utf8'));

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
 * adds to a run; a cost that grew with the base would show in every run. More of each for a cost made of allocations.
 */
function best<T>(fn: () => T, warm = 2, runs = 5): { ms: number; out: T } {
  let out = fn();
  for (let i = 1; i < warm; i++) out = fn();
  let ms = Infinity;
  for (let i = 0; i < runs; i++) {
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
      buildHitIndex(scene, visible, buildInstances(scene, visible, cam, { x, y }, P, undefined, font), P);
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

// ———— Visibility (plan 3c, task 6)

/** The screen of the view's tests (camAtTextPx). */
const W = 2560, H = 1600;
/**
 * The plan aims at 5 ms for the flat plan seen whole and 150 ms for buildIndex on the reference lobby: 5.1 and 110 ms at
 * best (machine quiet for a while), 6.8–7.9 and 137 ms in this file while the user's programs held 9 logical
 * processors of 16. The gates are three times the best measures (R12, R15, R20, R24 of the registry); the targets stay
 * the plan's.
 */
const FLAT_CEILING_MS = 15, INDEX_CEILING_MS = 330;

/**
 * A flat plan of 20 000 placed nodes: the generator's base of 20 000 nodes and 20 000 connections (buildLargeState), its
 * inclusions left out — every node, phantom and connection at the top level. Measured on its own, before the reference
 * base is built (the registry also gives its cost with that base in memory).
 */
function flatScene(): PlanScene {
  const { state, lobby } = buildLargeState({ seed: 1, nodes: 20_000, connections: 20_000 });
  const snap = toSnapshot(state), inclusions = new Set(snap.connections.filter((c) => c.kind === 'inclusion').map((c) => c.id));
  const flat = fromSnapshot({ ...snap, connections: snap.connections.filter((c) => !inclusions.has(c.id)), branches: snap.branches.filter(([, c]) => !inclusions.has(c)) });
  return buildScene(flat, lobby, measure, P);
}

// The flat-plan tests run before the first reference() test below: with the reference base resident (≈ 1 GB of heap),
// the same pass measures 13 to 17 ms instead of 5 to 8 (registry, R26). Keep any flat-plan test above them.
let flat: { scene: PlanScene; cam: Camera } | null = null;
const flatPlan = () => {
  if (!flat) {
    const scene = flatScene(), b = scene.bounds!;
    flat = { scene, cam: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom: Math.min(W / (b.maxX - b.minX), H / (b.maxY - b.minY)), widthPx: W, heightPx: H } };
  }
  return flat;
};

test('plan plat de 20 000 nœuds vu en entier : visible sans balayage (cible 5 ms)', () => {
  const { scene, cam } = flatPlan(), index = buildIndex(scene, P);
  // 20 861 connections seen: the set itself is ≈ 100 000 objects, whose allocation is most of the cost (≈ 3 ms of it
  // measured alone); the best of fifteen after ten, as the view meets it once its code is optimized.
  const r = best(() => computeVisible(scene, index, cam, P), 10, 15);
  show(`computeVisible, plan plat (${r.out.items.length} éléments, ${r.out.connections.length} connexions)`, r.ms);
  expect(scene.items.filter((it) => it.kind === 'node')).toHaveLength(20_000);
  expect(r.out.groups).toEqual([]);
  expect(r.out.items).toHaveLength(scene.items.length);
  expect(r.out.connections.length).toBeGreaterThan(15_000);
  expect(r.ms).toBeLessThanOrEqual(FLAT_CEILING_MS);
}, 120_000);

/**
 * The plan aims at 4 ms for the flat plan's instances (852 ms for buildFrame before), 3 ms per camera of the path and
 * 3 ms for the whole item texture: 3.5, 2.5 and 1.9 ms at best on a quiet machine, 3.8–4.7, 2.4–3.0 and 2.3–3.3 ms
 * while the user's programs held most processors, 6.7 ms for the flat plan in the full suite. The gates are about
 * three times the best measures (R12, R15, R26 of the registry); the targets stay the plan's.
 */
const FLAT_INSTANCES_CEILING_MS = 11, PATH_INSTANCES_CEILING_MS = 8, TEXELS_CEILING_MS = 7;

test('plan plat de 20 000 nœuds vu en entier : ses instances, titres compris (cible 4 ms)', () => {
  const { scene, cam } = flatPlan(), visible = computeVisible(scene, buildIndex(scene, P), cam, P);
  // Refilling the storage of the previous rebuild, as the renderer does.
  const reuse = buildInstances(scene, visible, cam, cam, P, undefined, font);
  const r = best(() => buildInstances(scene, visible, cam, cam, P, undefined, font, undefined, reuse), 10, 15);
  show(`buildInstances, plan plat (${r.out.simple.length / SIMPLE_INTS} simples, ${r.out.markers.length} faisceaux complexes)`, r.ms);
  expect(r.out.simple.length / SIMPLE_INTS).toBeGreaterThan(15_000);
  expect(r.out.pending).toBe(false);
  expect(r.ms).toBeLessThanOrEqual(FLAT_INSTANCES_CEILING_MS);
}, 120_000);

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

// ———— Visibility on the reference lobby as built, before the tests below change it

/** The cameras of the bench's path (benchPath, as the app's bench drives it), every `dt` seconds of it. */
function pathCameras(scene: PlanScene, dt: number): Camera[] {
  const { keys } = benchPath(scene, W, H, P), end = keys[keys.length - 1].t, out: Camera[] = [];
  for (let k = 0; k * dt <= end + 1e-9; k++) out.push({ ...cameraAt(keys, k * dt), widthPx: W, heightPx: H });
  return out;
}

/** Cameras drawn at random on the lobby's items (its bounds are mostly empty), zooms log-uniform from its overview to 2. */
function itemCameras(scene: PlanScene, count: number, r: () => number): Camera[] {
  const live = scene.items.flatMap((_it, i) => (isLive(scene, i) ? [i] : []));
  return Array.from({ length: count }, () => {
    const it = scene.items[live[Math.floor(r() * live.length)]], zoom = P.zoomMin * (2 / P.zoomMin) ** r();
    return { x: it.x + (r() - 0.5) * W / zoom, y: it.y + (r() - 0.5) * H / zoom, zoom, widthPx: W, heightPx: H };
  });
}

test('base de référence : computeVisible égale la force brute de sa règle, sur 50 caméras tirées au hasard et sur le parcours du banc', () => {
  const { scene } = reference(), index = buildIndex(scene, P);
  const cams = [...itemCameras(scene, 50, rng(71)), ...pathCameras(scene, 0.5)];
  let parts = 0;
  for (const cam of cams) {
    const v = computeVisible(scene, index, cam, P);
    expect(visibleDifference(v, bruteVisible(scene, cam)), `caméra ${JSON.stringify(cam)}`).toBeNull();
    parts += v.connections.length;
  }
  expect(cams.length).toBeGreaterThan(120);
  expect(parts).toBeGreaterThan(1000);
}, 600_000);

test('base de référence : buildIndex d’un passage sur les éléments et les parties (cible 150 ms)', () => {
  const { scene } = reference();
  const built = best(() => buildIndex(scene, P));
  show('buildIndex', built.ms);
  expect(built.ms).toBeLessThanOrEqual(INDEX_CEILING_MS);
}, 120_000);

test('base de référence : visible et intrus du visible en 1 ms au plus à chaque caméra du parcours du banc', () => {
  const { scene } = reference(), index = buildIndex(scene, P), cams = pathCameras(scene, 1 / 60);
  let worst = 0, worstIntruders = 0, at = 0;
  for (const [k, cam] of cams.entries()) {
    let ms = Infinity, intrudersMs = Infinity, v = computeVisible(scene, index, cam, P);
    for (let i = 0; i < 3; i++) {
      let t = performance.now();
      v = computeVisible(scene, index, cam, P);
      ms = Math.min(ms, performance.now() - t);
      t = performance.now();
      visibleIntruders(scene, v);
      intrudersMs = Math.min(intrudersMs, performance.now() - t);
    }
    if (ms > worst) { worst = ms; at = k; }
    worstIntruders = Math.max(worstIntruders, intrudersMs);
  }
  show(`computeVisible, pire des ${cams.length} caméras (n° ${at})`, worst);
  show('visibleIntruders, pire caméra', worstIntruders);
  expect(cams.length).toBeGreaterThan(2000);
  expect(worst).toBeLessThanOrEqual(1);
  expect(worstIntruders).toBeLessThanOrEqual(1);
}, 120_000);

test('base de référence : les instances, titres compris, en 3 ms au plus à chaque caméra du parcours du banc', () => {
  const { scene } = reference(), index = buildIndex(scene, P), cams = pathCameras(scene, 1 / 60);
  let worst = 0, at = 0, glyphs = 0;
  const reuse = buildInstances(scene, computeVisible(scene, index, cams[0], P), cams[0], cams[0], P, undefined, font);
  for (const [k, cam] of cams.entries()) {
    const v = computeVisible(scene, index, cam, P);
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      buildInstances(scene, v, cam, cam, P, undefined, font, undefined, reuse);
      ms = Math.min(ms, performance.now() - t);
    }
    glyphs = Math.max(glyphs, reuse.texts.length);
    if (ms > worst) { worst = ms; at = k; }
  }
  show(`buildInstances, pire des ${cams.length} caméras (n° ${at}, ${glyphs / GLYPH_FLOATS} glyphes au plus)`, worst);
  expect(glyphs).toBeGreaterThan(0);
  expect(worst).toBeLessThanOrEqual(PATH_INSTANCES_CEILING_MS);
}, 300_000);

test('base de référence : la texture des éléments du lobby se remplit en 3 ms au plus', () => {
  const { scene } = reference(), out = new Float32Array(scene.items.length * SLOT_FLOATS);
  const r = best(() => itemTexels(scene, { x: 1e5, y: -3e4 }, out));
  show(`itemTexels complet (${scene.items.length} emplacements)`, r.ms);
  expect(out.some((v) => v !== 0)).toBe(true);
  expect(r.ms).toBeLessThanOrEqual(TEXELS_CEILING_MS);
}, 120_000);

// ———— Previews and edits through the item texture (plan 3c, task 9)

/**
 * One frame of a drag's preview as the renderer prepares it: the preview's scene (the previous one's storage taken
 * again), its texels, its instances patched in place, its groups' envelopes apart; the split is made once per drag.
 */
function previewFrame(shown: Shown, split: PreviewSplit, moving: number[], d: { x: number; y: number }, previous: PlanScene | undefined, texels: Float32Array, side: EnvelopeMeshes) {
  const base = shown.state, preview = withOffsets(base, new Map(moving.map((i) => [i, d])), P, previous);
  itemTexels(preview, shown.inst.origin, texels, previewSlots(base, preview, split));
  const patched = patchPreview(shown, preview, split, P);
  if (patched) previewEnvelopes(shown, preview, split, P, side);
  return { preview, patched };
}

/**
 * Sixty frames of a drag (3 px then 2 px a frame on screen), three times: each frame's best of three, then their
 * median and worst; and how many were done in place.
 */
function dragFrames(shown: Shown, moving: number[]): { median: number; worst: number; inPlace: number; split: PreviewSplit } {
  const split = previewSplit(shown.state, shown.visible, moving), texels = new Float32Array(shown.state.items.length * SLOT_FLOATS), side = newEnvelopeMeshes();
  const z = shown.cam.zoom, frames = 60, bestOf = new Array<number>(frames).fill(Infinity);
  let previous: PlanScene | undefined, inPlace = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let f = 0; f < frames; f++) {
      const t = performance.now();
      const r = previewFrame(shown, split, moving, { x: (3 * (f + 1)) / z, y: (2 * (f + 1)) / z }, previous, texels, side);
      const ms = performance.now() - t;
      previous = r.preview;
      if (pass > 0) bestOf[f] = Math.min(bestOf[f], ms);
      if (pass === 0 && r.patched) inPlace++;
    }
  }
  // Given up: back to the frame before, to the bit (Review Focus 5).
  expect(patchPreview(shown, shown.state, split, P)).not.toBeNull();
  const sorted = [...bestOf].sort((a, b) => a - b);
  return { median: sorted[frames >> 1], worst: sorted[frames - 1], inPlace, split };
}

/**
 * The plan aims at 0.5 ms for a frame of a leaf's drag and 3 ms for a group of 200 elements, at the bench's deepest
 * camera (121 ms before at the bench, the index built and the texture written whole at each frame): 0.44–0.57 and
 * 0.39 ms (medians) while the user's programs held about half the processors. The gates are about three times the
 * measures (R12, R15 of the registry); the targets stay the plan's.
 */
const LEAF_PREVIEW_CEILING_MS = 1.5, GROUP_PREVIEW_CEILING_MS = 1.2;

test('base de référence : une image d’aperçu de glissement se prépare en 0,5 ms pour une feuille, en 3 ms pour un groupe de 200 éléments, à la caméra profonde', () => {
  const { scene } = reference(), index = buildIndex(scene, P), deep = benchPath(scene, W, H, P).deep!;
  const shownAt = (x: number, y: number): Shown => {
    const cam = { x, y, zoom: deep.zoom, widthPx: W, heightPx: H }, visible = computeVisible(scene, index, cam, P);
    return { scene, base: scene, state: scene, visible, cam, inst: buildInstances(scene, visible, cam, { x, y }, P, undefined, font, new Map()) };
  };
  // The leaf drawn whose visible connections number nearest 20, near the deep camera.
  const atDeep = shownAt(deep.x, deep.y), degree = new Map<number, number>();
  for (const vc of atDeep.visible.connections) for (const e of vc.ends) degree.set(e.item, (degree.get(e.item) ?? 0) + 1);
  const leaves = atDeep.visible.items.filter((i) => scene.items[i].kind === 'node' && scene.items[i].parent >= 0);
  const leaf = leaves.reduce((a, b) => (Math.abs((degree.get(b) ?? 0) - 20) < Math.abs((degree.get(a) ?? 0) - 20) ? b : a));
  const before = structuredClone([...atDeep.inst.curves.view(), ...atDeep.inst.texts.view()]);
  const l = dragFrames(atDeep, [leaf]);
  expect(structuredClone([...atDeep.inst.curves.view(), ...atDeep.inst.texts.view()])).toEqual(before);
  const sizes = (x: PreviewSplit) => `${x.items.length} éléments, ${x.groups.length} groupes, ${x.complex.length} faisceaux complexes et ${x.simple.length} simples réécrits`;
  show(`image d’aperçu, feuille de ${degree.get(leaf)} connexions visibles (${sizes(l.split)} ; médiane, ${l.inPlace} sur 60 en place)`, l.median);
  show('  la pire', l.worst);
  // The smallest group of at least 200 elements, the camera at the deep zoom on its deepest leaf: what it holds there is
  // drawn (on its own centre, the deep zoom shows none of it).
  const subtree = (i: number): number => scene.items[i].children.reduce((a, c) => a + subtree(c), 1);
  let big = -1;
  scene.items.forEach((it, i) => { if (isLive(scene, i) && it.kind === 'group' && subtree(i) >= 200 && (big < 0 || subtree(i) < subtree(big))) big = i; });
  let deepest = big;
  const descend = (i: number) => { if (scene.items[i].depth > scene.items[deepest].depth) deepest = i; for (const c of scene.items[i].children) descend(c); };
  descend(big);
  const atGroup = shownAt(scene.items[deepest].x, scene.items[deepest].y), g = dragFrames(atGroup, [big]);
  const drawn = new Set([...atGroup.visible.items, ...atGroup.visible.groups]), held = g.split.items.filter((i) => drawn.has(i)).length;
  show(`image d’aperçu, groupe de ${subtree(big)} éléments (${sizes(g.split)}, ${held} dessinés ; médiane, ${g.inPlace} sur 60 en place)`, g.median);
  show('  la pire', g.worst);
  expect(degree.get(leaf)).toBeGreaterThan(10);
  expect(l.inPlace).toBe(60);
  expect(held).toBeGreaterThan(10);
  expect(g.inPlace).toBeGreaterThan(0);
  expect(l.median).toBeLessThanOrEqual(LEAF_PREVIEW_CEILING_MS);
  expect(g.median).toBeLessThanOrEqual(GROUP_PREVIEW_CEILING_MS);
}, 300_000);

test('base de référence : un dépôt et son annulation mettent ce qui est dessiné à jour en place, à la caméra profonde', () => {
  const { s, lobby, scene } = reference(), deep = benchPath(scene, W, H, P).deep!, cam = { ...deep, widthPx: W, heightPx: H };
  let index = buildIndex(scene, P);
  const visible = computeVisible(scene, index, cam, P);
  const shown: Shown = { scene, base: scene, state: scene, visible, cam, inst: buildInstances(scene, visible, cam, cam, P, undefined, font, new Map()) };
  const leaf = visible.items.find((i) => scene.items[i].kind === 'node')!, it = scene.items[leaf];
  const a = moveNodes(s, lobby, [{ node: it.id, x: it.x + 30 / cam.zoom, y: it.y - 20 / cam.zoom }]), undo = invertAction(a);
  let ms = Infinity, undoMs = Infinity, sc = scene;
  for (let i = 0; i < 5; i++) {
    applyOps(s, a.ops);
    const u = updateScene(sc, s, a.ops, measure, P);
    index = updateIndex(index, u.scene, u.changes, P);
    let t = performance.now();
    expect(patchEdit(shown, sc, u.scene, u.changes, P, font, new Map())).not.toBeNull();
    ms = Math.min(ms, performance.now() - t);
    Object.assign(shown, { scene: u.scene, base: u.scene, state: u.scene });
    applyOps(s, undo.ops);
    const back = updateScene(u.scene, s, undo.ops, measure, P);
    index = updateIndex(index, back.scene, back.changes, P);
    t = performance.now();
    expect(patchEdit(shown, u.scene, back.scene, back.changes, P, font, new Map())).not.toBeNull();
    undoMs = Math.min(undoMs, performance.now() - t);
    Object.assign(shown, { scene: back.scene, base: back.scene, state: back.scene });
    sc = back.scene;
  }
  show('patchEdit, dépôt d’une feuille', ms);
  show('  son annulation', undoMs);
  expect(computeVisible(sc, index, cam, P)).toEqual(shown.visible);
  ref!.scene = sc;
}, 120_000);

test('base de référence : updateIndex d’un déplacement en 1 ms au plus, et l’index suivi égale l’index construit', () => {
  const { s, lobby } = reference();
  let { scene } = reference(), index = buildIndex(scene, P);
  const p = planRow(s, lobby);
  // A leaf five levels down: the move reshapes every group above it, up to a root.
  let leaf = -1;
  scene.items.forEach((it, i) => { if (leaf < 0 && isLive(scene, i) && it.kind === 'node' && it.depth >= 4) leaf = i; });
  const node = scene.items[leaf].id;
  expect(directGroup(s, p, nodeRow(s, node))).toBeGreaterThanOrEqual(0);
  const a = moveNodes(s, lobby, [{ node, x: scene.items[leaf].x + 500, y: scene.items[leaf].y - 300 }]), undo = invertAction(a);
  let bestMs = Infinity, bestUndo = Infinity;
  for (let i = 0; i < 9; i++) {
    applyOps(s, a.ops);
    const r = updateScene(scene, s, a.ops, measure, P);
    let t = performance.now();
    index = updateIndex(index, r.scene, r.changes, P);
    const ms = performance.now() - t;
    applyOps(s, undo.ops);
    const back = updateScene(r.scene, s, undo.ops, measure, P);
    t = performance.now();
    index = updateIndex(index, back.scene, back.changes, P);
    const undoMs = performance.now() - t;
    if (i >= 2) { bestMs = Math.min(bestMs, ms); bestUndo = Math.min(bestUndo, undoMs); }
    if (i === 0) expect(indexContent(index, back.scene)).toEqual(indexContent(buildIndex(back.scene, P), back.scene));
    scene = back.scene;
  }
  show('updateIndex, déplacement', bestMs);
  show('  son annulation', bestUndo);
  expect(bestMs).toBeLessThanOrEqual(1);
  expect(bestUndo).toBeLessThanOrEqual(1);
}, 120_000);

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
