/**
 * One exchange with the network and its body (plan 4c, D5; plan 5b, D3), shared by the metadata's exchange (fetch.ts)
 * and the open web's (guard.ts), so that their delays and their reading exist once (review of task 2, I1, I2):
 * - Transfer: the exchange's abort and its delays, the whole exchange's, then, for a PDF, the longest wait for data and
 *   the whole download's bound;
 * - readBody: a body read into one buffer under its cap.
 */

/** A refusal, its message for the user, in French. */
export class Refusal extends Error {}

export const OFFLINE = 'Pas de connexion.';
export const NOT_FOUND = 'Publication introuvable.';
/** The end of every `late` refusal (fetch.ts, guard.ts): « Le … ne répond pas (délai de 20 s dépassé). », its delay by `seconds`. */
const LATE = / ne répond pas \(délai de [^()]+ dépassé\)\.$/;

/**
 * Whether an import's refusal says that the network was not reached, rather than what it answered (plan 5b, task 3,
 * review I1): no connection (OFFLINE: a name not resolved, a connection refused, cut or its TLS refused), or no answer
 * within the delay (a `late` refusal, LATE). Another network may still reach it: the server's import failing so is the
 * PC's to make, by its own (Electron's: its proxy, its certificates). Anything else — not found, an address refused,
 * an answer unexpected or too large — is what the network said, the same from anywhere.
 */
export const unreachable = (message: string): boolean => message === OFFLINE || LATE.test(message);

