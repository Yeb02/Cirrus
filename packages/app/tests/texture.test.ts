import { buildFixture } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, combine, createNode, invertAction, moveNodes, type State } from '@cirrus/core';
import {
  buildIndex, buildScene, computeVisible, DEFAULT_PARAMS, EDGE_FLOATS, envelopeDistance, groupEdges, ITEM_TEXTURE_WIDTH, itemTexels, type PlanScene, previewSlots,
  previewSplit, rowRuns, SLOT_FLOATS, texelSlots, textureRows, updateScene, withOffsets,
} from '@cirrus/view';
import { expect, test } from 'vitest';
import { type TextureGl, Texture2D } from '../src/renderer/gl/texture.ts';
import { ItemTexture } from '../src/renderer/render/itemTexture.ts';

/** The calls a Texture2D makes, recorded with the data they would send and the texture bound (no WebGL under Node). */
function recorder() {
  const calls: { fn: string; args: unknown[]; tex?: unknown }[] = [];
  let bound: unknown = null;
  const rec = (fn: string) => (...args: unknown[]) => { if (fn === 'bindTexture') bound = args[1]; calls.push({ fn, args, tex: bound }); };
  // WebGL raises INVALID_OPERATION when the rows asked for run past the data from srcOffset (4 floats per texel).
  const subImage = (...args: unknown[]) => {
    const [, , , , w, h, , , data, offset] = args as [number, number, number, number, number, number, number, number, Float32Array, number];
    if (offset + w * h * 4 > data.length) throw new Error(`texSubImage2D : ${w} × ${h} texels depuis ${offset}, au-delà des ${data.length} flottants`);
    calls.push({ fn: 'texSubImage2D', args, tex: bound });
  };
  const constants = {
    TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601, NEAREST: 0x2600, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_FLIP_Y_WEBGL: 0x9240, RGBA8: 0x8058, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    RGBA32F: 0x8814, FLOAT: 0x1406, TEXTURE0: 0x84c0,
  };
  const gl = {
    ...constants, createTexture: () => ({ texture: calls.length }) as unknown as WebGLTexture, bindTexture: rec('bindTexture'), texParameteri: rec('texParameteri'), pixelStorei: rec('pixelStorei'),
    texImage2D: rec('texImage2D'), texSubImage2D: subImage, activeTexture: rec('activeTexture'), deleteTexture: rec('deleteTexture'),
  } as unknown as TextureGl;
  return { gl, calls, constants };
}

test('texture des éléments : RGBA32F au plus près, allouée une fois, puis seules les rangées touchées partent (texSubImage2D)', () => {
  const { gl, calls, constants: c } = recorder();
  const t = new Texture2D(gl, 'nearest');
  expect(calls.filter((x) => x.fn === 'texParameteri').map((x) => x.args[2])).toEqual([c.NEAREST, c.NEAREST, c.CLAMP_TO_EDGE, c.CLAMP_TO_EDGE]);

  // Storage for 4 rows of 1024 texels; asked again at the same size, nothing is made.
  calls.length = 0;
  expect(t.allocate(ITEM_TEXTURE_WIDTH, 4)).toBe(true);
  expect(calls.map((x) => x.fn)).toEqual(['bindTexture', 'texImage2D']);
  expect(calls[1].args).toEqual([c.TEXTURE_2D, 0, c.RGBA32F, ITEM_TEXTURE_WIDTH, 4, 0, c.RGBA, c.FLOAT, null]);
  calls.length = 0;
  expect(t.allocate(ITEM_TEXTURE_WIDTH, 4)).toBe(false);
  expect(calls).toEqual([]);

  // Rows 1 and 2 only: one texSubImage2D from row 1, two rows high, read from row 1 of the data (floats: 4 per texel).
  const data = new Float32Array(ITEM_TEXTURE_WIDTH * 4 * 4).map((_, i) => i);
  t.setRows(data, 1, 3);
  expect(calls.map((x) => x.fn)).toEqual(['bindTexture', 'texSubImage2D']);
  const [target, level, x0, y0, w, h, format, type, src, offset] = calls[1].args as [number, number, number, number, number, number, number, number, Float32Array, number];
  expect([target, level, x0, y0, w, h, format, type]).toEqual([c.TEXTURE_2D, 0, 0, 1, ITEM_TEXTURE_WIDTH, 2, c.RGBA, c.FLOAT]);
  expect(src).toBe(data);
  expect(offset).toBe(ITEM_TEXTURE_WIDTH * 4);
  expect(src[offset]).toBe(ITEM_TEXTURE_WIDTH * 4); // the first float of row 1
  calls.length = 0;
  t.setRows(data, 2, 2);
  expect(calls).toEqual([]);
});

