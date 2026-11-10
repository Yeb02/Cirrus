import { useEffect, useRef } from 'react';
import { registryEscapeCloses } from '../tagRegistry.ts';

/**
 * What an Escape is left to while it is on screen, before a side panel of the base's tools (the tag registry's, plan 6a,
 * D4; the trash's, D5): the floating panels (the loose ones close on the Escape nothing took, and run first), a
 * connection's pop-up, the graph's menu, the search, the import dialog, a title being typed, a full screen.
 */
const ESCAPE_YIELDS_TO = '.panels .panel, .popup, .context-menu, .search-box, .publication-dialog, .title-editor, .full-screen';

/**
 * Escape closes the side panel (`close`), wherever the focus is — a button clicked is gone, and the focus with it —,
 * unless something nearer took it: a field that gives something up, a question, a menu, the search, a gesture of the
 * graph (they prevent its default), or something on screen that has it first (ESCAPE_YIELDS_TO), which closes first.
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
    const arrived = (e: KeyboardEvent) => { yielding.current = e.key === 'Escape' && document.querySelector(ESCAPE_YIELDS_TO) !== null; };
    // Bubbling, after the graph's own Escape (a gesture, a menu, the pop-up of a connection) and the fields': one that took it prevented its default.
    const key = (e: KeyboardEvent) => { if (registryEscapeCloses(e, yielding.current)) closing.current(); };
    window.addEventListener('keydown', arrived, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', arrived, true); window.removeEventListener('keydown', key); };
  }, []);
}
