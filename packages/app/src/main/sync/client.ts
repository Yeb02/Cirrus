import { openAsBlob } from 'node:fs';
import {
  type Id, MAX_BODY_BYTES, MAX_HASHES_PER_REQUEST, MAX_LABEL_CHARS, MAX_UNITS_PER_REQUEST, parseRemoteUnit, type RemoteUnit, SNAPSHOT_VERSION,
  SYNC_PROTOCOL_VERSION, SyncDivergedError, truncateLabel, type Unit, type UnitResult,
} from '@cirrus/core';
import { filePath, type LocalStore, SCHEMA_VERSION } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import type { SecretStore, ServerConfig } from './config.ts';
import { Downloads, filesToFetch, filesToSend, hasBlob, isHash } from './downloads.ts';
import { readEvents } from './events.ts';

// The main process's sync client (plan 5a, task 3, D2 to D8). It sends this PC's pending writes to the server, in
// order, files first; it receives the writes the server numbered, every PC's, its own included (their
// acknowledgements), from its event stream, and hands them in batches to the interface's reconciliation (`reconcile`),
// which the base writes; it downloads the files they bring, but the PDFs. It depends on nothing of Electron: the network
// (`fetch`), the secrets, the clock and the reconciliation are given, so that the tests run several PCs in one process.

/** The settings the client reads (group « Synchronisation »), at each use: a change applies at once. */
export type SyncParams = Pick<RenderParams, 'syncBatchUnits' | 'syncDownloads' | 'syncRetryMinMs' | 'syncRetryMaxMs' | 'syncClockSkewWarnMs' | 'syncReceiveBatchMs'>;

/**
 * What the client is doing, for the interface (D8: the veil, the chip):
 * - off: no server paired, or stopped;
 * - connecting: its first connection since start, under way;
 * - catching-up: connected, `behind` server lines short of what the server held when it connected;
 * - live: caught up; `pending` writes of this PC not yet acknowledged;
 * - offline: the server lost, tried again at growing intervals (syncRetryMinMs to syncRetryMaxMs);
 * - refused: the server refuses (a token, a format, data replaced: its reason), or a write received does not apply here
 *   (`diverged`: this PC's state no longer follows the server's); not tried again until start().
 * `clockWarning` (D4), once the server's time is known, when this PC's clock differs from it by more than syncClockSkewWarnMs.
 */
export type SyncStatus = (
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'catching-up'; behind: number }
  | { state: 'live'; pending: number }
  | { state: 'offline'; pending: number }
  | { state: 'refused'; message: string; diverged?: true }
) & { clockWarning?: string };

export interface SyncDeps {
  fetch: typeof fetch;
  /** This PC's base: its pending writes, its last server number; never written by the client itself. */
  store: LocalStore;
  /** Where the base keeps its files (files/<2 hex>/<hash>). */
  storeDir: string;
  secrets: SecretStore;
  /**
   * The interface's reconciliation (task 4) of the writes received — each after the base's last server number, in
   * order, none twice — and of the writes the server refused; resolves once the base has written it
   * (applyReconciliation), its last server number with it. Rejects with SyncDivergedError when a received write does
   * not apply (the client then stops: refused, diverged); any other rejection is taken as a broken connection.
   */
  reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void>;
  /** This PC's clock (ms): the time of its writes is `now() + clockOffset()`. */
  now(): number;
  params(): SyncParams;
  status(s: SyncStatus): void;
}

/** The format headers of /hello (D10): the server refuses another protocol, schema or snapshot version. */
export const FORMAT = { 'Cirrus-Protocol': String(SYNC_PROTOCOL_VERSION), 'Cirrus-Schema': String(SCHEMA_VERSION), 'Cirrus-Snapshot': String(SNAPSHOT_VERSION) };
const JSON_BODY = { 'Content-Type': 'application/json' };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A refusal that trying again will not change: the server's (a token revoked, another format, its data replaced or
 * restored, a request it will never take), or this PC's state no longer following the server's (`diverged`). The
 * client stops until start() is called again.
 */
class Refusal extends Error {
  readonly diverged: boolean;

  constructor(message: string, diverged = false) {
    super(message);
    this.diverged = diverged;
  }
}

/** The French reason of a refused request: its body's `error`, or its status. */
async function reasonOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `Réponse ${res.status} du serveur.`;
}

