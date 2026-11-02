import { type Application, BitmapText, Container, type Geometry, Mesh, type Shader } from 'pixi.js';

type CustomMesh = Mesh<Geometry, Shader>;
import { bezierSegments, bundleBranches, ribbonAttributes, ribbonWorthDrawing, stubLine } from '../geometry/ribbon';
import { convexHull, featherRing } from '../geometry/hull';
import { starLayerAlpha, starsInRect } from '../geometry/stars';
import { textPx } from '../scene/lod';
import { BOX_WORLD_WIDTH, type RenderParams } from '../scene/params';
import type { Camera, Scene, Vec2 } from '../scene/types';
import { buildIndex, computeVisible, type SceneIndex, type VisibleSet } from '../scene/visibility';
import { boxShader, hullShader, makeGeometry, ribbonShader, setZoom, starShader } from './ribbonShader';

const FONT_FAMILY = 'Inter-Regular';
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Rect { minX: number; maxX: number; minY: number; maxY: number }
interface LocalHull { position: Float32Array; alpha: Float32Array; index: Uint32Array }

/**
 * Draws the visible part of a scene. Geometry lives in world units relative to a local origin placed at the camera
 * on each rebuild (float32 precision, see ledger Task 2); zoom-dependent effects run in the shaders.
 */
export class SceneRenderer {
  private readonly world = new Container();
  private readonly starLayer = new Container();
  private readonly index: SceneIndex;
  private readonly depth: Int32Array;
  private readonly distinctK: number[];
  private readonly shaders: { ribbon: Shader; hull: Shader; box: Shader; star: Shader[] };
  private readonly hullCache = new Map<number, LocalHull>();
  private readonly texts = new Map<number, BitmapText>();
  private origin: Vec2 = { x: 0, y: 0 };
  private cam: Camera = { x: 0, y: 0, zoom: 1, widthPx: 1, heightPx: 1 };
  private lastRect: Rect | null = null;
  private lastSignature = '';
  private lastZoom = -1;
  private ribbonZoom = 1;
  /** Vertex count of the current ribbon mesh (reported by the bench). */
  ribbonVertices = 0;
  private starRect: Rect | null = null;
  private starKey = '';
  private meshes: { box?: CustomMesh; hull?: CustomMesh; ribbon?: CustomMesh; stars: CustomMesh[] } = { stars: [] };
  visible: VisibleSet | null = null;

  constructor(private readonly app: Application, private readonly scene: Scene, private readonly params: RenderParams) {
    this.index = buildIndex(scene);
    this.depth = new Int32Array(scene.nodes.length);
    for (const n of scene.nodes) {
      let d = 0;
      for (let a = n.parent; a >= 0; a = scene.nodes[a].parent) d++;
      this.depth[n.id] = d;
    }
    this.distinctK = [...new Set([...this.index.maxChildK].filter((k) => k > -Infinity))].sort((a, b) => a - b);
    this.shaders = {
      ribbon: ribbonShader(params),
      hull: hullShader(params),
      box: boxShader(params),
      star: [starShader(params), starShader(params), starShader(params)],
    };
    app.stage.addChild(this.world);
    this.world.addChild(this.starLayer);
  }

  setCamera(cam: Camera): void {
    this.cam = cam;
  }

  /**
   * Draws one of each element type once so every shader is compiled during loading instead of on first sight
   * (ANGLE/D3D11 compiles on first use). Returns the time it took.
   */
  warmUp(): number {
    const t0 = performance.now();
    const tri = new Uint32Array([0, 1, 2]);
    const three = (size: number) => new Float32Array(3 * size);
    const meshes = [
      new Mesh({ geometry: makeGeometry({ aPosition: { data: three(2), size: 2 }, aParentK: { data: three(1), size: 1 } }, tri), shader: this.shaders.box }),
      new Mesh({ geometry: makeGeometry({ aPosition: { data: three(2), size: 2 }, aAlpha: { data: three(1), size: 1 }, aK: { data: three(1), size: 1 }, aLevel: { data: three(1), size: 1 } }, tri), shader: this.shaders.hull }),
      new Mesh({ geometry: makeGeometry({ aPosition: { data: three(2), size: 2 }, aNormal: { data: three(2), size: 2 }, aScale: { data: three(1), size: 1 }, aEnd0: { data: three(3), size: 3 }, aEnd1: { data: three(3), size: 3 } }, tri), shader: this.shaders.ribbon }),
      ...this.shaders.star.map((shader) => new Mesh({ geometry: makeGeometry({ aPosition: { data: three(2), size: 2 }, aCorner: { data: three(2), size: 2 } }, tri), shader })),
    ];
    const text = new BitmapText({ text: 'Nœud θ∑', style: { fontFamily: FONT_FAMILY, fontSize: 16, fill: 0xe6eefc } });
    const probe = new Container();
    probe.addChild(...meshes, text);
    this.app.stage.addChild(probe);
    this.app.renderer.render(this.app.stage);
    this.app.stage.removeChild(probe);
    probe.destroy({ children: true });
    return performance.now() - t0;
  }

