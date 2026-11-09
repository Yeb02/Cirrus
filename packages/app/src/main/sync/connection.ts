import { type Id, MAX_UNITS_PER_REQUEST, type RemoteUnit, SNAPSHOT_VERSION, SYNC_PROTOCOL_VERSION } from '@cirrus/core';
import { SCHEMA_VERSION } from '@cirrus/store';
import type { ServerConfig } from './config.ts';

// One connection of the sync client to the server (plan 5a, task 3): what it received and what it waits for, its
// requests — the token on each, one abort for all —, and how their answers are read: a refusal that trying again will
// not change (Refusal), or a failure that a later connection may not meet.

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
  /** Running from the stream's opening: once it fires, the connection has proven itself (the backoff starts again from the shortest pause). */
  proof: ReturnType<typeof setTimeout> | null = null;
  /** The run: the hello, the stream, then the sender awaited. */
  done: Promise<void> = Promise.resolve();
  /** The network: the client's. */
  private readonly net: { fetch: typeof fetch };
  /** flush's waits: resolved once the sender has nothing left to send. */
  private readonly idle: (() => void)[] = [];
  private wake: (() => void) | null = null;
  private poked = false;

  constructor(config: ServerConfig, net: { fetch: typeof fetch }) {
    this.config = config;
    this.net = net;
  }

  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  /** A request to the server, with this PC's token, ended with the connection. */
  request(path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
    return this.net.fetch(this.config.url + path, { ...init, headers: { Authorization: `Bearer ${this.config.token}`, ...init.headers }, signal: this.abort.signal });
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
  }
}
