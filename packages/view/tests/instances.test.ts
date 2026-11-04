import { readFileSync } from 'node:fs';
import { applyOps, connect, createNode, createPlan, invertAction, moveNodes, removeFromPlan, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { type Camera } from '../src/camera.ts';
import {
  buildInstances, CURVE_AT, CURVE_FLOATS, InstanceBuffers, type Instances, isSimple, markerCores, ITEM_BADGE, ITEM_GROUP, ITEM_STYLE, itemTexels, resumeInstances, rowRuns, SIMPLE_INTS,
  SLOT_FLOATS, texelSlots,
} from '../src/instances.ts';
import { buildScene, isLive, type PlanScene } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { GLYPH_AT, GLYPH_FLOATS, parseBmFont, TITLE_CONNECTION, TITLE_GROUP_OPEN, TITLE_NODE } from '../src/text.ts';
import { buildIndex, computeVisible, updateIndex, type VisibleSet } from '../src/visibility.ts';
import { camAtTextPx, copyOf, created, fixture, measure, P, randomActions, randomCameras, rng, run } from './helpers.ts';

const font = parseBmFont(readFileSync(new URL('../../app/src/renderer/public/font/inter-msdf.fnt', import.meta.url), 'utf8'));

let s: State, ids: FixtureIds;
beforeAll(() => {
  ({ s, ids } = fixture());
});

const build = (scene: PlanScene, cam: Camera, budget?: { deadline: number }) => {
  const visible = computeVisible(scene, buildIndex(scene, P), cam, P), origin = { x: cam.x + 17, y: cam.y - 5 };
  return { visible, origin, inst: buildInstances(scene, visible, cam, origin, P, budget, font, new Map()) };
};

/** The visible connections each kind of instance stands for: simple ones, complex ones drawn (by their curves). */
function drawn(inst: Instances): { simple: number[]; complex: Set<number> } {
  const sv = inst.simple.view(), simple: number[] = [];
  for (let o = 0; o < sv.length; o += SIMPLE_INTS) simple.push(sv[o + 3]);
  const c = inst.curves.view(), complex = new Set<number>();
  for (let o = 0; o < c.length; o += CURVE_FLOATS) complex.add(c[o + CURVE_AT.width + 3]);
  return { simple, complex };
}

/** Everything the instances hold, copied out of their storage (deep-equal comparisons). */
const contentOf = (x: Instances) => structuredClone({
  boxes: [...x.boxes.view()], simple: [...x.simple.view()], curves: [...x.curves.view()], keys: x.curveKeys, texts: [...x.texts.view()],
  glyphs: Object.fromEntries(Object.entries(x.glyphs).map(([k, l]) => [k, [...l.view()]])), markers: x.markers, stubs: x.stubs, titles: x.titles,
  reveal: x.revealZoom,
});

/** Every slot the instances cite is a live item of the scene (Review Focus 3). */
function deadSlot(scene: PlanScene, inst: Instances): string | null {
  const live = (i: number) => i >= 0 && i < scene.items.length && isLive(scene, i);
  for (const i of inst.boxes.view()) if (!live(i)) return `boîte ${i}`;
  const sv = inst.simple.view();
  for (let o = 0; o < sv.length; o += SIMPLE_INTS) {
    if (!live(sv[o]) || !live(sv[o + 1])) return `connexion simple ${sv[o]} → ${sv[o + 1]}`;
    if (sv[o + 4] !== -1 && !live(sv[o + 4])) return `groupe en fondu ${sv[o + 4]}`;
  }
  const t = inst.texts.view();
  for (let o = 0; o < t.length; o += GLYPH_FLOATS) if (t[o + GLYPH_AT.slot] !== -1 && !live(t[o + GLYPH_AT.slot])) return `titre de ${t[o + GLYPH_AT.slot]}`;
  return null;
}

test('chaque connexion visible est simple ou en branches complexes, jamais les deux ; les emplacements cités sont vivants ; aucun NaN', () => {
  let simpleSeen = 0, complexSeen = 0;
  for (const plan of Object.values(ids.plans)) {
    const scene = buildScene(s, plan, measure, P);
    for (const px of [0.5, 3, 5.5, 16, 200]) {
      const cam = camAtTextPx(scene, 0, px), { visible, inst } = build(scene, cam);
      expect(inst.pending).toBe(false);
      const { simple, complex } = drawn(inst);
      expect(new Set(simple).size).toBe(simple.length);
      for (const ci of simple) {
        expect(complex.has(ci), `connexion ${ci} des deux sortes`).toBe(false);
        expect(isSimple(scene, visible.connections[ci])).toBe(true);
      }
      visible.connections.forEach((vc, ci) => {
        if (!isSimple(scene, vc)) expect(simple).not.toContain(ci);
        else expect(simple).toContain(ci);
      });
      for (const ci of complex) expect(isSimple(scene, visible.connections[ci])).toBe(false);
      simpleSeen += simple.length;
      complexSeen += complex.size;
      expect(deadSlot(scene, inst)).toBeNull();
      expect([...inst.boxes.view()]).toEqual(visible.items);
      for (const list of [inst.curves, inst.texts, ...Object.values(inst.glyphs), ...Object.values(inst.envelopes)]) {
        expect([...list.view()].every(Number.isFinite)).toBe(true);
      }
    }
  }
  expect(simpleSeen).toBeGreaterThan(20);
  expect(complexSeen).toBeGreaterThan(20);
});

test('après des actions au hasard, retraits et emplacements recyclés compris, les instances ne citent aucun emplacement libéré (Review Focus 3)', () => {
  const st = copyOf(s), r = rng(808);
  let scene = buildScene(st, ids.plans.lobby, measure, P), index = buildIndex(scene, P);
  const next = randomActions(st, r);
  let recycled = 0, checked = 0;
  const freed = new Set<number>();
  const check = (ops: Parameters<typeof updateScene>[2]) => {
    const u = updateScene(scene, st, ops, measure, P);
    if (u.changes.full) freed.clear();
    for (const i of u.changes.items) if (freed.has(i) && isLive(u.scene, i)) { recycled++; freed.delete(i); }
    for (const i of u.changes.items) if (!isLive(u.scene, i)) freed.add(i);
    index = u.changes.full ? buildIndex(u.scene, P) : updateIndex(index, u.scene, u.changes, P);
    scene = u.scene;
    for (const cam of randomCameras(scene, 2, r, 0.01, 2)) {
      const visible = computeVisible(scene, index, cam, P);
      const inst = buildInstances(scene, visible, cam, cam, P, undefined, font);
      expect(deadSlot(scene, inst)).toBeNull();
      checked++;
    }
  };
  for (let i = 0; i < 200; i++) {
    const picked = next();
    if (!picked) continue;
    applyOps(st, picked.action.ops);
    check(picked.action.ops);
    if (r() < 0.4) {
      const undo = invertAction(picked.action);
      applyOps(st, undo.ops);
      check(undo.ops);
    }
  }
  // The last item of a plan removed, then a node in a freed slot.
  const plan = created(run(st, createPlan(st, 'Seul', 'plan')), 'plan');
  const at = (a: Parameters<typeof applyOps>[1]) => check(a);
  const one = created(run(st, createNode(st, { plan, title: 'Un', x: 0, y: 0, k: 0 })), 'node');
  scene = buildScene(st, plan, measure, P);
  index = buildIndex(scene, P);
  freed.clear();
  const two = run(st, createNode(st, { plan, title: 'Deux', x: 400, y: 0, k: 0 }));
  at(two.ops);
  at(run(st, connect(st, { plan, members: [{ node: one, role: 'source' }, { node: created(two, 'node'), role: 'target' }] })).ops);
  at(run(st, removeFromPlan(st, plan, created(two, 'node'))).ops);
  at(run(st, removeFromPlan(st, plan, one)).ops);
  expect(scene.roots).toEqual([]);
  at(run(st, createNode(st, { plan, title: 'Revenu', x: 0, y: 0, k: 0 })).ops);
  expect(checked).toBeGreaterThan(300);
  expect(recycled).toBeGreaterThan(0);
}, 300_000);

test('itemTexels restreint aux emplacements touchés égale le remplissage complet, sur ces rangées et partout (Review Focus 1 : annulations comprises)', () => {
  const st = copyOf(s), r = rng(99), origin = { x: 1234.5, y: -987.25 };
  let scene = buildScene(st, ids.plans.lobby, measure, P);
  let texels = new Float32Array(4096 * SLOT_FLOATS);
  itemTexels(scene, origin, texels);
  const next = randomActions(st, r);
  let partial = 0;
  const step = (ops: Parameters<typeof updateScene>[2]) => {
    const u = updateScene(scene, st, ops, measure, P);
    if (u.changes.full) itemTexels(u.scene, origin, texels);
    else {
      const slots = texelSlots(scene, u.scene, u.changes);
      itemTexels(u.scene, origin, texels, slots);
      partial++;
    }
    scene = u.scene;
    const full = new Float32Array(texels.length);
    itemTexels(scene, origin, full);
    const n = scene.items.length * SLOT_FLOATS;
    expect(texels.subarray(0, n)).toEqual(full.subarray(0, n));
  };
  for (let i = 0; i < 150; i++) {
    const picked = next();
    if (!picked) continue;
    applyOps(st, picked.action.ops);
    step(picked.action.ops);
    const undo = invertAction(picked.action);
    if (r() < 0.5) { applyOps(st, undo.ops); step(undo.ops); }
    if (scene.items.length * SLOT_FLOATS > texels.length) { const t = new Float32Array(texels.length * 2); t.set(texels); texels = t; }
  }
  expect(partial).toBeGreaterThan(100);
  // A slot's texels: position from the origin, half sizes, step, the parent's fold, its own, its flags.
  const g = scene.byId.get(ids.nodes.groupeML)!, m = scene.items[g].children.find((c) => scene.items[c].kind === 'node')!;
  itemTexels(scene, origin, texels);
  const it = scene.items[m];
  expect([...texels.subarray(m * SLOT_FLOATS, m * SLOT_FLOATS + 8)]).toEqual(
    [it.x - origin.x, it.y - origin.y, it.halfW, it.halfH, it.k, scene.items[g].maxChildK!, 1e9, it.badge ? ITEM_BADGE : 0].map(Math.fround),
  );
  expect(texels[g * SLOT_FLOATS + 7] & ITEM_GROUP).toBe(ITEM_GROUP);
  expect(texels[g * SLOT_FLOATS + 6]).toBe(Math.fround(scene.items[g].maxChildK!));
  const ph = scene.items.findIndex((x, i) => isLive(scene, i) && x.kind === 'phantom' && x.phantom === 'node');
  expect(texels[ph * SLOT_FLOATS + 7] & ITEM_STYLE).toBe(1);
});

test('texelSlots : un groupe dont le repli change réécrit ses enfants ; un déplacement, ce qu’il touche seulement', () => {
  const st = copyOf(s);
  const scene = buildScene(st, ids.plans.lobby, measure, P), g = scene.byId.get(ids.nodes.groupeML)!;
  const member = scene.items[g].children.find((c) => scene.items[c].kind === 'node')!;
  const id = scene.items[member].id;
  const move = run(st, moveNodes(st, ids.plans.lobby, [{ node: id, x: scene.items[member].x + 10, y: scene.items[member].y }]));
  const moved = updateScene(scene, st, move.ops, measure, P);
  expect(new Set(texelSlots(scene, moved.scene, moved.changes))).toEqual(new Set(moved.changes.items));
  const k = run(st, moveNodes(st, ids.plans.lobby, [{ node: id, k: 3 }]));
  const grown = updateScene(moved.scene, st, k.ops, measure, P);
  expect(grown.scene.items[g].maxChildK).not.toBe(moved.scene.items[g].maxChildK);
  const slots = new Set(texelSlots(moved.scene, grown.scene, grown.changes));
  for (const c of grown.scene.items[g].children) expect(slots.has(c)).toBe(true);
});

test('rangées des emplacements touchés : 512 emplacements par rangée, en suites contiguës', () => {
  expect(rowRuns([0, 511, 512, 2000, 1030])).toEqual([[0, 4]]);
  expect(rowRuns([5, 1600, 5000, 4700])).toEqual([[0, 1], [3, 4], [9, 10]]);
  expect(rowRuns([])).toEqual([]);
});

test('budget dépassé : un faisceau complexe par image, repris dans l’ordre jusqu’au bout ; le résultat égale une construction d’une traite', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), cam = camAtTextPx(scene, 0, 16);
  const whole = build(scene, cam).inst;
  const { inst } = build(scene, cam, { deadline: 0 });
  const complex = drawn(whole).complex.size;
  expect(complex).toBeGreaterThan(3);
  let frames = 1;
  expect(inst.pending).toBe(true);
  expect(inst.markers).toHaveLength(1);
  expect(inst.titles).toEqual([]);
  while (inst.pending) {
    const before = inst.markers.length;
    resumeInstances(inst, { deadline: 0 });
    expect(inst.markers.length).toBe(before + 1);
    frames++;
  }
  expect(frames).toBe(whole.markers.length);
  expect(contentOf(inst)).toEqual(contentOf(whole));
});

