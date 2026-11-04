import { buildFixture } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScene, DEFAULT_PARAMS, ITEM_TEXTURE_WIDTH, itemTexels, rowRuns, SLOT_FLOATS, textureRows } from '@cirrus/view';
import { expect, test } from 'vitest';
import { type TextureGl, Texture2D } from '../src/renderer/gl/texture.ts';

/** The calls a Texture2D makes, recorded with the data they would send (no WebGL under Node). */
function recorder() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); };
  // WebGL raises INVALID_OPERATION when the rows asked for run past the data from srcOffset (4 floats per texel).
  const subImage = (...args: unknown[]) => {
    const [, , , , w, h, , , data, offset] = args as [number, number, number, number, number, number, number, number, Float32Array, number];
    if (offset + w * h * 4 > data.length) throw new Error(`texSubImage2D : ${w} × ${h} texels depuis ${offset}, au-delà des ${data.length} flottants`);
    calls.push({ fn: 'texSubImage2D', args });
  };
  const constants = {
    TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601, NEAREST: 0x2600, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_FLIP_Y_WEBGL: 0x9240, RGBA8: 0x8058, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    RGBA32F: 0x8814, FLOAT: 0x1406, TEXTURE0: 0x84c0,
  };
  const gl = {
    ...constants, createTexture: () => ({}) as WebGLTexture, bindTexture: rec('bindTexture'), texParameteri: rec('texParameteri'), pixelStorei: rec('pixelStorei'),
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
