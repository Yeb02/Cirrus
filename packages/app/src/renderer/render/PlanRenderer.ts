import type { Id, Vec2 } from '@cirrus/core';
import {
  buildFrame, buildHitIndex, buildIndex, type Camera, computeVisible, emptySelection, FloatList, foldSignature, foldT, type FrameGeometry,
  gridLevels, type HitIndex, IndexList, offsetPolygon, type PlanScene, type RenderParams, type Rgb, type SceneIndex, smooth,
  type Selection, starLayerAlpha, starLayers, starsInRect, stepScale, textPx, type TitleSide, vertexNormals, type VisibleSet,
} from '@cirrus/view';
import { type Application, type BitmapText, Container, RenderTexture, type Shader, Sprite } from 'pixi.js';
import { type AttributeSpec, MeshSlot } from './meshes.ts';
import { boxShader, envelopeShader, glyphShader, markerShader, NO_GROUP, outlineShader, ribbonShader, setZoom, skyShader, starShader } from './shaders.ts';
import { type PackedFrame, packFrame } from './frameData.ts';
import type { FrameRequest } from './frameWorker.ts';
import { TextPool, type TextSpec } from './texts.ts';

interface Rect { minX: number; maxX: number; minY: number; maxY: number }

const RIBBON: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aPosition2', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aNormal2', size: 2 },
  { name: 'aScale', size: 1 }, { name: 'aSide', size: 1 }, { name: 'aDist', size: 1 }, { name: 'aEnd0', size: 3 }, { name: 'aEnd1', size: 3 },
  { name: 'aFold', size: 2 }, { name: 'aConn', size: 1 },
];
const GLYPH: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aPosition2', size: 2 }, { name: 'aOffset', size: 2 }, { name: 'aOffset2', size: 2 },
  { name: 'aScale', size: 1 }, { name: 'aFill', size: 1 }, { name: 'aEnd0', size: 3 }, { name: 'aEnd1', size: 3 }, { name: 'aFold', size: 2 }, { name: 'aConn', size: 1 },
];
const ENVELOPE: AttributeSpec[] = [
  { name: 'aPosition', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aAlpha', size: 1 }, { name: 'aOpen', size: 3 }, { name: 'aClosed', size: 3 }, { name: 'aFoldK', size: 1 },
];
const BOX: AttributeSpec[] = [
  { name: 'aCenter', size: 2 }, { name: 'aHalf', size: 2 }, { name: 'aCorner', size: 2 }, { name: 'aParentK', size: 1 }, { name: 'aStyle', size: 1 }, { name: 'aBadge', size: 1 },
];
const MARKER: AttributeSpec[] = [{ name: 'aCenter', size: 2 }, { name: 'aCorner', size: 2 }, { name: 'aK', size: 1 }, { name: 'aConn', size: 1 }];
const OUTLINE: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aNormal', size: 2 }, { name: 'aOuter', size: 1 }];
const STAR: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aCorner', size: 2 }];
const SKY: AttributeSpec[] = [{ name: 'aPosition', size: 2 }, { name: 'aWorld', size: 2 }, { name: 'aV', size: 1 }];
const QUAD = [-1, -1, 1, -1, 1, 1, -1, 1];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
const hex = (c: Rgb) => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);

interface Shaders { ribbon: Shader; glyph: Shader; envelope: Shader; box: Shader; marker: Shader; outline: Shader; drop: Shader; intruder: Shader; stars: Shader[]; sky: Shader }
interface Slots { ribbon: MeshSlot; glyph: MeshSlot; envelope: MeshSlot; box: MeshSlot; marker: MeshSlot; outline: MeshSlot; drop: MeshSlot; intruder: MeshSlot; stars: MeshSlot[]; sky: MeshSlot }
interface LiveText { t: BitmapText; alpha: (zoom: number) => number }

/**
 * Draws a plan scene (spec 8). Rebuilds the visible geometry when the view leaves the prepared rectangle, a group level
 * changes state or the zoom outgrows the curve sampling; between rebuilds only uniforms change. The visible set is
 * decided here; the meshes are built in a worker while the previous frame stays on screen (the first frame of a plan
 * is built at once). Envelopes are drawn in the main pass, or into a reduced texture if envelopeResolution < 1.
 */