test('reconstruction de la caméra au-delà du budget : ce qui est affiché reste entier jusqu’à la fin, puis tout change d’un coup (fix 1)', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), camA = camAtTextPx(scene, 0, 16), camB = { ...camA, x: camA.x + 400, y: camA.y - 150 };
  const buffers = new InstanceBuffers<{ visible: VisibleSet; inst: Instances }>();
  const make = (cam: Camera, budget?: { deadline: number }) => {
    const visible = computeVisible(scene, buildIndex(scene, P), cam, P);
    return { visible, inst: buildInstances(scene, visible, cam, camA, P, budget, font, new Map(), buffers.storage()) };
  };
  expect(buffers.start(make(camA))).toBe(true);
  const shown = buffers.front!, before = contentOf(shown.inst);
  expect(before.markers.length).toBeGreaterThan(3);
  expect(before.texts.length).toBeGreaterThan(0);
  // Over budget at once: nothing on screen changes, neither its complex bundles nor its connection titles.
  expect(buffers.start(make(camB, { deadline: 0 }))).toBe(false);
  expect(buffers.building!.inst).not.toBe(shown.inst);
  let frames = 0;
  for (;;) {
    expect(buffers.front).toBe(shown);
    expect(contentOf(shown.inst)).toEqual(before);
    frames++;
    if (buffers.resume({ deadline: 0 })) break;
  }
  expect(frames).toBeGreaterThan(2);
  // Then the new set whole, as if built at once; its visible set with it.
  const whole = buildInstances(scene, computeVisible(scene, buildIndex(scene, P), camB, P), camB, camA, P, undefined, font, new Map());
  expect(contentOf(buffers.front!.inst)).toEqual(contentOf(whole));
  expect(buffers.front!.visible).toEqual(computeVisible(scene, buildIndex(scene, P), camB, P));
  // The next rebuild refills the storage shown before, never what is on screen; a pending build given up gives its own.
  const third = make(camA, { deadline: 0 });
  expect(third.inst).toBe(shown.inst);
  expect(third.inst).not.toBe(buffers.front!.inst);
  expect(buffers.start(third)).toBe(false);
  expect(buffers.storage()).toBe(third.inst);
  expect(buffers.building).toBeNull();
  expect(buffers.resume()).toBe(false);
});

