import type { Id, Vec2 } from '@cirrus/core';
import {
  buildFrame, buildHitIndex, buildIndex, type Camera, computeVisible, emptySelection, FloatList, type FontData, foldSignature, type FrameGeometry,
  GLYPH_FLOATS, gridLevels, type HitIndex, IndexList, offsetPolygon, type PlanScene, type RenderParams, type SceneChanges, type SceneIndex,
  type Selection, starLayerAlpha, starLayers, starsInRect, type TitleSide, updateIndex, vertexNormals, visibleIntruders, type VisibleSet,
} from '@cirrus/view';
import type { Gl } from '../gl/context.ts';
import { Texture2D } from '../gl/texture.ts';
import { type AttributeSpec, InstanceMesh, Mesh } from './meshes.ts';
import { createPrograms, NO_GROUP, type Programs, setOutlineColor, setParamUniforms, setView } from './shaders.ts';
import { type PackedFrame, packFrame } from './frameData.ts';
import type { FrameRequest } from './frameWorker.ts';

interface Rect { minX: number; maxX: number; minY: number; maxY: number }

const RIBBON: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aPosition2', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aNormal2', size: 2 },
  { name: 'aScale', size: 1 }, { name: 'aSide', size: 1 }, { name: 'aDist', size: 1 }, { name: 'aEnd0', size: 3 }, { name: 'aEnd1', size: 3 },
  { name: 'aFold', size: 2 }, { name: 'aConn', size: 1 },
];
const ARROW: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aPosition2', size: 2 }, { name: 'aOffset', size: 2 }, { name: 'aOffset2', size: 2 },
  { name: 'aScale', size: 1 }, { name: 'aFill', size: 1 }, { name: 'aEnd0', size: 3 }, { name: 'aEnd1', size: 3 }, { name: 'aFold', size: 2 }, { name: 'aConn', size: 1 },
];
const ENVELOPE: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aAlpha', size: 1 }, { name: 'aOpen', size: 3 }, { name: 'aClosed', size: 3 }, { name: 'aFoldK', size: 1 },
  { name: 'aParentK', size: 1 },
];
const BOX: AttributeSpec[] = [
  { name: 'aCenter', size: 2 }, { name: 'aHalf', size: 2 }, { name: 'aCorner', size: 2 }, { name: 'aParentK', size: 1 }, { name: 'aStyle', size: 1 }, { name: 'aBadge', size: 1 },
];
const MARKER: AttributeSpec[] = [{ name: 'aCenter', size: 2 }, { name: 'aCorner', size: 2 }, { name: 'aK', size: 1 }, { name: 'aConn', size: 1 }];
const OUTLINE: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aOuter', size: 1 }];
const STAR: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aCorner', size: 2 }];
const SKY: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aWorld', size: 2 }, { name: 'aV', size: 1 }];
/** A glyph instance (GLYPH_FLOATS, view/text.ts). */
const TEXT: AttributeSpec[] = [{ name: 'aAnchor', size: 2 }, { name: 'aGlyph', size: 4 }, { name: 'aAtlas', size: 2 }, { name: 'aTitle', size: 4 }, { name: 'aFold', size: 2 }];
const QUAD = [-1, -1, 1, -1, 1, 1, -1, 1];
const QUAD_INDEX = new Uint32Array([0, 1, 2, 0, 2, 3]);

interface Meshes {
  ribbon: Mesh; arrow: Mesh; envelope: Mesh; box: Mesh; marker: Mesh; outline: Mesh; drop: Mesh; intruder: Mesh; stars: Mesh[]; sky: Mesh; text: InstanceMesh;
}

/**
 * Draws a plan scene (spec 8) with our own WebGL 2 engine (plan 3c task 7, gl/). Rebuilds the visible geometry when the
 * view leaves the prepared rectangle, a group level changes state or the zoom outgrows the curve sampling; between
 * rebuilds only uniforms change. The visible set is decided here; the meshes are built in a worker while the previous
 * frame stays on screen (the first frame of a plan is built at once), or here for a scene the worker does not hold
 * (one updated by an action, or kept with its index from an earlier tab: plan 3c task 6; task 8 removes the worker).
 * Titles are glyphs of the MSDF atlas, one instance each, faded in the shader. Draw order: sky, stars, envelopes,
 * ribbons, arrows, boxes, rings, markers, titles. A lost context draws nothing; once restored, everything is made and
 * built again.
 */
