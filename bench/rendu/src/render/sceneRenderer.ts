import { type Application, BitmapText, Container, Mesh, type Shader } from 'pixi.js';
import { bundleBranches, ribbonAttributes } from '../geometry/ribbon';
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
  private starRect: Rect | null = null;
  private starKey = '';
  private meshes: { box?: Mesh; hull?: Mesh; ribbon?: Mesh; stars: Mesh[] } = { stars: [] };
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
    if (cam.zoom !== this.lastZoom || rebuilt) this.updateTextAlpha();
    this.lastZoom = cam.zoom;
    this.app.renderer.render(this.app.stage);
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

  private rebuild(): void {
    const { scene, params } = this;
    this.origin = { x: this.cam.x, y: this.cam.y };
    const visible = computeVisible(scene, this.index, this.cam, params);
    this.visible = visible;
    this.lastRect = this.viewRect(params.viewMarginPx);
    this.lastSignature = this.openSignature();
    this.rebuildBoxes(visible);
    this.rebuildHulls(visible);
    this.rebuildRibbons(visible);
    this.rebuildTexts(visible);
    this.attachChildren();
  }

  private attachChildren(): void {
    this.world.removeChildren();
    this.world.addChild(this.starLayer);
    for (const m of [this.meshes.hull, this.meshes.ribbon, this.meshes.box]) if (m) this.world.addChild(m);
    for (const t of this.texts.values()) this.world.addChild(t);
  }

  private replaceMesh(key: 'box' | 'hull' | 'ribbon', mesh: Mesh | undefined): void {
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
    // Adaptive Bézier sampling: smooth on screen until the zoom grows by curveZoomHeadroom.
    const { curveSegmentPx, curveZoomHeadroom } = this.params;
    const pxPerUnit = this.cam.zoom * curveZoomHeadroom;
    const segmentsFor = (chord: number) => Math.min(96, Math.max(2, Math.ceil((chord * 1.2 * pxPerUnit) / curveSegmentPx)));
    this.ribbonZoom = this.cam.zoom;
    const parts: ReturnType<typeof ribbonAttributes>[] = [];
    for (const vc of visible.connections) {
      const members = vc.branches.map((b) => ({ pos: this.rel(b.node), role: b.role, k: this.scene.nodes[b.node].k }));
      for (const br of bundleBranches(members, segmentsFor, this.params.factor)) parts.push(ribbonAttributes(br.centerline, br.scales));
    }
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.scale.length; ni += p.index.length; }
    const position = new Float32Array(nv * 2), normal = new Float32Array(nv * 2), scale = new Float32Array(nv);
    const index = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
      position.set(p.position, vo * 2);
      normal.set(p.normal, vo * 2);
      scale.set(p.scale, vo);
      for (let i = 0; i < p.index.length; i++) index[io + i] = p.index[i] + vo;
      vo += p.scale.length; io += p.index.length;
    }
    this.replaceMesh('ribbon', nv === 0 ? undefined : new Mesh({
      geometry: makeGeometry({ aPosition: { data: position, size: 2 }, aNormal: { data: normal, size: 2 }, aScale: { data: scale, size: 1 } }, index),
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
        (mesh as Mesh & { layerK?: number }).layerK = k;
        return mesh;
      });
      this.starLayer.removeChildren();
      for (const m of this.meshes.stars) this.starLayer.addChild(m);
    }
    this.meshes.stars.forEach((m, i) => {
      this.shaders.star[i].resources.star.uniforms.uLayerAlpha = starLayerAlpha((m as Mesh & { layerK?: number }).layerK!, cam.zoom, params);
    });
  }
}
