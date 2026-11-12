import type { Id, Vec2 } from '@cirrus/core';
import {
  appendTitle, buildHitIndex, buildIndex, buildInstances, type Camera, computeVisible, CURVE_FIELDS, CURVE_FLOATS, emptySelection, type EnvelopeMeshes, FloatList,
  type FontData, foldSignature, GLYPH_FIELDS, GLYPH_FLOATS, type GlyphMeshes, gridLevels, type HitIndex, IndexList, InstanceBuffers, type LayoutOverrides,
  markerCores, newEnvelopeMeshes, offsetPolygon, type Patched, patchEdit, patchPreview, type PlanScene, previewBase, previewEnvelopes, previewSlots,
  type PreviewSplit, type Ranges, type RenderParams, type SceneChanges, type SceneIndex, type Selection, type Shown, SIMPLE_FIELDS, starLayerAlpha, starLayers,
  starsInRect, texelSlots, TITLE_NODE, type TitleSide, updateIndex, vertexNormals, visibleIntruders, type VisibleSet, withLayout,
} from '@cirrus/view';
import type { Gl } from '../gl/context.ts';
import { Texture2D } from '../gl/texture.ts';
import { foundItems } from './found.ts';
import { ItemTexture } from './itemTexture.ts';
import { type AttributeSpec, InstanceMesh, Mesh } from './meshes.ts';
import {
  ATLAS_UNIT, connectionPrograms, createPrograms, ITEMS_UNIT, NO_GROUP, type Programs, setOutlineColor, setParamUniforms, setView, SIMPLE_GLYPH_VERTICES,
  worldPrograms,
} from './shaders.ts';

interface Rect { minX: number; maxX: number; minY: number; maxY: number }

const ARROW: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aOffset', size: 2 }, { name: 'aScale', size: 1 }, { name: 'aFill', size: 1 }, { name: 'aEnd0', size: 3 },
  { name: 'aEnd1', size: 3 }, { name: 'aFold', size: 2 }, { name: 'aConn', size: 1 }, { name: 'aMasks', size: 4 },
];
const ENVELOPE: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aAlpha', size: 1 }, { name: 'aOpen', size: 3 }, { name: 'aClosed', size: 3 }, { name: 'aFoldK', size: 1 },
  { name: 'aParentK', size: 1 },
];
const MARKER: AttributeSpec[] = [{ name: 'aCenter', size: 2 }, { name: 'aCorner', size: 2 }, { name: 'aK', size: 1 }, { name: 'aConn', size: 1 }, { name: 'aMasks', size: 4 }];
const OUTLINE: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aOuter', size: 1 }];
const STAR: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aCorner', size: 2 }];
const SKY: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aWorld', size: 2 }, { name: 'aV', size: 1 }];
/** Instance layouts as the view defines them (its *_FIELDS), each attribute `a` + the field's name in the shader. */
const fields = (list: readonly (readonly [string, number])[]): AttributeSpec[] =>
  list.map(([field, size]) => ({ name: `a${field[0].toUpperCase()}${field.slice(1)}`, size: size as AttributeSpec['size'] }));
const TEXT = fields(GLYPH_FIELDS), SIMPLE = fields(SIMPLE_FIELDS), CURVE = fields(CURVE_FIELDS);
const BOX: AttributeSpec[] = [{ name: 'aSlot', size: 1 }];
const QUAD = [-1, -1, 1, -1, 1, 1, -1, 1];
const QUAD_INDEX = new Uint32Array([0, 1, 2, 0, 2, 3]);

interface Meshes {
  envelope: Mesh; previewEnvelope: Mesh; arrow: Mesh; marker: Mesh; outline: Mesh; drop: Mesh; intruder: Mesh; found: Mesh; stars: Mesh[]; sky: Mesh;
  box: InstanceMesh; simple: InstanceMesh; curve: InstanceMesh; text: InstanceMesh;
}

const envelopeAttributes = (e: EnvelopeMeshes): Record<string, Float32Array> => ({
  aPosition: e.position.view(), aNormal: e.normal.view(), aAlpha: e.alpha.view(), aOpen: e.open.view(), aClosed: e.closed.view(), aFoldK: e.foldK.view(),
  aParentK: e.parentK.view(),
});
const glyphAttributes = (g: GlyphMeshes): Record<string, Float32Array> => ({
  aPosition: g.position.view(), aOffset: g.offset.view(), aScale: g.scale.view(), aFill: g.fill.view(), aEnd0: g.end0.view(), aEnd1: g.end1.view(),
  aFold: g.fold.view(), aConn: g.conn.view(), aMasks: g.masks.view(),
});
/** Past this many ranges rewritten in a buffer, one range from the first to the last is sent (Ruling R23: one call each). */
const RANGES_MAX = 16;
/** The ranges in order, those that touch merged; one range over all of them past RANGES_MAX. */
function coalesce(ranges: Ranges): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]), out: Ranges = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.length > RANGES_MAX ? [[out[0][0], Math.max(...out.map((r) => r[1]))]] : out;
}
/** Whether two sets of layouts stand in for the same parts. */
const sameParts = (a: LayoutOverrides | undefined, b: LayoutOverrides | undefined) =>
  (a?.size ?? 0) === (b?.size ?? 0) && [...(a?.keys() ?? [])].every((k) => b?.has(k));