export class PlanRenderer {
  /** Called when a frame built in the worker has arrived: the view must be drawn again. */
  onUpdate: () => void = () => {};
  private worker: Worker | null = null;
  private seq = 0;
  private pending: { seq: number; origin: Vec2 } | null = null;
  private hitInputs: { visible: VisibleSet; frame: Pick<PackedFrame, 'centerlines' | 'stubs' | 'markers'>; origin: Vec2 } | null = null;
  private hasFrame = false;
  private originMoved = false;
  private p: RenderParams;
  private readonly g: Gl;
  private readonly font: FontData;
  /** The atlas as decoded, kept to make its texture again after a context loss. */
  private readonly atlasImage: ImageBitmap;
  private atlas!: Texture2D;
  private programs!: Programs;
  private meshes!: Meshes;
  private starsShown = false;
  private starAlpha = [0, 0, 0];
  /** What is drawn: the state's scene, or a preview over it. */
  private scene: PlanScene | null = null;
  private index: SceneIndex | null = null;
  /** The state's scene and its index, kept through a preview: an action updates them, a preview given up comes back to them. */
  private real: { scene: PlanScene; index: SceneIndex } | null = null;
  /** The scene the worker holds: frames are built there for it only. */
  private workerScene: PlanScene | null = null;
  /** The intruders among what is drawn (visibleIntruders), with their group: the ring and the tooltip (spec 10). */
  private intruderMap = new Map<number, number>();
  private visibleSet: VisibleSet | null = null;
  private frame: FrameGeometry | null = null;
  private hits: HitIndex | null = null;
  private titleSides = new Map<Id, TitleSide>();
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
  private dropTarget: number | null = null;
  private intruderItems: number[] = [];
  private markers: PackedFrame['markers'] = [];
  private allCores = false;
  private stale = true;