test('une action ne renvoie que les rangées de ses emplacements : deux texels par emplacement, 512 par rangée', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-texture-'));
  const store = LocalStore.open(dir, { pc: 'test' }), ids = buildFixture(store, dir), s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  const scene = buildScene(s, ids.plans.lobby, (x) => Math.max(1, Math.ceil(x.length / 23)), DEFAULT_PARAMS);
  // Three rows of mirror, as the renderer would hold for a slot in row 2 (its capacity covers every slot it sends).
  const texels = new Float32Array(Math.max(3, textureRows(scene.items.length)) * ITEM_TEXTURE_WIDTH * 4);
  itemTexels(scene, { x: 0, y: 0 }, texels);
  // Slot i is at texels 2i and 2i + 1: row ⌊i / 512⌋, columns 2 (i mod 512) and the next.
  const i = scene.byId.get(ids.nodes.mdl)!, it = scene.items[i], row = Math.floor(i / 512), col = 2 * (i % 512);
  const at = (row * ITEM_TEXTURE_WIDTH + col) * 4;
  expect(at).toBe(i * SLOT_FLOATS);
  expect([texels[at], texels[at + 1]]).toEqual([Math.fround(it.x), Math.fround(it.y)]);
  const { gl, calls } = recorder();
  const t = new Texture2D(gl, 'nearest');
  t.allocate(ITEM_TEXTURE_WIDTH, 4);
  calls.length = 0;
  // Two slots two rows apart: two rows sent, one each, the row between them not.
  expect(row).toBe(0);
  for (const [from, to] of rowRuns([i, 1500])) t.setRows(texels, from, to);
  const sub = calls.filter((x) => x.fn === 'texSubImage2D').map((x) => [x.args[3], x.args[5], x.args[9]]);
  expect(sub).toEqual([[0, 1, 0], [2, 1, 2 * ITEM_TEXTURE_WIDTH * 4]]);
});

// ———— The item texture as the renderer keeps it (plan 3c task 9)

function lobbyState() {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-texture-'));
  const store = LocalStore.open(dir, { pc: 'test' }), ids = buildFixture(store, dir), s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return { s, ids };
}
const measure = (x: string) => Math.max(1, Math.ceil(x.length / 23));
/** The texture's rows as bytes (equal to the bit, NaN and −0 included). */
const bytes = (t: Float32Array) => new Uint8Array(t.buffer.slice(0));
const whole = (scene: PlanScene, origin: { x: number; y: number }, length: number) => { const out = new Float32Array(length); itemTexels(scene, origin, out); return out; };
/** The item texture's own calls (its envelopes have their textures: EnvelopeTexture). */
const own = <C extends { fn: string; tex?: unknown }>(tex: ItemTexture, calls: C[], fn: string) => calls.filter((c) => c.fn === fn && c.tex === tex.texture.texture);
/** Every group's envelope edges as the texture holds them, against the scene's (relative to the origin): the first slot that differs, or null. */
function envelopeDifference(tex: ItemTexture, scene: PlanScene, origin: { x: number; y: number }): string | null {
  for (let i = 0; i < scene.items.length; i++) {
    const want: number[] = [];
    if (scene.items[i].kind === 'group') groupEdges(scene, i, origin, want);
    const got = tex.envelopes.edgesOf(i);
    if (got.length !== want.length || got.some((v, k) => v !== Math.fround(want[k]))) return `emplacement ${i} : ${got.length / EDGE_FLOATS} arêtes au lieu de ${want.length / EDGE_FLOATS}`;
  }
  return null;
}