test('cœurs montrés pendant un tracé de connexion : lus dans la scène des instances, pas dans une scène compactée depuis (fix 2)', () => {
  const st = copyOf(s), plan = created(run(st, createPlan(st, 'Cœurs', 'plan')), 'plan'), p = { ...P, sceneCompactShare: 0.05 };
  const nodes = Array.from({ length: 12 }, (_, i) => created(run(st, createNode(st, { plan, title: `N${i}`, x: i * 400, y: (i % 3) * 300, k: 0 })), 'node'));
  for (let i = 0; i + 1 < nodes.length; i += 2) run(st, connect(st, { plan, members: [{ node: nodes[i], role: 'source' }, { node: nodes[i + 1], role: 'target' }] }));
  const scene = buildScene(st, plan, measure, p), cam = camAtTextPx(scene, 0, 16);
  const visible = computeVisible(scene, buildIndex(scene, p), cam, p), inst = buildInstances(scene, visible, cam, cam, p, undefined, font);
  expect(markerCores(scene, inst, cam.zoom, p, false)).toEqual([]); // two members: no marker drawn
  const cores = markerCores(scene, inst, cam.zoom, p, true), sv = inst.simple.view();
  expect(cores).toHaveLength(sv.length / SIMPLE_INTS);
  cores.forEach((c, j) => {
    const a = scene.items[sv[j * SIMPLE_INTS]], b = scene.items[sv[j * SIMPLE_INTS + 1]];
    expect([c.x, c.y, c.conn]).toEqual([(a.x + b.x) * 0.5 - cam.x, (a.y + b.y) * 0.5 - cam.y, sv[j * SIMPLE_INTS + 3]]);
  });
  // An action that compacts the scene: its slots are no longer those the instances cite.
  let next = scene;
  for (const n of nodes.slice(0, 9)) {
    const a = run(st, removeFromPlan(st, plan, n));
    next = updateScene(next, st, a.ops, measure, p).scene;
  }
  expect(Math.max(...sv)).toBeGreaterThanOrEqual(next.items.length);
  expect(markerCores(scene, inst, cam.zoom, p, true)).toEqual(cores);
});

