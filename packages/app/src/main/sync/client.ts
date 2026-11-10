import { type Id, isObject, MAX_ID_CHARS, MAX_SETTING_AHEAD_MS, parseRemoteUnit, type RemoteUnit, SyncDivergedError } from '@cirrus/core';
import type { PublicationRequest } from '@cirrus/sources';
import type { LocalStore } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import { type SecretStore, SERVER_FILE, type ServerConfig } from './config.ts';
import { Connection, exchange, FORMAT, JSON_BODY, json, messageOf, ok, Refusal } from './connection.ts';
import { DownloadAll, Downloads, filesToFetch, freeBytes, isHash, LastMeasures, missingFiles, TransferRates } from './downloads.ts';
import { readEvents } from './events.ts';
import type { DownloadAllPlan, DownloadAllProgress, DownloadAllStart, ServerSpace, ServerStatus, SyncStatus } from './protocol.ts';
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
// settings, settingsSync.ts's; the files, uploads.ts's and downloads.ts's. The .tex open here (plan 5b, D6) go to the
// server at each connection and at each change (presence). The server's state and « Tout télécharger » (plan 5b, D8):
// the latency of GET /status measured here, the throughput by the transfers (TransferRates), the download of every PDF
// by downloads.ts (DownloadAll). On a real network (plan 9, D7): every request within a delay, a transfer within one of
// idleness (connection.ts: exchange); the stream held as cut once silent for syncStreamSilenceMs, and read only while
// the writes received waiting for their reconciliation are fewer than syncReceiveMaxUnits, which each batch takes at
// most; the clock's offset kept with the server (serveur.json), for the writes made before the next hello.

/** The settings the client reads (group « Synchronisation »), at each use: a change applies at once. */
export type SyncParams = Pick<
  RenderParams,
  'syncBatchUnits' | 'syncDownloads' | 'syncRetryMinMs' | 'syncRetryMaxMs' | 'syncClockSkewWarnMs' | 'syncReceiveBatchMs' | 'downloadAllReserveMb'
  | 'serverStatusSamples' | 'throughputMinMb' | 'syncRequestTimeoutMs' | 'syncStreamSilenceMs' | 'syncReceiveMaxUnits'
>;

/**
 * A publication's import by the server (POST /publications) waits for its metadata, which the server asks of several
 * sources, and for its PDF (publicationPdfMaxMs, the request's pdfMaxMs): bounded by that delay plus this margin, not by
 * syncRequestTimeoutMs (plan 9, D7: the PC's side had no delay, registry of plan 5b). Past it, this PC imports it itself
 * (via.ts). A margin over the server's own bounds, not a setting: the PDF's delay is one.
 */
export const PUBLICATION_MARGIN_MS = 60_000;

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
  /**
   * The .tex open in full screen on this PC (plan 5b, task 5, D6), as they are when a list leaves (SyncHost's); none:
   * the client sends no list.
   */
  presence?: () => readonly OpenFile[];
  /**
   * The server's state and « Tout télécharger » (plan 5b, D8): the clock its round trips and transfers are measured by
   * (ms, monotonic; performance.now by default), the free space of a folder's disk (its statfs by default), and what is
   * told of « Tout télécharger » at each change (none: nothing told), at most once every `downloadAllEveryMs`
   * (PROGRESS_EVERY_MS by default; 0, every change: the tests' virtual PCs, which act on each file's end).
   */
  clock?: () => number;
  freeBytes?: (dir: string) => Promise<number>;
  downloadAll?: (p: DownloadAllProgress) => void;
  downloadAllEveryMs?: number;
}

/** GET /status's answer (plan 5b, D8), checked: each size a non-negative number, `counting` a boolean; null otherwise. */
function spaceOf(body: unknown): ServerSpace | null {
  if (!isObject(body)) return null;
  const { baseBytes, storeBytes, storeFiles, freeBytes: free, counting } = body;
  const size = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return size(baseBytes) && size(storeBytes) && size(storeFiles) && size(free) && typeof counting === 'boolean'
    ? { baseBytes, storeBytes, storeFiles, freeBytes: free, counting }
    : null;
}

/** A file open in full screen: its node, its name. */
export interface OpenFile { node: Id; name: string }

/** The same file open on another PC, as the server answers it: that PC's name at the server, since when (the server's clock). */
export interface FileOpenElsewhere extends OpenFile { pc: string; since: number }

