import { useEffect } from 'react';

/** The keys and pointer events the veil holds: none reaches the page under it. */
const HELD = ['keydown', 'keyup', 'keypress'] as const;

/**
 * The veil « Synchronisation… » (plan 5a, D8): over the whole window, at startup and on waking, while this PC catches up
 * with the server (syncConnectTimeoutMs at most). It holds the actions: the pointer stops on it, and no key reaches the
 * page (taken at the window, before anything else).
 */
export function SyncVeil() {
  useEffect(() => {
    const hold = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    for (const type of HELD) window.addEventListener(type, hold, { capture: true });
    return () => { for (const type of HELD) window.removeEventListener(type, hold, { capture: true }); };
  }, []);
  return (
    <div className="sync-veil" role="status" aria-live="polite" onContextMenu={(e) => e.preventDefault()}>
      <span>Synchronisation…</span>
    </div>
  );
}
