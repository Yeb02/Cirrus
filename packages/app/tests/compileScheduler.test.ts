import type { CompileAnswer, CompiledPdf, CompileRequest, KnownLabel } from '@cirrus/core';
import { expect, test } from 'vitest';
import { CompileScheduler, type CompiledView, knownLabels } from '../src/renderer/latex/scheduler.ts';

const PAUSE = 300;

/** Timers on a clock the test moves (advance), in the scheduler's injected form. */
function fakeTimers() {
  let now = 0, next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => { due.set(next, { at: now + ms, fn }); return next++; },
      clear: (h: unknown) => { due.delete(h as number); },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && due.delete(id)) t.fn();
      }
    },
  };
}

/** A bridge whose compilations the test answers, each by its request. */
function fakeBridge() {
  const sent: { req: CompileRequest; answer: (a: CompileAnswer) => Promise<void>; fail: (e: Error) => Promise<void> }[] = [];
  const cancelled: string[] = [];
  return {
    bridge: {
      compile: (req: CompileRequest) => new Promise<CompileAnswer>((resolve, reject) => {
        sent.push({ req, answer: (a) => { resolve(a); return settled(); }, fail: (e) => { reject(e); return settled(); } });
      }),
      cancel: (slot: string) => { cancelled.push(slot); },
    },
    sent, cancelled,
  };
}
/** The answers' callbacks run. */
const settled = () => new Promise<void>((r) => setImmediate(r));

let slots = 0;
/** A slot of its own per test: the table of known labels belongs to the module. */
const freshSlot = () => `summary:test-${++slots}`;
const req = (slot: string, source: string, known: KnownLabel[] = []): CompileRequest => ({
  slot, mode: 'snippet', source, preamble: 'P', refs: [], broken: [], doubled: [], cites: [], doubledCites: [], unknownCites: [], known, resources: [],
});
const pdf = (key: string): CompiledPdf => ({ key, size: 100, pages: 1 });
const ok = (key: string, labels: KnownLabel[] = []): CompileAnswer => ({ status: 'ok', pdf: pdf(key), labels, log: `log ${key}`, ms: 50, passes: 1, cached: false });
const LABEL: KnownLabel = { label: 'eq:1', number: '1', page: '1', anchor: 'equation.0.1' };

function setup() {
  const t = fakeTimers(), b = fakeBridge();
  const scheduler = new CompileScheduler(b.bridge, t.timers, () => PAUSE);
  const views: CompiledView[] = [];
  scheduler.subscribe((v) => views.push(v));
  return { ...t, ...b, scheduler, views, view: () => views.at(-1)! };
}

test('CompileScheduler : la première requête part sans pause', () => {
  const { scheduler, sent, view } = setup();
  expect(view()).toEqual({ pdf: null, error: null, log: '', pending: false, unavailable: null });
  scheduler.request(req(freshSlot(), 'a'));
  expect(sent.map((x) => x.req.source)).toEqual(['a']);
  expect(view().pending).toBe(true);
});

test('CompileScheduler : trois requêtes pendant la pause n’en compilent qu’une, la dernière', async () => {
  const { scheduler, sent, advance, view } = setup();
  const slot = freshSlot();
  scheduler.request(req(slot, 'a'));
  await sent[0].answer(ok('A'));
  expect(view()).toMatchObject({ pdf: pdf('A'), pending: false, log: 'log A' });
  for (const source of ['ab', 'abc', 'abcd']) {
    scheduler.request(req(slot, source));
    expect(view().pending).toBe(true);
    // Each new request starts the pause again.
    advance(PAUSE - 1);
  }
  expect(sent).toHaveLength(1);
  advance(1);
  expect(sent.map((x) => x.req.source)).toEqual(['a', 'abcd']);
  // The last good PDF stays while compiling.
  expect(view()).toMatchObject({ pdf: pdf('A'), pending: true });
  await sent[1].answer(ok('D'));
  expect(view()).toMatchObject({ pdf: pdf('D'), pending: false });
});

test('CompileScheduler : une requête qui change annule aussitôt la compilation en cours ; une requête égale ne fait rien', () => {
  const { scheduler, sent, cancelled, advance } = setup();
  const slot = freshSlot();
  scheduler.request(req(slot, 'a'));
  // The same request again, another object, another `known` hint: nothing.
  scheduler.request(req(slot, 'a', [LABEL]));
  expect(cancelled).toEqual([]);
  scheduler.request(req(slot, 'b'));
  expect(cancelled).toEqual([slot]);
  advance(PAUSE);
  expect(sent.map((x) => x.req.source)).toEqual(['a', 'b']);
  advance(10 * PAUSE);
  expect(sent).toHaveLength(2);
});

