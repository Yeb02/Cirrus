import { readFileSync } from 'node:fs';
import { applyOps, editNode, include, invertAction, moveNodes, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import type { Camera } from '../src/camera.ts';
import { type EnvelopeMeshes, newEnvelopeMeshes } from '../src/geometry/envelope.ts';
import { BUNDLE_AT, BUNDLE_INTS, buildInstances, CURVE_FLOATS, type Instances, isSimple, type LayoutOverrides } from '../src/instances.ts';
import { layoutSplit, patchEdit, patchPreview, previewEnvelopes, previewSplit, type Shown } from '../src/preview.ts';
import { buildScene, type PlanScene, withMoves, withOffsets } from '../src/scene.ts';
import { updateScene } from '../src/sceneUpdate.ts';
import { parseBmFont } from '../src/text.ts';
import { buildIndex, computeVisible, updateIndex, type VisibleSet } from '../src/visibility.ts';
import { camAtTextPx, copyOf, fixture, measure, P, randomActions, rng } from './helpers.ts';

const font = parseBmFont(readFileSync(new URL('../../app/src/renderer/public/font/inter-msdf.fnt', import.meta.url), 'utf8'));

let s: State, ids: FixtureIds;
beforeAll(() => {
  ({ s, ids } = fixture());
});

/** What is drawn for a scene at a camera, built whole as the renderer does (font, sides of its own). */
function shownFor(scene: PlanScene, cam: Camera, visible?: VisibleSet, layouts?: LayoutOverrides): Shown {
  const v = visible ?? computeVisible(scene, buildIndex(scene, P), cam, P), origin = { x: cam.x + 17, y: cam.y - 5 };
  return { scene, base: scene, state: scene, visible: v, cam, inst: buildInstances(scene, v, cam, origin, P, undefined, font, new Map(), undefined, layouts), layouts };
}

/** Everything the instances hold, envelopes and the places of their parts included, copied out (deep-equal comparisons). */
const contentOf = (x: Instances) => structuredClone({
  boxes: [...x.boxes.view()], simple: [...x.simple.view()], curves: [...x.curves.view()], keys: x.curveKeys, texts: [...x.texts.view()],
  glyphs: Object.fromEntries(Object.entries(x.glyphs).map(([k, l]) => [k, [...l.view()]])),
  envelopes: Object.fromEntries(Object.entries(x.envelopes).map(([k, l]) => [k, [...l.view()]])), markers: x.markers, stubs: x.stubs, titles: x.titles,
  reveal: x.revealZoom, bundles: [...x.bundles.view()], bundleOf: [...x.bundleOf.view()], envelopeAt: [...x.envelopeAt.view()],
  groupTitles: [...x.groupTitles.view()], itemTexts: x.itemTexts, titleGlyphs: [...x.titleGlyphs.view()], titled: [...x.titled.view()],
});

/** The scene with item i one step larger, as the scale gesture previews it. */
const withMovesOf = (scene: PlanScene, i: number) => withMoves(scene, { nodes: [{ node: scene.items[i].id, k: scene.items[i].k + 1 }], phantoms: [] }, P);

/** The curve floats of one complex bundle. */
const curvesOf = (x: Instances, ci: number) => {
  const o = x.bundleOf.storage[ci] * BUNDLE_INTS, b = x.bundles.storage;
  return [...x.curves.view().subarray(b[o + BUNDLE_AT.curve] * CURVE_FLOATS, (b[o + BUNDLE_AT.curve] + b[o + BUNDLE_AT.curves]) * CURVE_FLOATS)];
};

test('previewSplit : déplacer un groupe y fait entrer ses descendants, ses ancêtres et les faisceaux complexes qui les touchent', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), cam = camAtTextPx(scene, 0, 16), { visible } = shownFor(scene, cam);
  const g = scene.byId.get(ids.nodes.groupeComplexite)!, split = previewSplit(scene, visible, [g]);
  const below: number[] = [];
  const walk = (i: number) => { below.push(i); for (const c of scene.items[i].children) walk(c); };
  walk(g);
  expect(new Set(split.items)).toEqual(new Set(below));
  for (const id of [ids.nodes.mdl, ids.nodes.solomonoff, ids.phantoms.node, ids.nodes.groupeInduction]) expect(split.items).toContain(scene.byId.get(id)!);
  const above: number[] = [];
  for (let a = scene.items[g].parent; a >= 0; a = scene.items[a].parent) above.push(a);
  expect(above.length).toBeGreaterThan(0);
  expect(new Set(split.groups)).toEqual(new Set([...above, ...below.filter((i) => scene.items[i].kind === 'group')]));
  // Every visible connection that ends on one of them (or is centred on one) is in the split, by its kind; no other is.
  const all = new Set([...split.items, ...split.groups]);
  visible.connections.forEach((vc, ci) => {
    const touching = vc.ends.some((e) => all.has(e.item) || all.has(e.mask) || all.has(e.mask2)) || (vc.center !== undefined && all.has(vc.center));
    expect(split.complex.includes(ci), `connexion ${ci}`).toBe(touching && !isSimple(scene, vc));
    expect(split.simple.includes(ci), `connexion ${ci}`).toBe(touching && isSimple(scene, vc));
  });
  expect(split.complex.length).toBeGreaterThan(0);
  expect(split.simple.length).toBeGreaterThan(0);
  expect(split.drawnGroups.map((j) => visible.groups[j])).toEqual(visible.groups.filter((x) => all.has(x)));
});

