import type { Vec2 } from '@cirrus/core';
import { ITEM_TEXTURE_WIDTH, itemTexels, type PlanScene, rowRuns, textureRows } from '@cirrus/view';
import { Texture2D, type TextureGl } from '../gl/texture.ts';
import { EnvelopeTexture } from './envelopeTexture.ts';

/**
 * The item texture (plan 3c task 8) with its rows on the CPU: the items of one scene relative to an origin, and the
 * slots a preview wrote over it (plan 3c task 9). Written whole for a scene it does not hold, at a new origin and when
 * it must grow; otherwise slot by slot, each run of rows they are in sent by one texSubImage2D (rowRuns). Extracted
 * from PlanRenderer to be tested without WebGL (Ruling of plan 3c task 9). The groups' envelopes, which the connections'
 * masks read (spec 8.5, point 7), follow the same slots (EnvelopeTexture).
 */
export class ItemTexture {
  readonly texture: Texture2D;
  readonly envelopes: EnvelopeTexture;
  /** The texture's rows (SLOT_FLOATS per slot), what partial writes start from; doubled when short (Ruling R23). */
  texels = new Float32Array(ITEM_TEXTURE_WIDTH * 4);
  /** The scene whose items it holds (null: to be written whole), relative to `origin`. */
  scene: PlanScene | null = null;
  origin: Vec2 = { x: 0, y: 0 };
  /** Slots written from a preview of `scene` instead: written back from `scene` when it ends. */
  private over: number[] = [];

  constructor(gl: TextureGl) {
    this.texture = new Texture2D(gl, 'nearest');
    this.texture.allocate(ITEM_TEXTURE_WIDTH, 1);
    this.envelopes = new EnvelopeTexture(gl);
  }

  /** The slots a preview holds now. */
  get previewed(): readonly number[] {
    return this.over;
  }

  /** The whole scene, relative to `origin`. */
  writeAll(scene: PlanScene, origin: Vec2): void {
    this.reserve(scene.items.length);
    this.origin = origin;
    itemTexels(scene, origin, this.texels);
    this.texture.allocate(ITEM_TEXTURE_WIDTH, this.texels.length / (ITEM_TEXTURE_WIDTH * 4));
    this.texture.setRows(this.texels, 0, Math.max(1, textureRows(scene.items.length)));
    this.envelopes.writeAll(scene, origin);
    this.scene = scene;
    this.over = [];
  }

  /**
   * `scene` after an action that led from `prev` to it, changing `slots` (texelSlots): only them, and a preview's
   * slots written from `scene` too (a drop). Returns false, holding nothing, if it did not hold `prev`: written whole
   * later. Whole if it must grow.
   */
  update(prev: PlanScene, scene: PlanScene, slots: readonly number[]): boolean {
    if (this.scene !== prev) { this.scene = null; return false; }
    const all = this.over.length > 0 ? [...slots, ...this.over] : slots;
    if (this.reserve(scene.items.length)) { this.writeAll(scene, this.origin); return true; }
    this.write(scene, all);
    this.scene = scene;
    this.over = [];
    return true;
  }

  /**
   * A preview of the scene it holds: `slots` written from `preview`, those a previous preview wrote and this one does
   * not set back from the scene.
   */
  preview(preview: PlanScene, slots: readonly number[]): void {
    if (!this.scene) return;
    if (this.over.length > 0) {
      const now = new Set(slots), back = this.over.filter((i) => !now.has(i));
      if (back.length > 0) this.write(this.scene, back);
    }
    this.write(preview, slots);
    this.over = [...slots];
  }

  /** The preview's slots written back from the scene it holds. */
  restore(): void {
    if (this.scene && this.over.length > 0) this.write(this.scene, this.over);
    this.over = [];
  }

  /** The item texture on `unit`, the envelopes' index and edges on the two next ones. */
  bind(unit: number): void {
    this.texture.bind(unit);
    this.envelopes.bind(unit + 1, unit + 2);
  }

  dispose(): void {
    this.texture.dispose();
    this.envelopes.dispose();
  }

  private write(scene: PlanScene, slots: readonly number[]): void {
    itemTexels(scene, this.origin, this.texels, slots);
    for (const [from, to] of rowRuns(slots)) this.texture.setRows(this.texels, from, to);
    this.envelopes.write(scene, this.origin, slots);
  }

  /** Room for `slots` slots, doubling; returns whether the rows grew (everything is then to be written). */
  private reserve(slots: number): boolean {
    const need = Math.max(1, textureRows(slots)) * ITEM_TEXTURE_WIDTH * 4;
    if (need <= this.texels.length) return false;
    let size = this.texels.length * 2;
    while (size < need) size *= 2;
    const next = new Float32Array(size);
    next.set(this.texels);
    this.texels = next;
    return true;
  }
}