test('CompileScheduler : une erreur garde le dernier pdf, avec son journal', async () => {
  const { scheduler, sent, advance, view } = setup();
  const slot = freshSlot();
  scheduler.request(req(slot, 'a'));
  await sent[0].answer(ok('A'));
  scheduler.request(req(slot, 'a \\oops'));
  advance(PAUSE);
  const error = { message: 'Undefined control sequence.', line: 1, where: 'source' as const };
  await sent[1].answer({ status: 'error', error, labels: [], log: 'le journal', ms: 40, missing: 'tikz-cd.sty' });
  expect(view()).toEqual({ pdf: pdf('A'), error, log: 'le journal', pending: false, unavailable: null, missing: 'tikz-cd.sty' });
  // Fixed: the error goes.
  scheduler.request(req(slot, 'a'));
  advance(PAUSE);
  await sent[2].answer(ok('A'));
  expect(view()).toEqual({ pdf: pdf('A'), error: null, log: 'log A', pending: false, unavailable: null });
});

test('CompileScheduler : une réponse dépassée ou annulée est ignorée', async () => {
  const { scheduler, sent, advance, view } = setup();
  const slot = freshSlot();
  scheduler.request(req(slot, 'a'));
  scheduler.request(req(slot, 'b'));
  advance(PAUSE);
  // The main process would answer the first « cancelled »; even « ok », it is too late.
  await sent[0].answer(ok('A'));
  expect(view()).toMatchObject({ pdf: null, log: '', pending: true });
  // The current one cancelled by the main process itself (closing, the same slot asked elsewhere): nothing shown of it,
  // but nothing runs any more.
  await sent[1].answer({ status: 'cancelled' });
  expect(view()).toEqual({ pdf: null, error: null, log: '', pending: false, unavailable: null });
});

test('CompileScheduler : les labels rendus reviennent en known à la requête suivante du même emplacement (Review Focus 3)', async () => {
  const { scheduler, sent, advance } = setup();
  const slot = freshSlot();
  scheduler.request(req(slot, '\\label{eq:1}'));
  expect(sent[0].req.known).toEqual([]);
  await sent[0].answer(ok('A', [LABEL]));
  expect(knownLabels(slot)).toEqual([LABEL]);
  scheduler.request(req(slot, '\\label{eq:1} \\eqref{eq:1}'));
  advance(PAUSE);
  expect(sent[1].req.known).toEqual([LABEL]);
  // Through the module's table: a pop-up opened again on that source sends them too.
  const other = setup();
  other.scheduler.request(req(slot, '\\label{eq:1}'));
  expect(other.sent[0].req.known).toEqual([LABEL]);
  expect(knownLabels(freshSlot())).toEqual([]);
});

test('CompileScheduler : une autre source part aussitôt, sans le pdf de la précédente', async () => {
  const { scheduler, sent, cancelled, view } = setup();
  const a = freshSlot(), b = freshSlot();
  scheduler.request(req(a, 'a'));
  await sent[0].answer(ok('A'));
  scheduler.request(req(b, 'b'));
  expect(sent.map((x) => x.req.slot)).toEqual([a, b]);
  expect(cancelled).toEqual([]);
  expect(view()).toEqual({ pdf: null, error: null, log: '', pending: true, unavailable: null });
});

test('CompileScheduler : LaTeX indisponible, un pont qui échoue, null puis la même requête, dispose', async () => {
  const { scheduler, sent, cancelled, advance, view, views } = setup();
  const slot = freshSlot();
  scheduler.request(req(slot, 'a'));
  await sent[0].answer(ok('A'));
  scheduler.request(req(slot, 'b'));
  advance(PAUSE);
  await sent[1].answer({ status: 'unavailable', reason: 'absent', message: 'LaTeX n’est pas installé.' });
  expect(view()).toMatchObject({ pdf: pdf('A'), pending: false, unavailable: { reason: 'absent', message: 'LaTeX n’est pas installé.' } });
  scheduler.request(req(slot, 'c'));
  advance(PAUSE);
  await sent[2].fail(new Error('IPC fermé'));
  expect(view()).toMatchObject({ pdf: pdf('A'), pending: false, unavailable: null, error: { message: 'La compilation n’a pas pu être demandée : IPC fermé', line: null, where: 'source' } });
  // No request: what waits is dropped, what runs cancelled; the same request then goes at once.
  scheduler.request(req(slot, 'd'));
  scheduler.request(null);
  expect(view().pending).toBe(false);
  advance(PAUSE);
  expect(sent).toHaveLength(3);
  scheduler.request(req(slot, 'c'));
  expect(sent).toHaveLength(4);
  scheduler.dispose();
  expect(cancelled.at(-1)).toBe(slot);
  const seen = views.length;
  await sent[3].answer(ok('C'));
  scheduler.request(req(slot, 'e'));
  advance(PAUSE);
  expect(views).toHaveLength(seen);
  expect(sent).toHaveLength(4);
});