/** The vertices of the triangles of an envelope mesh's index range, as positions (meshes numbered apart compared). */
const triangles = (m: EnvelopeMeshes, from: number, to: number) => {
  const idx = m.index.view(), pos = m.position.view(), out: number[] = [];
  for (let k = from; k < to; k++) out.push(pos[2 * idx[k]], pos[2 * idx[k] + 1]);
  return out;
};

test('aperçu puis fin d’aperçu : les instances reviennent à l’octet près, décalage nul ou non (Review Focus 5) ; les faisceaux tirés égalent ceux d’une reconstruction', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), cam = camAtTextPx(scene, 0, 16), shown = shownFor(scene, cam), before = contentOf(shown.inst);
  let previous: PlanScene | undefined, patched = 0;
  for (const id of [ids.nodes.mdl, ids.nodes.groupeComplexite, ids.nodes.solomonoff]) {
    const moving = [scene.byId.get(id)!], split = previewSplit(scene, shown.visible, moving);
    for (const d of [{ x: 0, y: 0 }, { x: 40, y: -25 }, { x: -12.5, y: 7 }]) {
      const preview = withOffsets(scene, new Map(moving.map((i) => [i, d])), P, previous);
      previous = preview;
      const r = patchPreview(shown, preview, split, P);
      expect(r, `${id} ${JSON.stringify(d)}`).not.toBeNull();
      patched++;
      shown.scene = preview;
      // Its complex bundles are those of a rebuild for the same visible set, at the same camera and origin.
      const whole = buildInstances(preview, shown.visible, cam, shown.inst.origin, P, undefined, font, new Map());
      for (const ci of split.complex) expect(curvesOf(shown.inst, ci)).toEqual(curvesOf(whole, ci));
      if (d.x === 0 && d.y === 0) expect(contentOf(shown.inst)).toEqual(before);
      // Its groups' envelopes apart, in their own mesh, drawn in place of theirs.
      const side = newEnvelopeMeshes(), draws = previewEnvelopes(shown, preview, split, P, side);
      expect(draws.length).toBe(4 * split.drawnGroups.length);
      split.drawnGroups.forEach((j, q) => {
        expect(draws.slice(4 * q, 4 * q + 2)).toEqual([shown.inst.envelopeAt.storage[2 * j], shown.inst.envelopeAt.storage[2 * j] + shown.inst.envelopeAt.storage[2 * j + 1]]);
        expect(triangles(side, draws[4 * q + 2], draws[4 * q + 3])).toEqual(triangles(whole.envelopes, whole.envelopeAt.storage[2 * j], whole.envelopeAt.storage[2 * j] + whole.envelopeAt.storage[2 * j + 1]));
      });
      // Given up: back to the state's scene, to the bit.
      expect(patchPreview(shown, scene, split, P)).not.toBeNull();
      shown.scene = scene;
      expect(contentOf(shown.inst)).toEqual(before);
    }
  }
  expect(patched).toBe(9);
});