export class PlanRenderer {
  /** Called when a frame built in the worker has arrived: the view must be drawn again. */
  onUpdate: () => void = () => {};
  private worker: Worker | null = null;
  private seq = 0;
  private pending: { seq: number; origin: Vec2 } | null = null;
  private hitInputs: { visible: VisibleSet; frame: Pick<PackedFrame, 'centerlines' | 'stubs'>; origin: Vec2 } | null = null;
  private hasFrame = false;
  private originMoved = false;
  private p: RenderParams;
  private shaders!: Shaders;
  private slots!: Slots;
  private readonly bgWorld = new Container();
  private readonly envWorld = new Container();
  private readonly world = new Container();
  private readonly meshLayer = new Container();
  private readonly textLayer = new Container();
  private readonly skyLayer = new Container();
  private envTexture: RenderTexture | null = null;
  private readonly envSprite = new Sprite();
  private readonly texts: TextPool;
  private live: LiveText[] = [];
  private scene: PlanScene | null = null;
  private index: SceneIndex | null = null;
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
  private textZoom = -1;
  private stale = true;

  private readonly app: Application;

  constructor(app: Application, p: RenderParams) {
    this.app = app;
    this.p = p;
    this.texts = new TextPool(this.textLayer);
    this.createGpu();
    app.stage.addChild(this.skyLayer, this.bgWorld, this.envSprite, this.world);
    this.world.addChild(this.meshLayer, this.textLayer);
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
    } catch (e) {
      console.warn(`Travailleur de rendu indisponible (${String(e)}) : construction sur le fil principal.`);
    }
  }

  private createGpu(): void {
    const p = this.p;
    this.shaders = {
      ribbon: ribbonShader(p), glyph: glyphShader(p), envelope: envelopeShader(p), box: boxShader(p), marker: markerShader(p), outline: outlineShader(p),
      drop: outlineShader(p, p.dropColor), intruder: outlineShader(p, p.intruderColor),
      stars: [starShader(p), starShader(p), starShader(p)], sky: skyShader(p),
    };
    const s = this.shaders;
    this.slots = {
      ribbon: new MeshSlot(RIBBON, s.ribbon, 4096), glyph: new MeshSlot(GLYPH, s.glyph, 2048), envelope: new MeshSlot(ENVELOPE, s.envelope, 1024),
      box: new MeshSlot(BOX, s.box, 1024), marker: new MeshSlot(MARKER, s.marker, 256), outline: new MeshSlot(OUTLINE, s.outline, 64),
      drop: new MeshSlot(OUTLINE, s.drop, 64), intruder: new MeshSlot(OUTLINE, s.intruder, 64),
      stars: s.stars.map((sh) => new MeshSlot(STAR, sh, 4096)), sky: new MeshSlot(SKY, s.sky, 4),
    };
    // envelopeResolution 1: envelopes drawn in the main pass (no extra render target); below 1, into a reduced texture.
    if (p.envelopeResolution >= 1) this.meshLayer.addChild(this.slots.envelope.mesh);
    else this.envWorld.addChild(this.slots.envelope.mesh);
    this.meshLayer.addChild(this.slots.ribbon.mesh, this.slots.glyph.mesh, this.slots.box.mesh, this.slots.intruder.mesh, this.slots.drop.mesh, this.slots.outline.mesh, this.slots.marker.mesh);
    for (const st of this.slots.stars) this.bgWorld.addChild(st.mesh);
    this.skyLayer.addChild(this.slots.sky.mesh);
    this.slots.sky.update({ aPosition: new Float32Array(8), aWorld: new Float32Array(8), aV: new Float32Array([0, 0, 1, 1]) }, new Uint32Array(QUAD_INDEX));
  }

  private destroyGpu(): void {
    for (const slot of [this.slots.ribbon, this.slots.glyph, this.slots.envelope, this.slots.box, this.slots.marker, this.slots.outline, this.slots.drop, this.slots.intruder, this.slots.sky, ...this.slots.stars]) slot.dispose();
    for (const sh of [this.shaders.ribbon, this.shaders.glyph, this.shaders.envelope, this.shaders.box, this.shaders.marker, this.shaders.outline, this.shaders.drop, this.shaders.intruder, this.shaders.sky, ...this.shaders.stars]) sh.destroy();
  }

  setParams(p: RenderParams): void {
    this.p = p;
    this.destroyGpu();
    this.createGpu();
    this.envTexture?.destroy(true);
    this.envTexture = null;
    this.starKey = '';
    this.stale = true;
    // The new meshes are empty: build the next frame at once rather than show nothing while the worker works.
    this.hasFrame = false;
    this.pending = null;
  }

  /**
   * `transient`: a preview (a drag in progress) drawn at once on the main thread, without sending the scene to the
   * worker nor forgetting where the connection titles sit; the real scene follows once the action is written.
   */
  setScene(scene: PlanScene, transient = false): void {
    this.scene = scene;
    this.index = buildIndex(scene, this.p);
    this.stale = true;
    this.hasFrame = false;
    this.pending = null;
    this.hits = null;
    this.hitInputs = null;
    if (transient) return;
    this.titleSides.clear();
    this.worker?.postMessage({ t: 'scene', scene, params: this.p } satisfies FrameRequest);
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
    this.textZoom = -1;
  }

  /** Selected items get an outline; a selected connection is lit like a hovered one (spec 8.5, 9.2). */
  setSelection(sel: Selection): void {
    this.selection = sel;
    this.updateOutline();
    this.textZoom = -1;
  }

  /** The visible connection lit: the hovered one, else the first selected one shown. */
  private lit(): number {
    if (this.hot >= 0 || !this.scene || !this.visibleSet || this.selection.connections.size === 0) return this.hot;
    const i = this.visibleSet.connections.findIndex((vc) => vc.conns.some((c) => this.selection.connections.has(this.scene!.connections[c].id)));
    return i;
  }

  /** The group that would receive a drop, lit while dragging (spec 10). */
  setDropTarget(item: number | null): void {
    if (item === this.dropTarget) return;
    this.dropTarget = item;
    this.slots.drop.update(...this.outlineArrays(item === null ? [] : [item]));
  }

  /** Items an envelope covers without being its members (spec 10), with an orange ring. */
  setIntruders(items: number[]): void {
    this.intruderItems = items;
    this.slots.intruder.update(...this.outlineArrays(items));
  }

  private updateOutline(): void {
    const scene = this.scene;
    const items = scene ? [...this.selection.items].flatMap((id) => { const i = scene.byId.get(id); return i === undefined ? [] : [i]; }) : [];
    this.slots.outline.update(...this.outlineArrays(items));
    this.slots.drop.update(...this.outlineArrays(this.dropTarget === null ? [] : [this.dropTarget]));
    this.slots.intruder.update(...this.outlineArrays(this.intruderItems));
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
    const one = (specs: AttributeSpec[]) => Object.fromEntries(specs.map((s) => [s.name, new Float32Array(3 * s.size)]));
    for (const [slot, specs] of [[this.slots.ribbon, RIBBON], [this.slots.glyph, GLYPH], [this.slots.envelope, ENVELOPE], [this.slots.box, BOX], [this.slots.marker, MARKER], [this.slots.outline, OUTLINE], [this.slots.stars[0], STAR]] as const) {
      slot.update(one(specs), new Uint32Array([0, 1, 2]));
    }
    const t = this.texts.acquire({ text: 'Nœud θ∑ ≤', size: 16, wrap: 0, lineHeight: 20, x: 0, y: 0, color: 0xffffff });
    this.renderEnvelopes();
    this.app.renderer.render(this.app.stage);
    this.texts.release(t);
    for (const slot of [this.slots.ribbon, this.slots.glyph, this.slots.envelope, this.slots.box, this.slots.marker, this.slots.outline, this.slots.stars[0]]) {
      slot.update(Object.fromEntries([...RIBBON, ...GLYPH, ...ENVELOPE, ...BOX, ...MARKER, ...OUTLINE, ...STAR].map((s) => [s.name, new Float32Array(0)])), new Uint32Array(0));
    }
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

  /** Draws one frame if anything changed; returns whether the visible geometry was rebuilt. */
  renderFrame(): boolean {
    const { cam, p } = this;
    let rebuilt = false;
    // One request at a time: while the worker builds, the camera may move on; the next request leaves when this one
    // is back, from wherever the camera is then (no queue of frames built for places already left).
    const reason = this.scene && !this.pending ? this.rebuildReason() : null;
    if (reason) {
      this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
      if (this.worker && this.hasFrame) this.request();
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
    for (const c of [this.world, this.bgWorld, this.envWorld]) {
      c.scale.set(cam.zoom);
      c.position.set((this.origin.x - cam.x) * cam.zoom + cam.widthPx / 2, (this.origin.y - cam.y) * cam.zoom + cam.heightPx / 2);
    }
    const s = this.shaders;
    setZoom([s.ribbon, s.glyph, s.envelope, s.box, s.marker, s.outline, s.drop, s.intruder, ...s.stars], cam.zoom);
    const hw = cam.widthPx / 2 / cam.zoom, hh = cam.heightPx / 2 / cam.zoom;
    const lx = cam.x - this.origin.x, ly = cam.y - this.origin.y;
    for (const sh of [s.ribbon, s.glyph]) {
      const u = sh.resources.conn.uniforms;
      u.uScreen = [lx - hw, ly - hh, lx + hw, ly + hh];
      u.uFadeWorld = p.connectionFadePx / cam.zoom;
      u.uHot = this.lit();
    }
    s.marker.resources.marker.uniforms.uHot = this.lit();
    if (cam.zoom !== this.textZoom || rebuilt) {
      for (const l of this.live) {
        const a = l.alpha(cam.zoom);
        l.t.alpha = a;
        l.t.visible = a > 0.01;
      }
      this.textZoom = cam.zoom;
    }
    // Layers left out for cost diagnosis (bench: CIRRUS_BENCH_HIDE=sky,stars,env,ribbon,glyph,box,marker,text).
    const h = this.hidden;
    this.skyLayer.visible = !h.has('sky');
    if (h.has('stars')) this.bgWorld.visible = false;
    const direct = this.p.envelopeResolution >= 1;
    this.envSprite.visible = !direct && !h.has('env');
    if (direct) this.slots.envelope.mesh.visible &&= !h.has('env');
    this.slots.ribbon.mesh.visible &&= !h.has('ribbon');
    this.slots.glyph.mesh.visible &&= !h.has('glyph');
    this.slots.box.mesh.visible &&= !h.has('box');
    this.slots.marker.mesh.visible &&= !h.has('marker');
    this.textLayer.visible = !h.has('text');
    if (this.envSprite.visible) this.renderEnvelopes();
    this.app.renderer.render(this.app.stage);
    return rebuilt;
  }

  private renderEnvelopes(): void {
    const { cam, p } = this;
    const res = (window.devicePixelRatio || 1) * p.envelopeResolution;
    const w = Math.max(1, Math.ceil(cam.widthPx)), h = Math.max(1, Math.ceil(cam.heightPx));
    if (!this.envTexture || this.envTexture.width !== w || this.envTexture.height !== h || this.envTexture.source.resolution !== res) {
      this.envTexture?.destroy(true);
      this.envTexture = RenderTexture.create({ width: w, height: h, resolution: res });
      this.envSprite.texture = this.envTexture;
    }
    this.envSprite.width = w;
    this.envSprite.height = h;
    this.app.renderer.render({ container: this.envWorld, target: this.envTexture, clear: true, clearColor: [0, 0, 0, 0] });
  }

  /** Decides what is visible now and marks it prepared, so the request is not repeated while the worker builds it. */
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
    this.frame = buildFrame(this.scene!, visible, this.cam, origin, this.p, this.titleSides, this.frame ?? undefined);
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
    // Built on the first hover query: navigation does not wait for it.
    this.hits = null;
    this.hitInputs = { visible, frame: { centerlines: f.centerlines, stubs: f.stubs }, origin };
    this.slots.ribbon.update(f.ribbons, f.ribbonIndex);
    this.slots.glyph.update(f.glyphs, f.glyphIndex);
    this.slots.envelope.update(f.envelopes, f.envelopeIndex);
    this.updateBoxes(visible);
    this.updateMarkers(f);
    this.updateOutline();
    this.updateTexts(visible, f);
    this.textZoom = -1;
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
    this.slots.box.update({ aCenter: center.view(), aHalf: half.view(), aCorner: corner.view(), aParentK: parentK.view(), aStyle: style.view(), aBadge: badge.view() }, index.view());
  }

  private updateMarkers(f: Pick<PackedFrame, 'markers'>): void {
    const multi = f.markers.filter((m) => m.multi);
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
    this.slots.marker.update({ aCenter: center.view(), aCorner: corner.view(), aK: k.view(), aConn: conn.view() }, index.view());
  }

  private updateTexts(visible: VisibleSet, f: Pick<PackedFrame, 'titles'>): void {
    const scene = this.scene!, p = this.p, o = this.origin;
    for (const l of this.live) this.texts.release(l.t);
    this.live = [];
    const ink = hex(p.inkColor), titleInk = hex(p.titleColor);
    const add = (spec: TextSpec, alpha: (zoom: number) => number) => this.live.push({ t: this.texts.acquire(spec), alpha });
    const parentFold = (i: number) => {
      const parent = scene.items[i].parent;
      return (zoom: number) => (parent >= 0 ? 1 - foldT(scene.items[parent].maxChildK!, zoom, p) : 1);
    };
    // A text still unreadable at the deepest zoom this geometry serves is not created (most of them, zoomed out).
    const maxZoom = this.builtZoom * p.curveZoomHeadroom;
    const readable = (k: number, scale: number) => textPx(k, maxZoom, p) * scale >= p.textFade[0];
    for (const i of visible.items) {
      const it = scene.items[i];
      if ((it.kind === 'phantom' && it.phantom !== 'node') || !readable(it.k, 1)) continue;
      const s = stepScale(it.k, p), size = p.baseFontPx * s;
      const inParent = parentFold(i);
      const dim = it.kind === 'phantom' ? 0.65 : 1;
      add({ text: it.title, size, wrap: (p.boxWidth - 2 * p.boxPadX) * s, lineHeight: size * p.lineHeight, x: it.x - o.x, y: it.y - o.y, color: ink },
        (zoom) => dim * smooth(p.textFade[0], p.textFade[1], textPx(it.k, zoom, p)) * inParent(zoom));
    }
    for (const g of visible.groups) {
      const it = scene.items[g];
      if (!readable(it.k, Math.max(p.groupTitleOpenScale, p.groupTitleClosedScale))) continue;
      const s = stepScale(it.k, p);
      const top = Math.min(...offsetPolygon(it.hull!, it.pad!).map((q) => q.y));
      const inParent = parentFold(g);
      const openSize = p.baseFontPx * s * p.groupTitleOpenScale, closedSize = p.baseFontPx * s * p.groupTitleClosedScale;
      const [s0, s1] = p.groupTitleSwap;
      add({ text: it.title, size: openSize, wrap: 0, lineHeight: openSize * p.lineHeight, x: it.x - o.x, y: top - o.y - openSize * 0.45, color: ink },
        (zoom) => (1 - smooth(s0, s1, foldT(it.maxChildK!, zoom, p))) * smooth(p.textFade[0], p.textFade[1], textPx(it.k, zoom, p) * p.groupTitleOpenScale) * inParent(zoom));
      add({ text: it.title, size: closedSize, wrap: p.boxWidth * s, lineHeight: closedSize * p.lineHeight, x: it.x - o.x, y: it.y - o.y, color: ink },
        (zoom) => smooth(s0, s1, foldT(it.maxChildK!, zoom, p)) * smooth(p.textFade[0], p.textFade[1], textPx(it.k, zoom, p) * p.groupTitleClosedScale) * inParent(zoom));
    }
    for (const t of f.titles) {
      const size = p.titleFontPx * stepScale(t.kMax, p);
      const vc = visible.connections[t.conn];
      add({ text: t.text, size, wrap: 0, lineHeight: size * 1.2, x: t.box.x + t.box.w / 2, y: t.box.y + t.box.h / 2, color: titleInk },
        (zoom) => {
          if (t.conn === this.hot) return 1;
          const readable = smooth(p.titleFade[0], p.titleFade[1], size * zoom);
          return vc.fade === 'out' ? readable * (1 - foldT(vc.foldK, zoom, p)) : readable;
        });
    }
  }

  private updateBackground(rebuilt: boolean): void {
    const { cam, p } = this;
    const stars = p.background === 'stars';
    // Sky quad in screen space, with the local world position of its corners for the grid.
    const w = cam.widthPx, h = cam.heightPx;
    const tl = { x: cam.x - w / 2 / cam.zoom - this.origin.x, y: cam.y - h / 2 / cam.zoom - this.origin.y };
    const br = { x: tl.x + w / cam.zoom, y: tl.y + h / cam.zoom };
    this.slots.sky.update({
      aPosition: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      aWorld: new Float32Array([tl.x, tl.y, br.x, tl.y, br.x, br.y, tl.x, br.y]),
      aV: new Float32Array([0, 0, 1, 1]),
    }, new Uint32Array(QUAD_INDEX));
    const su = this.shaders.sky.resources.sky.uniforms;
    su.uZoom = cam.zoom;
    const levels = stars ? [] : gridLevels(cam.zoom, p).slice(-3);
    const spacing = [0, 0, 0], alpha = [0, 0, 0];
    levels.forEach((l, i) => {
      spacing[i] = l.spacingWorld;
      alpha[i] = l.alpha * p.backgroundOpacity;
      const mod = (v: number) => ((v % l.spacingWorld) + l.spacingWorld) % l.spacingWorld;
      su[`uOffset${i}`] = [mod(this.origin.x), mod(this.origin.y)];
    });
    su.uSpacing = spacing;
    su.uGridAlpha = alpha;

    this.bgWorld.visible = stars;
    if (!stars) return;
    const ks = starLayers(cam.zoom, p);
    const key = ks.join(',');
    const v = this.viewRect(0), r = this.starRect;
    const outside = !r || v.minX < r.minX || v.maxX > r.maxX || v.minY < r.minY || v.maxY > r.maxY;
    if (rebuilt || outside || key !== this.starKey) {
      this.starKey = key;
      this.starKs = ks;
      this.starRect = this.viewRect(Math.max(cam.widthPx, cam.heightPx) / 2);
      this.slots.stars.forEach((slot, i) => {
        const k = ks[i];
        if (k === undefined) { slot.update({ aPosition: new Float32Array(0), aCorner: new Float32Array(0) }, new Uint32Array(0)); return; }
        const rr = this.starRect!;
        const list = starsInRect({ x: rr.minX, y: rr.minY, w: rr.maxX - rr.minX, h: rr.maxY - rr.minY }, k, 7, p);
        const pos = new Float32Array(list.length * 8), corner = new Float32Array(list.length * 8), index = new Uint32Array(list.length * 6);
        list.forEach((st, j) => {
          const x = st.x - this.origin.x, y = st.y - this.origin.y;
          pos.set([x, y, x, y, x, y, x, y], j * 8);
          corner.set(QUAD, j * 8);
          const o = j * 4;
          index.set([o, o + 1, o + 2, o, o + 2, o + 3], j * 6);
        });
        slot.update({ aPosition: pos, aCorner: corner }, index);
      });
    }
    this.slots.stars.forEach((_slot, i) => {
      const k = this.starKs[i];
      this.shaders.stars[i].resources.star.uniforms.uLayerAlpha = k === undefined ? 0 : starLayerAlpha(k, cam.zoom, p) * p.backgroundOpacity;
    });
  }

  destroy(): void {
    this.worker?.terminate();
    for (const l of this.live) this.texts.release(l.t);
    this.texts.destroy();
    this.destroyGpu();
    this.envTexture?.destroy(true);
  }
}