export const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** The redirects followed at most, per request (a DOI resolver's chains take one or two). A fixed bound, as browsers have one. */
export const MAX_REDIRECTS = 5;
/** The media type of a Content-Type, lower case, without its parameters. */
export const mediaType = (header: string | null) => (header ?? '').split(';')[0].trim().toLowerCase();
const fr = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
export const seconds = (ms: number) => `${fr(ms / 1000)} s`;
/** A duration as a message says it: in seconds under a minute, else in minutes (« 5 min »). */
export const duration = (ms: number) => (ms < 60_000 ? seconds(ms) : `${fr(ms / 60_000)} min`);
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The delays of an exchange: publicationTimeoutMs, publicationPdfMaxMs. */
export interface Limits {
  /** The whole exchange's delay; once it is a PDF's download (Transfer.stall), the longest wait for data. */
  timeoutMs: number;
  /** A PDF's whole download at most, counted from the exchange's start (review of task 2, I2). */
  pdfMaxMs: number;
}

/** What an exchange says, in French, when its delays are unusable (see validLimits): refused before anything is asked. */
export const INVALID_DELAY = 'Délai invalide.';

/**
 * Whether both delays are finite numbers above zero. Anything else is a bug upstream (a setting that came through
 * absent or garbled) that must not run an exchange: with NaN or no value the deadline is NaN, no comparison with it is
 * ever true, so nothing stops the exchange and its timer (`setTimeout` reads a NaN delay as 1 ms) is set again every
 * millisecond; with zero or less the exchange is stopped before it can answer; with infinity it has no bound at all.
 * So the Transfer refuses them (RangeError), and the two callers that must never throw (openFetch, exchange) check first.
 */
export const validLimits = (limits: Limits) => [limits.timeoutMs, limits.pdfMaxMs].every((ms) => Number.isFinite(ms) && ms > 0);

/** The longest delay `setTimeout` keeps: 2^31 − 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What an exchange says when it ends early, in French: its delay passed, a PDF's download too long, the network failing. */
export interface Failures {
  late(): Refusal;
  tooLong(): Refusal;
  /** The network failed with `cause` (logged by the caller, never shown). */
  offline(cause: unknown): Refusal;
}

/**
 * An exchange's abort and its delays. One timer, whose deadline a piece of data moves without touching the timer
 * itself: when it fires before the deadline, it is set again for it. A piece of data thus costs a number written,
 * never a timer, whatever pieces a server cuts its body into. Stopped (its delay, a sibling's refusal), the exchange is
 * aborted, every step raced against it fails at once, and a body being read is let go (readBody).
 */
export class Transfer {
  private readonly controller = new AbortController();
  /** Aborted when the exchange stops or ends: its reason a Refusal when it stopped. */
  readonly signal: AbortSignal = this.controller.signal;
  private readonly limits: Limits;
  private readonly failures: Failures;
  private readonly start = performance.now();
  private deadline: number;
  private absolute = Number.POSITIVE_INFINITY;
  private stalled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expire: (e: Refusal) => void = () => {};
  private readonly expired: Promise<never>;

  /** @throws RangeError unless both delays are finite numbers above zero (validLimits): a programming error, never the user's. */
  constructor(limits: Limits, failures: Failures) {
    if (!validLimits(limits)) throw new RangeError('Transfer: timeoutMs and pdfMaxMs must be finite numbers above 0.');
    this.limits = limits;
    this.failures = failures;
    this.expired = new Promise<never>((_resolve, reject) => { this.expire = reject; });
    this.expired.catch(() => {});
    this.deadline = this.start + limits.timeoutMs;
    this.schedule();
  }

  /** Given up with `e`: the exchange aborted, any step raced against it rejected (a step may ignore its signal). */
  stop(e: Refusal): void {
    if (this.signal.aborted) return;
    clearTimeout(this.timer);
    this.controller.abort(e);
    this.expire(e);
  }

  /**
   * From now on, a PDF's download: the delay becomes a wait for data (moved by `touch`), and the whole download is
   * bounded by `pdfMaxMs` from the exchange's start, however steadily its data come.
   */
  stall(): void {
    if (this.stalled) return;
    this.stalled = true;
    this.absolute = this.start + this.limits.pdfMaxMs;
    this.deadline = performance.now() + this.limits.timeoutMs;
    this.schedule();
  }

  /** Data came (a piece, a redirect): a PDF's wait for data starts again. Nothing for the whole exchange's delay. */
  touch(): void {
    if (this.stalled) this.deadline = performance.now() + this.limits.timeoutMs;
  }

  /**
   * One timer for both deadlines. Node reads a delay over 2^31 − 1 ms (about 24.8 days) as 1 ms, so a far deadline is
   * reached in steps of that size, check() setting the timer again until it is due.
   */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.signal.aborted) return;
    const wait = Math.max(0, Math.min(this.deadline, this.absolute) - performance.now());
    this.timer = setTimeout(() => this.check(), Math.min(wait, MAX_TIMER_MS));
  }

  private check(): void {
    const now = performance.now();
    if (now >= this.absolute) this.stop(this.failures.tooLong());
    else if (now >= this.deadline) this.stop(this.failures.late());
    else this.schedule();
  }

  /** What a failure of the network is to the user: the stop's refusal if the exchange stopped, else the network's. */
  failure(e: unknown): Refusal {
    if (e instanceof Refusal) return e;
    if (this.signal.reason instanceof Refusal) return this.signal.reason;
    return this.failures.offline(e);
  }

  /**
   * One step of the network (a resolution, a request), raced against the delay: its failure is the connection's. For
   * a few steps only: each race waits on the delay until it ends (a body's pieces are read by readBody, never so).
   */
  async network<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await Promise.race([step(), this.expired]);
    } catch (e) {
      throw this.failure(e);
    }
  }

  /** The exchange done: its timer cleared, whatever it still runs aborted. */
  close(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

/** The bytes that tell a PDF, « %PDF- »: a body's rule is chosen once they are in. */
export const HEAD_BYTES = 5;
/** A buffer's first size when the body's length is not declared within its cap. */
const FIRST_BYTES = 64 * 1024;
/**
 * A buffer's first size at most when it is declared within its cap: a server that announces 200 Mo and sends nothing
 * costs this, never what it announced (review of task 2, round 2).
 */
const FIRST_DECLARED_BYTES = 2 ** 20;

/** How a body is read. */
export interface BodyRule {
  /** The bytes read at most. */
  cap: number;
  /** Past the cap: refused with this; null, the body is cut there and the rest let go. */
  tooBig: Refusal | null;
  /** A PDF's download (Transfer.stall). */
  stall: boolean;
}

/**
 * One buffer, doubling as bytes come, never beyond its cap; while the body keeps within its declared length
 * (`expected`), never beyond that length either, so that an honest body ends in a buffer of its own size. `sized`: each
 * size allocated (a test's probe).
 */
class Bytes {
  private buf: Uint8Array;
  private readonly cap: number;
  private readonly expected: number | null;
  private readonly sized: ((capacity: number) => void) | undefined;
  size = 0;

  constructor(first: number, cap: number, expected: number | null, sized?: (capacity: number) => void) {
    this.buf = new Uint8Array(first);
    this.cap = cap;
    this.expected = expected;
    this.sized = sized;
    sized?.(first);
  }

  /** `piece` after the others: the caller made sure it fits under the cap. */
  push(piece: Uint8Array): void {
    const need = this.size + piece.byteLength;
    if (need > this.buf.length) {
      const doubled = Math.max(need, this.buf.length * 2);
      // Past its declared length, a body doubles as any other: a server that lies costs no copy per piece.
      const target = this.expected !== null && need <= this.expected ? Math.min(doubled, this.expected) : doubled;
      const next = new Uint8Array(Math.min(this.cap, target));
      next.set(this.buf.subarray(0, this.size));
      this.buf = next;
      this.sized?.(next.length);
    }
    this.buf.set(piece, this.size);
    this.size = need;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.size);
  }
}