test('titres : chaque glyphe d’un élément porte son emplacement, celui d’un groupe ouvert son écart au centre, celui d’une connexion son ancre', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), cam = camAtTextPx(scene, 0, 16), { visible, inst } = build(scene, cam);
  const t = inst.texts.view(), A = GLYPH_AT.anchor, T = GLYPH_AT.title, S = GLYPH_AT.slot;
  const kinds = new Set<number>();
  for (let o = 0; o < t.length; o += GLYPH_FLOATS) {
    const kind = t[o + T + 1], slot = t[o + S];
    kinds.add(kind);
    if (kind === TITLE_NODE) {
      expect(slot).toBe(visible.items[t[o + T + 2]]);
      expect([t[o + A], t[o + A + 1]]).toEqual([0, 0]);
    } else if (kind === TITLE_GROUP_OPEN) {
      expect(slot).toBe(visible.groups[t[o + T + 2]]);
      expect(t[o + A + 1]).toBeLessThan(0); // above its centre
    } else if (kind === TITLE_CONNECTION) {
      expect(slot).toBe(-1);
      const title = inst.titles.find((x) => x.conn === t[o + T + 2])!;
      expect(t[o + A]).toBeCloseTo(title.box.x + title.box.w / 2, 3);
    }
  }
  expect([...kinds].sort()).toEqual([0, 1, 2, 3]);
  expect(inst.titles.map((x) => x.text)).toContain('Déduction jointe');
});