test('ItemTexture : un aperçu réécrit ses emplacements, rangée par rangée ; sa fin rend la texture à l’octet près, décalage nul ou non (Review Focus 5)', () => {
  const { s, ids } = lobbyState(), scene = buildScene(s, ids.plans.lobby, measure, DEFAULT_PARAMS), origin = { x: 120.5, y: -40.25 };
  const { gl, calls } = recorder(), tex = new ItemTexture(gl);
  tex.writeAll(scene, origin);
  expect(tex.scene).toBe(scene);
  const before = bytes(tex.texels);
  const cam = { x: 0, y: 0, zoom: 0.5, widthPx: 2560, heightPx: 1600 }, visible = computeVisible(scene, buildIndex(scene, DEFAULT_PARAMS), cam, DEFAULT_PARAMS);
  let previous: PlanScene | undefined;
  for (const [id, d] of [[ids.nodes.groupeComplexite, { x: 0, y: 0 }], [ids.nodes.groupeComplexite, { x: 35, y: -12 }], [ids.nodes.mdl, { x: -8, y: 3 }]] as const) {
    const moving = [scene.byId.get(id)!], split = previewSplit(scene, visible, moving);
    const preview = withOffsets(scene, new Map(moving.map((i) => [i, d])), DEFAULT_PARAMS, previous), slots = previewSlots(scene, preview, split);
    previous = preview;
    calls.length = 0;
    tex.preview(preview, slots);
    // Only texSubImage2D, on the rows of the slots it writes (and those an earlier preview wrote, set back).
    expect(calls.filter((c) => c.fn === 'texImage2D')).toEqual([]);
    const sent = own(tex, calls, 'texSubImage2D').map((c) => c.args[3] as number);
    for (const [from] of rowRuns(slots)) expect(sent).toContain(from);
    // The preview's slots hold the preview, every other slot the scene.
    expect(bytes(tex.texels)).toEqual(bytes(whole(preview, origin, tex.texels.length)));
    if (d.x === 0) expect(bytes(tex.texels)).toEqual(before);
    expect(new Set(tex.previewed)).toEqual(new Set(slots));
    // The envelopes follow the preview: the masks are laid where the groups are drawn (point 7).
    expect(envelopeDifference(tex, preview, origin)).toBeNull();
  }
  tex.restore();
  expect(bytes(tex.texels)).toEqual(before);
  expect(envelopeDifference(tex, scene, origin)).toBeNull();
  expect(tex.previewed).toEqual([]);
  expect(tex.scene).toBe(scene);
});

test('ItemTexture : une action puis son annulation, un dépôt d’aperçu compris, en partiel, égalent le remplissage complet (Review Focus 1) ; croissance, autre scène, origine', () => {
  const { s, ids } = lobbyState(), lobby = ids.plans.lobby, scene0 = buildScene(s, lobby, measure, DEFAULT_PARAMS), origin = { x: -3.5, y: 77 };
  const { gl, calls } = recorder(), tex = new ItemTexture(gl);
  tex.writeAll(scene0, origin);
  const before = bytes(tex.texels), mdl = scene0.byId.get(ids.nodes.mdl)!, it = scene0.items[mdl];
  // Previewed, then dropped where previewed: the action's slots and the preview's, from the new scene.
  const visible = computeVisible(scene0, buildIndex(scene0, DEFAULT_PARAMS), { x: it.x, y: it.y, zoom: 1, widthPx: 1600, heightPx: 900 }, DEFAULT_PARAMS);
  const split = previewSplit(scene0, visible, [mdl]), preview = withOffsets(scene0, new Map([[mdl, { x: 30, y: 20 }]]), DEFAULT_PARAMS);
  tex.preview(preview, previewSlots(scene0, preview, split));
  const a = moveNodes(s, lobby, [{ node: ids.nodes.mdl, x: it.x + 30, y: it.y + 20 }]);
  applyOps(s, a.ops);
  const u = updateScene(scene0, s, a.ops, measure, DEFAULT_PARAMS);
  calls.length = 0;
  expect(tex.update(scene0, u.scene, texelSlots(scene0, u.scene, u.changes))).toBe(true);
  expect(calls.filter((c) => c.fn === 'texImage2D')).toEqual([]);
  expect(bytes(tex.texels)).toEqual(bytes(whole(u.scene, origin, tex.texels.length)));
  expect(envelopeDifference(tex, u.scene, origin)).toBeNull();
  expect(tex.previewed).toEqual([]);
  const undo = invertAction(a);
  applyOps(s, undo.ops);
  const back = updateScene(u.scene, s, undo.ops, measure, DEFAULT_PARAMS);
  expect(tex.update(u.scene, back.scene, texelSlots(u.scene, back.scene, back.changes))).toBe(true);
  expect(bytes(tex.texels)).toEqual(bytes(whole(back.scene, origin, tex.texels.length)));
  expect(bytes(tex.texels)).toEqual(before);
  expect(envelopeDifference(tex, back.scene, origin)).toBeNull();
  // A scene it does not hold: nothing written, to be written whole.
  expect(tex.update(u.scene, back.scene, [mdl])).toBe(false);
  expect(tex.scene).toBeNull();
  tex.writeAll(back.scene, origin);
  // Six hundred nodes more: past the rows held, the texture grows and is written whole.
  const many = combine(s, 'Créer', Array.from({ length: 600 }, (_, i) => (x: State) => createNode(x, { plan: lobby, title: `N${i}`, x: i * 10, y: 0, k: 0 })));
  applyOps(s, many.ops);
  const grown = updateScene(back.scene, s, many.ops, measure, DEFAULT_PARAMS);
  expect(grown.scene.items.length).toBeGreaterThan(512);
  calls.length = 0;
  expect(tex.update(back.scene, grown.scene, texelSlots(back.scene, grown.scene, grown.changes))).toBe(true);
  expect(own(tex, calls, 'texImage2D')).toHaveLength(1);
  expect(envelopeDifference(tex, grown.scene, origin)).toBeNull();
  expect(tex.texels.length).toBeGreaterThanOrEqual(textureRows(grown.scene.items.length) * ITEM_TEXTURE_WIDTH * 4);
  expect(bytes(tex.texels)).toEqual(bytes(whole(grown.scene, origin, tex.texels.length)));
  // The origin moved: everything again from the new one, at the same size.
  calls.length = 0;
  tex.writeAll(grown.scene, { x: 5e5, y: -2e5 });
  expect(calls.filter((c) => c.fn === 'texImage2D')).toEqual([]);
  expect(bytes(tex.texels)).toEqual(bytes(whole(grown.scene, { x: 5e5, y: -2e5 }, tex.texels.length)));
  expect(envelopeDifference(tex, grown.scene, { x: 5e5, y: -2e5 })).toBeNull();
});

