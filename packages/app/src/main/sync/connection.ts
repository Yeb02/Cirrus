import { type Id, MAX_UNITS_PER_REQUEST, type RemoteUnit, SNAPSHOT_VERSION, SYNC_PROTOCOL_VERSION } from '@cirrus/core';
import { SCHEMA_VERSION } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import type { ServerConfig } from './config.ts';

// One connection of the sync client to the server (plan 5a, task 3): what it received and what it waits for, its
// requests — the token on each, one abort for all, a delay on each (plan 9, D7: exchange) —, and how their answers are
// read: a refusal that trying again will not change (Refusal), or a failure that a later connection may not meet.

/** The format headers of /hello (D10): the server refuses another protocol, schema or snapshot version. */
export const FORMAT = { 'Cirrus-Protocol': String(SYNC_PROTOCOL_VERSION), 'Cirrus-Schema': String(SCHEMA_VERSION), 'Cirrus-Snapshot': String(SNAPSHOT_VERSION) };
export const JSON_BODY = { 'Content-Type': 'application/json' };

/** What failed, as text: an error's message, or the value thrown (the sync's modules all read failures so). */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A refusal that trying again will not change: the server's (a token revoked, another format, its data replaced or
 * restored, a request it will never take), or this PC's state no longer following the server's (`diverged`). The
 * client stops until start() is called again.
 */
export class Refusal extends Error {
  readonly diverged: boolean;

  constructor(message: string, diverged = false) {
    super(message);
    this.diverged = diverged;
  }
}

/**
 * The French reason of a refused request: its body's `error`, or its status — and the route asked, `path`, when given
 * (a first sync's requests: firstSync.ts).
 */
export async function reasonOf(res: Response, path?: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `Réponse ${res.status} du serveur${path === undefined ? '' : ` à ${path}`}.`;
}

/** A refused request: a Refusal for what trying again will not change (4xx), an Error otherwise (the server's own failure). */
export async function ok(res: Response): Promise<void> {
  if (res.ok) return;
  const reason = await reasonOf(res);
  if (res.status >= 400 && res.status < 500) throw new Refusal(reason);
  throw new Error(reason);
}

export async function json(res: Response): Promise<unknown> {
  await ok(res);
  return res.json();
}

/** A request as the sync makes them: its method, its headers, its body. */
export interface SyncInit { method?: string; headers?: Record<string, string>; body?: BodyInit }

/**
 * A request's delay (plan 9, D7): `timeoutMs`, syncRequestTimeoutMs by default; `transfer`, how it counts — see
 * exchange.
 */
export interface RequestOptions { timeoutMs?: number; transfer?: boolean }

/**
 * The most a chunk of a transfer's body holds, as a file's Blob gives them: each taken by the network re-arms the delay,
 * so that a large one, in memory, is not taken in one piece. A buffer's size, not a setting: the delay is.
 */
const CHUNK_BYTES = 64 * 1024;

/** A delay over: the network failing (an Error, never a Refusal), said in French for the console and a first sync's message. */
function expired(path: string, ms: number, transfer: boolean): Error {
  const s = Math.max(1, Math.round(ms / 1000));
  return new Error(transfer
    ? `Le serveur ne répond plus : rien envoyé ni reçu pour ${path} depuis ${s} s.`
    : `Le serveur n’a pas répondu à ${path} en ${s} s.`);
}

/** `p`, or `signal`'s reason once it aborts, whichever comes first; a late answer (`dropped`) is let go. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, dropped: (x: T) => void = () => {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      p.then(dropped, () => {});
      reject(signal.reason);
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    p.then(
      (x) => { signal.removeEventListener('abort', stop); resolve(x); },
      (e: unknown) => { signal.removeEventListener('abort', stop); reject(e); },
    );
  });
}

/**
 * A transfer's body as the network takes it: a stream of chunks of CHUNK_BYTES at most — a Blob's own (a file's come
 * so; one in memory comes whole), bytes or text cut so —, `moved` told as each is asked for: the one before taken.
 * Nothing is copied: views of the bytes.
 */
