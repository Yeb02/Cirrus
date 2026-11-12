import { useEffect, useRef } from 'react';
import { registryEscapeCloses } from '../tagRegistry.ts';

/**
 * What an Escape is left to while it is on screen, before a side panel of the base's tools (the tag registry's, plan 6a,
 * D4; the trash's, D5): a floating panel that is loose (it closes on the Escape nothing took, and runs first; a pinned one
 * never takes it: only its × closes it; a connection's pop-up is one), the graph's menu, a title being typed, a full screen.
 * Not the search box nor the import dialog: each takes Escape through its own keys, so only with the focus, and stops it
 * there (the panel never hears it); open without the focus, they leave it to the panel.
 */
export const ESCAPE_CANDIDATES = '.panel, .context-menu, .title-editor, .full-screen';
/** The classes of ESCAPE_CANDIDATES other than a floating panel's, which is not like the others (a pinned one never takes the key). */
const TAKERS = ESCAPE_CANDIDATES.split(', ').map((selector) => selector.slice(1)).filter((name) => name !== 'panel');

/** What the decision reads of an element on screen (an Element's class list and `closest`). */
export interface OnScreen { classList: { contains(name: string): boolean }; closest(selector: string): unknown }

/** Whether this element has the Escape before the side panel: one of ESCAPE_CANDIDATES — but a pinned panel, and a panel outside `.panels` (a side one). */
export function hasEscapeFirst(el: OnScreen): boolean {
  if (el.classList.contains('panel')) return !el.classList.contains('pinned') && el.closest('.panels') !== null;
  return TAKERS.some((name) => el.classList.contains(name));
}

/** Whether any of these elements (ESCAPE_CANDIDATES found on screen) has the Escape first. */
export const escapeYielded = (found: Iterable<OnScreen>): boolean => {
  for (const el of found) if (hasEscapeFirst(el)) return true;
  return false;
};

/**
 * Escape closes the side panel (`close`), wherever the focus is — a button clicked is gone, and the focus with it —,
 * unless something nearer took it: a field that gives something up, a question, a menu, the search, a gesture of the
 * graph (they prevent its default), or something on screen that has it first (ESCAPE_CANDIDATES, hasEscapeFirst), which closes first.
 * The decision is registryEscapeCloses', pure.
 */
export function usePanelEscape(close: () => void): void {
  const closing = useRef(close);
  closing.current = close;
  /** Whether something that has the Escape first was on screen when the key arrived. */
  const yielding = useRef(false);
  useEffect(() => {
    // Capturing, before any handler of the key: a floating panel closes on its own Escape and may be gone from the page by the time the
    // listener below runs (React flushes its state first), when one key would close both.
    const arrived = (e: KeyboardEvent) => { yielding.current = e.key === 'Escape' && escapeYielded(document.querySelectorAll(ESCAPE_CANDIDATES)); };
    // Bubbling, after the graph's own Escape (a gesture, a menu) and the fields': one that took it prevented its default.
    const key = (e: KeyboardEvent) => { if (registryEscapeCloses(e, yielding.current)) closing.current(); };
    window.addEventListener('keydown', arrived, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', arrived, true); window.removeEventListener('keydown', key); };
  }, []);
}
