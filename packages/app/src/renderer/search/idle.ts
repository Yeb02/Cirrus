// The search index's slices inside one idle moment (plan 6a, D1; minor points pass after the reviews of tasks 4 and 6).
// `requestIdleCallback` calls back a request made during an idle moment only at the next one, and Chromium makes them 50 ms
// long when nothing is drawn: one slice of 8 ms per moment built a rich 50 000-node base (2 s of work) in 15 s. The slices now
// follow one another inside a moment, while it has time left and no input waits (`navigator.scheduling.isInputPending`).

/** The least an idle moment must have left, in ms, for another slice to begin in it. */
export const IDLE_MARGIN_MS = 1;

/**
 * After a slice, in the same idle moment: the budget in ms of another slice — `sliceMs` (searchBuildSliceMs) at most, what
 * remains of the moment if less —, or null, the moment given back. Another slice only while the moment has more than the
 * margin left (`remaining`, `deadline.timeRemaining()`) and no input waits (`inputPending`).
 */
export function nextSliceMs(remaining: number, inputPending: boolean, sliceMs: number): number | null {
  if (inputPending || !(remaining > IDLE_MARGIN_MS)) return null;
  return Math.min(sliceMs, remaining);
}

/**
 * `navigator.scheduling.isInputPending`, asked without the continuous inputs (a mouse that moves does not stop a slice of 8
 * ms: only a key or a click does); null where the page has none — one slice per idle moment, as before.
 */
export function inputProbe(nav: Navigator = navigator): (() => boolean) | null {
  const scheduling = (nav as { scheduling?: { isInputPending?(options?: { includeContinuous?: boolean }): boolean } }).scheduling;
  const ask = scheduling?.isInputPending;
  return typeof ask === 'function' ? () => ask.call(scheduling, { includeContinuous: false }) : null;
}

/**
 * The slices of one idle moment: the first always, at `sliceMs` or what the moment leaves (a millisecond at least: a callback
 * run by its timeout has nothing left, and a busy window must still build); then, with a `pending` probe, another while
 * nextSliceMs says so, each step bounded by its own end. `step(end)` works until `end` (a time of `now`) and says whether
 * the work is done, which stops the loop. Without a probe the moment holds one slice.
 */
export function runIdleSlices(
  idle: { timeRemaining(): number }, sliceMs: number, step: (end: number) => boolean, pending: (() => boolean) | null,
  now: () => number = () => performance.now(),
): void {
  let budget: number | null = Math.min(sliceMs, Math.max(IDLE_MARGIN_MS, idle.timeRemaining()));
  while (budget !== null) {
    if (step(now() + budget)) return;
    budget = pending === null ? null : nextSliceMs(idle.timeRemaining(), pending(), sliceMs);
  }
}
