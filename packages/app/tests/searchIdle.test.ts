import { expect, test } from 'vitest';
import { IDLE_MARGIN_MS, inputProbe, nextSliceMs, runIdleSlices } from '../src/renderer/search/idle.ts';

// The slices of the search index's build inside one idle moment (plan 6a, minor points pass, task 6's review): as many as
// the moment allows, none while an input waits, one per moment where the page cannot tell. The decision is pure.

test('nextSliceMs : une autre tranche tant qu’il reste plus que la marge et qu’aucune saisie n’attend, bornée par searchBuildSliceMs et par ce qui reste', () => {
  expect(IDLE_MARGIN_MS).toBe(1);
  expect(nextSliceMs(30, false, 8)).toBe(8);
  expect(nextSliceMs(5, false, 8)).toBe(5);
  expect(nextSliceMs(1.5, false, 8)).toBe(1.5);
  expect(nextSliceMs(30, false, 2)).toBe(2);
  // Not above the margin: the moment is given back.
  expect(nextSliceMs(1, false, 8)).toBeNull();
  expect(nextSliceMs(0.4, false, 8)).toBeNull();
  expect(nextSliceMs(0, false, 8)).toBeNull();
  // An input waits: given back, whatever remains.
  expect(nextSliceMs(30, true, 8)).toBeNull();
  expect(nextSliceMs(1000, true, 50)).toBeNull();
});

/** An idle moment of `length` ms on a clock that only the slices advance: each takes the whole of its budget. */
function moment(length: number) {
  let t = 0;
  const ends: number[] = [];
  return {
    idle: { timeRemaining: () => Math.max(0, length - t) },
    now: () => t,
    /** A step that works until its end, `slices` times at most before it is done. */
    step: (doneAfter = Infinity) => (end: number) => { ends.push(end); t = end; return ends.length >= doneAfter; },
    ends,
    at: () => t,
  };
}

test('runIdleSlices : sans isInputPending, une seule tranche par moment libre, comme avant — bornée par searchBuildSliceMs', () => {
  const m = moment(50);
  runIdleSlices(m.idle, 8, m.step(), null, m.now);
  expect(m.ends).toEqual([8]);
  // The moment the browser gave short, or none (a callback run by its timeout: nothing remains): still one, at least a millisecond.
  const short = moment(3);
  runIdleSlices(short.idle, 8, short.step(), null, short.now);
  expect(short.ends).toEqual([3]);
  const late = moment(0);
  runIdleSlices(late.idle, 8, late.step(), null, late.now);
  expect(late.ends).toEqual([1]);
});

test('runIdleSlices : avec isInputPending, des tranches de searchBuildSliceMs tant qu’il reste plus d’une milliseconde, la dernière de ce qui reste', () => {
  const m = moment(50);
  runIdleSlices(m.idle, 8, m.step(), () => false, m.now);
  // 6 slices of 8 ms, then 2 ms remain (more than the margin): a last one of 2 ms, which ends with the moment.
  expect(m.ends).toEqual([8, 16, 24, 32, 40, 48, 50]);
  const small = moment(50);
  runIdleSlices(small.idle, 2, small.step(), () => false, small.now);
  expect(small.ends).toHaveLength(25);
  expect(small.ends.every((end, i) => end === (i + 1) * 2)).toBe(true);
});

test('runIdleSlices : une saisie qui attend rend le moment libre — après la première tranche, qui a lieu toujours —, la construction finie arrête la boucle', () => {
  // The first slice is made whatever waits: without it a busy window would never build the index.
  const waiting = moment(50);
  runIdleSlices(waiting.idle, 8, waiting.step(), () => true, waiting.now);
  expect(waiting.ends).toEqual([8]);
  // An input comes in after the third slice.
  const m = moment(50);
  let asked = 0;
  runIdleSlices(m.idle, 8, m.step(), () => ++asked > 2, m.now);
  expect(m.ends).toEqual([8, 16, 24]);
  // Done: no more slices, nothing is asked of the page.
  const done = moment(50);
  let probed = 0;
  runIdleSlices(done.idle, 8, done.step(2), () => { probed++; return false; }, done.now);
  expect(done.ends).toEqual([8, 16]);
  expect(probed).toBe(1);
});

test('inputProbe : isInputPending de la page, appelé sans les entrées continues (la souris qui bouge n’interrompt pas) ; absent, rien', () => {
  expect(inputProbe({} as Navigator)).toBeNull();
  expect(inputProbe({ scheduling: {} } as unknown as Navigator)).toBeNull();
  const calls: unknown[] = [];
  let pending = false;
  const probe = inputProbe({
    scheduling: { isInputPending(this: unknown, options?: unknown) { calls.push([this !== undefined, options]); return pending; } },
  } as unknown as Navigator);
  expect(probe).not.toBeNull();
  expect(probe!()).toBe(false);
  pending = true;
  expect(probe!()).toBe(true);
  expect(calls).toEqual([[true, { includeContinuous: false }], [true, { includeContinuous: false }]]);
});
