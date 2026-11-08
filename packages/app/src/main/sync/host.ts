import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Action, type Id, MAX_ID_CHARS, type Op, type Reconciliation, type RemoteUnit, SyncDivergedError, type Unit } from '@cirrus/core';
import type { LocalStore } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import { FORMAT, SyncClient, type SyncStatus } from './client.ts';
import { pair, type SecretStore, type ServerConfig, serverUrl } from './config.ts';
import { DOWNLOADS_FILE } from './downloads.ts';

// The synchronisation in the app's main process (plan 5a, task 4), without Electron (wire.ts binds it to IPC, the
// window, safeStorage and powerMonitor): the sync client's life — started once the interface holds its pending writes,
// stopped and started again at wake, stopped at quit, never two of these at once —; the reconciliation's round trip
// through the interface, which holds the state; the pairing and the unpairing; each local write's time.

/** The writes received, sent to the interface to reconcile (cirrus:sync:incoming); `id` names its answer. */
export interface SyncIncoming { id: number; units: RemoteUnit[]; refused: { unit: Id; message: string }[] }

/**
 * The interface's answer (cirrus:sync:reconciled): its reconciliation, for the base to write; or why it could not make
 * one — `diverged`, a received write that does not apply to its state (SyncDivergedError); `error`, anything else.
 */
export type ReconcileOutcome = { reconciliation: Reconciliation } | { diverged: string } | { error: string };

export type PairResult = { ok: true } | { ok: false; message: string };

/**
 * The block « Serveur » of the settings: the server paired, its address and this PC's name there; not paired, the name
 * to propose (the machine's) and no address (the interface proposes its own).
 */
export interface ServerInfo { paired: boolean; url: string; name: string }

/** What a local write's commit gives the interface: its journal number, and its time, the server's clock's (D4). */
export interface Committed { seq: number; at: number }

/** The window, as the host speaks to it: false from `incoming` when there is none to reconcile. */
export interface HostWindow {
  incoming(m: SyncIncoming): boolean;
  status(s: SyncStatus): void;
  /** The veil « Synchronisation… » (D8): waking up. */
  veil(): void;
}

export interface HostDeps {
  fetch: typeof fetch;
  store: LocalStore;
  /** The base's folder: its files, serveur.json, downloads.json. */
  dir: string;
  /** This PC's identifier (pc.json). */
  pc: string;
  secrets: SecretStore;
  /** Whether the token can be kept encrypted (safeStorage, DPAPI): never in clear on the disk. */
  canEncrypt(): boolean;
  params(): RenderParams;
  now(): number;
  /** The name proposed for this PC: the machine's. */
  machineName: string;
  window: HostWindow;
}

/** R8: the first sync of a base that is not empty (D7) comes with the next step (task 5). */
export const FIRST_SYNC_LATER = 'La base de ce PC n’est pas vide : l’envoyer au serveur, ou la remplacer par celle du serveur, arrive avec la prochaine étape de Cirrus. Ce PC n’est pas jumelé.';
/**
 * R8, R11: a server whose journal is not empty, to a PC whose base is — even a lobby alone, another PC's (this one's
 * would make a second).
 */
export const SERVER_NOT_EMPTY = 'Le serveur tient déjà une base : la prendre sur ce PC arrive avec la prochaine étape de Cirrus. Ce PC n’est pas jumelé ; sur le serveur, révoque-le (revoquer) avant de le jumeler de nouveau.';

