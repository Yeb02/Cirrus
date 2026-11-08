import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, applyOps, canonical, decodeState, type Id, reconcile, type RemoteUnit, SNAPSHOT_VERSION, type State, SYNC_PROTOCOL_VERSION, toSnapshot, type Unit,
  type UnitResult, uuidv7,
} from '@cirrus/core';
import { type RunningServer, startServer, Tokens } from '@cirrus/server';
import { type ChangeRow, LocalStore, SCHEMA_VERSION } from '@cirrus/store';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { SyncClient, type SyncParams, type SyncStatus } from '../../src/main/sync/client.ts';
import { fileSecrets, pair, type ServerConfig, type TokenCipher } from '../../src/main/sync/config.ts';

// Virtual PCs (plan 5a, task 3): PCs without Electron, each a base in a temporary folder, the interface's state and its
// pending writes, reconciled as the interface will reconcile them (task 4), and a SyncClient on Node's fetch — through
// a network the tests hold or cut. A Lab runs them against a server started in the process, on 127.0.0.1
// and a free port, its data in a temporary folder: never the user's base, never %LOCALAPPDATA%\Cirrus.

export const T0 = Date.UTC(2026, 10, 8, 9);

/** The tests keep the token in clear (the app encrypts it with safeStorage). */
export const PLAIN: TokenCipher = { encrypt: (text) => Buffer.from(text, 'utf8'), decrypt: (data) => data.toString('utf8') };

/** The sync settings of the tests: the defaults, but reconnections within milliseconds. */
export const TEST_PARAMS: SyncParams = {
  syncBatchUnits: DEFAULT_PARAMS.syncBatchUnits, syncDownloads: DEFAULT_PARAMS.syncDownloads, syncRetryMinMs: 10, syncRetryMaxMs: 40,
  syncClockSkewWarnMs: DEFAULT_PARAMS.syncClockSkewWarnMs, syncReceiveBatchMs: DEFAULT_PARAMS.syncReceiveBatchMs,
};

/** The format headers of /hello (D10), this build's. */
export const FORMAT = { 'Cirrus-Protocol': String(SYNC_PROTOCOL_VERSION), 'Cirrus-Schema': String(SCHEMA_VERSION), 'Cirrus-Snapshot': String(SNAPSHOT_VERSION) };

/** A state's content, each list sorted: equal states, whatever the order their rows were made in. */
export const image = (s: State): string =>
  canonical(Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)])));

/** The record a write creates first, of kind `t`: its identifier. */
export const created = (u: Unit | null, t: 'node' | 'connection' | 'plan'): Id => (u!.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for `ok` to hold, read every few milliseconds; past `timeoutMs`, fails with `what` (the state it waited on). */
export async function until(ok: () => boolean | Promise<boolean>, timeoutMs = 5000, what: () => string | Promise<string> = () => ''): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!(await ok())) {
    if (Date.now() > limit) throw new Error(`Attente dépassée (${timeoutMs} ms) : ${await what()}`);
    await sleep(3);
  }
}

interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * A PC's network as a test wants it: every request logged, every answer to POST /units kept; the event stream held
 * (`hold`, `release`) or cut after so many bytes (`cutAfter`), mid-frame; an answer to POST /units lost once the server
 * gave it (`onUnitsAnswered` throws); the files it downloads altered (`corruptBlobs`).
 */
export class Net {
  readonly requests: { method: string; path: string }[] = [];
  /** The writes of each POST /units, and every answer to them. */
  readonly batches: number[] = [];
  readonly results: UnitResult[] = [];
  corruptBlobs = false;
  onUnitsAnswered: ((results: UnitResult[]) => void) | null = null;
  private gate: Deferred | null = null;
  /** Holds the downloads (GET /files/<hash>) until released, or until their request is aborted. */
  private filesGate: Deferred | null = null;
  /** The bytes the event stream still passes before it is cut (null: not armed). */
  private cutIn: number | null = null;

  hold(): void { this.gate ??= deferred(); }

  release(): void {
    const g = this.gate;
    this.gate = null;
    g?.resolve();
  }

  holdFiles(): void { this.filesGate ??= deferred(); }

  releaseFiles(): void {
    const g = this.filesGate;
    this.filesGate = null;
    g?.resolve();
  }

  cutAfter(bytes: number): void { this.cutIn = bytes; }

