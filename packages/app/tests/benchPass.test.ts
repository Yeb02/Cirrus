import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import {
  buildIndex, buildScene, DEFAULT_PARAMS as P, dropEffects, dropTarget, fitBounds, isLive, ITEM_TEXTURE_WIDTH, type PlanScene, textPx, worldToScreen,
} from '@cirrus/view';
import { beforeAll, expect, test } from 'vitest';
import { type BufferGl, DynamicBuffer } from '../src/renderer/gl/buffers.ts';
import { Texture2D, type TextureGl } from '../src/renderer/gl/texture.ts';
import { countUploads, denseAt, denseLayout, groupChangingDrop, meshBuffers, timeMethods } from '../src/renderer/bench.ts';

// The bench's own measures in the interface (R46 of plan 3c, task 10): bytes sent per drag frame, time of chosen
// methods, the group-changing drop of the edit pass, the dense view at the readability threshold.

const ARRAY_BUFFER = 0x8892;

/** A WebGL stand-in for buffers and textures: every call does nothing; the counter wraps the uploads. */
function stubGl() {
  const nop = () => {};
  return {
    TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601, NEAREST: 0x2600, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_FLIP_Y_WEBGL: 0x9240, RGBA8: 0x8058, RGBA: 0x1908, RG: 0x8227,
    RED: 0x1903, UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140b, RGBA32F: 0x8814, FLOAT: 0x1406, TEXTURE0: 0x84c0, DYNAMIC_DRAW: 0x88e8,
    createBuffer: () => ({}), bindBuffer: nop, bufferData: nop, bufferSubData: nop, deleteBuffer: nop,
    createTexture: () => ({}), bindTexture: nop, texParameteri: nop, pixelStorei: nop, texImage2D: nop, texSubImage2D: nop, activeTexture: nop, deleteTexture: nop,
  };
}

test('octets envoyés : chaque envoi compté à sa taille, tampons et texture à part, les allocations à zéro, puis les méthodes rendues', () => {
  const gl = stubGl(), own = gl.bufferSubData;
  const count = countUploads(gl as unknown as WebGL2RenderingContext);
  // Made with room for 64 bytes: bufferData of a size, nothing sent.
  const b = new DynamicBuffer(gl as unknown as BufferGl, ARRAY_BUFFER, 64);
  expect([count.buffers, count.textures]).toEqual([0, 0]);
  const data = new Float32Array(100);
  b.upload(data.subarray(0, 10));
  // 120 bytes: the capacity doubled (a size again), then the data.
  b.upload(data.subarray(0, 30));
  b.uploadRange(data, 2, 5);
  expect(count.buffers).toBe(40 + 120 + 12);
  // bufferData given data sends it; a length counts elements from srcOffset.
  (gl.bufferData as (...a: unknown[]) => void)(ARRAY_BUFFER, new Float32Array(8), gl.DYNAMIC_DRAW);
  (gl.bufferSubData as (...a: unknown[]) => void)(ARRAY_BUFFER, 0, new Uint32Array(20), 4);
  expect(count.buffers).toBe(172 + 32 + 64);

  // The item texture: its storage made (no data), then two rows of 1 024 RGBA32F texels.
  const t = new Texture2D(gl as unknown as TextureGl, 'nearest');
  t.allocate(ITEM_TEXTURE_WIDTH, 4);
  expect(count.textures).toBe(0);
  t.setRows(new Float32Array(ITEM_TEXTURE_WIDTH * 4 * 4), 1, 3);
  expect(count.textures).toBe(2 * ITEM_TEXTURE_WIDTH * 16);
  // An 8-bit image (the atlas), 8 × 4 texels.
  (gl.texImage2D as (...a: unknown[]) => void)(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { width: 8, height: 4 });
  expect(count.textures).toBe(2 * ITEM_TEXTURE_WIDTH * 16 + 128);

  count.reset();
  expect([count.buffers, count.textures, count.byBuffer.size]).toEqual([0, 0, 0]);
  // Each buffer object's bytes, by the one bound when they were sent.
  const b2 = new DynamicBuffer(gl as unknown as BufferGl, ARRAY_BUFFER, 64);
  b.upload(data.subarray(0, 4));
  b2.upload(data.subarray(0, 6));
  b.uploadRange(data, 0, 2);
  expect([count.byBuffer.get(b.buffer), count.byBuffer.get(b2.buffer), count.buffers]).toEqual([24, 24, 48]);
  count.restore();
  expect(gl.bufferSubData).toBe(own);
  b.upload(data.subarray(0, 10));
  expect(count.buffers).toBe(48);
});

test('maillages du moteur : chaque tampon nommé par son maillage, la taille de ses tampons de sommets ou d’instances au dernier envoi entier', () => {
  const curve = {}, position = {}, index = {}, star0 = {}, star1 = {};
  const renderer = {
    meshes: {
      curve: { instances: { buffer: curve, used: 400 }, corners: { buffer: {}, used: 32 } },
      arrow: { buffers: new Map([['aPosition', { buffer: { buffer: position, used: 80 } }]]), index: { buffer: index, used: 12 } },
      stars: [{ buffers: new Map([['aPosition', { buffer: { buffer: star0, used: 8 } }]]) }, { buffers: new Map([['aPosition', { buffer: { buffer: star1, used: 16 } }]]) }],
    },
  };
  const { names, sizes } = meshBuffers(renderer);
  expect([names.get(curve), names.get(position), names.get(index), names.get(star0), names.get(star1)]).toEqual(['curve', 'arrow', 'arrow', 'stars', 'stars']);
  expect(Object.fromEntries(sizes)).toEqual({ curve: 400, arrow: 80, stars: 24 });
  expect(meshBuffers({}).names.size).toBe(0);
});