test('le masque suit l’enveloppe pendant un glissement : le groupe glissé, et ses ancêtres dont l’enveloppe change, réécrits à chaque image (point 7)', () => {
  const { s, ids } = lobbyState(), scene = buildScene(s, ids.plans.lobby, measure, DEFAULT_PARAMS), origin = { x: 40, y: 10 };
  const { gl, calls } = recorder(), tex = new ItemTexture(gl);
  tex.writeAll(scene, origin);
  const g = scene.byId.get(ids.nodes.groupeInduction)!, leaf = scene.byId.get(ids.nodes.solomonoff)!, it = scene.items[g];
  const visible = computeVisible(scene, buildIndex(scene, DEFAULT_PARAMS), { x: it.x, y: it.y, zoom: 0.5, widthPx: 2560, heightPx: 1600 }, DEFAULT_PARAMS);
  // A point just inside the group's envelope on its right, where a connection to one of its members would be hidden.
  const edges = (sc: PlanScene) => { const e: number[] = []; return { e, n: groupEdges(sc, g, origin, e) }; };
  const inside = (sc: PlanScene, x: number, y: number) => { const { e, n } = edges(sc); return envelopeDistance(e, 0, n, x - origin.x, y - origin.y) < 0; };
  const right = Math.max(...it.hull!.map((q) => q.x)) + it.pad! / 2;
  expect(inside(scene, right, it.y)).toBe(true);
  let previous: PlanScene | undefined;
  for (const [moving, d] of [[g, { x: -400, y: 0 }], [g, { x: -800, y: 30 }], [leaf, { x: 900, y: 0 }]] as const) {
    const split = previewSplit(scene, visible, [moving]);
    const preview = withOffsets(scene, new Map([[moving, d]]), DEFAULT_PARAMS, previous), slots = previewSlots(scene, preview, split);
    previous = preview;
    calls.length = 0;
    tex.preview(preview, slots);
    // The texture holds the preview's envelopes: the group moved away (or stretched by its member), the point follows.
    expect(envelopeDifference(tex, preview, origin)).toBeNull();
    const held = (x: number, y: number) => { const e = tex.envelopes.edgesOf(g); return envelopeDistance(e, 0, e.length / EDGE_FLOATS, x - origin.x, y - origin.y) < 0; };
    expect(held(right, it.y)).toBe(inside(preview, right, it.y));
    if (moving === g) expect(held(right + d.x, it.y + d.y)).toBe(true);
    // Only the rows of what it writes: no texture made anew.
    expect(calls.filter((c) => c.fn === 'texImage2D')).toEqual([]);
  }
  expect(inside(previous!, right, it.y)).toBe(true); // the member dragged out to the right stretched the group over it
  tex.restore();
  expect(envelopeDifference(tex, scene, origin)).toBeNull();
});