/** The hosts a server without HTTPS may have (R10): this machine's. */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** R10: an http: address that leaves this machine, where the pairing code and the token would travel in clear. */
export function insecureServer(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'http:' && !LOOPBACK.has(u.hostname.toLowerCase());
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export class SyncHost {
  /** The sync client of the server paired now; a new one at each unpairing (its files known there, its downloads, its clock). */
  client: SyncClient;
  private readonly deps: HostDeps;
  private config: ServerConfig | null;
  private last: SyncStatus = { state: 'off' };
  /** The interface asked for the synchronisation (cirrus:sync:start), a server being paired. */
  private started = false;
  private closed = false;
  /** start, stop, pairing, unpairing, waking: one at a time, in order (never a start while a stop runs). */
  private cycle: Promise<void> = Promise.resolve();
  private nextId = 0;
  /** The reconciliations sent to the interface, awaiting its answer. */
  private readonly waiting = new Map<number, { incoming: RemoteUnit[]; resolve(): void; reject(e: unknown): void }>();

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.config = deps.secrets.read();
    this.client = this.newClient();
  }

  private newClient(): SyncClient {
    const { deps } = this;
    return new SyncClient({
      fetch: deps.fetch, store: deps.store, storeDir: deps.dir, secrets: deps.secrets, now: deps.now, params: deps.params,
      reconcile: (incoming, refused) => this.reconcile(incoming, refused),
      status: (s) => {
        this.last = s;
        deps.window.status(s);
      },
    });
  }

  /** Whether a server is paired (serveur.json read, its token opened). */
  paired(): boolean {
    return this.config !== null;
  }

  /** The client's last status. */
  status(): SyncStatus {
    return this.last;
  }

  info(): ServerInfo {
    return this.config ? { paired: true, url: this.config.url, name: this.config.name } : { paired: false, url: '', name: this.deps.machineName };
  }

  /** The pending writes, all of them, as JSON: the interface's list at pairing (in its queue: none is written meanwhile). */
  pending(): string {
    return JSON.stringify(this.deps.store.pendingUnits());
  }

  /** One lifecycle step after the others; its failure reported, the chain kept. */
  private step(fn: () => void | Promise<void>): Promise<void> {
    const p = this.cycle.then(fn);
    this.cycle = p.catch((e: unknown) => console.error('Synchronisation :', e));
    return p;
  }

  /**
   * The interface holds its state and its pending writes (cirrus:sync:start): the client starts if a server is paired —
   * at startup, or once a pairing is done. Its status, as it then is.
   */
  async start(): Promise<SyncStatus> {
    await this.step(() => {
      if (this.closed || !this.config) return;
      this.started = true;
      this.client.start();
    });
    return this.last;
  }

  /** The chip's « Réessayer »: at once, after whatever step runs (a stop under way first ends). */
  retry(): void {
    void this.step(() => { if (this.started && !this.closed) this.client.start(); });
  }

  /** Before sleep (D8): what is pending sent, syncSuspendFlushMs at most. */
  async suspend(): Promise<void> {
    if (this.started && !this.closed) await this.client.flush(this.deps.params().syncSuspendFlushMs);
  }

  /** On waking (D8): the veil, then the connection made again — the old one may be half dead. */
  resume(): Promise<void> {
    if (!this.started || this.closed) return Promise.resolve();
    this.deps.window.veil();
    return this.step(async () => {
      await this.client.stop();
      if (this.started && !this.closed) this.client.start();
    });
  }

  /** Quitting: the client stopped (the reconciliations under way rejected first: detach), nothing started again. */
  close(): Promise<void> {
    this.closed = true;
    this.detach();
    return this.step(() => this.client.stop());
  }

  /**
   * A local write (cirrus:commit), with the interface's identifier: written at the time of this PC corrected by the
   * server's (D4), the client told. Its journal number and that time, which the interface's pending write carries.
   */
  commit(action: Action, unit: unknown): Committed {
    if (typeof unit !== 'string' || unit.length === 0 || unit.length > MAX_ID_CHARS) throw new Error('Action refusée : identifiant d’écriture invalide.');
    const at = this.deps.now() + this.client.clockOffset();
    const seq = this.deps.store.commit(action, { at, unit });
    this.client.kick();
    return { seq, at };
  }

  /**
   * The client's reconcile (task 3): the writes received sent to the interface, which reconciles them on its state; once
   * the base has written its reconciliation (`reconciled`), resolved. Rejected with SyncDivergedError when the
   * interface's reconcile threw it, with an Error for any other failure, or at once without a window to answer.
   */
  reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.waiting.set(id, { incoming, resolve, reject });
      if (!this.deps.window.incoming({ id, units: incoming, refused })) {
        this.waiting.delete(id);
        reject(new Error('Fenêtre absente : réconciliation remise à plus tard.'));
      }
    });
  }

  /**
   * The interface's answer to reconciliation `id` (cirrus:sync:reconciled). A reconciliation is checked — its received
   * writes those the server sent, the others well formed —, then written by the base, every "before" checked, in one
   * transaction: its journal number, the client's reconcile resolved. Null for a failure the interface reports. An
   * unknown identifier, or a reconciliation the base refuses, throws (the interface then reads its state again).
   */
  reconciled(id: number, outcome: ReconcileOutcome): number | null {
    const w = this.waiting.get(id);
    if (!w) throw new Error('Réconciliation inconnue ou abandonnée : rien n’est écrit.');
    this.waiting.delete(id);
    if (isObject(outcome) && 'diverged' in outcome) {
      w.reject(new SyncDivergedError(String(outcome.diverged)));
      return null;
    }
    if (!isObject(outcome) || !('reconciliation' in outcome)) {
      w.reject(new Error(isObject(outcome) && 'error' in outcome ? String(outcome.error) : 'Réponse de l’interface illisible.'));
      return null;
    }
    try {
      const seq = this.deps.store.applyReconciliation(this.checked(outcome.reconciliation, w.incoming));
      w.resolve();
      return seq;
    } catch (e) {
      w.reject(e);
      throw e;
    }
  }

  /**
   * A reconciliation as the base may write it: the received writes are this process's own copy of what the server sent
   * (the interface's must name the same, in order); the replayed writes this PC's, as the base will keep them. Their
   * operations are checked by the base as it writes them (checkRecord, each "before"), not by the server's stricter
   * parseOp: a write the server refuses must still be undone here, and dropped. Costs the lists' lengths.
   */
  private checked(r: unknown, incoming: RemoteUnit[]): Reconciliation {
    const bad = (why: string): never => { throw new Error(`Réconciliation incohérente : ${why}.`); };
    if (!isObject(r)) return bad('ce n’est pas un objet');
    const { rewind, remote, rebased, dropped, acked, notices } = r;
    if (![rewind, remote, rebased, dropped, acked, notices].every(Array.isArray)) bad('une de ses listes manque');
    const theirs = remote as unknown[];
    if (theirs.length !== incoming.length || !theirs.every((u, i) => isObject(u) && u.unit === incoming[i].unit && u.seq === incoming[i].seq)) {
      bad('les écritures reçues ne sont pas celles du serveur');
    }
    if (!(acked as unknown[]).every((u) => typeof u === 'string')) bad('un accusé n’est pas un identifiant');
    const unit = (u: unknown): boolean => isObject(u) && [u.unit, u.action, u.label].every((x) => typeof x === 'string') && Number.isFinite(u.at)
      && u.pc === this.deps.pc && Array.isArray(u.ops) && (u.ops as unknown[]).every(isObject);
    if (!(rebased as unknown[]).every(unit)) bad('une écriture rejouée est mal formée, ou n’est pas de ce PC');
    if (!(rewind as unknown[]).every(isObject)) bad('un inverse n’est pas une opération');
    return { rewind: rewind as Op[], remote: incoming, rebased: rebased as Unit[], dropped: dropped as Reconciliation['dropped'], acked: acked as Id[], notices: notices as string[] };
  }

  /** The window is gone (closed, its page reloaded or crashed): the reconciliations it held rejected, so that stop() never waits for them. */
  detach(): void {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) w.reject(new Error('Fenêtre fermée : réconciliation abandonnée.'));
  }

  /**
   * Pairs this PC (D3), the code `jumeler` showed traded for a token, kept encrypted in serveur.json; the interface then
   * takes its pending writes and starts the synchronisation (start). Refused, in French, before anything is asked of
   * the server: without encryption (no token in clear), an http: address off this machine (R10), a base that is not
   * empty (R8, D7: the next step sends it, or replaces it). After the exchange: a server whose journal is not empty
   * (R11: this PC's lobby becomes its first write), or of another format (D10); nothing is kept then.
   */
  async pair(url: unknown, code: unknown, name: unknown): Promise<PairResult> {
    let result: PairResult = { ok: false, message: 'Jumelage interrompu.' };
    await this.step(async () => {
      try {
        result = await this.pairNow(url, code, name);
      } catch (e) {
        // serveur.json not written (a disk full, a folder refused): not paired.
        result = { ok: false, message: `Jumelage interrompu : ${messageOf(e)}` };
      }
    });
    return result;
  }

  private async pairNow(url: unknown, code: unknown, name: unknown): Promise<PairResult> {
    const no = (message: string): PairResult => ({ ok: false, message });
    if (this.closed) return no('Cirrus se ferme.');
    if (this.config) return no('Ce PC est déjà jumelé à un serveur : dissocie-le d’abord.');
    if (!this.deps.canEncrypt()) return no('Windows ne peut pas chiffrer le jeton de ce PC ici : jumelage refusé, aucun jeton n’est gardé en clair.');
    let base: string;
    try {
      base = serverUrl(typeof url === 'string' ? url : '');
    } catch (e) {
      return no(messageOf(e));
    }
    if (insecureServer(base)) return no('Adresse refusée : sans HTTPS, seul un serveur de cette machine (127.0.0.1, localhost ou ::1) peut être jumelé, pour que le code et le jeton ne passent jamais en clair sur le réseau.');
    const typedCode = typeof code === 'string' ? code.trim() : '', typedName = typeof name === 'string' ? name.trim() : '';
    if (typedCode === '') return no('Donne le code de jumelage affiché par le serveur.');
    if (typedName === '') return no('Donne un nom à ce PC.');
    const { store } = this.deps;
    // A base that already received from a server is not new either: its stream would resume at a number this one never gave.
    if (!store.isEmpty() || store.lastServerSeq() > 0) return no(FIRST_SYNC_LATER);
    // Each request within syncConnectTimeoutMs: a server that never answers holds neither the block nor the quit.
    const ms = this.deps.params().syncConnectTimeoutMs;
    const bounded: typeof fetch = (input, init) => this.deps.fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
    let config: ServerConfig;
    try {
      config = await pair(bounded, base, typedCode, this.deps.pc, typedName);
    } catch (e) {
      return no(messageOf(e));
    }
    // The server's base (D7) and format (D10), which only a token may ask.
    let hello: unknown;
    try {
      const res = await bounded(`${config.url}/hello`, { headers: { ...FORMAT, Authorization: `Bearer ${config.token}` } });
      hello = await res.json().catch(() => null);
      if (!res.ok) return no(isObject(hello) && typeof hello.error === 'string' ? hello.error : `Réponse ${res.status} du serveur.`);
    } catch (e) {
      return no(`Serveur injoignable (${config.url}) : ${messageOf(e)}.`);
    }
    if (!isObject(hello) || typeof hello.empty !== 'boolean' || !Number.isSafeInteger(hello.lastSeq)) return no('Réponse du serveur illisible à /hello : mets à jour Cirrus, ou le serveur.');
    if (!hello.empty || hello.lastSeq !== 0) return no(SERVER_NOT_EMPTY);
    this.deps.secrets.write(config);
    this.config = config;
    return { ok: true };
  }

  /**
   * Unpairs this PC: the client stopped (a reconciliation under way ends first), the list of downloads to do and
   * serveur.json removed. The base then behaves as without a server (plan 4c); its pending writes stay pending.
   */
  unpair(): Promise<void> {
    return this.step(async () => {
      this.started = false;
      await this.client.stop();
      rmSync(join(this.deps.dir, DOWNLOADS_FILE), { force: true });
      this.deps.secrets.write(null);
      this.config = null;
      // The next server starts from nothing known: its files, its clock.
      this.client = this.newClient();
      this.last = { state: 'off' };
      this.deps.window.status(this.last);
    });
  }

  /** cirrus-file:'s fetcher of an absent blob (D6): the client's, with a server paired; none otherwise (plan 4c's 404). */
  blobFetcher(): ((hash: string) => Promise<boolean>) | null {
    return this.config ? (hash) => this.client.fetchBlob(hash) : null;
  }
}