test('aperçu : ce qui ne se fait pas en place est refusé sans rien changer (pas changé, élément amené dans la vue, autre ensemble visible)', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), mdl = scene.byId.get(ids.nodes.mdl)!;
  const cam: Camera = { x: scene.items[mdl].x, y: scene.items[mdl].y, zoom: 3, widthPx: 800, heightPx: 600 };
  const shown = shownFor(scene, cam), before = contentOf(shown.inst);
  // A group seen from inside: some of its members are out of the view; dragged far enough, one comes in.
  const g = scene.byId.get(ids.nodes.groupeComplexite)!, split = previewSplit(scene, shown.visible, [g]);
  expect(split.hidden.length).toBeGreaterThan(0);
  // A small move keeps them out; one that brings the first of them to the camera's centre does not.
  expect(patchPreview(shown, withOffsets(scene, new Map([[g, { x: 2, y: -1 }]]), P), split, P)).not.toBeNull();
  expect(patchPreview(shown, scene, split, P)).not.toBeNull();
  expect(contentOf(shown.inst)).toEqual(before);
  const h = scene.items[split.hidden[0]], come = withOffsets(scene, new Map([[g, { x: cam.x - h.x, y: cam.y - h.y }]]), P);
  expect(patchPreview(shown, come, split, P)).toBeNull();
  // A split made for another visible set; a step changed (a scale gesture).
  expect(patchPreview(shown, scene, previewSplit(scene, computeVisible(scene, buildIndex(scene, P), camAtTextPx(scene, 0, 16), P), [g]), P)).toBeNull();
  const scaled = buildScene(s, ids.plans.lobby, measure, P), k = withMovesOf(scaled, mdl);
  expect(patchPreview({ ...shown, state: scaled }, k, previewSplit(scaled, shown.visible, [mdl]), P)).toBeNull();
  expect(contentOf(shown.inst)).toEqual(before);
});

test('poignée de disposition : la disposition passe en surcharge, sans copier la scène ; une connexion simple se reconstruit', () => {
  const scene = buildScene(s, ids.plans.lobby, measure, P), cam = camAtTextPx(scene, 0, 16), shown = shownFor(scene, cam), before = contentOf(shown.inst);
  const ci = shown.visible.connections.findIndex((vc) => vc.fade < 0 && !isSimple(scene, vc) && vc.ends.length > 2);
  expect(ci).toBeGreaterThanOrEqual(0);
  const part = shown.visible.connections[ci].part, m = shown.inst.markers[shown.inst.bundles.storage[shown.inst.bundleOf.storage[ci] * BUNDLE_INTS + BUNDLE_AT.marker]];
  const layouts: LayoutOverrides = new Map([[part, { handles: {}, marker: { x: m.pos.x + shown.inst.origin.x + 60, y: m.pos.y + shown.inst.origin.y - 30 } }]]);
  const split = layoutSplit(shown.visible, part);
  expect(patchPreview(shown, scene, split, P, layouts)).not.toBeNull();
  const whole = buildInstances(scene, shown.visible, cam, shown.inst.origin, P, undefined, font, new Map(), undefined, layouts);
  expect(curvesOf(shown.inst, ci)).toEqual(curvesOf(whole, ci));
  expect(curvesOf(shown.inst, ci)).not.toEqual(curvesOf(buildInstances(scene, shown.visible, cam, shown.inst.origin, P, undefined, font, new Map()), ci));
  // Its title follows its marker.
  const title = shown.inst.titles.find((t) => t.conn === ci);
  if (title) expect(title.box).not.toEqual(before.titles.find((t) => t.conn === ci)!.box);
  expect(patchPreview(shown, scene, split, P)).not.toBeNull();
  expect(contentOf(shown.inst)).toEqual(before);
  // A simple connection given a layout becomes a complex one: not in place.
  const simple = shown.visible.connections.findIndex((vc) => isSimple(scene, vc));
  const sp = shown.visible.connections[simple].part;
  expect(patchPreview(shown, scene, layoutSplit(shown.visible, sp), P, new Map([[sp, { handles: {}, marker: { x: 0, y: 0 } }]]))).toBeNull();
  expect(contentOf(shown.inst)).toEqual(before);
});