/**
 * Draws a plan scene (spec 8) with our own WebGL 2 engine (plan 3c task 7, gl/), driven by the item texture (plan 3c
 * task 8): each item's slot holds its position, half sizes, step, folds and style, relative to a local origin; boxes,
 * simple connections (their curves computed in the shaders) and titles read it by slot. Complex bundles are cubics
 * built here, within rebuildBudgetMs per frame, the rest at the next frames, the previous frame drawn whole until then
 * (InstanceBuffers). Everything is built on the main thread.
 * Geometry is rebuilt when the view leaves the prepared rectangle, a group level changes state, zooming out far, or
 * zooming in to where a title or a thin connection left out becomes visible; the item texture is written whole for a
 * new scene and when the camera goes originShiftPx from the origin, and only the rows of the slots an action changed
 * otherwise. Previews and edits go through the texture (plan 3c task 9): a drag, a scale gesture or a layout handle
 * rewrites the texels of what moves and, in place in what is drawn, the complex bundles and titles that touch it, its
 * groups' envelopes drawn apart; an action that cannot have changed the visible set does the same. The groups' envelopes
 * follow the texels' slots (EnvelopeTexture): the connections' masks read them (spec 8.5, point 7). Draw order: sky,
 * stars, envelopes, simple ribbons, complex ribbons, simple glyphs, complex glyphs, boxes, rings, markers, titles. A
 * lost context draws nothing; once restored, everything is made and built again.
 */
export class PlanRenderer {
  /** Called when something must be drawn again without an input: complex bundles left pending, a context restored. */
  onUpdate: () => void = () => {};
  private hasFrame = false;
  private p: RenderParams;
  private readonly g: Gl;
  private readonly font: FontData;
  /** The atlas as decoded, kept to make its texture again after a context loss. */
  private readonly atlasImage: ImageBitmap;
  private atlas!: Texture2D;
  /** The items of the scene drawn, by slot (a preview's written over the state's). */
  private tex!: ItemTexture;
  private programs!: Programs;
  private meshes!: Meshes;
  private starsShown = false;
  private starAlpha = [0, 0, 0];
  /** What is drawn: the state's scene, or a preview over it. */
  private scene: PlanScene | null = null;
  private index: SceneIndex | null = null;
  private transient = false;
  /** The state's scene and its index, kept through a preview: an action updates them, a preview given up comes back to them. */
  private real: { scene: PlanScene; index: SceneIndex } | null = null;
  /**
   * A preview over the state's scene (plan 3c task 9): its scene, split and layouts, the slots its texels hold. Drawn in
   * place when it can be (patchPreview), else built whole, its index then following it for that build only.
   */
  private overlay: { scene: PlanScene; split: PreviewSplit; layouts?: LayoutOverrides; slots: number[] } | null = null;
  /** The preview's envelopes, and where they are drawn among the instances' (previewEnvelopes), null when none. */
  private readonly sideEnvelopes = newEnvelopeMeshes();
  private envelopeDraws: number[] | null = null;
  /** The intruders among what is drawn (visibleIntruders), with their group: the ring and the tooltip (spec 10). */
  private intruderMap = new Map<number, number>();
  /** What is drawn and hit-tested (complete), and the rebuild in progress (pending complex bundles). */
  private readonly frames = new InstanceBuffers<Shown>();
  private hits: HitIndex | null = null;
  private titleSides = new Map<Id, TitleSide>();
  /** The sides the titles had when a preview began: a preview given up that had to be built whole places them so again. */
  private sidesBefore: Map<Id, TitleSide> | null = null;
  private cam: Camera = { x: 0, y: 0, zoom: 1, widthPx: 1, heightPx: 1 };
  private origin: Vec2 = { x: 0, y: 0 };
  private lastRect: Rect | null = null;
  private lastSignature = '';
  private builtZoom = 1;
  private starRect: Rect | null = null;
  private starKey = '';
  private starKs: number[] = [];
  private hot = -1;
  private selection: Selection = emptySelection();
  /** What the search found, or the object a jump framed (plan 6a, D1, D2): by identifier, ringed where the scene shows them. */
  private found: readonly Id[] = [];
  private dropTarget: number | null = null;
  private intruderItems: number[] = [];
  private allCores = false;
  private stale = true;
  /** The rebuild asked for is the origin's move (bench report: 'origin', not 'stale'). */
  private shifted = false;
  /** What is drawn was patched in place since the last frame (a preview, an action): it changed as a rebuild would. */
  private patchedSince = false;

  /** `font`: the titles' (parsed before the first scene: the boxes are measured with it); `atlas`: its MSDF image. */
  constructor(g: Gl, p: RenderParams, font: FontData, atlas: ImageBitmap) {
    this.g = g;
    this.p = p;
    this.font = font;
    this.atlasImage = atlas;
    this.createGpu();
    // The context is back: programs, buffers and textures are new and empty; the item texture and every instance are
    // made again at once.
    g.onRestored = () => {
      this.createGpu();
      this.forgetFrame();
      this.onUpdate();
    };
  }

