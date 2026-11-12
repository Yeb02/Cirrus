/**
 * What a « close » of the window does (window.ts; review of the forced update, I1):
 * - wait: the closing sequence is under way (cirrus:quit, the interface's last saves): this close is held, and the
 *   window waits for that sequence's end — a second close (the title bar's cross clicked again, the forced update's
 *   restart) must never cut it short;
 * - close: no base open, nothing to save: the window closes;
 * - save: the closing sequence starts.
 */
export function closeStep(o: { closing: boolean; baseOpen: boolean }): 'wait' | 'close' | 'save' {
  if (o.closing) return 'wait';
  return o.baseOpen ? 'save' : 'close';
}