/** An answer to POST /units, as the server gives it. */
const isResult = (r: unknown): r is UnitResult => {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Record<string, unknown>;
  return Number.isSafeInteger(x.accepted) || Number.isSafeInteger(x.stale) || typeof x.refused === 'string';
};

/** One connection to the server: its requests (one abort for all), its stream, what it received and what it waits for. */
class Connection {
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
  /** flush's waits: resolved once the sender has nothing left to send. */
  private readonly idle: (() => void)[] = [];
  private wake: (() => void) | null = null;
  private poked = false;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  get closed(): boolean {
    return this.abort.signal.aborted;
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

type Mode = 'off' | 'connecting' | 'catching-up' | 'live' | 'offline' | 'refused';

export class SyncClient {
  private readonly deps: SyncDeps;
  private readonly downloads: Downloads;
  /** Between start() and stop(): the client connects, and tries again when it loses the server. */
  private running = false;
  private conn: Connection | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last pause before trying again (0: the next one is the shortest). */
  private retryDelay = 0;
  /** The reconciliations, one at a time whatever the connection: the tail of their chain (it never rejects). */
  private chain: Promise<void> = Promise.resolve();
  private offset = 0;
  private clockWarning: string | undefined;
  private mode: Mode = 'off';
  private refusal: Refusal | null = null;
  private lastStatus = '';
  /** The files the server is known to hold: each sent once. The server never removes one. */
  private readonly onServer = new Set<string>();

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.downloads = new Downloads(deps.storeDir, (hash, signal) => this.blobRequest(hash, signal), () => deps.params().syncDownloads);
  }

  /** Starts syncing; when offline or refused, tries again at once (the chip's click). Without a server paired: off. */
  start(): void {
    if (this.running && this.conn && !this.conn.closed) return;
    this.running = true;
    this.cancelRetry();
    this.connect();
  }

  /** Stops: the connection closed, the reconciliation and the downloads under way awaited; off. */
  async stop(): Promise<void> {
    this.running = false;
    this.cancelRetry();
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      conn.close();
      await conn.done;
    }
    await this.reconciled();
    await this.downloads.stop();
    this.setMode('off');
  }

  /** A local write was made: sent as soon as the connection allows. */
  kick(): void {
    this.conn?.poke();
    if (this.mode === 'live' || this.mode === 'offline') this.report();
  }

