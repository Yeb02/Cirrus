import { canonical, type CompileAnswer, type CompiledPdf, type CompileRequest, type KnownLabel, type TexError } from '@cirrus/core';

export interface CompiledView {
  pdf: CompiledPdf | null;   // the last good one: kept while compiling and after an error
  error: TexError | null;    // of the latest finished compile
  log: string;
  pending: boolean;
  unavailable: { reason: 'absent' | 'installing' | 'failed'; message: string } | null;
  missing?: string;
}

/** Nothing compiled yet. */
export const IDLE_VIEW: CompiledView = { pdf: null, error: null, log: '', pending: false, unavailable: null };

export interface CompileBridge { compile(r: CompileRequest): Promise<CompileAnswer>; cancel(slot: string): void }
export interface Timers { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }

/**
 * The labels of each slot's last compilation, from its .aux (their numbers): the next request of that slot sends them
 * as its `known`, whichever scheduler sends it (a pop-up opened again on the same source).
 */
const known = new Map<string, KnownLabel[]>();
export const knownLabels = (slot: string): KnownLabel[] => known.get(slot) ?? [];

/** What two requests are compared by: everything but `known`, a hint that changes with the answers. */
const keyOf = (r: CompileRequest) => canonical({ ...r, known: undefined });

/**
 * When a source is compiled (plan 4b, spec 13), its clock and its bridge injected. The first request goes at once, so
 * that opening a pop-up does not wait; one that changes cancels at once the compilation running for its slot and goes
 * after `pauseMs` (latexTypingPauseMs), each new one starting the pause again; an equal one (by keyOf) changes nothing.
 * A request of another slot is another source: it goes at once, and the view starts empty. An answer to a request that
 * is no longer the latest is ignored, a `cancelled` one too (the latest's only ends `pending`). The view keeps the last
 * good PDF while compiling and after an error, which it shows with its log.
 */
export class CompileScheduler {
  private readonly bridge: CompileBridge;
  private readonly timers: Timers;
  private readonly pauseMs: () => number;
  private view: CompiledView = IDLE_VIEW;
  /** The slot the view shows. */
  private viewSlot: string | null = null;
  private readonly listeners = new Set<(v: CompiledView) => void>();
  private latest: CompileRequest | null = null;
  private latestKey = '';
  /** The request sent and not answered yet, by its number. */
  private running: { slot: string; n: number } | null = null;
  private sent = 0;
  /** A changed request waits for the pause: its timer. */
  private waiting = false;
  private timer: unknown = null;
  private disposed = false;

  constructor(bridge: CompileBridge, timers: Timers, pauseMs: () => number) {
    this.bridge = bridge;
    this.timers = timers;
    this.pauseMs = pauseMs;
  }

  /** The source to compile as it is now; null: none (what waits is dropped, what runs cancelled). */
  request(r: CompileRequest | null): void {
    if (this.disposed) return;
    if (r === null) {
      this.stop();
      this.latest = null;
      if (this.view.pending) this.show({ ...this.view, pending: false });
      return;
    }
    const key = keyOf(r);
    if (this.latest !== null && key === this.latestKey) return;
    const fresh = this.latest === null || this.latest.slot !== r.slot;
    this.stop();
    this.latest = r;
    this.latestKey = key;
    if (r.slot !== this.viewSlot) {
      this.viewSlot = r.slot;
      this.view = IDLE_VIEW;
    }
    if (fresh) this.send();
    else {
      this.timer = this.timers.set(() => { this.waiting = false; this.send(); }, this.pauseMs());
      this.waiting = true;
    }
    this.show({ ...this.view, pending: true });
  }

  /** `cb` is told the view now, then at each change; returns the unsubscription. */
  subscribe(cb: (v: CompiledView) => void): () => void {
    this.listeners.add(cb);
    cb(this.view);
    return () => { this.listeners.delete(cb); };
  }

  /** Nothing more: what waits is dropped, what runs cancelled, and later answers are ignored. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }

  private stop(): void {
    if (this.waiting) {
      this.timers.clear(this.timer);
      this.waiting = false;
    }
    if (this.running) {
      this.bridge.cancel(this.running.slot);
      this.running = null;
    }
  }

  private send(): void {
    const r = this.latest!, n = ++this.sent;
    this.running = { slot: r.slot, n };
    let answer: Promise<CompileAnswer>;
    try {
      answer = this.bridge.compile({ ...r, known: known.get(r.slot) ?? r.known });
    } catch (e) {
      answer = Promise.reject(e);
    }
    answer.then((a) => this.answered(r.slot, n, a), (e: unknown) => this.failed(n, e));
  }

  private answered(slot: string, n: number, a: CompileAnswer): void {
    if (this.disposed || this.running?.n !== n) return;
    this.running = null;
    const v = this.view;
    switch (a.status) {
      case 'ok':
        known.set(slot, a.labels);
        return this.show({ pdf: a.pdf, error: null, log: a.log, pending: false, unavailable: null });
      case 'error':
        known.set(slot, a.labels);
        return this.show({ pdf: v.pdf, error: a.error, log: a.log, pending: false, unavailable: null, ...(a.missing ? { missing: a.missing } : {}) });
      case 'unavailable':
        return this.show({ ...v, pending: false, unavailable: { reason: a.reason, message: a.message } });
      case 'cancelled':
        // Cancelled by the main process itself (closing, the same slot asked by another view): nothing to show of it.
        return this.show({ ...v, pending: false });
    }
  }

  /** The bridge failed (the IPC): said as an error of the source, the last PDF kept. */
  private failed(n: number, e: unknown): void {
    if (this.disposed || this.running?.n !== n) return;
    this.running = null;
    const message = `La compilation n’a pas pu être demandée : ${e instanceof Error ? e.message : String(e)}`;
    this.show({ pdf: this.view.pdf, error: { message, line: null, where: 'source' }, log: '', pending: false, unavailable: null });
  }

  private show(v: CompiledView): void {
    this.view = v;
    for (const cb of this.listeners) cb(v);
  }
}