  private createGpu(): void {
    const gl = this.g.gl;
    const pr = (this.programs = createPrograms(gl));
    setParamUniforms(pr, this.p, this.font);
    this.meshes = {
      envelope: new Mesh(gl, pr.envelope, ENVELOPE, 1024), previewEnvelope: new Mesh(gl, pr.envelope, ENVELOPE, 256), arrow: new Mesh(gl, pr.arrow, ARROW, 2048),
      marker: new Mesh(gl, pr.marker, MARKER, 256),
      outline: new Mesh(gl, pr.outline, OUTLINE, 64), drop: new Mesh(gl, pr.outline, OUTLINE, 64), intruder: new Mesh(gl, pr.outline, OUTLINE, 64),
      found: new Mesh(gl, pr.outline, OUTLINE, 64),
      stars: [0, 1, 2].map(() => new Mesh(gl, pr.star, STAR, 4096)), sky: new Mesh(gl, pr.sky, SKY, 4),
      box: new InstanceMesh(gl, [pr.box], BOX, 1024, true), simple: new InstanceMesh(gl, [pr.simpleRibbon, pr.simpleGlyph], SIMPLE, 4096, true),
      curve: new InstanceMesh(gl, [pr.curve], CURVE, 1024), text: new InstanceMesh(gl, [pr.text], TEXT, 4096),
    };
    this.atlas = new Texture2D(gl, 'linear');
    this.atlas.setImage(this.atlasImage);
    this.tex = new ItemTexture(gl);
  }

  private destroyGpu(): void {
    const m = this.meshes;
    for (const mesh of [m.envelope, m.previewEnvelope, m.arrow, m.marker, m.outline, m.drop, m.intruder, m.found, m.sky, m.box, m.simple, m.curve, m.text, ...m.stars]) {
      mesh.dispose();
    }
    for (const pr of Object.values(this.programs)) pr.dispose();
    this.atlas.dispose();
    this.tex.dispose();
  }

  /** Nothing drawn is kept: the next frame is built at once, the stars too. */
  private forgetFrame(): void {
    this.starKey = '';
    this.stale = true;
    this.hasFrame = false;
  }

  /** The settings are uniforms (set again here) and the instances' geometry: built again at once. */
  setParams(p: RenderParams): void {
    this.p = p;
    setParamUniforms(this.programs, p, this.font);
    this.forgetFrame();
  }

  /**
   * `transient`: a preview of another scene than the state's (an action came during the gesture), built whole with its
   * own index, as every preview was before plan 3c task 9, drawn without forgetting where the connection titles sit; the
   * real scene follows once the action is written, and the state's scene given again (a preview given up) comes back
   * with its index, not built again. `index`: the scene's index kept from before (a tab shown again), not built again.
   * The item texture is written whole for the scene at the next frame.
   */
  setScene(scene: PlanScene, transient = false, index?: SceneIndex): void {
    this.dropPreview();
    if (transient) {
      this.scene = scene;
      this.index = buildIndex(scene, this.p);
    } else if (this.real && scene === this.real.scene) {
      this.scene = scene;
      this.index = this.real.index;
      this.titleSides.clear();
    } else {
      this.real = { scene, index: index ?? buildIndex(scene, this.p) };
      this.scene = scene;
      this.index = this.real.index;
      this.titleSides.clear();
    }
    this.transient = transient;
    this.restart(!transient);
  }

  /**
   * The state's scene after an action (plan 3c, task 6): `scene` follows the scene last given (setScene or updateScene)
   * by `changes`; its index follows them too (updateIndex) instead of being built again, and the item texture's rows
   * of the slots they changed are written again (texelSlots), with those of a preview in progress (a drop), the texture
   * holding that scene. What is drawn is patched in place when the visible set cannot have changed (patchEdit: what
   * the action moved, plan 3c task 9), else its first frame is built at once — before anything is drawn, so that no
   * instance citing a freed or recycled slot meets the new texels.
   */
  updateScene(scene: PlanScene, changes: SceneChanges): void {
    if (!this.real) { this.setScene(scene); return; }
    const prev = this.real.scene, split = this.overlay?.split;
    this.overlay = null;
    this.envelopeDraws = null;
    this.real = { scene, index: updateIndex(this.real.index, scene, changes, this.p) };
    this.scene = scene;
    this.index = this.real.index;
    this.transient = false;
    if (changes.full) this.tex.scene = null;
    else this.tex.update(prev, scene, texelSlots(prev, scene, changes));
    // The titles are placed anew, as for any scene of the state given before (a preview only keeps them).
    this.titleSides.clear();
    const front = this.patchable(scene);
    const patched = front && !front.layouts && front.base === prev ? patchEdit(front, prev, scene, changes, this.p, this.font, this.titleSides, split) : null;
    if (!front || !patched) { this.restart(true); return; }
    Object.assign(front, { scene, base: scene, state: scene });
    this.send(patched);
    this.hits = null;
    this.intruderMap = visibleIntruders(scene, front.visible);
    this.intruderItems = [...this.intruderMap.keys()];
    for (const t of front.inst.titles) this.titleSides.set(t.id, t.side);
    this.updateMarkers();
    this.updateOutline();
  }

