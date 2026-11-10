import type { Id, State } from '@cirrus/core';
import { type Camera, fitBounds, fitItem, type PlanScene, plansShowing, type RenderParams } from '@cirrus/view';
import { foundItems, itemsBounds } from '../../render/found.ts';

/** What a jump shows (plan 6a, D2): a node or a connection, in a plan. */
export interface RevealTarget { plan: Id; id: Id; kind: 'node' | 'connection' }

/** Whether the target is there to be shown: live, and in that plan (a node placed there; a connection drawn there — plansShowing's). */
export function revealable(s: State, t: RevealTarget): boolean {
  return s.plans.has(t.plan) && plansShowing(s, t.kind, t.id).includes(t.plan);
}

/** The camera that frames the target in its plan's scene (D2): a node as the hierarchy's corner does, a connection by its parts; null if not shown. */
export function framing(scene: PlanScene, t: RevealTarget, cam: Camera, p: RenderParams): Camera | null {
  if (t.kind === 'node') {
    const i = scene.byId.get(t.id);
    return i === undefined ? null : fitItem(scene, i, cam, p);
  }
  const b = itemsBounds(scene, foundItems(scene, [t.id]));
  return b && fitBounds(b, cam.widthPx, cam.heightPx, p);
}

/** What the revealer reads of GraphView, and does through it. */
export interface RevealHost {
  state(): State;
  /** The scene shown, and the plan asked for (GraphView's plan: its scene may still be on its way). */
  scene(): PlanScene | null;
  plan(): Id;
  /** The renderer's camera, null before the engine is up. */
  camera(): Camera | null;
  params(): RenderParams;
  openPlan(plan: Id): void;
  moveCamera(c: Camera): void;
  /** The ring of what was found around these objects, searchFlashMs (D2). */
  flash(ids: Id[]): void;
}

/**
 * The jump (plan 6a, D2), the one way GraphView shows an object for another part of the app (the search; « voir dans
 * un autre plan » and the history next): the target's plan opened in its tab if it is not the one shown, then, once
 * its scene is shown, the object framed and ringed a moment. Only the camera moves: no gesture begins, the selection
 * stays (a placing waits in `pendingPlace`, which this never touches). The pending target is taken by its plan's
 * scene only (`sceneShown`, from GraphView's scene effect), once; another jump replaces it.
 */
export class Revealer {
  private pending: RevealTarget | null = null;
  private readonly host: RevealHost;
  constructor(host: RevealHost) { this.host = host; }

  /** False at once, nothing done, for an object gone, in the trash, or no longer in that plan (Review Focus 3). */
  reveal(t: RevealTarget): boolean {
    const h = this.host;
    if (!revealable(h.state(), t)) return false;
    this.pending = t;
    const sc = h.scene();
    if (sc && sc.plan.id === t.plan && h.plan() === t.plan) this.sceneShown();
    else h.openPlan(t.plan);
    return true;
  }

  /** A scene was shown: the target waiting for its plan is framed, and ringed. */
  sceneShown(): void {
    const h = this.host, t = this.pending, sc = h.scene(), cam = h.camera();
    if (!t) return;
    // Another plan asked for since: the jump is given up.
    if (h.plan() !== t.plan) { this.pending = null; return; }
    if (!sc || sc.plan.id !== t.plan || !cam) return;
    this.pending = null;
    const next = framing(sc, t, cam, h.params());
    if (!next) return;
    h.moveCamera(next);
    h.flash([t.id]);
  }
}