function sentBody(body: Blob | Uint8Array | string, moved: () => void): ReadableStream<Uint8Array> {
  const source = body instanceof Blob ? body.stream().getReader() : null;
  let bytes: Uint8Array = body instanceof Blob ? new Uint8Array(0) : typeof body === 'string' ? new TextEncoder().encode(body) : body, at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      moved();
      while (at >= bytes.length && source) {
        const { value, done } = await source.read();
        if (done) break;
        bytes = value;
        at = 0;
      }
      if (at < bytes.length) c.enqueue(bytes.subarray(at, (at += CHUNK_BYTES)));
      else c.close();
    },
    cancel: (reason) => source?.cancel(reason),
  }, { highWaterMark: 0 });
}

/**
 * An answer's body as its reader reads it, through `signal` (the request's: its delay, its connection): the delay's
 * reason when it aborts, whatever the network does. For a transfer, `each` re-arms the delay as each chunk is asked for,
 * and none runs while nothing is (the reader busy elsewhere: the disk, a full inbox, is not the network); `end` once it
 * is read, cancelled or failed.
 */
function receivedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, each: (() => void) | null, end: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      each?.();
      try {
        const { value, done } = await untilAborted(reader.read(), signal);
        if (done) {
          end();
          c.close();
        } else {
          c.enqueue(value);
        }
      } catch (e) {
        end();
        reader.cancel().catch(() => {});
        throw signal.aborted ? signal.reason : e;
      } finally {
        if (each) end();
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/**
 * A request to the server within a delay (plan 9, D7), ended with `o.signal` too (its connection, a pairing's quit):
 * - a request (by default): the whole exchange within `timeoutMs`, from its start until its answer is read — its head
 *   and its body;
 * - a transfer (`transfer`: a file, a base, a journal, the event stream): no total delay, which would cut a large one on
 *   a slow line, but one of idleness — its body (bytes, text or a Blob) sent as a stream, each chunk taken by the network
 *   within `timeoutMs` of the one before; its answer's head within `timeoutMs` of the last; each chunk of its answer's
 *   body within `timeoutMs` of being asked for.
 * Past it, the request is aborted, and its promise, or its answer's reading, rejects with an Error (expired): the network
 * failing, as `fetch` failing, never a refusal. Whether `fetchFn` heeds the abort or not: a test's network, or one that
 * never answers, cannot hold it. Costs one timer and two small streams per request.
 */
export async function exchange(
  fetchFn: typeof fetch, url: string, path: string, init: SyncInit, o: { signal: AbortSignal; timeoutMs: number; transfer?: boolean },
): Promise<Response> {
  // A delay that is no number (a caller's mistake) bounds nothing, rather than end every request at once.
  const ms = Math.max(1, o.timeoutMs), bounded = Number.isFinite(ms), transfer = o.transfer === true, delay = new AbortController();
  const signal = AbortSignal.any([o.signal, delay.signal]);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (!bounded) return;
    timer = setTimeout(() => {
      timer = null;
      delay.abort(expired(path, ms, transfer));
    }, ms);
  };
  const { body } = init;
  const sendable = transfer && (body instanceof Blob || body instanceof Uint8Array || typeof body === 'string') ? body : null;
  // A body sent as a stream: Node's fetch, as the standard, asks it be said (duplex), Electron's as well.
  const sent = sendable !== null ? { body: sentBody(sendable, arm), duplex: 'half' } : {};
  arm();
  let res: Response;
  try {
    res = await untilAborted(fetchFn(url, { ...init, ...sent, signal } as RequestInit), signal, (late) => { late.body?.cancel().catch(() => {}); });
  } catch (e) {
    disarm();
    throw delay.signal.aborted ? delay.signal.reason : e;
  }
  if (transfer) disarm();
  if (!res.body) {
    disarm();
    return res;
  }
  return new Response(receivedBody(res.body, signal, transfer ? arm : null, disarm), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** What a connection's requests read of the settings: their delay. */
type ConnectionParams = Pick<RenderParams, 'syncRequestTimeoutMs'>;

/** One connection to the server: its requests (one abort for all), its stream, what it received and what it waits for. */
export class Connection {
  readonly config: ServerConfig;
  readonly abort = new AbortController();
  /** What ended it, the first cause. */
  error: unknown = null;
  /** The server's last number when it said hello: the base has caught up once it has received it. */
  target = 0;
  caughtUp = false;
  /** Its stream open: the sender runs. */
  open = false;
  /** The number of the last write its stream gave. */
  received = 0;
  /** The writes received, not yet handed to the reconciliation; the writes the server refused, likewise. */
  inbox: RemoteUnit[] = [];
  refused: { unit: Id; message: string }[] = [];
  /** The writes the server accepted, with their numbers, until they come back on the stream: not sent again. */
  readonly accepted = new Map<Id, number>();
  /** After a stale answer: the number to have received before sending again. */
  waitFor = 0;
  /** The most writes in one request, halved for a body over MAX_BODY_BYTES. */
  batchLimit = MAX_UNITS_PER_REQUEST;
  /** The receive window under way. */
  timer: ReturnType<typeof setTimeout> | null = null;
  /** A reconciliation of what arrived waits in the client's chain: it will take what arrives meanwhile. */
  queued = false;
  /** Running from the stream's opening: once it fires, the connection has proven itself (the backoff starts again from the shortest pause). */
  proof: ReturnType<typeof setTimeout> | null = null;
  /** The run: the hello, the stream, then the sender awaited. */
  done: Promise<void> = Promise.resolve();
  /** The network and the settings: the client's. */
  private readonly net: { fetch: typeof fetch; params(): ConnectionParams };
  /** flush's waits: resolved once the sender has nothing left to send. */
  private readonly idle: (() => void)[] = [];
  /** The stream's reading, waiting for room in the inbox (room). */
  private readonly roomWaits: (() => void)[] = [];
  private wake: (() => void) | null = null;
  private poked = false;

  constructor(config: ServerConfig, net: { fetch: typeof fetch; params(): ConnectionParams }) {
    this.config = config;
    this.net = net;
  }

  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  /**
   * A request to the server, with this PC's token, ended with the connection; within its delay (exchange):
   * syncRequestTimeoutMs, read now, unless `o.timeoutMs` says otherwise; a transfer's idleness with `o.transfer`.
   */
  request(path: string, init: SyncInit = {}, o: RequestOptions = {}): Promise<Response> {
    return exchange(this.net.fetch, this.config.url + path, path, { ...init, headers: { Authorization: `Bearer ${this.config.token}`, ...init.headers } }, {
      signal: this.abort.signal, timeoutMs: o.timeoutMs ?? this.net.params().syncRequestTimeoutMs, transfer: o.transfer,
    });
  }

  /** Resolves once the inbox has room again (a reconciliation took from it: made), or the connection is closed. */
  room(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((resolve) => { this.roomWaits.push(resolve); });
  }

  made(): void {
    for (const resolve of this.roomWaits.splice(0)) resolve();
  }

  /** Resolves at the next poke; at once if one came since the last sleep, or once closed. */
  sleep(): Promise<void> {
    if (this.poked || this.closed) {
      this.poked = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => { this.wake = resolve; });
  }

  poke(): void {
    const wake = this.wake;
    this.wake = null;
    if (wake) wake();
    else this.poked = true;
  }

  /** Resolves once the sender has nothing left to send, or the connection is closed. */
  drained(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((resolve) => { this.idle.push(resolve); this.poke(); });
  }

  settled(): void {
    for (const resolve of this.idle.splice(0)) resolve();
  }

  /** Ends it for `e`, the first cause kept. */
  fail(e: unknown): void {
    if (this.closed) return;
    this.error = e;
    this.close();
  }

  close(): void {
    this.abort.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.proof !== null) clearTimeout(this.proof);
    this.timer = null;
    this.proof = null;
    this.poke();
    this.settled();
    this.made();
  }
}