  /**
   * A preview over the state's scene (plan 3c task 9): `scene` made from it at the cost of what moves (withOffsets,
   * withMoves; the state's scene itself for a layout handle, `layouts` then standing in for its parts' own), `split`
   * what it changes in the visible set drawn (previewSplit, layoutSplit). Its texels are written; what is drawn is
   * patched in place (patchPreview), its groups' envelopes drawn apart, the rest following by the texture — or, when
   * that cannot be done, built whole at the next frame, its index following it for that build. A preview of another
   * scene than the state's is built whole, as before (setScene, transient).
   */
  preview(scene: PlanScene, split: PreviewSplit, layouts?: LayoutOverrides): void {
    const real = this.real;
    if (!real || previewBase(scene) !== real.scene) {
      let other = scene;
      for (const [part, layout] of layouts ?? []) other = withLayout(other, part, layout);
      this.setScene(other, true);
      return;
    }
    // From a preview of another scene: back to the state's index; the texture holds that other scene (written whole).
    if (this.transient && !this.overlay) this.index = real.index;
    const slots = previewSlots(real.scene, scene, split);
    if (this.tex.scene === real.scene) this.tex.preview(scene, slots);
    if (!this.overlay) this.sidesBefore = new Map(this.titleSides);
    this.overlay = { scene, split, layouts, slots };
    this.scene = scene;
    this.transient = true;
    this.hits = null;
    const front = this.patchable(real.scene);
    const patched = front && front.state === real.scene && (!front.layouts || sameParts(front.layouts, layouts))
      ? patchPreview(front, scene, split, this.p, layouts) : null;
    if (!front || !patched) { this.buildWhole(); return; }
    front.scene = scene;
    this.send(patched);
    this.envelopeDraws = previewEnvelopes(front, scene, split, this.p, this.sideEnvelopes);
    this.meshes.previewEnvelope.update(envelopeAttributes(this.sideEnvelopes), this.sideEnvelopes.index.view());
    this.updateMarkers();
    this.updateOutline();
  }

  /**
   * The preview given up (Escape, a lost focus, a right click, a refusal): the same texels and instances written again
   * from the state's scene (patchPreview), back to the frame before to the bit (Review Focus 5); built whole if the
   * preview had to be. A preview of another scene: the state's scene given again.
   */
  endPreview(): void {
    const real = this.real;
    if (!real || !this.transient) return;
    if (!this.overlay) { this.setScene(real.scene); return; }
    const { split } = this.overlay;
    this.dropPreview();
    this.scene = real.scene;
    this.transient = false;
    this.hits = null;
    const front = this.patchable(real.scene);
    const patched = front && front.base === real.scene && !front.layouts ? patchPreview(front, real.scene, split, this.p) : null;
    if (!front || !patched) {
      this.frames.cancel();
      this.titleSides = this.sidesBefore ?? new Map();
      this.restart(true);
      return;
    }
    front.scene = real.scene;
    this.send(patched);
    this.updateMarkers();
    this.updateOutline();
  }

  /**
   * What is drawn, if it can be patched in place: complete and on screen (no rebuild pending or asked for), the item
   * texture holding `held` (the scene the patch leaves under it); null otherwise.
   */
  private patchable(held: PlanScene): Shown | null {
    const front = this.frames.front;
    return front && !this.frames.building && !this.stale && this.hasFrame && this.tex.scene === held ? front : null;
  }

  /** An in-place preview dropped: its texels written back from the state's scene, its envelopes no longer drawn. */
  private dropPreview(): void {
    if (!this.overlay) return;
    this.tex.restore();
    this.overlay = null;
    this.envelopeDraws = null;
  }

  /** What is drawn is built whole at the next frame (a preview that cannot be drawn in place): a pending build given up. */
  private buildWhole(): void {
    this.frames.cancel();
    this.stale = true;
    this.hasFrame = false;
    this.envelopeDraws = null;
  }

  /** The parts of the instances drawn that a patch rewrote, sent again (each run of instances or vertices once). */
  private send(x: Patched): void {
    const inst = this.frames.front!.inst, m = this.meshes;
    this.patchedSince = true;
    for (const [a, b] of coalesce(x.curves)) m.curve.updateRange(inst.curves.view(), a, b);
    if (x.glyphs.length > 0) {
      const g = glyphAttributes(inst.glyphs);
      for (const [a, b] of coalesce(x.glyphs)) m.arrow.updateRange(g, a, b);
    }
    if (inst.texts.length / GLYPH_FLOATS !== m.text.length) m.text.update(inst.texts.view());
    else for (const [a, b] of coalesce(x.texts)) m.text.updateRange(inst.texts.view(), a, b);
    if (x.envelopes) m.envelope.update(envelopeAttributes(inst.envelopes), inst.envelopes.index.view());
  }

  /**
   * The state's index made to hold the preview's items (`preview` false: the state's own again), for one build of the
   * preview whole: what it moves into view is then drawn, a step it changes folds what it does. O(what moves).
   */
  private indexHolds(preview: boolean): void {
    const o = this.overlay, real = this.real;
    if (!o || !real || this.index !== real.index) return;
    updateIndex(real.index, preview ? o.scene : real.scene, { items: o.slots, parts: [], hierarchy: false, full: false }, this.p);
  }

  /** The state's scene and its index, as kept here: a tab left takes its index along (GraphView's cache). */
  get held(): { scene: PlanScene; index: SceneIndex } | null {
    return this.real;
  }