  /** Updates what changed, renders one frame and returns the CPU time spent in JS for it. */
  renderFrame(): { cpuMs: number; rebuilt: boolean } {
    const t0 = performance.now();
    const cam = this.cam;
    let rebuilt = false;
    if (this.needsRebuild()) {
      this.rebuild();
      rebuilt = true;
    } else if (this.visible && cam.zoom > this.ribbonZoom * this.params.curveZoomHeadroom) {
      // Zoomed past the sampling headroom: resample the curves only.
      this.rebuildRibbons(this.visible);
      this.attachChildren();
      rebuilt = true;
    }
    this.updateStars(rebuilt);
    this.world.scale.set(cam.zoom);
    this.world.position.set((this.origin.x - cam.x) * cam.zoom + cam.widthPx / 2, (this.origin.y - cam.y) * cam.zoom + cam.heightPx / 2);
    setZoom([this.shaders.ribbon, this.shaders.hull, this.shaders.box, ...this.shaders.star], cam.zoom);
    // Screen rectangle in local world units, for the ribbon fade (spec 8.5).
    const hw = cam.widthPx / 2 / cam.zoom, hh = cam.heightPx / 2 / cam.zoom;
    const lx = cam.x - this.origin.x, ly = cam.y - this.origin.y;
    const ribbonUniforms = this.shaders.ribbon.resources.ribbon.uniforms;
    ribbonUniforms.uScreen = [lx - hw, ly - hh, lx + hw, ly + hh];
    ribbonUniforms.uFadeWorld = this.params.connectionFadePx / cam.zoom;
    if (cam.zoom !== this.lastZoom || rebuilt) this.updateTextAlpha();
    this.lastZoom = cam.zoom;
    const heapBefore = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const tr = performance.now();
    this.app.renderer.render(this.app.stage);
    this.lastRenderMs = performance.now() - tr;
    this.lastHeapDeltaMb = (((performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) - heapBefore) / 1e6;
    return { cpuMs: performance.now() - t0, rebuilt };
  }

  private viewRect(marginPx: number): Rect {
    const { cam } = this;
    const hw = (cam.widthPx / 2 + marginPx) / cam.zoom, hh = (cam.heightPx / 2 + marginPx) / cam.zoom;
    return { minX: cam.x - hw, maxX: cam.x + hw, minY: cam.y - hh, maxY: cam.y + hh };
  }

  private openSignature(): string {
    return this.distinctK.map((k) => (textPx(k, this.cam.zoom, this.params) >= this.params.groupFold[0] ? '1' : '0')).join('');
  }

  private needsRebuild(): boolean {
    if (!this.lastRect || this.openSignature() !== this.lastSignature) return true;
    const v = this.viewRect(0), r = this.lastRect;
    return v.minX < r.minX || v.maxX > r.maxX || v.minY < r.minY || v.maxY > r.maxY;
  }

  private rel(id: number): Vec2 {
    const n = this.scene.nodes[id];
    return { x: n.x - this.origin.x, y: n.y - this.origin.y };
  }

  /** Last rebuild's phase timings (ms) and sizes, for diagnosis. */
  lastRebuild: Record<string, number> = {};
  /** Time spent in PixiJS render() for the last frame. */
  lastRenderMs = 0;
  /** JS heap change across the last render() call, in MB (a large drop betrays a GC pause). */
  lastHeapDeltaMb = 0;

  private rebuild(): void {
    const { scene, params } = this;
    const t: number[] = [performance.now()];
    this.origin = { x: this.cam.x, y: this.cam.y };
    const visible = computeVisible(scene, this.index, this.cam, params);
    this.visible = visible;
    this.lastRect = this.viewRect(params.viewMarginPx);
    this.lastSignature = this.openSignature();
    t.push(performance.now());
    this.rebuildBoxes(visible);
    this.rebuildHulls(visible);
    t.push(performance.now());
    this.rebuildRibbons(visible);
    t.push(performance.now());
    const textsBefore = this.texts.size;
    this.rebuildTexts(visible);
    t.push(performance.now());
    this.attachChildren();
    t.push(performance.now());
    this.lastRebuild = {
      visibleMs: t[1] - t[0], boxHullMs: t[2] - t[1], ribbonMs: t[3] - t[2], textMs: t[4] - t[3], attachMs: t[5] - t[4],
      nodes: visible.nodes.length, closed: visible.closedGroups.length, open: visible.openGroups.length,
      connections: visible.connections.length, ribbonVertices: this.ribbonVertices, texts: this.texts.size, textsBefore,
    };
  }

  /** Layers left out for cost diagnosis (?hide=stars,hull,ribbon,box,text). */
  hidden = new Set<string>();

  private attachChildren(): void {
    this.world.removeChildren();
    if (!this.hidden.has('stars')) this.world.addChild(this.starLayer);
    const layers: [string, CustomMesh | undefined][] = [['hull', this.meshes.hull], ['ribbon', this.meshes.ribbon], ['box', this.meshes.box]];
    for (const [name, m] of layers) if (m && !this.hidden.has(name)) this.world.addChild(m);
    if (!this.hidden.has('text')) for (const t of this.texts.values()) this.world.addChild(t);
  }

  private replaceMesh(key: 'box' | 'hull' | 'ribbon', mesh: CustomMesh | undefined): void {
    const old = this.meshes[key];
    if (old) old.destroy({ children: false });
    this.meshes[key] = mesh;
  }

  private rebuildBoxes(visible: VisibleSet): void {
    const ids = visible.nodes;
    const position = new Float32Array(ids.length * 8), parentK = new Float32Array(ids.length * 4);
    const index = new Uint32Array(ids.length * 6);
    ids.forEach((id, i) => {
      const n = this.scene.nodes[id], c = this.rel(id);
      const hw = (BOX_WORLD_WIDTH / 2) * this.params.factor ** n.k, hh = hw * 0.3;
      position.set([c.x - hw, c.y - hh, c.x + hw, c.y - hh, c.x + hw, c.y + hh, c.x - hw, c.y + hh], i * 8);
      parentK.fill(n.parent >= 0 ? this.index.maxChildK[n.parent] : -1e9, i * 4, i * 4 + 4);
      const v = i * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    });
    this.replaceMesh('box', ids.length === 0 ? undefined : new Mesh({
      geometry: makeGeometry({ aPosition: { data: position, size: 2 }, aParentK: { data: parentK, size: 1 } }, index),
      shader: this.shaders.box,
    }));
  }

  private localHull(g: number): LocalHull {
    let h = this.hullCache.get(g);
    if (!h) {
      const { nodes, children } = this.scene;
      const gx = nodes[g].x, gy = nodes[g].y;
      const pts = children[g].map((c) => ({ x: nodes[c].x - gx, y: nodes[c].y - gy }));
      const pad = Math.max(...children[g].map((c) => (BOX_WORLD_WIDTH / 2) * this.params.factor ** nodes[c].k)) * 1.1;
      h = featherRing(convexHull(pts), pad, pad * 0.8);
      this.hullCache.set(g, h);
    }
    return h;
  }

  private rebuildHulls(visible: VisibleSet): void {
    const groups = [...visible.openGroups, ...visible.closedGroups];
    // Parents first so nested envelopes are drawn on top of their parent's.
    groups.sort((a, b) => this.depth[a] - this.depth[b]);
    let nv = 0, ni = 0;
    for (const g of groups) { const h = this.localHull(g); nv += h.alpha.length; ni += h.index.length; }
    const position = new Float32Array(nv * 2), alpha = new Float32Array(nv), k = new Float32Array(nv), level = new Float32Array(nv);
    const index = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const g of groups) {
      const h = this.localHull(g), c = this.rel(g), count = h.alpha.length;
      for (let i = 0; i < count; i++) {
        position[(vo + i) * 2] = h.position[i * 2] + c.x;
        position[(vo + i) * 2 + 1] = h.position[i * 2 + 1] + c.y;
      }
      alpha.set(h.alpha, vo);
      k.fill(this.index.maxChildK[g], vo, vo + count);
      level.fill(this.depth[g] % 2, vo, vo + count);
      for (let i = 0; i < h.index.length; i++) index[io + i] = h.index[i] + vo;
      vo += count; io += h.index.length;
    }
    this.replaceMesh('hull', nv === 0 ? undefined : new Mesh({
      geometry: makeGeometry({ aPosition: { data: position, size: 2 }, aAlpha: { data: alpha, size: 1 }, aK: { data: k, size: 1 }, aLevel: { data: level, size: 1 } }, index),
      shader: this.shaders.hull,
    }));
  }