test('action puis annulation par updateScene et patchEdit : les instances égalent une reconstruction complète (Review Focus 1)', () => {
  const st = copyOf(s), lobby = ids.plans.lobby, scene0 = buildScene(st, lobby, measure, P), cam = camAtTextPx(scene0, 0, 16);
  const shown = shownFor(scene0, cam), before = contentOf(shown.inst);
  let index = buildIndex(scene0, P);
  for (const id of [ids.nodes.mdl, ids.nodes.solomonoff]) {
    const it = scene0.items[scene0.byId.get(id)!];
    const a = moveNodes(st, lobby, [{ node: id, x: it.x + 35, y: it.y - 20 }]);
    applyOps(st, a.ops);
    const u = updateScene(shown.state, st, a.ops, measure, P);
    index = updateIndex(index, u.scene, u.changes, P);
    expect(patchEdit(shown, shown.state, u.scene, u.changes, P, font, new Map())).not.toBeNull();
    Object.assign(shown, { scene: u.scene, base: u.scene, state: u.scene });
    // What a rebuild gives: the same visible set, the same instances.
    expect(computeVisible(u.scene, index, cam, P)).toEqual(shown.visible);
    expect(contentOf(shown.inst)).toEqual(contentOf(shownFor(u.scene, cam).inst));
    const undo = invertAction(a);
    applyOps(st, undo.ops);
    const back = updateScene(u.scene, st, undo.ops, measure, P);
    index = updateIndex(index, back.scene, back.changes, P);
    expect(patchEdit(shown, u.scene, back.scene, back.changes, P, font, new Map())).not.toBeNull();
    Object.assign(shown, { scene: back.scene, base: back.scene, state: back.scene });
    expect(contentOf(shown.inst)).toEqual(contentOf(shownFor(back.scene, cam).inst));
    expect(contentOf(shown.inst)).toEqual(before);
  }
});

test('dépôt d’un aperçu : patchEdit réécrit aussi ce que l’aperçu avait changé, et égale une reconstruction complète', () => {
  const st = copyOf(s), lobby = ids.plans.lobby, scene0 = buildScene(st, lobby, measure, P), cam = camAtTextPx(scene0, 0, 16), shown = shownFor(scene0, cam);
  const g = scene0.byId.get(ids.nodes.groupeInduction)!, split = previewSplit(scene0, shown.visible, [g]);
  // Previewed at one offset, dropped at another (the last pointer move), as GraphView does.
  expect(patchPreview(shown, withOffsets(scene0, new Map([[g, { x: 50, y: 30 }]]), P), split, P)).not.toBeNull();
  const nodes: { node: string; x: number; y: number }[] = [];
  const walk = (i: number) => { const it = scene0.items[i]; if (it.kind !== 'phantom') nodes.push({ node: it.id, x: it.x + 20, y: it.y + 10 }); for (const c of it.children) walk(c); };
  walk(g);
  const a = moveNodes(st, lobby, nodes);
  applyOps(st, a.ops);
  const u = updateScene(scene0, st, a.ops, measure, P);
  expect(patchEdit(shown, scene0, u.scene, u.changes, P, font, new Map(), split)).not.toBeNull();
  expect(contentOf(shown.inst)).toEqual(contentOf(shownFor(u.scene, cam, shown.visible).inst));
});

test('une action pendant une poignée de disposition faite en place : le faisceau tiré revient à sa disposition, comme une reconstruction', () => {
  const st = copyOf(s), lobby = ids.plans.lobby, scene0 = buildScene(st, lobby, measure, P), cam = camAtTextPx(scene0, 0, 16), shown = shownFor(scene0, cam);
  const ci = shown.visible.connections.findIndex((vc) => vc.fade < 0 && !isSimple(scene0, vc) && vc.ends.length > 2);
  const part = shown.visible.connections[ci].part, split = layoutSplit(shown.visible, part);
  expect(patchPreview(shown, scene0, split, P, new Map([[part, { handles: {}, marker: { x: 0, y: 0 }, angle: 1 }]]))).not.toBeNull();
  // A move of a drawn node that touches nothing of that bundle (Ctrl+Z of a move, a sync), done in place.
  const ends = new Set(shown.visible.connections[ci].ends.map((e) => e.item));
  const other = shown.visible.items.find((i) => scene0.items[i].kind === 'node' && !ends.has(i))!, it = scene0.items[other];
  const a = moveNodes(st, lobby, [{ node: it.id, x: it.x + 5, y: it.y - 3 }]);
  applyOps(st, a.ops);
  const u = updateScene(scene0, st, a.ops, measure, P);
  expect(patchEdit(shown, scene0, u.scene, u.changes, P, font, new Map(), split)).not.toBeNull();
  expect(contentOf(shown.inst)).toEqual(contentOf(shownFor(u.scene, cam, shown.visible).inst));
});