  count(method: string, path: string | RegExp): number {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? 'GET';
    this.requests.push({ method, path: url.pathname });
    if (url.pathname === '/units' && method === 'POST') this.batches.push((JSON.parse(String(init?.body)) as { units: unknown[] }).units.length);
    if (method === 'GET' && url.pathname.startsWith('/files/')) {
      const signal = init?.signal ?? undefined;
      while (this.filesGate) {
        const gate = this.filesGate.promise;
        await new Promise<void>((resolve) => {
          void gate.then(resolve);
          signal?.addEventListener('abort', () => resolve(), { once: true });
          if (signal?.aborted) resolve();
        });
        signal?.throwIfAborted();
      }
    }
    const res = await fetch(input, init);
    if (url.pathname === '/events' && res.ok && res.body) return new Response(this.stream(res.body), { status: res.status, headers: res.headers });
    if (url.pathname === '/units' && method === 'POST' && res.ok) {
      const body = (await res.json()) as { results: UnitResult[] };
      this.results.push(...body.results);
      this.onUnitsAnswered?.(body.results);
      return Response.json(body);
    }
    if (this.corruptBlobs && method === 'GET' && url.pathname.startsWith('/files/') && res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      bytes[0] ^= 1;
      return new Response(bytes, { status: 200, headers: res.headers });
    }
    return res;
  };

  /** The event stream's bytes, through the hold and the cut. */
  private stream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: async (chunk, c) => {
        while (this.gate) await this.gate.promise;
        const left = this.cutIn;
        if (left !== null && chunk.length > left) {
          this.cutIn = null;
          c.enqueue(chunk.subarray(0, left));
          c.error(new TypeError('terminated'));
          return;
        }
        if (left !== null) this.cutIn = left - chunk.length;
        c.enqueue(chunk);
      },
    }));
  }
}

/**
 * A PC without Electron: its base in `dir` (its files with it, as the app keeps them), the interface's state and pending
 * writes, reconciled as the interface does (reconcile, then the base writes it: applyReconciliation), and its SyncClient.
 */
export class VirtualPc {
  readonly id: string;
  readonly dir: string;
  net = new Net();
  store: LocalStore;
  s: State;
  pending: Unit[];
  client: SyncClient;
  readonly statuses: SyncStatus[] = [];
  readonly notices: string[] = [];
  readonly dropped: string[] = [];
  /** Each call of the client's reconcile: what it received, and what the server refused. */
  readonly reconciled: { incoming: RemoteUnit[]; refused: { unit: Id; message: string }[] }[] = [];
  readonly now: () => number;
  params: SyncParams;

  constructor(o: { id: string; dir: string; now: () => number; params?: Partial<SyncParams> }) {
    this.id = o.id;
    this.dir = o.dir;
    this.now = o.now;
    this.params = { ...TEST_PARAMS, ...o.params };
    this.store = LocalStore.open(o.dir, { pc: o.id });
    this.s = this.store.loadState();
    this.pending = this.store.pendingUnits();
    this.client = this.newClient();
  }

  private newClient(): SyncClient {
    return new SyncClient({
      fetch: this.net.fetch, store: this.store, storeDir: this.dir, secrets: fileSecrets(this.dir, PLAIN), reconcile: (incoming, refused) => this.reconcile(incoming, refused),
      now: this.now, params: () => this.params, status: (s) => { this.statuses.push(s); },
    });
  }

  /** The last status the client gave. */
  get status(): SyncStatus | undefined {
    return this.statuses.at(-1);
  }

  /**
   * An action of the user: written to the base as one write, at the PC's time corrected by the server's (D4), applied to
   * the state, pending, and the client told. Null for an action that changes nothing.
   */
  act(build: (s: State) => Action): Unit | null {
    const a = build(this.s);
    if (a.ops.length === 0) return null;
    const at = this.now() + this.client.clockOffset();
    const u: Unit = { unit: uuidv7(), action: a.id, label: a.label, at, pc: this.id, ops: a.ops };
    this.store.commit(a, { at, unit: u.unit });
    applyOps(this.s, a.ops);
    this.pending.push(u);
    this.client.kick();
    return u;
  }

  /** The client's reconcile: as the interface does it, then written by the base; the state read back from the base if that fails. */
  async reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void> {
    this.reconciled.push({ incoming, refused });
    const r = reconcile(this.s, this.pending, incoming, refused);
    try {
      this.store.applyReconciliation(r);
    } catch (e) {
      this.s = this.store.loadState();
      this.pending = this.store.pendingUnits();
      throw e;
    }
    this.pending = r.rebased;
    this.notices.push(...r.notices);
    this.dropped.push(...r.dropped.map((d) => d.message));
  }