  /**
   * A new scene drawn: its first frame built at once, nothing kept of the previous visible set (its slots may be
   * another's) — but the intruders, through a preview (`state` false): the ring keeps the state's, as it always did.
   */
  private restart(state: boolean): void {
    this.stale = true;
    this.hasFrame = false;
    this.hits = null;
    if (!state) return;
    this.intruderMap = new Map();
    this.intruderItems = [];
  }

  setCamera(c: Camera): void {
    this.cam = c;
  }

  get camera(): Camera {
    return this.cam;
  }

  /** Visible connection index under the pointer, or null. */
  setHover(conn: number | null): void {
    this.hot = conn ?? -1;
  }

  /** Selected items get an outline; a selected connection is lit like a hovered one (spec 8.5, 9.2). */
  setSelection(sel: Selection): void {
    this.selection = sel;
    this.updateOutline();
  }

  /** The visible connection lit: the hovered one, else the first selected one shown. */
  private lit(): number {
    const front = this.frames.front;
    if (this.hot >= 0 || !front || this.selection.connections.size === 0) return this.hot;
    // Among what is drawn, by the scene it was built for.
    return front.visible.connections.findIndex((vc) => this.selection.connections.has(front.scene.ids[vc.part]));
  }

  /**
   * The ring of what was found (plan 6a, D1, D2), in searchFoundColor: the search's results while its box is open, the
   * object a jump framed a moment after. Never the selection, which Delete and Ctrl+C would act on. By identifier — a
   * node, a phantom, a connection (its ends: foundItems) — and found again in each scene drawn.
   */
  setFound(items: Id[]): void {
    if (items.length === this.found.length && items.every((id, i) => id === this.found[i])) return;
    this.found = items;
    this.meshes.found.update(...this.outlineArrays(this.scene ? foundItems(this.scene, items) : []));
  }

  /** The group that would receive a drop, lit while dragging (spec 10). */
  setDropTarget(item: number | null): void {
    if (item === this.dropTarget) return;
    this.dropTarget = item;
    this.meshes.drop.update(...this.outlineArrays(item === null ? [] : [item]));
  }

  /** While a connection is drawn, 1-to-1 connections show their centre too: a target (spec 11.1). */
  setCoresShown(on: boolean): void {
    if (on === this.allCores) return;
    this.allCores = on;
    this.updateMarkers();
  }

  /**
   * The items drawn that an envelope drawn covers without being its members (spec 10), with that group: an orange ring
   * each, and the tooltip. Found at each new visible set (visibleIntruders), for what is drawn only.
   */
  get intruders(): ReadonlyMap<number, number> {
    return this.intruderMap;
  }

  private updateOutline(): void {
    const scene = this.scene;
    const items = scene ? [...this.selection.items].flatMap((id) => { const i = scene.byId.get(id); return i === undefined ? [] : [i]; }) : [];
    this.meshes.outline.update(...this.outlineArrays(items));
    this.meshes.drop.update(...this.outlineArrays(this.dropTarget === null ? [] : [this.dropTarget]));
    this.meshes.intruder.update(...this.outlineArrays(this.intruderItems));
    this.meshes.found.update(...this.outlineArrays(scene && this.found.length > 0 ? foundItems(scene, this.found) : []));
  }