/** The server's answer to PUT /presence, checked: the files open elsewhere; null for anything else. */
function othersOf(body: unknown): FileOpenElsewhere[] | null {
  const others = (body as { others?: unknown } | null)?.others;
  if (!Array.isArray(others)) return null;
  const ok = others.every((o: Partial<FileOpenElsewhere> | null) =>
    typeof o?.node === 'string' && typeof o.name === 'string' && typeof o.pc === 'string' && typeof o.since === 'number' && Number.isFinite(o.since));
  return ok ? (others as FileOpenElsewhere[]).map(({ node, name, pc, since }) => ({ node, name, pc, since })) : null;
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
  /** The server's clock minus this PC's: kept in serveur.json at the last hello (D7), measured again at each. */
  private offset = 0;
  private clockWarning: string | undefined;
  private mode: Mode = 'off';
  private refusal: Refusal | null = null;
  private lastStatus = '';
  /** What its sender works with (sender.ts): the files sent, each once (uploads.ts), its reconciliation and its status. */
  private readonly sending: SenderClient;
  /** The lists of open .tex sent, one at a time whatever the connection: the tail of their chain (it never rejects). */
  private presenceChain: Promise<unknown> = Promise.resolve();
  /** The throughput (plan 5b, D8): the transfers' rates, downloads and files sent. */
  private readonly rates: TransferRates;
  /** The latency (D8): the last round trips of GET /status. */
  private readonly latency = new LastMeasures(() => this.deps.params().serverStatusSamples);
  /** « Tout télécharger » (D8). */
  private readonly all: DownloadAll;
  /** The GET /status under way: a call meanwhile shares its answer. */
  private statusAsked: Promise<ServerStatus> | null = null;
  /** A GET /status that failed is said once in the console: the block asks every few seconds. */
  private statusWarned = false;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    // The offset the last hello measured (plan 9, D7): this PC's writes are dated by it until this run's first hello —
    // started offline, they still bear the server's time.
    this.offset = deps.secrets.read()?.clockOffsetMs ?? 0;
    this.rates = new TransferRates(deps.clock ?? (() => performance.now()), () => deps.params());
    this.downloads = new Downloads(deps.storeDir, (hash, signal) => this.blobRequest(hash, signal), () => deps.params().syncDownloads, this.rates);
    this.all = new DownloadAll(this.downloads, (p) => deps.downloadAll?.(p), deps.downloadAllEveryMs === undefined ? {} : { everyMs: deps.downloadAllEveryMs });
    this.sending = {
      deps, uploads: new Uploads(deps.storeDir, this.rates),
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

  /** Stops: « Tout télécharger » interrupted, the connection closed, the reconciliation and the downloads under way awaited; off. */
  async stop(): Promise<void> {
    this.all.stop('interrupted');
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

  /**
   * Whether a connection is open: its hello made, its event stream open (« catching-up » or « live »), not ended since.
   * A publication's import goes to the server only then (plan 5b, task 3, D2); connecting, offline, refused or off,
   * this PC imports it itself.
   */
  connected(): boolean {
    const conn = this.conn;
    return conn !== null && !conn.closed && conn.open;
  }

  /**
   * A publication's import asked of the server (POST /publications, plan 5b, task 3), through the connection open, with
   * its token: the server's answer as it comes. Rejects when no connection is open, or the network fails; aborted with
   * the connection; given up past PUBLICATION_MARGIN_MS and the PDF's delay, its answer read (plan 9, D7).
   */
  publication(request: PublicationRequest): Promise<Response> {
    const conn = this.conn;
    if (conn === null || conn.closed || !conn.open) return Promise.reject(new Error('aucune connexion au serveur'));
    const pdfMs = Number.isFinite(request.pdfMaxMs) ? Math.max(0, request.pdfMaxMs) : 0;
    return conn.request('/publications', { method: 'POST', headers: JSON_BODY, body: JSON.stringify(request) }, { timeoutMs: PUBLICATION_MARGIN_MS + pdfMs });
  }

  /**
   * The .tex open here (plan 5b, task 5, D6) sent to the server (PUT /presence): the whole list, as `deps.presence` gives
   * it when the request leaves. Resolves with the same files open on other PCs; null when no connection is open — the
   * list leaves at the next one (session) —, without a list to send, or when the request fails (the next change or
   * connection sends it again). One request at a time, in order: the server always ends with the latest list.
   */
  presence(): Promise<FileOpenElsewhere[] | null> {
    const conn = this.conn, list = this.deps.presence;
    if (!list || conn === null || conn.closed || !conn.open) return Promise.resolve(null);
    const p = this.presenceChain.then(async (): Promise<FileOpenElsewhere[] | null> => {
      if (conn.closed) return null;
      try {
        const res = await conn.request('/presence', { method: 'PUT', headers: JSON_BODY, body: JSON.stringify({ open: list() }) });
        const others = othersOf(await json(res));
        if (others === null) console.warn('Fichiers ouverts : réponse du serveur illisible à /presence.');
        return others;
      } catch (e) {
        if (!conn.closed) console.warn(`Fichiers ouverts non envoyés au serveur : ${messageOf(e)}`);
        return null;
      }
    });
    this.presenceChain = p;
    return p;
  }

  /** Resolves once the lists of open .tex under way are sent (or failed), or after `ms`: what quitting waits for. */
  async presenceSent(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.presenceChain, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }

  /**
   * The server's state for the block « Serveur » (plan 5b, D8): while a connection is open, GET /status asked through
   * it, its round trip measured — the latency, the median of the last serverStatusSamples —; the throughput's median; the
   * server's space, null when not connected or when it could not be read (an older server, a failure). One request at
   * a time: a call while one runs shares its answer.
   */
  serverStatus(): Promise<ServerStatus> {
    this.statusAsked ??= this.askStatus().finally(() => { this.statusAsked = null; });
    return this.statusAsked;
  }

  private async askStatus(): Promise<ServerStatus> {
    const conn = this.conn;
    if (conn === null || conn.closed || !conn.open) return { latencyMs: null, throughput: this.rates.median(), server: null };
    let server: ServerSpace | null = null;
    try {
      const since = this.rates.clock();
      const res = await conn.request('/status');
      this.latency.add(this.rates.clock() - since);
      server = spaceOf(await json(res));
    } catch (e) {
      if (!conn.closed && !this.statusWarned) console.warn(`État du serveur non lu : ${messageOf(e)}`);
      this.statusWarned ||= !conn.closed;
    }
    return { latencyMs: this.latency.median(), throughput: this.rates.median(), server };
  }

  /**
   * « Télécharger tous les PDF… » (plan 5b, D8): the plan of `refs` — the PDFs the interface counted (referencedPdfs),
   * checked here —: those missing on this PC, their bytes by their references, the free space of its disk. Asks the
   * server nothing.
   */
  downloadAllPlan(refs: unknown): Promise<DownloadAllPlan> {
    return this.plan(missingFiles(this.deps.storeDir, refs));
  }

  private async plan(missing: ReadonlyMap<string, number>): Promise<DownloadAllPlan> {
    let bytes = 0;
    for (const size of missing.values()) bytes += size;
    return { count: missing.size, bytes, freeBytes: await (this.deps.freeBytes ?? freeBytes)(this.deps.storeDir) };
  }

  /**
   * Starts it: refused while one runs, without a connection open, with nothing missing, or when its bytes would leave
   * less than downloadAllReserveMb free on this PC's disk — the plan made again now: the disk may have changed since the
   * question. Told then by `deps.downloadAll`.
   */
  async downloadAllStart(refs: unknown): Promise<DownloadAllStart> {
    if (this.all.running()) return { ok: false, reason: 'running' };
    if (!this.connected()) return { ok: false, reason: 'offline' };
    const missing = missingFiles(this.deps.storeDir, refs), plan = await this.plan(missing);
    if (plan.count === 0) return { ok: false, reason: 'none', plan };
    if (plan.bytes > plan.freeBytes - Math.max(0, this.deps.params().downloadAllReserveMb) * 2 ** 20) return { ok: false, reason: 'room', plan };
    // Asked again after the disk's answer: a start, or a stop, may have come meanwhile.
    if (this.all.running()) return { ok: false, reason: 'running' };
    if (!this.connected()) return { ok: false, reason: 'offline' };
    this.all.start(missing);
    return { ok: true };
  }

  /** « Arrêter »: those queued dropped, those under way aborted. */
  downloadAllStop(): void {
    this.all.stop('stopped');
  }

  /** Where « Tout télécharger » is, or how the last one ended; null before any (the block « Serveur » shown again reads it). */
  downloadAllProgress(): DownloadAllProgress | null {
    return this.all.current();
  }

  /**
   * The server's clock minus this PC's, measured at the last hello — this run's, or else the one serveur.json kept (0
   * before any): a write's time is now() + clockOffset().
   */
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
   * once the stream is open. The stream is a transfer whose delay is syncStreamSilenceMs (plan 9, D7): nothing received
   * for that long, its pings included, and it is held as cut — but only while it is read: it is not while
   * syncReceiveMaxUnits writes wait for their reconciliation, and the server keeps the rest in its journal.
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
    // The server's time against the middle of the exchange (D4), kept for the next start (plan 9, D7).
    this.setClock(serverTime - (t0 + t1) / 2);
    this.keepClock(conn.config);
    conn.target = lastSeq as number;
    const from = this.deps.store.lastServerSeq();
    const res = await conn.request('/events', { headers: { 'Last-Event-ID': String(from), Accept: 'text/event-stream' } }, {
      transfer: true, timeoutMs: this.deps.params().syncStreamSilenceMs,
    });
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
    // The .tex open here (D6): what this PC has open now, an empty list included — a list left by a stop without closing
    // them (a laptop shut) goes so at its next connection.
    void this.presence();
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
      // Bounded memory (D7): the stream read no further while a batch waits whole — a reconciliation taking it makes room.
      while (!conn.closed && conn.inbox.length >= this.receiveMax()) await conn.room();
    }
  }

  /** The most writes received a reconciliation takes (syncReceiveMaxUnits, one at least); without a number, no bound. */
  private receiveMax(): number {
    const n = Math.floor(this.deps.params().syncReceiveMaxUnits);
    return Number.isFinite(n) ? Math.max(1, n) : Number.POSITIVE_INFINITY;
  }

  /**
   * The reconciliation of what arrived: once the window (syncReceiveBatchMs) since the first of it has passed, or at
   * once when a whole batch waits (syncReceiveMaxUnits, plan 9, D7); none more while one waits in the chain: it will
   * take what arrives meanwhile.
   */
  private schedule(conn: Connection): void {
    if (conn.closed || conn.queued) return;
    if (conn.inbox.length >= this.receiveMax()) {
      this.enqueue(conn);
      return;
    }
    if (conn.timer !== null) return;
    conn.timer = setTimeout(() => {
      conn.timer = null;
      this.enqueue(conn);
    }, Math.max(0, this.deps.params().syncReceiveBatchMs));
  }

  /** A reconciliation of what arrived, after those under way; the window, if one runs, given up. */
  private enqueue(conn: Connection): void {
    if (conn.timer !== null) clearTimeout(conn.timer);
    conn.timer = null;
    if (conn.closed || conn.queued) return;
    conn.queued = true;
    this.chain = this.chain.then(() => this.reconcileNow(conn));
  }

  /**
   * Hands what arrived to the reconciliation: syncReceiveMaxUnits writes at most (plan 9, D7: a large delay goes in
   * several batches, each a reconciliation and a transaction), those after the base's last server number (one a former
   * connection brought may be written already), and the refusals; the stream read on meanwhile. Once written: the
   * acknowledged writes forgotten, the files brought downloaded, the sender woken, the rest scheduled. Never rejects.
   */
  private async reconcileNow(conn: Connection): Promise<void> {
    conn.queued = false;
    if (conn.closed) return;
    try {
      const { store } = this.deps;
      const from = store.lastServerSeq();
      const incoming = conn.inbox.splice(0, this.receiveMax()).filter((u) => u.seq > from), refused = conn.refused.splice(0);
      conn.made();
      if (incoming.length > 0 || refused.length > 0) {
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
      }
      if (conn.inbox.length > 0 || conn.refused.length > 0) this.schedule(conn);
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

  /**
   * GET /files/<hash> on the server of the connection under way, or else of the secrets now (none: null): a transfer,
   * given up once nothing came for syncRequestTimeoutMs (plan 9, D7) — lost, tried again as any download the network
   * broke.
   */
  private blobRequest(hash: string, signal: AbortSignal): Promise<Response> | null {
    const config = this.conn?.config ?? this.deps.secrets.read();
    if (!config) return null;
    const path = `/files/${hash}`;
    return exchange(this.deps.fetch, config.url + path, path, { headers: { Authorization: `Bearer ${config.token}` } }, {
      signal, timeoutMs: this.deps.params().syncRequestTimeoutMs, transfer: true,
    });
  }

  /**
   * The offset just measured, kept in serveur.json when it changed (plan 9, D7): for the server of `config` only, still
   * paired with the same token — an unpairing meanwhile writes nothing back. Read and written at once, nothing in
   * between. A file that cannot be written is said, and the sync goes on.
   */
  private keepClock(config: ServerConfig): void {
    try {
      const now = this.deps.secrets.read();
      if (!now || now.url !== config.url || now.token !== config.token || now.clockOffsetMs === this.offset) return;
      this.deps.secrets.write({ ...now, clockOffsetMs: this.offset });
    } catch (e) {
      console.warn(`Écart d’horloge avec le serveur non gardé (${SERVER_FILE}) : ${messageOf(e)}`);
    }
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
