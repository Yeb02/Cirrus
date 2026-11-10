import type { Id, State } from '@cirrus/core';
import { type Camera, DEFAULT_PARAMS, plansShowing } from '@cirrus/view';
import { type KeyTarget, textOwnsKeys } from './keys.ts';

/** Where the view was (plan 6a, D2): a plan, and its camera there. */
export interface Place { plan: Id; camera: Camera }

const ALL = () => true;

/** Whether two places are the same view: the plan and what the camera frames (the window's size is not part of it). */
const sameView = (a: Place, b: Place): boolean => a.plan === b.plan && a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.zoom === b.camera.zoom;

/**
 * The stack behind « précédent » and « suivant » (plan 6a, D2), for the session: pure, it knows nothing of the view.
 * A jump pushes the place it leaves (`push`); `back` and `forward` give the place to go to, taking the one the view is at
 * to the other side, so that each can be undone by the other. A new jump after a `back` clears what was ahead. At most
 * `max` places are kept behind (navHistoryMax, 100 unless told), the oldest forgotten; `max` may be changed between two
 * pushes.
 *
 * A place whose plan is gone (`exists` says so; every plan exists unless told) is skipped and dropped, and so is one equal to where the view is: a
 * step must show something. Without a place to go to, nothing changes except those drops.
 */
export class NavHistory {
  private behind: Place[] = [];
  private ahead: Place[] = [];
  max: number;
  constructor(max: number = DEFAULT_PARAMS.navHistoryMax) { this.max = max; }

  push(here: Place): void {
    this.ahead = [];
    const last = this.behind[this.behind.length - 1];
    if (last && sameView(last, here)) return;
    this.behind.push(here);
    if (this.behind.length > this.max) this.behind.splice(0, this.behind.length - this.max);
  }

  back(here: Place, exists: (plan: Id) => boolean = ALL): Place | null {
    return this.step(this.behind, this.ahead, here, exists);
  }

  forward(here: Place, exists: (plan: Id) => boolean = ALL): Place | null {
    return this.step(this.ahead, this.behind, here, exists);
  }

  /** The last live place of `from` other than `here`, which `to` gets in its stead; those skipped are dropped. */
  private step(from: Place[], to: Place[], here: Place, exists: (plan: Id) => boolean): Place | null {
    while (from.length > 0) {
      const place = from.pop()!;
      if (!exists(place.plan) || sameView(place, here)) continue;
      to.push(here);
      return place;
    }
    return null;
  }
}

/** A key as the shortcuts read it. */
interface KeyLike { key: string; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }
export type HistoryMove = 'back' | 'forward';

/** Alt+← and Alt+→ alone (D2): the window's shortcuts for « précédent » and « suivant ». */
export function historyKey(ev: KeyLike): HistoryMove | null {
  if (!ev.altKey || ev.ctrlKey || ev.shiftKey || ev.metaKey) return null;
  return ev.key === 'ArrowLeft' ? 'back' : ev.key === 'ArrowRight' ? 'forward' : null;
}

/**
 * Whether the history's keys and buttons are heard with `target` focused (or hit): not in a text field, a LaTeX field being
 * edited (textOwnsKeys: the keys are the text's, Alt+← moves its cursor) nor in a code editor (CodeMirror); a title editor
 * and the search box are fields too. Anywhere else, a panel's button included, they are.
 */
function heard(target: KeyTarget | null): boolean {
  return !textOwnsKeys(target) && target?.closest('.cm-editor') == null;
}

/** The move Alt+← or Alt+→ asks for from `target`, or null: another key, or a field that keeps its keys (fix round 1, M3). */
export function historyKeyFor(ev: KeyLike, target: KeyTarget | null): HistoryMove | null {
  const dir = historyKey(ev);
  return dir !== null && heard(target) ? dir : null;
}

/** The move a side button asks for with `active` focused: none while a field owns the keys (fix round 1, M6). */
export function historyButtonFor(button: number, active: KeyTarget | null): HistoryMove | null {
  const dir = sideButton(button);
  return dir !== null && heard(active) ? dir : null;
}

/** The move an app command of Windows asks for (the main process sends `browser-backward` and `browser-forward`), likewise. */
export function historyCommandFor(command: string, active: KeyTarget | null): HistoryMove | null {
  const dir = command === 'browser-backward' ? 'back' : command === 'browser-forward' ? 'forward' : null;
  return dir !== null && heard(active) ? dir : null;
}

const NAV_KEYS = new Set(['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * The key that moves the view (spec 8.1, 9.1: + − and the arrows when the graph has the focus), or null. The arrows with
 * Alt move nothing any more (plan 6a, D2): Alt+← and Alt+→ are « précédent » and « suivant ».
 */
export function navKeyOf(ev: Pick<KeyLike, 'key' | 'altKey'>): string | null {
  if (!NAV_KEYS.has(ev.key)) return null;
  return ev.altKey && ev.key.startsWith('Arrow') ? null : ev.key;
}

/**
 * The mouse's side buttons (D2): `button` 3 is « précédent », 4 « suivant ». They are neither of the graph's three
 * buttons: the graph does not feed them as a left press (it would begin a gesture), and the window acts on their release.
 */
export function sideButton(button: number): HistoryMove | null {
  return button === 3 ? 'back' : button === 4 ? 'forward' : null;
}

const COLLATOR = new Intl.Collator('fr');

/**
 * The plans `id` is shown in other than `here` (plan 6a, D3), in the order a list of them is read: the lobby first (its
 * tab is always the first), then the open tabs in their order, then the plans without a tab by name.
 */
export function elsewhere(s: State, kind: 'node' | 'connection', id: Id, here: Id, tabs: readonly Id[]): Id[] {
  const rank = (p: Id) => (s.plans.get(p)?.type === 'lobby' ? -1 : tabs.includes(p) ? tabs.indexOf(p) : tabs.length);
  const name = (p: Id) => s.plans.get(p)?.name ?? '';
  return plansShowing(s, kind, id).filter((p) => p !== here && s.plans.has(p)).sort((a, b) => rank(a) - rank(b) || COLLATOR.compare(name(a), name(b)) || (a < b ? -1 : 1));
}

/**
 * Where a jump to an object goes (D2): this plan if it is shown there, else the first of its other plans (`elsewhere`:
 * the lobby, the tabs, the rest by name), or null if it is in none.
 */
export function destination(s: State, kind: 'node' | 'connection', id: Id, here: Id, tabs: readonly Id[]): Id | null {
  if (plansShowing(s, kind, id).includes(here)) return here;
  return elsewhere(s, kind, id, here, tabs)[0] ?? null;
}