  private rebuildRibbons(visible: VisibleSet): void {
    // Bézier flattening follows curvature (a straight curve gets one segment) and stays within curveTolerancePx
    // until the zoom grows by curveZoomHeadroom.
    const { curveTolerancePx, curveZoomHeadroom } = this.params;
    const pxPerUnit = this.cam.zoom * curveZoomHeadroom;
    const segmentsFor = (_chord: number, p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2) => bezierSegments(p0, c0, c1, p3, pxPerUnit, curveTolerancePx);
    this.ribbonZoom = this.cam.zoom;
    // Each branch also carries two endpoints of its connection (its own and the one nearest the camera at rebuild,
    // or the other one for a two-member connection), so the shader can fade the whole connection (spec 8.5).
    const parts: { attrs: ReturnType<typeof ribbonAttributes>; end0: number[]; end1: number[] }[] = [];
    const endOf = (node: number): number[] => { const c = this.rel(node); return [c.x, c.y, this.index.extent[node]]; };
    const cx = this.cam.x - this.origin.x, cy = this.cam.y - this.origin.y;
    for (const vc of visible.connections) {
      // Invisible at any zoom this geometry stays valid for: skip (spec 8.5, fade below the minimum width).
      const maxK = Math.max(...vc.branches.map((b) => this.scene.nodes[b.node].k));
      if (!ribbonWorthDrawing(maxK, pxPerUnit, this.params)) continue;
      const members = vc.branches.map((b) => ({ pos: this.rel(b.node), role: b.role, k: this.scene.nodes[b.node].k }));
      if (vc.stubs) {
        // Far connection: a short stub at each endpoint toward the others, fading with its own endpoint only.
        members.forEach((m, i) => {
          const others = members.filter((_, j) => j !== i);
          const toward = { x: others.reduce((s2, o) => s2 + o.pos.x, 0) / others.length, y: others.reduce((s2, o) => s2 + o.pos.y, 0) / others.length };
          const line = stubLine(m.pos, toward, this.params.stubPx / this.cam.zoom);
          const sc = this.params.factor ** m.k;
          const end = endOf(vc.branches[i].node);
          parts.push({ attrs: ribbonAttributes(line, [sc, sc]), end0: end, end1: end });
        });
        continue;
      }
      let nearest = 0, best = Infinity;
      members.forEach((m, i) => { const d = Math.hypot(m.pos.x - cx, m.pos.y - cy); if (d < best) { best = d; nearest = i; } });
      bundleBranches(members, segmentsFor, this.params.factor).forEach((br, i) => {
        const other = i !== nearest ? nearest : (nearest + 1) % members.length;
        parts.push({ attrs: ribbonAttributes(br.centerline, br.scales), end0: endOf(vc.branches[i].node), end1: endOf(vc.branches[other].node) });
      });
    }
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.attrs.scale.length; ni += p.attrs.index.length; }
    const position = new Float32Array(nv * 2), normal = new Float32Array(nv * 2), scale = new Float32Array(nv);
    const end0 = new Float32Array(nv * 3), end1 = new Float32Array(nv * 3);
    const index = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const { attrs: p, end0: e0, end1: e1 } of parts) {
      const count = p.scale.length;
      position.set(p.position, vo * 2);
      normal.set(p.normal, vo * 2);
      scale.set(p.scale, vo);
      for (let v = 0; v < count; v++) { end0.set(e0, (vo + v) * 3); end1.set(e1, (vo + v) * 3); }
      for (let i = 0; i < p.index.length; i++) index[io + i] = p.index[i] + vo;
      vo += count; io += p.index.length;
    }
    this.ribbonVertices = nv;
    this.replaceMesh('ribbon', nv === 0 ? undefined : new Mesh({
      geometry: makeGeometry({
        aPosition: { data: position, size: 2 }, aNormal: { data: normal, size: 2 }, aScale: { data: scale, size: 1 },
        aEnd0: { data: end0, size: 3 }, aEnd1: { data: end1, size: 3 },
      }, index),
      shader: this.shaders.ribbon,
    }));
  }

  private rebuildTexts(visible: VisibleSet): void {
    const wanted = new Set([...visible.nodes, ...visible.closedGroups]);
    for (const [id, t] of this.texts) if (!wanted.has(id)) { t.destroy(); this.texts.delete(id); }
    for (const id of wanted) {
      const n = this.scene.nodes[id];
      const c = this.rel(id);
      let t = this.texts.get(id);
      if (!t) {
        const size = this.params.baseFontPx * this.params.textScale * this.params.factor ** n.k;
        t = new BitmapText({
          text: n.title,
          style: { fontFamily: FONT_FAMILY, fontSize: size, fill: 0xe6eefc, align: 'center', wordWrap: true, wordWrapWidth: BOX_WORLD_WIDTH * this.params.factor ** n.k * 0.9 },
        });
        t.anchor.set(0.5);
        this.texts.set(id, t);
      }
      t.position.set(c.x, c.y);
    }
  }

  private updateTextAlpha(): void {
    const { scene, params, cam } = this;
    const fold = (k: number) => 1 - smooth(params.groupFold[0], params.groupFold[1], textPx(k, cam.zoom, params));
    for (const [id, t] of this.texts) {
      const n = scene.nodes[id];
      const readable = smooth(params.textFade[0], params.textFade[1], textPx(n.k, cam.zoom, params));
      const isGroup = scene.children[id].length > 0;
      const a = isGroup ? fold(this.index.maxChildK[id]) * readable : readable * (n.parent >= 0 ? 1 - fold(this.index.maxChildK[n.parent]) : 1);
      t.alpha = a;
      t.visible = a > 0.01;
    }
  }

  private updateStars(force: boolean): void {
    const { cam, params } = this;
    const ks: number[] = [];
    const base = params.starCellWorld * cam.zoom;
    const kLo = Math.ceil(Math.log(params.starSpacingPx[0] / base) / Math.log(params.factor));
    for (let k = kLo; k <= kLo + 2; k++) if (starLayerAlpha(k, cam.zoom, params) > 0) ks.push(k);
    const key = ks.join(',');
    const v = this.viewRect(0), r = this.starRect;
    const outside = !r || v.minX < r.minX || v.maxX > r.maxX || v.minY < r.minY || v.maxY > r.maxY;
    if (force || outside || key !== this.starKey) {
      this.starKey = key;
      this.starRect = this.viewRect(Math.max(cam.widthPx, cam.heightPx) / 2);
      for (const m of this.meshes.stars) m.destroy({ children: false });
      this.meshes.stars = ks.map((k, i) => {
        const rr = this.starRect!;
        const stars = starsInRect({ x: rr.minX, y: rr.minY, w: rr.maxX - rr.minX, h: rr.maxY - rr.minY }, k, 7, params);
        const position = new Float32Array(stars.length * 8), corner = new Float32Array(stars.length * 8);
        const index = new Uint32Array(stars.length * 6);
        stars.forEach((s, j) => {
          const x = s.x - this.origin.x, y = s.y - this.origin.y;
          position.set([x, y, x, y, x, y, x, y], j * 8);
          corner.set([-1, -1, 1, -1, 1, 1, -1, 1], j * 8);
          const o = j * 4;
          index.set([o, o + 1, o + 2, o, o + 2, o + 3], j * 6);
        });
        const mesh = new Mesh({ geometry: makeGeometry({ aPosition: { data: position, size: 2 }, aCorner: { data: corner, size: 2 } }, index), shader: this.shaders.star[i] });
        (mesh as CustomMesh & { layerK?: number }).layerK = k;
        return mesh;
      });
      this.starLayer.removeChildren();
      for (const m of this.meshes.stars) this.starLayer.addChild(m);
    }
    this.meshes.stars.forEach((m, i) => {
      this.shaders.star[i].resources.star.uniforms.uLayerAlpha = starLayerAlpha((m as CustomMesh & { layerK?: number }).layerK!, cam.zoom, params);
    });
  }
}
