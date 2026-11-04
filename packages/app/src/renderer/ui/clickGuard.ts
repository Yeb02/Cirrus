/**
 * The click a press closing a context menu begins is swallowed, app-wide (ruling I2 of the task 5 review): whatever
 * pop-up, panel or button it lands on, it only meant to close the menu — no preview opens, no file goes to the
 * system's application. Its double-click too (a double-click whose first press closed the menu). The press is told
 * apart by its own event: ContextMenu hands the press that closed it (dismissedBy), each press is recorded (press),
 * and a click belongs to the last press. A click of the keyboard or of a script (`detail` 0) is never one that closed
 * a menu. Pure: the window's listeners (guardClicks) feed it.
 */
export class ClickGuard {
  /** The last press, and the one that closed a menu, by identity. */
  private last: object | null = null;
  private dismissing: object | null = null;
  /** Whether the first click of the pair under way was swallowed: its double-click is then too. */
  private pairSwallowed = false;

  press(e: object): void {
    this.last = e;
  }

  dismissedBy(e: object): void {
    this.dismissing = e;
  }

  /** A click, `detail` its count: whether it is swallowed. */
  click(detail: number): boolean {
    const swallow = detail >= 1 && this.dismissing !== null && this.last === this.dismissing;
    if (swallow) this.dismissing = null;
    if (detail <= 1) this.pairSwallowed = swallow;
    return swallow;
  }

  /** A double-click: whether it is swallowed. */
  dblclick(): boolean {
    const swallow = this.pairSwallowed;
    this.pairSwallowed = false;
    return swallow;
  }
}

/** The app's guard: ContextMenu tells it the press that closed a menu. */
export const clickGuard = new ClickGuard();

/**
 * The guard on the window, in the capture phase so that nothing under it sees a swallowed click; returns its removal.
 * The graph's own gestures go by presses and releases, not clicks: they are not concerned.
 */
export function guardClicks(win: Window): () => void {
  const press = (e: PointerEvent) => clickGuard.press(e);
  const stop = (e: Event) => { e.stopImmediatePropagation(); e.preventDefault(); };
  const click = (e: MouseEvent) => { if (clickGuard.click(e.detail)) stop(e); };
  const dblclick = (e: MouseEvent) => { if (clickGuard.dblclick()) stop(e); };
  win.addEventListener('pointerdown', press, true);
  win.addEventListener('click', click, true);
  win.addEventListener('dblclick', dblclick, true);
  return () => {
    win.removeEventListener('pointerdown', press, true);
    win.removeEventListener('click', click, true);
    win.removeEventListener('dblclick', dblclick, true);
  };
}