  /** The app closed, then opened again: its client stopped, its base closed and reopened, the state and pending writes read back. */
  async restart(): Promise<void> {
    await this.client.stop();
    this.store.close();
    this.net = new Net();
    this.store = LocalStore.open(this.dir, { pc: this.id });
    this.s = this.store.loadState();
    this.pending = this.store.pendingUnits();
    this.client = this.newClient();
    this.client.start();
  }

  async close(): Promise<void> {
    await this.client.stop();
    this.store.close();
  }
}

/** A server in the process and the virtual PCs paired with it; one clock for all, but each PC's skew. */
export class Lab {
  readonly root = mkdtempSync(join(tmpdir(), 'cirrus-sync-'));
  readonly dataDir = join(this.root, 'serveur');
  /** The server's time, and every PC's but for its skew: moved by the tests only. */
  clock = T0;
  readonly pcs: VirtualPc[] = [];
  private server: RunningServer | null = null;
  private port = 0;
  /** A paired PC's token, for the lab's own reads (/hello, /snapshot, /journal). */
  private observer!: ServerConfig;

  private constructor() {}

  static async start(): Promise<Lab> {
    const lab = new Lab();
    await lab.startServer();
    lab.observer = await lab.pairing('Observateur', 'observateur');
    return lab;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts the server, on the port it had before if it ran already (the PCs keep its address). */
  async startServer(): Promise<void> {
    this.server = await startServer({ dataDir: this.dataDir, port: this.port, now: () => this.clock });
    this.port = Number(new URL(this.server.url).port);
  }

  async stopServer(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  /** A code made as `jumeler` makes it, traded for a token as the app does (config.pair). */
  async pairing(name: string, pc: string): Promise<ServerConfig> {
    const tokens = Tokens.open(this.dataDir);
    let code: string;
    try {
      code = tokens.createCode(name, this.clock).code;
    } finally {
      tokens.close();
    }
    return pair(fetch, this.url, code, pc, name);
  }

  revoke(name: string): void {
    const tokens = Tokens.open(this.dataDir);
    try {
      tokens.revoke(name);
    } finally {
      tokens.close();
    }
  }

  /** A virtual PC paired with the server (its name there: its id in capitals), its client started unless `start` is false. */
  async pc(id: string, o: { skewMs?: number; params?: Partial<SyncParams>; start?: boolean } = {}): Promise<VirtualPc> {
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true });
    fileSecrets(dir, PLAIN).write(await this.pairing(id.toUpperCase(), id));
    const pc = new VirtualPc({ id, dir, now: () => this.clock + (o.skewMs ?? 0), params: o.params });
    this.pcs.push(pc);
    if (o.start !== false) pc.client.start();
    return pc;
  }

  private get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(this.url + path, { headers: { Authorization: `Bearer ${this.observer.token}`, ...headers } });
  }

  async lastSeq(): Promise<number> {
    const res = await this.get('/hello', FORMAT);
    if (res.status !== 200) throw new Error(`GET /hello : ${res.status}`);
    return ((await res.json()) as { lastSeq: number }).lastSeq;
  }

  /** The server's state (GET /snapshot). */
  async state(): Promise<State> {
    const res = await this.get('/snapshot');
    if (res.status !== 200) throw new Error(`GET /snapshot : ${res.status}`);
    return decodeState(await res.arrayBuffer());
  }

  /** The server's journal (GET /journal), whole. */
  async journal(): Promise<ChangeRow[]> {
    const rows: ChangeRow[] = [];
    for (;;) {
      const res = await this.get(`/journal?after=${rows.at(-1)?.localSeq ?? 0}`);
      const page = ((await res.json()) as { rows: ChangeRow[] }).rows;
      if (page.length === 0) return rows;
      rows.push(...page);
    }
  }

  /**
   * Waits for rest: every PC (of `pcs`) live, with nothing pending, having received and written everything the server
   * numbered.
   */
  async settle(pcs: VirtualPc[] = this.pcs, timeoutMs = 10_000): Promise<void> {
    let last = -1;
    await until(async () => {
      last = await this.lastSeq();
      return pcs.every((pc) => pc.pending.length === 0 && pc.store.pendingCount() === 0 && pc.store.lastServerSeq() === last && pc.status?.state === 'live');
    }, timeoutMs, () => `serveur au ${last} ; ${pcs.map((pc) => `${pc.id} : ${pc.pending.length} en attente, reçu jusqu’au ${pc.store.lastServerSeq()}, ${JSON.stringify(pc.status)}`).join(' ; ')}`);
  }

  async close(): Promise<void> {
    for (const pc of this.pcs) await pc.close();
    await this.stopServer();
    rmSync(this.root, { recursive: true, force: true });
  }
}
