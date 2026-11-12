import type { Vec2 } from '@cirrus/core';
import { EDGE_FLOATS, ENVELOPE_TEXTURE_WIDTH, GONE_ITEM, groupEdges, type PlanScene } from '@cirrus/view';
import { Texture2D, type TextureGl } from '../gl/texture.ts';

const W = ENVELOPE_TEXTURE_WIDTH;
const rowsFor = (texels: number) => Math.max(1, Math.ceil(texels / W));

/**
 * The groups' padded envelopes as the connection shaders read them for their masks (spec 8.5, point 7 of 2026-11-12):
 * an index of one RGBA32F texel per item slot — the first edge, the edge count (0 for any other item), the room held —
 * and a pool of one texel per edge (geometry/mask.ts, envelopeEdges), relative to the item texture's origin. Kept by
 * the item texture (ItemTexture), slot for slot with its texels: written whole with them, and only the slots they write
 * otherwise (an action, a preview and its end). An envelope rewritten in place when its edges fit in its room, else
 * appended with half again as much room; the pool keeps a quarter more than it holds, and is packed when written whole.
 * Extracted to be tested without WebGL, as the item texture.
 */
export class EnvelopeTexture {
  readonly index: Texture2D;
  readonly edges: Texture2D;
  /** The index's rows (four floats per slot), and the pool's (EDGE_FLOATS per edge): what partial writes start from. */
  indexTexels = new Float32Array(W * 4);
  edgeTexels = new Float32Array(W * EDGE_FLOATS);
  /** Edges in use in the pool (room included). */
  top = 0;
  private readonly scratch: number[] = [];

  constructor(gl: TextureGl) {
    this.index = new Texture2D(gl, 'nearest');
    this.edges = new Texture2D(gl, 'nearest');
    this.index.allocate(W, 1);
    this.edges.allocate(W, 1);
  }

  /** Every group of the scene, relative to `origin`, the pool packed. */
  writeAll(scene: PlanScene, origin: Vec2): void {
    const n = scene.items.length;
    if (this.indexTexels.length < rowsFor(n) * W * 4) this.indexTexels = new Float32Array(rowsFor(n) * W * 4);
    else this.indexTexels.fill(0);
    this.top = 0;
    for (let i = 0; i < n; i++) this.place(scene, i, origin, false);
    this.reservePool(this.top + (this.top >> 2));
    this.sendAll();
  }

  /** The slots `slots` from `scene`, relative to `origin`: only the rows they change are sent (all of them if the pool grew). */
  write(scene: PlanScene, origin: Vec2, slots: readonly number[]): void {
    if (scene.items.length > this.indexTexels.length / 4) { this.writeAll(scene, origin); return; }
    const capacity = this.edgeTexels.length, indexRows = new Set<number>(), edgeRows = new Set<number>();
    for (const i of slots) {
      const at = this.place(scene, i, origin, true);
      indexRows.add(Math.floor(i / W));
      if (at) for (let r = Math.floor(at[0] / W); r <= Math.floor((at[0] + at[1] - 1) / W); r++) edgeRows.add(r);
    }
    if (this.edgeTexels.length !== capacity || this.index.height !== this.indexTexels.length / (W * 4)) { this.sendAll(); return; }
    for (const [from, to] of runs(indexRows)) this.index.setRows(this.indexTexels, from, to);
    for (const [from, to] of runs(edgeRows)) this.edges.setRows(this.edgeTexels, from, to);
  }

  /** Group i's edges as they are held (tests): EDGE_FLOATS each. */
  edgesOf(i: number): number[] {
    const o = 4 * i, start = this.indexTexels[o], count = this.indexTexels[o + 1];
    return [...this.edgeTexels.subarray(start * EDGE_FLOATS, (start + count) * EDGE_FLOATS)];
  }

  bind(indexUnit: number, edgesUnit: number): void {
    this.index.bind(indexUnit);
    this.edges.bind(edgesUnit);
  }

  dispose(): void {
    this.index.dispose();
    this.edges.dispose();
  }

  /** Slot i written: its edges in its room or appended; returns the edges written [start, count], null for none. */
  private place(scene: PlanScene, i: number, origin: Vec2, again: boolean): [number, number] | null {
    const idx = this.indexTexels, o = 4 * i, it = scene.items[i];
    if (it === GONE_ITEM || it.kind !== 'group') { idx[o + 1] = 0; return null; }
    const e = this.scratch;
    e.length = 0;
    const count = groupEdges(scene, i, origin, e);
    let start = idx[o], room = idx[o + 2];
    if (count > room) {
      room = again ? count + (count >> 1) : count;
      start = this.top;
      this.top += room;
      this.reservePool(this.top);
    }
    this.edgeTexels.set(e, start * EDGE_FLOATS);
    idx[o] = start;
    idx[o + 1] = count;
    idx[o + 2] = room;
    return count > 0 ? [start, count] : null;
  }

  /** Room in the pool for `edges` edges, doubling (whole rows). */
  private reservePool(edges: number): void {
    const need = rowsFor(edges) * W * EDGE_FLOATS;
    if (need <= this.edgeTexels.length) return;
    let size = this.edgeTexels.length * 2;
    while (size < need) size *= 2;
    const next = new Float32Array(size);
    next.set(this.edgeTexels);
    this.edgeTexels = next;
  }

  private sendAll(): void {
    const indexRows = this.indexTexels.length / (W * 4), edgeRows = this.edgeTexels.length / (W * EDGE_FLOATS);
    this.index.allocate(W, indexRows);
    this.index.setRows(this.indexTexels, 0, indexRows);
    this.edges.allocate(W, edgeRows);
    this.edges.setRows(this.edgeTexels, 0, edgeRows);
  }
}

/** Rows as runs [from, to) in order. */
function runs(rows: Set<number>): [number, number][] {
  const out: [number, number][] = [];
  for (const r of [...rows].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === r) last[1] = r + 1;
    else out.push([r, r + 1]);
  }
  return out;
}