  /** Before sleep (D8): sends what is pending, and resolves once the server has it all, or after `ms`. */
  async flush(ms: number): Promise<void> {
    const conn = this.conn;
    if (!conn || conn.closed || !conn.open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([conn.drained(), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }

  /**
   * The blob of `hash` in the store (a PDF at its first reading, D6; any absent file): downloaded now from the server,
   * checked against its hash; false when it could not be had (no server, offline, absent there, wrong bytes).
   */
  fetchBlob(hash: string): Promise<boolean> {
    return isHash(hash) ? this.downloads.fetch(hash) : Promise.resolve(false);
  }

  /** The server's clock minus this PC's, measured at the last hello (0 before): a write's time is now() + clockOffset(). */
  clockOffset(): number {
    return this.offset;
  }

  private connect(): void {
    const config = this.deps.secrets.read();
    if (!config) {
      this.running = false;
      this.setMode('off');
      return;
    }
    const conn = new Connection(config);
    this.conn = conn;
    // A retry stays « offline » until it succeeds: the chip does not flicker.
    if (this.mode !== 'offline') this.setMode('connecting');
    conn.done = this.run(conn);
  }

  /** One connection, from its hello to its end; then refused, or offline and tried again later. */
  private async run(conn: Connection): Promise<void> {
    let sender: Promise<void> = Promise.resolve();
    try {
      await this.session(conn, (s) => { sender = s; });
      conn.fail(new Error('Le serveur a fermé le flux.'));
    } catch (e) {
      conn.fail(e);
    }
    await sender;
    if (this.conn !== conn) return;
    this.conn = null;
    if (conn.error instanceof Refusal) {
      this.refusal = conn.error;
      this.setMode('refused');
      return;
    }
    this.setMode('offline');
    if (this.running) this.retryLater();
  }

  /**
   * The hello (formats, the server's time and last number), then the stream from the base's last server number: each
   * write checked (parseRemoteUnit) and to follow the last one, then queued for the reconciliation; the sender started
   * once the stream is open.
   */
  private async session(conn: Connection, started: (sender: Promise<void>) => void): Promise<void> {
    const t0 = this.deps.now();
    const hello = await this.json(await this.request(conn, '/hello', { headers: FORMAT }));
    const t1 = this.deps.now();
    const { serverTime, lastSeq } = (hello ?? {}) as { serverTime?: unknown; lastSeq?: unknown };
    if (typeof serverTime !== 'number' || !Number.isFinite(serverTime) || !Number.isSafeInteger(lastSeq) || (lastSeq as number) < 0) {
      throw new Refusal('Réponse du serveur illisible à /hello : mets à jour Cirrus, ou le serveur.');
    }
    // The server's time against the middle of the exchange (D4).
    this.setClock(serverTime - (t0 + t1) / 2);
    conn.target = lastSeq as number;
    const from = this.deps.store.lastServerSeq();
    const res = await this.request(conn, '/events', { headers: { 'Last-Event-ID': String(from), Accept: 'text/event-stream' } });
    await this.ok(res);
    if (!res.body) throw new Error('Flux du serveur sans corps.');
    conn.received = from;
    conn.open = true;
    // Opened is not proven: a stream the server ends at once, or a reconciliation that always fails, would otherwise
    // bring the client back every syncRetryMinMs, forever (review of task 3, I1).
    conn.proof = setTimeout(() => {
      conn.proof = null;
      this.retryDelay = 0;
    }, this.deps.params().syncRetryMaxMs);
    this.downloads.retry();
    this.progress(conn);
    started(this.send(conn));
    for await (const e of readEvents(res.body, conn.abort.signal)) {
      // `settings` (task 6) and any other event: not this client's yet.
      if (e.event !== 'unit') continue;
      let u: RemoteUnit;
      try {
        u = parseRemoteUnit(JSON.parse(e.data));
      } catch (err) {
        throw new Refusal(`Le serveur a envoyé une écriture illisible : ${messageOf(err)}`);
      }
      const first = u.seq - u.ops.length + 1;
      if (first !== conn.received + 1) throw new Refusal(`Le flux du serveur reprend au numéro ${first} ; ce PC attendait le ${conn.received + 1}.`);
      conn.received = u.seq;
      conn.inbox.push(u);
      this.schedule(conn);
    }
  }

  /** The reconciliation of what arrived, once the window (syncReceiveBatchMs) since the first of it has passed. */
  private schedule(conn: Connection): void {
    if (conn.timer !== null || conn.closed) return;
    conn.timer = setTimeout(() => {
      conn.timer = null;
      this.chain = this.chain.then(() => this.reconcileNow(conn));
    }, Math.max(0, this.deps.params().syncReceiveBatchMs));
  }

  /**
   * Hands what arrived to the reconciliation: the writes after the base's last server number (one a former connection
   * brought may be written already), and the refusals. Once written: the acknowledged writes forgotten, the files
   * brought downloaded, the sender woken. Never rejects.
   */
  private async reconcileNow(conn: Connection): Promise<void> {
    if (conn.closed) return;
    try {
      const { store } = this.deps;
      const from = store.lastServerSeq();
      const incoming = conn.inbox.splice(0).filter((u) => u.seq > from), refused = conn.refused.splice(0);
      if (incoming.length === 0 && refused.length === 0) return;
      const first = incoming[0];
      if (first && first.seq - first.ops.length !== from) throw new Refusal(`Le flux du serveur reprend au numéro ${first.seq - first.ops.length + 1} ; ce PC attendait le ${from + 1}.`);
      try {
        await this.deps.reconcile(incoming, refused);
      } catch (e) {
        throw e instanceof SyncDivergedError ? new Refusal(e.message, true) : e;
      }
      // A reconciliation written: the connection has proven itself.
      this.retryDelay = 0;
      const at = store.lastServerSeq();
      for (const [unit, seq] of conn.accepted) if (seq <= at) conn.accepted.delete(unit);
      this.downloads.want(filesToFetch(incoming));
      conn.poke();
      this.progress(conn);
    } catch (e) {
      conn.fail(e);
    }
  }

  /** Resolves once no reconciliation is under way. */
  private async reconciled(): Promise<void> {
    for (let c = this.chain; ; c = this.chain) {
      await c;
      if (c === this.chain) return;
    }
  }

  /**
   * The sender: the pending writes, in order, syncBatchUnits at most per request, the files they add first — when no
   * reconciliation is under way, no refusal waits for one, and the base has received what a stale answer asked for.
   */
  private async send(conn: Connection): Promise<void> {
    const { store } = this.deps;
    try {
      while (!conn.closed) {
        await this.reconciled();
        if (conn.closed) return;
        const at = store.lastServerSeq();
        if (conn.waitFor > at || conn.refused.length > 0) {
          await conn.sleep();
          continue;
        }
        for (const [unit, seq] of conn.accepted) if (seq <= at) conn.accepted.delete(unit);
        const limit = Math.max(1, Math.min(conn.batchLimit, this.deps.params().syncBatchUnits, MAX_UNITS_PER_REQUEST));
        const batch = store.pendingUnits(conn.accepted.size + limit).filter((u) => !conn.accepted.has(u.unit)).slice(0, limit);
        if (batch.length === 0) {
          conn.settled();
          await conn.sleep();
          continue;
        }
        await this.upload(conn, batch);
        const results = await this.post(conn, batch);
        if (!results) continue;
        const miss = results.find((r) => !('accepted' in r));
        // Stale, though the base had everything up to that number when the write was read: it can never apply there.
        if (miss && 'stale' in miss && miss.stale <= at) {
          throw new Refusal('Une écriture de ce PC ne s’applique pas au serveur, qui n’a pourtant rien de plus que lui : la base de ce PC ne suit plus celle du serveur.', true);
        }
        results.forEach((r, i) => {
          if ('accepted' in r) conn.accepted.set(batch[i].unit, r.accepted);
          else if ('stale' in r) conn.waitFor = Math.max(conn.waitFor, r.stale);
          else conn.refused.push({ unit: batch[i].unit, message: r.refused });
        });
        if (conn.refused.length > 0) this.schedule(conn);
        this.report();
      }
    } catch (e) {
      conn.fail(e);
    }
  }

  /**
   * The files the batch adds that the server lacks, each sent once (D6), before the writes: the server refuses a write
   * whose file it does not hold. One this PC lacks too, or that the server will not take (its bytes no longer those of
   * their hash, too large), is left: the server then refuses the write (« Fichier manquant au serveur. »), dropped.
   */
  private async upload(conn: Connection, batch: Unit[]): Promise<void> {
    const hashes = filesToSend(batch).filter((h) => !this.onServer.has(h));
    for (let i = 0; i < hashes.length; i += MAX_HASHES_PER_REQUEST) {
      const chunk = hashes.slice(i, i + MAX_HASHES_PER_REQUEST);
      const body = await this.json(await this.request(conn, '/files/missing', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ hashes: chunk }) }));
      const missing = (body as { missing?: unknown } | null)?.missing;
      if (!Array.isArray(missing)) throw new Refusal('Réponse du serveur illisible à /files/missing : mets à jour Cirrus, ou le serveur.');
      const absent = new Set(missing);
      for (const hash of chunk) {
        if (absent.has(hash)) {
          if (!hasBlob(this.deps.storeDir, hash)) continue;
          const file = await openAsBlob(filePath(this.deps.storeDir, { name: '', hash, size: 0 }));
          const res = await this.request(conn, `/files/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file as unknown as Blob });
          if (res.status === 400 || res.status === 413) {
            console.warn(`Fichier ${hash} refusé par le serveur : ${await reasonOf(res)}`);
            continue;
          }
          await this.ok(res);
          await res.body?.cancel();
        }
        this.onServer.add(hash);
      }
    }
  }

  /**
   * POST /units: the results, one per write. A body over MAX_BODY_BYTES is not sent: a smaller batch next (null), or,
   * for one write alone, a refusal, as the server would give it.
   */
  private async post(conn: Connection, batch: Unit[]): Promise<UnitResult[] | null> {
    // A label past the bound, written before it was cut at its making, is cut as it leaves (R20): the server refuses it.
    const body = JSON.stringify({ units: batch.map((u) => (u.label.length > MAX_LABEL_CHARS ? { ...u, label: truncateLabel(u.label) } : u)) });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      if (batch.length > 1) conn.batchLimit = Math.max(1, Math.floor(batch.length / 2));
      else {
        conn.refused.push({ unit: batch[0].unit, message: `Écriture trop grosse pour le serveur : ${MAX_BODY_BYTES} octets au plus.` });
        this.schedule(conn);
      }
      return null;
    }
    const answer = await this.json(await this.request(conn, '/units', { method: 'POST', headers: JSON_BODY, body }));
    const results = (answer as { results?: unknown } | null)?.results;
    if (!Array.isArray(results) || results.length !== batch.length || !results.every(isResult)) {
      throw new Refusal('Réponse du serveur illisible à /units : mets à jour Cirrus, ou le serveur.');
    }
    return results;
  }

  private request(conn: Connection, path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
    return this.deps.fetch(conn.config.url + path, { ...init, headers: { Authorization: `Bearer ${conn.config.token}`, ...init.headers }, signal: conn.abort.signal });
  }

  /** A refused request: a Refusal for what trying again will not change (4xx), an Error otherwise (the server's own failure). */
  private async ok(res: Response): Promise<void> {
    if (res.ok) return;
    const reason = await reasonOf(res);
    if (res.status >= 400 && res.status < 500) throw new Refusal(reason);
    throw new Error(reason);
  }

  private async json(res: Response): Promise<unknown> {
    await this.ok(res);
    return res.json();
  }

  /** GET /files/<hash> on the server of the connection under way, or else of the secrets now (none: null). */
  private blobRequest(hash: string, signal: AbortSignal): Promise<Response> | null {
    const config = this.conn?.config ?? this.deps.secrets.read();
    if (!config) return null;
    return this.deps.fetch(`${config.url}/files/${hash}`, { headers: { Authorization: `Bearer ${config.token}` }, signal });
  }

  /** The server's time minus this PC's; the warning of D4 past syncClockSkewWarnMs. */
  private setClock(offset: number): void {
    this.offset = Math.round(offset);
    const gap = Math.abs(this.offset), minutes = Math.max(1, Math.round(gap / 60_000));
    this.clockWarning = gap > this.deps.params().syncClockSkewWarnMs
      ? `L'horloge de ce PC diffère de celle du serveur de ${minutes} minute${minutes > 1 ? 's' : ''} : règle-la.`
      : undefined;
  }

  /**
   * The next attempt, after a pause twice the last one, from syncRetryMinMs to syncRetryMaxMs (D8); the shortest again
   * once a connection has proven itself: a reconciliation written, or its stream open for syncRetryMaxMs.
   */
  private retryLater(): void {
    const p = this.deps.params(), shortest = Math.max(1, Math.min(p.syncRetryMinMs, p.syncRetryMaxMs)), longest = Math.max(shortest, p.syncRetryMaxMs);
    this.retryDelay = this.retryDelay === 0 ? shortest : Math.min(longest, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running && !this.conn) this.connect();
    }, this.retryDelay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Catching up, or live once the base has received what the server held at the hello. */
  private progress(conn: Connection): void {
    if (conn !== this.conn || conn.closed || !conn.open) return;
    if (!conn.caughtUp && this.deps.store.lastServerSeq() >= conn.target) conn.caughtUp = true;
    this.setMode(conn.caughtUp ? 'live' : 'catching-up');
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.report();
  }

  /** The status, its counts read now; given only when it changed. */
  private report(): void {
    const { store } = this.deps;
    let s: SyncStatus;
    switch (this.mode) {
      case 'off': s = { state: 'off' }; break;
      case 'connecting': s = { state: 'connecting' }; break;
      case 'catching-up': s = { state: 'catching-up', behind: Math.max(0, (this.conn?.target ?? 0) - store.lastServerSeq()) }; break;
      case 'live': s = { state: 'live', pending: store.pendingCount() }; break;
      case 'offline': s = { state: 'offline', pending: store.pendingCount() }; break;
      case 'refused': s = this.refusal?.diverged ? { state: 'refused', message: this.refusal.message, diverged: true } : { state: 'refused', message: this.refusal?.message ?? '' }; break;
    }
    if (this.clockWarning !== undefined && this.mode !== 'off') s.clockWarning = this.clockWarning;
    const key = JSON.stringify(s);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.deps.status(s);
  }
}