test('temps de méthodes : chaque appel compté une fois, un appel imbriqué dans le temps de l’appel qui l’entoure, puis les méthodes rendues', () => {
  let clock = 0;
  class Thing {
    inner(): string { clock += 2; return 'i'; }
    outer(): string { clock += 3; return `${this.inner()}o`; }
  }
  const thing = new Thing();
  const timed = timeMethods(thing, ['outer', 'inner'], () => clock);
  expect(thing.outer()).toBe('io');
  expect(timed.ms).toBe(5);
  thing.inner();
  expect(timed.ms).toBe(7);
  timed.reset();
  expect(timed.ms).toBe(0);
  timed.restore();
  expect(Object.hasOwn(thing, 'outer')).toBe(false);
  thing.outer();
  expect(timed.ms).toBe(0);
  expect(() => timeMethods(thing, ['absente'])).toThrow(/absente/);
});

let sc: PlanScene, ids: FixtureIds;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-app-benchpass-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  const s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  sc = buildScene(s, ids.plans.lobby, (t) => Math.max(1, Math.ceil(t.length / 23)), P);
});

test('dépôt qui change de groupe : un point de l’écran, hors d’un clic du nœud, où le dépôt avec Alt le fait entrer dans un autre groupe', () => {
  const index = buildIndex(sc, P), cam = fitBounds(sc.bounds, 1600, 1000, P);
  const node = sc.items.findIndex((it, i) => isLive(sc, i) && it.kind === 'node' && it.parent >= 0);
  expect(node).toBeGreaterThanOrEqual(0);
  const r = groupChangingDrop(sc, node, cam, P, index);
  expect(r).not.toBeNull();
  const { at, target } = r!;
  expect(sc.items[target].kind).toBe('group');
  expect(target).not.toBe(sc.items[node].parent);
  expect(dropTarget(sc, at, [node], cam.zoom, P, index)).toBe(target);
  expect(dropEffects(sc, [node], target, true)).toEqual([{ item: node, leave: true, enter: target }]);
  const q = worldToScreen(cam, at.x, at.y), from = worldToScreen(cam, sc.items[node].x, sc.items[node].y);
  expect(q.x >= 0 && q.x <= cam.widthPx && q.y >= 0 && q.y <= cam.heightPx).toBe(true);
  expect(Math.hypot(q.x - from.x, q.y - from.y)).toBeGreaterThan(P.clickSlopPx);
  // No group on screen: no point.
  expect(groupChangingDrop(sc, node, { ...cam, x: cam.x + 1e7 }, P, index)).toBeNull();
});

test('vue dense : une grille de boîtes sans chevauchement, titres à 6 px puis 8 px, chaque caméra du parcours dans la grille, ≈ 3 000 titres préparés au seuil', () => {
  const W = 2560, H = 1600, d = denseLayout(W, H, P), m = P.viewMarginPx;
  expect(textPx(0, d.zoomLo, P)).toBeCloseTo(P.textFade[0], 9);
  expect(textPx(0, d.zoomHi, P)).toBeCloseTo(P.textFade[1], 9);
  // One-line boxes, 46 world units high at step 0: the cells leave a gap between them.
  expect(d.cellW).toBeGreaterThan(P.boxWidth);
  expect(d.cellH).toBeGreaterThan(P.lineHeight * P.baseFontPx + 2 * P.boxPadY);
  const at = Array.from({ length: d.cols * d.rows }, (_, j) => denseAt(d, j));
  expect(new Set(at.map((q) => `${q.x},${q.y}`)).size).toBe(at.length);
  const maxX = (d.cols - 1) * d.cellW, maxY = (d.rows - 1) * d.cellH;
  expect(d.keys[0].t).toBe(0);
  for (const { cam } of d.keys) {
    const hw = (W / 2 + m) / cam.zoom, hh = (H / 2 + m) / cam.zoom;
    expect(cam.x - hw).toBeGreaterThanOrEqual(-1e-6);
    expect(cam.x + hw).toBeLessThanOrEqual(maxX + 1e-6);
    expect(cam.y - hh).toBeGreaterThanOrEqual(-1e-6);
    expect(cam.y + hh).toBeLessThanOrEqual(maxY + 1e-6);
  }
  // At the threshold, the boxes whose centre is in the prepared rectangle, and on screen.
  const c = d.keys[0].cam, count = (mx: number) => at.filter((q) => Math.abs(q.x - c.x) <= (W / 2 + mx) / c.zoom && Math.abs(q.y - c.y) <= (H / 2 + mx) / c.zoom).length;
  expect(count(m)).toBeGreaterThan(2800);
  expect(count(m)).toBeLessThan(4000);
  expect(count(0)).toBeGreaterThan(1800);
  expect(d.keys.some((k) => k.cam.zoom === d.zoomHi)).toBe(true);
});