  /** `font`: the titles' (parsed before the first scene: the boxes are measured with it); `atlas`: its MSDF image. */
  constructor(g: Gl, p: RenderParams, font: FontData, atlas: ImageBitmap) {
    this.g = g;
    this.p = p;
    this.font = font;
    this.atlasImage = atlas;
    this.createGpu();
    // The context is back: programs, buffers and textures are new and empty; everything is built again at once.
    g.onRestored = () => {
      this.createGpu();
      this.forgetFrame();
      this.onUpdate();
    };
    try {
      this.worker = new Worker(new URL('./frameWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ seq: number; visible: VisibleSet; frame: PackedFrame }>) => this.receive(e.data.seq, e.data.visible, e.data.frame);
      this.worker.onerror = (e) => {
        // Without a worker, frames are built on the main thread: slower rebuilds, same picture.
        console.warn(`Travailleur de rendu indisponible (${e.message}) : construction sur le fil principal.`);
        this.worker = null;
        this.pending = null;
        this.stale = true;
        this.onUpdate();
      };
      this.worker.postMessage({ t: 'font', font } satisfies FrameRequest);
    } catch (e) {
      console.warn(`Travailleur de rendu indisponible (${String(e)}) : construction sur le fil principal.`);
    }
  }

  private createGpu(): void {
    const gl = this.g.gl;
    const pr = (this.programs = createPrograms(gl));
    setParamUniforms(pr, this.p, this.font);
    this.meshes = {
      ribbon: new Mesh(gl, pr.ribbon, RIBBON, 4096), arrow: new Mesh(gl, pr.arrow, ARROW, 2048), envelope: new Mesh(gl, pr.envelope, ENVELOPE, 1024),
      box: new Mesh(gl, pr.box, BOX, 1024), marker: new Mesh(gl, pr.marker, MARKER, 256), outline: new Mesh(gl, pr.outline, OUTLINE, 64),
      drop: new Mesh(gl, pr.outline, OUTLINE, 64), intruder: new Mesh(gl, pr.outline, OUTLINE, 64),
      stars: [0, 1, 2].map(() => new Mesh(gl, pr.star, STAR, 4096)), sky: new Mesh(gl, pr.sky, SKY, 4), text: new InstanceMesh(gl, pr.text, TEXT, 4096),
    };
    this.atlas = new Texture2D(gl, 'linear');
    this.atlas.setImage(this.atlasImage);
  }

  private destroyGpu(): void {
    const m = this.meshes;
    for (const mesh of [m.ribbon, m.arrow, m.envelope, m.box, m.marker, m.outline, m.drop, m.intruder, m.sky, m.text, ...m.stars]) mesh.dispose();
    for (const pr of Object.values(this.programs)) pr.dispose();
    this.atlas.dispose();
  }

  /** Nothing drawn is kept: the next frame is built at once, the stars too. */
  private forgetFrame(): void {
    this.starKey = '';
    this.stale = true;
    this.hasFrame = false;
    this.pending = null;
  }

  /** The settings are uniforms (set again here) and the frame's geometry: built again at once, not left to the worker. */
  setParams(p: RenderParams): void {
    this.p = p;
    setParamUniforms(this.programs, p, this.font);
    this.forgetFrame();
  }

  /**
   * `transient`: a preview (a drag in progress) drawn at once on the main thread, without sending the scene to the
   * worker nor forgetting where the connection titles sit; the real scene follows once the action is written, and the
   * state's scene given again (a preview given up) comes back with its index, neither built again nor sent. `index`:
   * the scene's index kept from before (a tab shown again): neither built again nor the scene sent to the worker.
   */
  setScene(scene: PlanScene, transient = false, index?: SceneIndex): void {
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
      if (!index && this.worker) {
        this.worker.postMessage({ t: 'scene', scene, params: this.p } satisfies FrameRequest);
        this.workerScene = scene;
      }
    }
    this.restart(!transient);
  }

  /**
   * The state's scene after an action (plan 3c, task 6): `scene` follows the scene last given (setScene or updateScene)
   * by `changes`; its index follows them too (updateIndex) instead of being built again, and its first frame is built
   * here at once. A preview in progress is dropped. The worker keeps the scene from before: frames are built here
   * until a scene is sent to it.
   */
  updateScene(scene: PlanScene, changes: SceneChanges): void {
    if (!this.real) { this.setScene(scene); return; }
    this.real = { scene, index: updateIndex(this.real.index, scene, changes, this.p) };
    this.scene = scene;
    this.index = this.real.index;
    // The titles are placed anew, as for any scene of the state given before (a preview only keeps them).
    this.titleSides.clear();
    this.restart(true);
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
    this.pending = null;
    this.hits = null;
    this.hitInputs = null;
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
    if (this.hot >= 0 || !this.scene || !this.visibleSet || this.selection.connections.size === 0) return this.hot;
    const i = this.visibleSet.connections.findIndex((vc) => vc.conns.some((c) => this.selection.connections.has(this.scene!.ids[c])));
    return i;
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
    this.updateMarkers({ markers: this.markers });
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

  get hitIndex(): HitIndex | null {
    if (!this.hits && this.hitInputs && this.scene) {
      const { visible, frame, origin } = this.hitInputs;
      this.hits = buildHitIndex(this.scene, visible, frame, origin, this.p);
    }
    return this.hits;
  }

  get visible(): VisibleSet | null {
    return this.visibleSet;
  }

  /** Compiles every shader now instead of on first sight (ANGLE compiles on first use: a 5 s freeze in the bench). */
  warmUp(): number {
    const t0 = performance.now();
    const cam = this.cam;
    this.cam = { x: 0, y: 0, zoom: 1, widthPx: 64, heightPx: 64 };
    const m = this.meshes;
    const meshes = [[m.ribbon, RIBBON], [m.arrow, ARROW], [m.envelope, ENVELOPE], [m.box, BOX], [m.marker, MARKER], [m.outline, OUTLINE], [m.stars[0], STAR], [m.sky, SKY]] as const;
    const fill = (specs: AttributeSpec[], n: number) => Object.fromEntries(specs.map((s) => [s.name, new Float32Array(n * s.size)]));
    for (const [mesh, specs] of meshes) mesh.update(fill(specs, 3), new Uint32Array([0, 1, 2]));
    // One glyph, readable, so that the title program draws.
    const glyph = new Float32Array(GLYPH_FLOATS);
    glyph.set([0, 0, 0, 0, 8, 8, 0, 0, this.p.baseFontPx, 0, -2, 1, NO_GROUP, NO_GROUP]);
    m.text.update(glyph);
    this.starsShown = true;
    this.draw();
    for (const [mesh, specs] of meshes) mesh.update(fill(specs, 0), new Uint32Array(0));
    m.text.update(new Float32Array(0));
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
    if (this.stale || !this.lastRect || !this.index) return 'stale';
    if (foldSignature(this.index, this.cam.zoom, this.p) !== this.lastSignature) return 'fold';
    if (this.cam.zoom > this.builtZoom * this.p.curveZoomHeadroom) return 'zoomIn';
    if (this.cam.zoom < this.builtZoom / (2 * this.p.curveZoomHeadroom)) return 'zoomOut';
    const v = this.viewRect(0), r = this.lastRect;
    return v.minX < r.minX || v.maxX > r.maxX || v.minY < r.minY || v.maxY > r.maxY ? 'rect' : null;
  }

  /** Draws one frame (nothing while the context is lost); returns whether the visible geometry was rebuilt. */
  renderFrame(): boolean {
    if (this.g.lost) return false;
    let rebuilt = false;
    // One request at a time: while the worker builds, the camera may move on; the next request leaves when this one
    // is back, from wherever the camera is then (no queue of frames built for places already left).
    const reason = this.scene && !this.pending ? this.rebuildReason() : null;
    if (reason) {
      this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
      if (this.worker && this.hasFrame && this.workerScene === this.scene) this.request();
      else {
        this.rebuildNow();
        rebuilt = true;
      }
    }
    if (this.originMoved) {
      rebuilt = true;
      this.originMoved = false;
    }
    this.updateBackground(rebuilt);
    this.draw();
    return rebuilt;
  }

  /** The camera's uniforms, then every layer in order, cleared to the sky first (one draw call per mesh). */
  private draw(): void {
    const { cam, p, g } = this, gl = g.gl, pr = this.programs, m = this.meshes;
    const hw = cam.widthPx / 2 / cam.zoom, hh = cam.heightPx / 2 / cam.zoom;
    const lx = cam.x - this.origin.x, ly = cam.y - this.origin.y;
    setView([pr.ribbon, pr.arrow, pr.envelope, pr.box, pr.marker, pr.outline, pr.star, pr.text], cam.zoom, lx, ly, cam.widthPx, cam.heightPx);
    const lit = this.lit();
    for (const x of [pr.ribbon, pr.arrow]) {
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
    if (!off('env')) m.envelope.draw();
    if (!off('ribbon')) m.ribbon.draw();
    if (!off('glyph')) m.arrow.draw();
    if (!off('box')) m.box.draw();
    if (!off('outline')) {
      for (const [ring, c] of [[m.intruder, p.intruderColor], [m.drop, p.dropColor], [m.outline, p.selectionColor]] as const) {
        if (ring.empty) continue;
        setOutlineColor(pr, c);
        ring.draw();
      }
    }
    if (!off('marker')) m.marker.draw();
    if (!off('text') && m.text.length > 0) {
      this.atlas.bind(0);
      m.text.draw();
    }
  }

  /** Glyph instances drawn (bench: the densest view's count). */
  get glyphCount(): number {
    return this.meshes.text.length;
  }

  /** Marks the camera's surroundings prepared, so the rebuild is not asked for again while it is being built. */
  private prepare(): Vec2 {
    const cam = this.cam;
    this.lastRect = this.viewRect(this.p.viewMarginPx);
    this.lastSignature = foldSignature(this.index!, cam.zoom, this.p);
    this.builtZoom = cam.zoom;
    this.stale = false;
    return { x: cam.x, y: cam.y };
  }

  private rebuildNow(): void {
    const origin = this.prepare();
    const visible = computeVisible(this.scene!, this.index!, this.cam, this.p);
    this.pending = null;
    this.seq++;
    this.frame = buildFrame(this.scene!, visible, this.cam, origin, this.p, this.titleSides, this.frame ?? undefined, this.font);
    this.apply(packFrame(this.frame, false), visible, origin);
  }

  /** The worker decides what is visible and builds it; the main thread only uploads. */
  private request(): void {
    const origin = this.prepare();
    const seq = ++this.seq;
    this.pending = { seq, origin };
    this.worker!.postMessage({ t: 'frame', seq, cam: this.cam, origin, params: this.p, sides: [...this.titleSides] } satisfies FrameRequest);
  }

  /** A frame from the worker: kept only if it answers the request in flight. */
  private receive(seq: number, visible: VisibleSet, frame: PackedFrame): void {
    if (!this.pending || seq !== this.pending.seq) return;
    const { origin } = this.pending;
    this.pending = null;
    this.apply(frame, visible, origin);
    this.originMoved = true;
    this.onUpdate();
  }

  private apply(f: PackedFrame, visible: VisibleSet, origin: Vec2): void {
    this.origin = origin;
    this.visibleSet = visible;
    this.hasFrame = true;
    for (const t of f.titles) this.titleSides.set(t.id, t.side);
    // The hovered index belonged to the previous visible set (I1 of the review); hover() sets it again.
    this.hot = -1;
    // Built on the first hover query: navigation does not wait for it.
    this.hits = null;
    this.hitInputs = { visible, frame: { centerlines: f.centerlines, stubs: f.stubs, markers: f.markers }, origin };
    if (this.scene === this.real?.scene) {
      this.intruderMap = visibleIntruders(this.scene, visible);
      this.intruderItems = [...this.intruderMap.keys()];
    }
    this.meshes.ribbon.update(f.ribbons, f.ribbonIndex);
    this.meshes.arrow.update(f.glyphs, f.glyphIndex);
    this.meshes.envelope.update(f.envelopes, f.envelopeIndex);
    this.updateBoxes(visible);
    this.updateMarkers(f);
    this.updateOutline();
    this.meshes.text.update(f.glyphInstances);
  }

  private updateBoxes(visible: VisibleSet): void {
    const scene = this.scene!;
    const center = new FloatList(visible.items.length * 8), half = new FloatList(visible.items.length * 8), corner = new FloatList(visible.items.length * 8);
    const parentK = new FloatList(visible.items.length * 4), style = new FloatList(visible.items.length * 4), badge = new FloatList(visible.items.length * 4);
    const index = new IndexList(visible.items.length * 6);
    const STYLE = { node: 1, center: 2, absent: 3 } as const;
    visible.items.forEach((i, j) => {
      const it = scene.items[i];
      const pk = it.parent >= 0 ? scene.items[it.parent].maxChildK! : NO_GROUP;
      const st = it.kind === 'phantom' ? STYLE[it.phantom!] : 0;
      for (let c = 0; c < 4; c++) {
        center.push2(it.x - this.origin.x, it.y - this.origin.y);
        half.push2(it.halfW, it.halfH);
        corner.push2(QUAD[c * 2], QUAD[c * 2 + 1]);
        parentK.push1(pk);
        style.push1(st);
        badge.push1(it.badge ? 1 : 0);
      }
      const v = j * 4;
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    });
    this.meshes.box.update({ aCenter: center.view(), aHalf: half.view(), aCorner: corner.view(), aParentK: parentK.view(), aStyle: style.view(), aBadge: badge.view() }, index.view());
  }

  private updateMarkers(f: Pick<PackedFrame, 'markers'>): void {
    this.markers = f.markers;
    const multi = f.markers.filter((m) => m.multi || this.allCores);
    const center = new FloatList(), corner = new FloatList(), k = new FloatList(), conn = new FloatList(), index = new IndexList();
    multi.forEach((m, j) => {
      for (let c = 0; c < 4; c++) {
        center.push2(m.pos.x, m.pos.y);
        corner.push2(QUAD[c * 2], QUAD[c * 2 + 1]);
        k.push1(m.kMax);
        conn.push1(m.conn);
      }
      const v = j * 4;
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    });
    this.meshes.marker.update({ aCenter: center.view(), aCorner: corner.view(), aK: k.view(), aConn: conn.view() }, index.view());
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
    this.worker?.terminate();
    this.g.onRestored = () => {};
    this.destroyGpu();
  }
}
