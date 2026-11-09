import { type Id, MAX_ID_CHARS, MAX_SETTING_AHEAD_MS, parseRemoteUnit, type RemoteUnit, SyncDivergedError } from '@cirrus/core';
import type { LocalStore } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import type { SecretStore } from './config.ts';
import { Connection, FORMAT, json, messageOf, ok, Refusal } from './connection.ts';
import { Downloads, filesToFetch, isHash } from './downloads.ts';
import { readEvents } from './events.ts';
import type { SyncStatus } from './protocol.ts';
import { send, type SenderClient } from './sender.ts';
import { receiveAllSettings, settingsEvent, type SettingsSync } from './settingsSync.ts';
import { Uploads } from './uploads.ts';

// The main process's sync client (plan 5a, task 3, D2 to D8). It sends this PC's pending writes to the server, in
// order, files first; it receives the writes the server numbered, every PC's, its own included (their
// acknowledgements), from its event stream, and hands them in batches to the interface's reconciliation (`reconcile`),
// which the base writes; it downloads the files they bring, but the PDFs. It shares the settings too (task 6, D9): the
// server's read at each connection, those changed elsewhere received by the stream, this PC's sent with the writes. It
// depends on nothing of Electron: the network (`fetch`), the secrets, the clock and the reconciliation are given, so that
// the tests run several PCs in one process.
// Here: its life (start, stop, the retries), each connection's hello and event stream, the reconciliation of what
// arrived, and its status. A connection and its requests are connection.ts's; the sending, sender.ts's; the shared
// settings, settingsSync.ts's; the files, uploads.ts's and downloads.ts's.

/** The settings the client reads (group « Synchronisation »), at each use: a change applies at once. */
export type SyncParams = Pick<RenderParams, 'syncBatchUnits' | 'syncDownloads' | 'syncRetryMinMs' | 'syncRetryMaxMs' | 'syncClockSkewWarnMs' | 'syncReceiveBatchMs'>;

export interface SyncDeps {
  fetch: typeof fetch;
  /**
   * This PC's base: its pending writes, its last server number, the identity of the server's base it follows (R31);
   * the client writes only that identity, when the base has none yet.
   */
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
  /** The shared settings (task 6, main/settings.ts's SharedSettings); none: the client shares none. */
  settings?: SettingsSync;
}

/** A server whose base is another than the one this PC follows (R31): its data replaced. */
const BASE_REPLACED = 'Le serveur tient une autre base que celle que suit ce PC : ses données ont été remplacées. Dissocie ce PC, puis jumelle-le de nouveau.';

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
  /** What its sender works with (sender.ts): the files sent, each once (uploads.ts), its reconciliation and its status. */
  private readonly sending: SenderClient;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.downloads = new Downloads(deps.storeDir, (hash, signal) => this.blobRequest(hash, signal), () => deps.params().syncDownloads);
    this.sending = {
      deps, uploads: new Uploads(deps.storeDir),
      reconciled: () => this.reconciled(), schedule: (conn) => this.schedule(conn), report: () => this.report(), latestSettingTime: () => this.latestSettingTime(),
    };
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
   * checked against its hash; false when it could not be had (no server, offline, absent there, wrong bytes). Rejects,
   * its code NOT_STORED (downloads.ts), when this PC could not keep the bytes received (final review, Minor 4).
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
    const conn = new Connection(config, this.deps);
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
    const hello = await json(await conn.request('/hello', { headers: FORMAT }));
    const t1 = this.deps.now();
    const { serverTime, lastSeq, baseId } = (hello ?? {}) as { serverTime?: unknown; lastSeq?: unknown; baseId?: unknown };
    if (
      typeof serverTime !== 'number' || !Number.isFinite(serverTime) || !Number.isSafeInteger(lastSeq) || (lastSeq as number) < 0
      || typeof baseId !== 'string' || baseId.length === 0 || baseId.length > MAX_ID_CHARS
    ) {
      throw new Refusal('Réponse du serveur illisible à /hello : mets à jour Cirrus, ou le serveur.');
    }
    // The base this PC follows (R31): another one, the server's data replaced, stops here, before anything of it is
    // received (Minor 2 of the final review: its lines would otherwise apply, unrelated); none known (a PC paired
    // before R31), it takes the server's.
    const known = this.deps.store.baseId();
    if (known === null) this.deps.store.setBaseId(baseId);
    else if (known !== baseId) throw new Refusal(BASE_REPLACED);
    // The server's time against the middle of the exchange (D4).
    this.setClock(serverTime - (t0 + t1) / 2);
    conn.target = lastSeq as number;
    const from = this.deps.store.lastServerSeq();
    const res = await conn.request('/events', { headers: { 'Last-Event-ID': String(from), Accept: 'text/event-stream' } });
    await ok(res);
    if (!res.body) throw new Error('Flux du serveur sans corps.');
    // The shared settings (task 6), read whole once the stream is open, and applied before anything it brings: a setting
    // changed meanwhile comes by both, and its stamp keeps it from being applied twice (SharedSettings.receive).
    const shared = this.deps.settings;
    if (shared) receiveAllSettings(shared, await json(await conn.request('/settings')));
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
    started(send(conn, this.sending));
    for await (const e of readEvents(res.body, conn.abort.signal)) {
      if (e.event === 'settings') {
        settingsEvent(this.deps.settings, e.data);
        continue;
      }
      // Any other event: not this client's.
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
   * The latest time the server takes for a setting changed here (R26): its clock, as measured at the hello, plus
   * MAX_SETTING_AHEAD_MS, less syncClockSkewWarnMs — the margin this PC allows its corrected clock, which can drift from
   * the server's while connected.
   */
  latestSettingTime(): number {
    return this.deps.now() + this.offset + MAX_SETTING_AHEAD_MS - Math.max(0, this.deps.params().syncClockSkewWarnMs);
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