test('ce qui est trop petit au zoom servi attend son zoom : revealZoom le donne, et à ce zoom il est construit', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P);
  const far = camAtTextPx(scene, 0, 0.5), { inst } = build(scene, far);
  expect(inst.revealZoom).toBeGreaterThan(far.zoom);
  expect(Number.isFinite(inst.revealZoom)).toBe(true);
  const near = { ...far, zoom: inst.revealZoom }, more = build(scene, near).inst;
  const count = (x: Instances) => x.texts.length + x.curves.length + x.titles.length;
  expect(count(more)).toBeGreaterThan(count(inst));
  expect(more.revealZoom).toBeGreaterThan(near.zoom);
  // Deep in, everything is built: nothing waits.
  expect(build(scene, camAtTextPx(scene, -3, 200)).inst.revealZoom).toBe(Infinity);
});

test('plan vide : aucune instance', () => {
  const st = copyOf(s), plan = created(run(st, createPlan(st, 'Vide', 'plan')), 'plan'), scene = buildScene(st, plan, measure, P);
  const visible: VisibleSet = computeVisible(scene, buildIndex(scene, P), { x: 0, y: 0, zoom: 1, widthPx: 800, heightPx: 600 }, P);
  const inst = buildInstances(scene, visible, { x: 0, y: 0, zoom: 1, widthPx: 800, heightPx: 600 }, { x: 0, y: 0 }, P, { deadline: 0 }, font);
  expect([inst.boxes.length, inst.simple.length, inst.curves.length, inst.texts.length, inst.pending]).toEqual([0, 0, 0, 0, false]);
  const texels = new Float32Array(8);
  itemTexels(scene, { x: 0, y: 0 }, texels);
  expect([...texels]).toEqual(new Array(8).fill(0));
});