  /** Rings around items (boxes, discs or padded envelopes), relative to the current origin. */
  private outlineArrays(items: number[]): [Record<string, Float32Array>, Uint32Array] {
    const scene = this.scene;
    const position = new FloatList(), normal = new FloatList(), outer = new FloatList(), index = new IndexList();
    if (scene) {
      for (const i of items) {
        const it = scene.items[i];
        if (!it) continue;
        const poly = it.kind === 'group'
          ? offsetPolygon(it.hull!, it.pad!)
          : it.kind === 'phantom' && it.phantom !== 'node'
            ? offsetPolygon([{ x: it.x, y: it.y }], it.halfW)
            : [{ x: it.x - it.halfW, y: it.y - it.halfH }, { x: it.x + it.halfW, y: it.y - it.halfH }, { x: it.x + it.halfW, y: it.y + it.halfH }, { x: it.x - it.halfW, y: it.y + it.halfH }];
        const normals = vertexNormals(poly);
        const base = outer.length, m = poly.length;
        poly.forEach((q, j) => {
          for (const o of [0, 1]) {
            position.push2(q.x - this.origin.x, q.y - this.origin.y);
            normal.push2(normals[j].x, normals[j].y);
            outer.push1(o);
          }
        });
        for (let j = 0; j < m; j++) {
          const a = base + j * 2, b = base + ((j + 1) % m) * 2;
          index.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }
    return [{ aPosition: position.view(), aNormal: normal.view(), aOuter: outer.view() }, index.view()];
  }

  /** What is under a point, from the instances drawn (complete or not: what is on screen). */
  get hitIndex(): HitIndex | null {
    const front = this.frames.front;
    if (!this.hits && this.hasFrame && front) this.hits = buildHitIndex(front.scene, front.visible, front.inst, this.p);
    return this.hits;
  }

  get visible(): VisibleSet | null {
    return this.frames.front?.visible ?? null;
  }

  /** Compiles every shader now instead of on first sight (ANGLE compiles on first use: a 5 s freeze in the bench). */
  warmUp(): number {
    const t0 = performance.now();
    const cam = this.cam;
    this.cam = { x: 0, y: 0, zoom: 1, widthPx: 64, heightPx: 64 };
    const m = this.meshes;
    const meshes = [[m.envelope, ENVELOPE], [m.arrow, ARROW], [m.marker, MARKER], [m.outline, OUTLINE], [m.stars[0], STAR], [m.sky, SKY]] as const;
    const fill = (specs: AttributeSpec[], n: number) => Object.fromEntries(specs.map((s) => [s.name, new Float32Array(n * s.size)]));
    for (const [mesh, specs] of meshes) mesh.update(fill(specs, 3), new Uint32Array([0, 1, 2]));
    m.box.update(new Int32Array(1));
    m.simple.update(new Int32Array([0, 0, 1, 0, -1]));
    m.curve.update(new Float32Array(CURVE_FLOATS));
    // A readable title, so that the title program draws.
    const glyphs = new FloatList(256);
    const size = this.p.baseFontPx;
    appendTitle(glyphs, this.font, 'Nœud θ∑ ≤', size, 0, size * this.p.lineHeight, 0, 0, TITLE_NODE, -2, 1, NO_GROUP, NO_GROUP, -1);
    m.text.update(glyphs.view());
    this.starsShown = true;
    this.draw();
    for (const [mesh, specs] of meshes) mesh.update(fill(specs, 0), new Uint32Array(0));
    for (const mesh of [m.box, m.simple, m.curve, m.text]) mesh.update(new Float32Array(0));
    this.cam = cam;
    this.stale = true;
    return performance.now() - t0;
  }

  private viewRect(marginPx: number): Rect {
    const c = this.cam;
    const hw = (c.widthPx / 2 + marginPx) / c.zoom, hh = (c.heightPx / 2 + marginPx) / c.zoom;
    return { minX: c.x - hw, maxX: c.x + hw, minY: c.y - hh, maxY: c.y + hh };
  }

  /** Why each rebuild happened (bench report). */
  readonly reasons: Record<string, number> = {};
  /** Layers left out, for cost diagnosis. */
  readonly hidden = new Set<string>();

  /** Why the prepared geometry no longer serves the camera, or null. */
  private rebuildReason(): string | null {
    const front = this.frames.front;
    if (this.stale || !this.lastRect || !this.index || !front) return this.shifted ? 'origin' : 'stale';
    if (foldSignature(this.index, this.cam.zoom, this.p) !== this.lastSignature) return 'fold';
    // A title or a thin complex bundle left out becomes visible (the curves themselves are never sampled again).
    if (this.cam.zoom >= front.inst.revealZoom) return 'reveal';
    if (this.cam.zoom < this.builtZoom / (2 * this.p.curveZoomHeadroom)) return 'zoomOut';
    const v = this.viewRect(0), r = this.lastRect;
    return v.minX < r.minX || v.maxX > r.maxX || v.minY < r.minY || v.maxY > r.maxY ? 'rect' : null;
  }

  /**
   * Draws one frame (nothing while the context is lost); returns whether it did rebuild work (a rebuild started or
   * resumed: what is drawn changes when one completes) or what is drawn was patched since the last one (a preview, an
   * action done in place: what is under a resting pointer may have changed).
   */
  renderFrame(): boolean {
    if (this.g.lost) return false;
    const budget = { deadline: performance.now() + this.p.rebuildBudgetMs };
    let rebuilt = false, swapped = false;
    const scene = this.scene;
    if (scene) {
      const c = this.cam, far = Math.hypot(c.x - this.origin.x, c.y - this.origin.y) * c.zoom > this.p.originShiftPx;
      // Under a preview drawn over the state's scene, the texture holds the state's, the preview's slots written over.
      const held = this.overlay ? this.real!.scene : scene;
      if (this.tex.scene !== held || far) {
        // A scene of the state: the origin comes to the camera (a preview keeps the origin of what it covers).
        if (far || !this.transient) this.origin = { x: c.x, y: c.y };
        this.shifted = far && this.tex.scene === held && !this.stale;
        this.tex.writeAll(held, this.origin);
        if (this.overlay) this.tex.preview(this.overlay.scene, this.overlay.slots);
        this.stale = true;
      }
      // One rebuild at a time: complex bundles pending are built at the next frames, in order, before the camera is
      // looked at again (no bundle is left behind by a camera that keeps moving); the previous frame stays drawn.
      const shown = this.frames.front;
      if (this.frames.building && !this.stale) {
        if (this.frames.resume(budget)) this.show();
        rebuilt = true;
      } else {
        const reason = this.rebuildReason();
        if (reason) {
          this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
          // A new scene, an edit, new settings, a moved origin: its first frame whole, as before; the camera's rebuilds
          // within the budget — but during a preview, whose patches rewrite what is shown (never a pending build).
          this.rebuild(reason === 'stale' || reason === 'origin' || this.transient ? undefined : budget);
          this.shifted = false;
          rebuilt = true;
        }
      }
      swapped = this.frames.front !== shown;
      if (this.frames.building) this.onUpdate();
    }
    this.updateBackground(swapped);
    this.draw();
    const patched = this.patchedSince;
    this.patchedSince = false;
    return rebuilt || patched;
  }

  /** The camera's uniforms, then every layer in order, cleared to the sky first (one draw call per mesh or program). */
  private draw(): void {
    const { cam, p, g } = this, gl = g.gl, pr = this.programs, m = this.meshes;
    const hw = cam.widthPx / 2 / cam.zoom, hh = cam.heightPx / 2 / cam.zoom;
    const lx = cam.x - this.origin.x, ly = cam.y - this.origin.y;
    setView(worldPrograms(pr), cam.zoom, lx, ly, cam.widthPx, cam.heightPx);
    const lit = this.lit();
    for (const x of connectionPrograms(pr)) {
      x.set('uScreen', [lx - hw, ly - hh, lx + hw, ly + hh]);
      x.set('uFadeWorld', p.connectionFadePx / cam.zoom);
      x.set('uHot', lit);
    }
    pr.marker.set('uHot', lit);
    // A title is lit by the hover only, as BitmapText's alpha was (a selected connection lights its line, not its title).
    pr.text.set('uHot', this.hot);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, g.canvas.width, g.canvas.height);
    gl.clearColor(p.skyColor[0], p.skyColor[1], p.skyColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.atlas.bind(ATLAS_UNIT);
    this.tex.bind(ITEMS_UNIT);
    // Layers left out for cost diagnosis (bench: CIRRUS_BENCH_HIDE=sky,stars,env,ribbon,glyph,box,marker,text,outline;
    // "all" for the floor pass, an empty frame).
    const off = (layer: string) => this.hidden.has('all') || this.hidden.has(layer);
    if (!off('sky')) m.sky.draw();
    if (this.starsShown && !off('stars')) {
      m.stars.forEach((mesh, i) => {
        if (mesh.empty) return;
        pr.star.set('uLayerAlpha', this.starAlpha[i]);
        mesh.draw();
      });
    }
    const strip = 2 * (p.curveSegments + 1);
    if (!off('env')) {
      // A preview's groups: each envelope drawn from its own mesh in place of the instances' one (the order is kept).
      const d = this.envelopeDraws;
      let at = 0;
      if (d) for (let q = 0; q < d.length; q += 4) { m.envelope.draw(at, d[q]); m.previewEnvelope.draw(d[q + 2], d[q + 3]); at = d[q + 1]; }
      m.envelope.draw(at);
    }
    if (!off('ribbon')) {
      m.simple.draw(0, 2 * strip + 2);
      m.curve.draw(0, strip);
    }
    if (!off('glyph')) {
      m.simple.draw(1, SIMPLE_GLYPH_VERTICES, gl.TRIANGLES);
      m.arrow.draw();
    }
    if (!off('box')) m.box.draw();
    if (!off('outline')) {
      for (const [ring, c] of [[m.intruder, p.intruderColor], [m.found, p.searchFoundColor], [m.drop, p.dropColor], [m.outline, p.selectionColor]] as const) {
        if (ring.empty) continue;
        setOutlineColor(pr, c);
        ring.draw();
      }
    }
    if (!off('marker')) m.marker.draw();
    if (!off('text')) m.text.draw();
  }

  /** Glyph instances built and sent for the frame shown, those faded below 1 % included (bench: the densest view's count). */
  get glyphCount(): number {
    return this.meshes.text.length;
  }

  /** Marks the camera's surroundings prepared, so the rebuild is not asked for again while it is being built. */
  private prepare(): void {
    const cam = this.cam;
    this.lastRect = this.viewRect(this.p.viewMarginPx);
    this.lastSignature = foldSignature(this.index!, cam.zoom, this.p);
    this.builtZoom = cam.zoom;
    this.stale = false;
  }

  /**
   * The visible set from the camera and its instances, built into storage that is not on screen; shown at once if
   * complete, else at the frame that completes it (complex bundles beyond the budget left pending).
   */
  private rebuild(budget: { deadline: number } | undefined): void {
    this.prepare();
    const scene = this.scene!, layouts = this.overlay?.layouts;
    // The state's index holds the preview's items for this computeVisible only: it is also a tab's cache.
    let visible: VisibleSet;
    this.indexHolds(true);
    try { visible = computeVisible(scene, this.index!, this.cam, this.p); } finally { this.indexHolds(false); }
    const inst = buildInstances(scene, visible, this.cam, this.origin, this.p, budget, this.font, this.titleSides, this.frames.storage(), layouts);
    const state = this.overlay ? this.real!.scene : scene;
    if (this.frames.start({ scene, base: scene, state, visible, inst, cam: this.cam, layouts })) this.show();
  }

  /**
   * The rebuild just completed replaces what was drawn, all at once (fix 1 of plan 3c task 8): until then the previous
   * frame stayed drawn and hit-tested whole, its visible set with it, as the render worker's did — a camera rebuild
   * moves no item, and whatever moves one (an action, a preview, new settings, the origin) builds whole.
   */
  private show(): void {
    const { scene, visible, inst } = this.frames.front!, m = this.meshes;
    this.hasFrame = true;
    this.envelopeDraws = null;
    // The hovered index belonged to the previous visible set (I1 of the review); hover() sets it again.
    this.hot = -1;
    // Built on the first hover query: navigation does not wait for it.
    this.hits = null;
    if (scene === this.real?.scene) {
      this.intruderMap = visibleIntruders(scene, visible);
      this.intruderItems = [...this.intruderMap.keys()];
    }
    m.envelope.update(envelopeAttributes(inst.envelopes), inst.envelopes.index.view());
    m.box.update(inst.boxes.view());
    m.simple.update(inst.simple.view());
    m.curve.update(inst.curves.view());
    m.arrow.update(glyphAttributes(inst.glyphs), inst.glyphs.index.view());
    m.text.update(inst.texts.view());
    this.updateMarkers();
    this.updateOutline();
    for (const t of inst.titles) this.titleSides.set(t.id, t.side);
  }

  /** Bundle markers: the complex bundles' with several members; while a connection is drawn, every core (spec 11.1). */
  private updateMarkers(): void {
    const center = new FloatList(), corner = new FloatList(), k = new FloatList(), conn = new FloatList(), masks = new FloatList(), index = new IndexList();
    // The cores of what is drawn, read in the scene its instances were built for (an action may have compacted the
    // scene since: the slots would be another's).
    const front = this.frames.front, cores = front ? markerCores(front.scene, front.inst, this.cam.zoom, this.p, this.allCores) : [];
    cores.forEach((c, j) => {
      for (let q = 0; q < 4; q++) {
        center.push2(c.x, c.y);
        corner.push2(QUAD[q * 2], QUAD[q * 2 + 1]);
        k.push1(c.kMax);
        conn.push1(c.conn);
        masks.push2(c.masks[0], c.masks[1]);
        masks.push2(c.masks[2], c.masks[3]);
      }
      const v = j * 4;
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    });
    this.meshes.marker.update({ aCenter: center.view(), aCorner: corner.view(), aK: k.view(), aConn: conn.view(), aMasks: masks.view() }, index.view());
  }

  private updateBackground(rebuilt: boolean): void {
    const { cam, p } = this;
    const stars = p.background === 'stars';
    // Sky quad in screen space, with the local world position of its corners for the grid.
    const w = cam.widthPx, h = cam.heightPx;
    const tl = { x: cam.x - w / 2 / cam.zoom - this.origin.x, y: cam.y - h / 2 / cam.zoom - this.origin.y };
    const br = { x: tl.x + w / cam.zoom, y: tl.y + h / cam.zoom };
    this.meshes.sky.update({
      aPosition: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      aWorld: new Float32Array([tl.x, tl.y, br.x, tl.y, br.x, br.y, tl.x, br.y]),
      aV: new Float32Array([0, 0, 1, 1]),
    }, QUAD_INDEX);
    const sky = this.programs.sky;
    sky.set('uZoom', cam.zoom);
    sky.set('uSize', [w, h]);
    const levels = stars ? [] : gridLevels(cam.zoom, p).slice(-3);
    const spacing = [0, 0, 0], alpha = [0, 0, 0];
    levels.forEach((l, i) => {
      spacing[i] = l.spacingWorld;
      alpha[i] = l.alpha * p.backgroundOpacity;
      const mod = (v: number) => ((v % l.spacingWorld) + l.spacingWorld) % l.spacingWorld;
      sky.set(`uOffset${i}`, [mod(this.origin.x), mod(this.origin.y)]);
    });
    sky.set('uSpacing', spacing);
    sky.set('uGridAlpha', alpha);

    this.starsShown = stars;
    if (!stars) return;
    const ks = starLayers(cam.zoom, p);
    const key = ks.join(',');
    const v = this.viewRect(0), r = this.starRect;
    const outside = !r || v.minX < r.minX || v.maxX > r.maxX || v.minY < r.minY || v.maxY > r.maxY;
    if (rebuilt || outside || key !== this.starKey) {
      this.starKey = key;
      this.starKs = ks;
      this.starRect = this.viewRect(Math.max(cam.widthPx, cam.heightPx) / 2);
      this.meshes.stars.forEach((mesh, i) => {
        const k = ks[i];
        if (k === undefined) { mesh.update({ aPosition: new Float32Array(0), aCorner: new Float32Array(0) }, new Uint32Array(0)); return; }
        const rr = this.starRect!;
        const list = starsInRect({ x: rr.minX, y: rr.minY, w: rr.maxX - rr.minX, h: rr.maxY - rr.minY }, k, p.starSeed, p);
        const pos = new Float32Array(list.length * 8), corner = new Float32Array(list.length * 8), index = new Uint32Array(list.length * 6);
        list.forEach((st, j) => {
          const x = st.x - this.origin.x, y = st.y - this.origin.y;
          pos.set([x, y, x, y, x, y, x, y], j * 8);
          corner.set(QUAD, j * 8);
          const o = j * 4;
          index.set([o, o + 1, o + 2, o, o + 2, o + 3], j * 6);
        });
        mesh.update({ aPosition: pos, aCorner: corner }, index);
      });
    }
    this.starAlpha = [0, 1, 2].map((i) => {
      const k = this.starKs[i];
      return k === undefined ? 0 : starLayerAlpha(k, cam.zoom, p) * p.backgroundOpacity;
    });
  }

  destroy(): void {
    this.g.onRestored = () => {};
    this.destroyGpu();
    this.atlasImage.close();
  }
}
