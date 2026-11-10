import type { Id, State } from '@cirrus/core';
import type { Camera } from '@cirrus/view';
import { NavHistory, type HistoryMove, type Place } from '../../navigation.ts';
import type { RevealTarget } from './reveal.ts';

/** What a jump says when its object is no longer where it was shown: in the trash, or out of that plan (Review Focus 3). */
export const OBJECT_GONE = 'Cet objet n’est plus là : il a été jeté, ou retiré de ce plan.';

/** What the jumps read of GraphView, and do through it. */
export interface JumpHost {
  state(): State;
  /** Where the view is: the plan whose scene is shown, and its camera; null before the engine is up. */
  place(): Place | null;
  /** navHistoryMax, as of now. */
  max(): number;
  /** A gesture, a question, a repercussion or a .bib's import under way: the history waits for it. */
  busy(): boolean;
  /** Ends the ring of a jump still in progress: a step back or forward is a move of its own, nothing blinks after it. */
  stopFlash(): void;
  /** The camera `plan` opens with the next time it is shown (GraphView's cameras). */
  remember(plan: Id, camera: Camera): void;
  /** Shows a plan in its tab (App's openPlan). */
  openPlan(plan: Id): void;
  moveCamera(camera: Camera): void;
}

/**
 * The jumps and the stack behind « précédent » et « suivant » (plan 6a, D2), around the revealer: a jump pushes the place
 * it leaves, once it is known to go (an object gone pushes nothing: the stack stays right); `back` and `forward` restore
 * a place — its plan opened in its tab if it is not the one shown, and that plan's camera exactly — without ringing
 * anything (the ring of a jump in progress ends: `stopFlash`), and skip a place whose plan has been deleted. A simple move of the view never enters the stack.
 */
export class Jumps {
  readonly history = new NavHistory();
  private readonly host: JumpHost;
  private readonly revealer: { reveal(t: RevealTarget): boolean };
  constructor(host: JumpHost, revealer: { reveal(t: RevealTarget): boolean }) {
    this.host = host;
    this.revealer = revealer;
  }

  /** The revealer's jump, with the place left pushed. False at once, nothing pushed, for an object gone. */
  reveal(t: RevealTarget): boolean {
    const here = this.host.place();
    if (!this.revealer.reveal(t)) return false;
    this.leave(here);
    return true;
  }

  /** A jump within the plan that is only a move of the camera (« s’y téléporter »): the place left is pushed. */
  moveTo(camera: Camera): void {
    this.leave(this.host.place());
    this.host.moveCamera(camera);
  }

  back(): boolean { return this.move('back'); }
  forward(): boolean { return this.move('forward'); }

  private leave(here: Place | null): void {
    if (!here) return;
    this.history.max = this.host.max();
    this.history.push({ plan: here.plan, camera: { ...here.camera } });
  }

  private move(dir: HistoryMove): boolean {
    const h = this.host, here = h.place();
    if (!here || h.busy()) return false;
    const to = this.history[dir]({ plan: here.plan, camera: { ...here.camera } }, (plan) => h.state().plans.has(plan));
    if (!to) return false;
    h.stopFlash();
    if (to.plan === here.plan) {
      h.moveCamera({ ...to.camera, widthPx: here.camera.widthPx, heightPx: here.camera.heightPx });
    } else {
      // The scene shown for that plan restores its camera, the window's size being today's.
      h.remember(to.plan, to.camera);
      h.openPlan(to.plan);
    }
    return true;
  }
}

/**
 * A plan's button in a node's pop-up (D2): the node framed in that plan, as a jump; the node no longer there, the plan
 * opens as the button did before.
 */
export function showNodeIn(jumps: Pick<Jumps, 'reveal'>, openPlan: (plan: Id) => void, plan: Id, node: Id): void {
  if (!jumps.reveal({ plan, id: node, kind: 'node' })) openPlan(plan);
}