test('patchEdit refuse ce qui peut changer l’ensemble visible : renommage, pas, hiérarchie, élément amené dans la vue', () => {
  const st = copyOf(s), lobby = ids.plans.lobby;
  const scene0 = buildScene(st, lobby, measure, P), mdl = scene0.byId.get(ids.nodes.mdl)!, it = scene0.items[mdl];
  const cam: Camera = { x: it.x, y: it.y, zoom: 3, widthPx: 800, heightPx: 600 };
  const tries: [string, () => ReturnType<typeof moveNodes>][] = [
    ['renommage', () => editNode(st, ids.nodes.mdl, { title: 'Un autre titre' })],
    ['pas', () => moveNodes(st, lobby, [{ node: ids.nodes.mdl, k: 1 }])],
    ['hiérarchie', () => include(st, lobby, ids.nodes.monde, ids.nodes.groupeInduction)],
  ];
  // An item out of the view brought next to the camera.
  const out = scene0.items.findIndex((x, i) => x.kind === 'node' && x.parent < 0 && !computeVisible(scene0, buildIndex(scene0, P), cam, P).items.includes(i));
  expect(out).toBeGreaterThanOrEqual(0);
  tries.push(['amené dans la vue', () => moveNodes(st, lobby, [{ node: scene0.items[out].id, x: it.x + 50, y: it.y + 40 }])]);
  for (const [name, make] of tries) {
    const scene = buildScene(st, lobby, measure, P), shown = shownFor(scene, cam), before = contentOf(shown.inst), a = make();
    applyOps(st, a.ops);
    const u = updateScene(scene, st, a.ops, measure, P);
    expect(patchEdit(shown, scene, u.scene, u.changes, P, font, new Map()), name).toBeNull();
    expect(contentOf(shown.inst), name).toEqual(before);
    applyOps(st, invertAction(a).ops);
  }
});

test('actions au hasard et leurs annulations : chaque édition faite en place égale la reconstruction pour le même ensemble visible, et ne perd rien de ce qui se voit', () => {
  const st = copyOf(s), r = rng(4242), lobby = ids.plans.lobby;
  let scene = buildScene(st, lobby, measure, P), index = buildIndex(scene, P);
  const cam = camAtTextPx(scene, 0, 16);
  let shown = shownFor(scene, cam, computeVisible(scene, index, cam, P));
  const random = randomActions(st, r);
  // The base's actions, and as many small moves of a node drawn (a drop): those an edit does in place.
  const next = () => {
    if (r() < 0.5) return random();
    const drawn = shown.visible.items.filter((i) => scene.items[i].kind === 'node');
    const it = scene.items[drawn[Math.floor(r() * drawn.length)]];
    return { kind: 'déplacement', action: moveNodes(st, lobby, [{ node: it.id, x: it.x + (r() - 0.5) * 80, y: it.y + (r() - 0.5) * 60 }]) };
  };
  let inPlace = 0, rebuilt = 0;
  const step = (ops: Parameters<typeof updateScene>[2]) => {
    const u = updateScene(scene, st, ops, measure, P);
    if (u.scene === scene) return;
    index = u.changes.full ? buildIndex(u.scene, P) : updateIndex(index, u.scene, u.changes, P);
    if (patchEdit(shown, scene, u.scene, u.changes, P, font, new Map())) {
      inPlace++;
      Object.assign(shown, { scene: u.scene, base: u.scene, state: u.scene });
      expect(contentOf(shown.inst)).toEqual(contentOf(shownFor(u.scene, cam, shown.visible).inst));
      // Whatever a rebuild would draw is drawn.
      const fresh = computeVisible(u.scene, index, cam, P);
      for (const i of fresh.items) expect(shown.visible.items).toContain(i);
      for (const g of fresh.groups) expect(shown.visible.groups).toContain(g);
    } else {
      rebuilt++;
      shown = shownFor(u.scene, cam, computeVisible(u.scene, index, cam, P));
    }
    scene = u.scene;
  };
  for (let i = 0; i < 150; i++) {
    const picked = next();
    if (!picked) continue;
    applyOps(st, picked.action.ops);
    step(picked.action.ops);
    if (r() < 0.5) { const undo = invertAction(picked.action); applyOps(st, undo.ops); step(undo.ops); }
  }
  // 120 in place and 20 rebuilt with this seed.
  expect(inPlace).toBeGreaterThan(60);
  expect(rebuilt).toBeGreaterThan(10);
}, 120_000);