/**
 * `res`'s body (review of task 2, I1): into one buffer that doubles as bytes come and never grows past its cap (its
 * first size the declared length, 1 Mio at most), so that memory follows the bytes received, never the pieces a server
 * cuts them into nor the length it announces. `sized`: each size of the buffer allocated (a test's probe). `rule(null)`: the rule before any byte, whose cap refuses a declared length at once when it has a refusal;
 * `rule(head)`: the rule the body is read under, once its first HEAD_BYTES are in (or fewer, at its end). A read waits
 * on the network without a race: when the exchange stops, its reader is cancelled, which ends the read at once, even
 * on a source that ignores it. A failure of the stream is the connection's (`t.failure`). Its first bytes come back
 * as `head`, whatever the cap kept.
 */
export async function readBody(
  res: Response, t: Transfer, rule: (head: Uint8Array | null) => BodyRule, sized?: (capacity: number) => void,
): Promise<{ bytes: Uint8Array; head: Uint8Array }> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  const before = rule(null);
  if (before.tooBig && declared > before.cap) {
    void res.body?.cancel().catch(() => {});
    throw before.tooBig;
  }
  const head = new Uint8Array(HEAD_BYTES);
  let headSize = 0;
  let current: BodyRule | null = null;
  let out = new Bytes(0, 0, null);
  /** The pieces before the head is in: HEAD_BYTES − 1 bytes, then the piece that completes it. */
  const early: Uint8Array[] = [];
  /** `piece` under the current rule; false once the body is cut there (nothing further is read). */
  const add = (piece: Uint8Array): boolean => {
    const chosen = current!;
    const room = chosen.cap - out.size;
    if (piece.byteLength <= room) {
      out.push(piece);
      return true;
    }
    if (chosen.tooBig) throw chosen.tooBig;
    out.push(piece.subarray(0, room));
    return false;
  };
  /** The rule chosen from the head; the early pieces added under it. */
  const decide = (): boolean => {
    const chosen = rule(head.subarray(0, headSize));
    current = chosen;
    if (chosen.stall) t.stall();
    if (chosen.tooBig && declared > chosen.cap) throw chosen.tooBig;
    // The declared length only sizes the buffer, and only as its bytes come: a server that sends more or less is read as
    // it sends, and one that announces much and sends little costs FIRST_DECLARED_BYTES at most.
    const expected = Number.isSafeInteger(declared) && declared >= 0 && declared <= chosen.cap ? declared : null;
    out = new Bytes(expected !== null ? Math.min(expected, FIRST_DECLARED_BYTES) : Math.min(chosen.cap, FIRST_BYTES), chosen.cap, expected, sized);
    return early.splice(0).every(add);
  };
  if (!res.body) {
    decide();
    return { bytes: out.bytes(), head: head.subarray(0, 0) };
  }
  // Stopped before its body is read (a sibling's refusal): it is not read.
  if (t.signal.reason instanceof Refusal) {
    void res.body.cancel().catch(() => {});
    throw t.signal.reason;
  }
  const reader = res.body.getReader();
  const letGo = () => { void reader.cancel(t.signal.reason).catch(() => {}); };
  t.signal.addEventListener('abort', letGo, { once: true });
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (e) {
        throw t.failure(e);
      }
      // Stopped while it waited: the read was ended by the cancel.
      if (t.signal.reason instanceof Refusal) throw t.signal.reason;
      if (next.done) break;
      const piece = next.value;
      t.touch();
      // An empty piece (which an injected network may send): nothing to keep, never a place in `early`.
      if (piece.byteLength === 0) continue;
      if (current !== null) {
        if (!add(piece)) break;
        continue;
      }
      const take = Math.min(HEAD_BYTES - headSize, piece.byteLength);
      head.set(piece.subarray(0, take), headSize);
      headSize += take;
      early.push(piece);
      if (headSize === HEAD_BYTES && !decide()) break;
    }
    if (current === null) decide();
  } finally {
    t.signal.removeEventListener('abort', letGo);
    // Not waited for: a stalled source may never answer it.
    void reader.cancel().catch(() => {});
  }
  return { bytes: out.bytes(), head: head.subarray(0, headSize) };
}
