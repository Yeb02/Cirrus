import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Action, type Id, isObject, type Op, type Reconciliation, type RemoteUnit, SyncDivergedError, type Unit } from '@cirrus/core';
import type { LocalStore } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import { SharedSettings } from '../settings.ts';
import { SyncClient, writeRefusal } from './client.ts';
import { pair, type SecretStore, type ServerConfig, serverUrl } from './config.ts';
import { FORMAT } from './connection.ts';
import { DOWNLOADS_FILE } from './downloads.ts';
import {
  adoptBase, firstSyncOffer, isBaseId, offerMessage, pristine, revokeSelf, seedBase, sentence, stagedDir, stagedWaiting, waitingMessage,
} from './firstSync.ts';
import type { Committed, FirstSyncOffer, PairResult, ReconcileOutcome, ServerInfo, SyncIncoming, SyncStatus } from './protocol.ts';

// The synchronisation in the app's main process (plan 5a, task 4), without Electron (wire.ts binds it to IPC, the
// window, safeStorage and powerMonitor): the sync client's life — started once the interface holds its pending writes,
// stopped and started again at wake, stopped at quit, never two of these at once —; the reconciliation's round trip
// through the interface, which holds the state; the pairing, its first sync (task 5, D7: firstSync.ts), and the
// unpairing; each local write's time; the settings changed in Réglages, shared with a server paired (task 6, D9).

/** The window, as the host speaks to it: false from `incoming` when there is none to reconcile. */
export interface HostWindow {
  incoming(m: SyncIncoming): boolean;
  status(s: SyncStatus): void;
  /** The veil « Synchronisation… » (D8): waking up. */
  veil(): void;
  /** Shared settings received that changed here (cirrus:settings:changed, task 6): key: value, null back to the default; one batch. */
  settings(changes: Record<string, unknown>): void;
  /**
   * What the block « Serveur » shows, at each change of the pairing (cirrus:sync:server; short review after plan 5a,
   * B2): a pairing done or refused, an offer, a first sync begun or ended, an unpairing. A page that opened before a
   * pairing ended (reloaded meanwhile) learns so that it is paired, and starts the synchronisation.
   */
  server(info: ServerInfo): void;
}

export interface HostDeps {
  fetch: typeof fetch;
  store: LocalStore;
  /** The base's folder: its files, serveur.json, downloads.json. */
  dir: string;
  /** This PC's identifier (pc.json). */
  pc: string;
  secrets: SecretStore;
  /** The server's configuration in another base's folder: the base taken from the server, staged (D7), starts paired. */
  secretsAt(dir: string): SecretStore;
  /** Whether the token can be kept encrypted (safeStorage, DPAPI): never in clear on the disk. */
  canEncrypt(): boolean;
  params(): RenderParams;
  now(): number;
  /** The name proposed for this PC: the machine's. */
  machineName: string;
  window: HostWindow;
  /** The app quits and starts again: on the base taken from the server, swapped in before it opens (D7, R17). */
  relaunch(): void;
}

/** A first sync that did not happen: this PC unpaired (its token revoked, R15), its base as it was. */
const UNTOUCHED = 'Ce PC n’est pas jumelé, et sa base reste telle quelle.';

/** The hosts a server without HTTPS may have (R10): this machine's. */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** R10: an http: address that leaves this machine, where the pairing code and the token would travel in clear. */
export function insecureServer(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'http:' && !LOOPBACK.has(u.hostname.toLowerCase());
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What watchWindow listens to: a window and its page, as Electron's BrowserWindow and WebContents emit them. */
interface Emitter { on(event: string, listener: (...args: unknown[]) => void): unknown }
export type WatchedWindow = Emitter & { webContents: Emitter };

/**
 * A window's page gone or replaced: what it was reconciling is abandoned, and nothing is sent until a page asks to start
 * (detach, R13) — the window closed, its renderer lost, or a navigation of its main frame to another document committed
 * (`did-navigate`: never for one in the same document, nor for one refused by will-navigate, which ends before it
 * commits; the page that refused it lives on, ready). Review of task 4, round 2, Minor 1.
 */
export function watchWindow(win: WatchedWindow, host: { detach(): void }): void {
  win.on('closed', () => host.detach());
  win.webContents.on('render-process-gone', () => host.detach());
  win.webContents.on('did-navigate', () => host.detach());
}

export class SyncHost {
  /** The sync client of the server paired now; a new one at each unpairing (its files known there, its downloads, its clock). */
  client: SyncClient;
  /** This PC's settings: settings.json, and with a server paired their changes waiting for it (task 6). */
  readonly settings: SharedSettings;
  private readonly deps: HostDeps;
  private config: ServerConfig | null;
  private last: SyncStatus = { state: 'off' };
  /** The interface asked for the synchronisation (cirrus:sync:start), a server being paired. */
  private started = false;
  /**
   * The page holds its state and listens (cirrus:sync:start), since its last going away (detach): a reconciliation sent
   * otherwise would reach no one, and the client would wait for it for ever (R13).
   */
  private ready = false;
  private closed = false;
  /**
   * A pairing done (/pair, /hello) that awaits the user's answer to D7's offer (`first`): its server and token, in
   * memory only — nothing is written, nothing starts, until the base's first sync is settled (R8).
   */
  private offered: { config: ServerConfig; offer: FirstSyncOffer; at: number; baseId: string } | null = null;
  /** The first sync under way (seed, adopt): aborted if the app quits meanwhile. */
  private firstSync: AbortController | null = null;
  /** The first sync under way, for the block (info): its server, and what it does (review of task 5, Minor 3). */
  private working: { config: ServerConfig; busy: string } | null = null;
  /**
   * The server whose base was taken in this run (D7): the app restarts on it, and the block says only that — not the
   * base waiting beside this one as if its swap had failed (short review after plan 5a, B2).
   */
  private restarting: ServerConfig | null = null;
  /** start, stop, pairing, unpairing, waking: one at a time, in order (never a start while a stop runs). */
  private cycle: Promise<void> = Promise.resolve();
  private nextId = 0;
  /** The reconciliations sent to the interface, awaiting its answer. */
  private readonly waiting = new Map<number, { incoming: RemoteUnit[]; resolve(): void; reject(e: unknown): void }>();

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.config = deps.secrets.read();
    this.settings = new SharedSettings(deps.dir, deps.pc, (changes) => deps.window.settings(changes));
    this.client = this.newClient();
  }

  private newClient(): SyncClient {
    const { deps } = this;
    return new SyncClient({
      fetch: deps.fetch, store: deps.store, storeDir: deps.dir, secrets: deps.secrets, now: deps.now, params: deps.params, settings: this.settings,
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

  info(): ServerInfo {
    if (this.config) return { paired: true, url: this.config.url, name: this.config.name };
    const r = this.restarting;
    if (r) return { paired: false, url: r.url, name: r.name, busy: 'Base du serveur prise : Cirrus redémarre sur elle.' };
    const waiting = stagedWaiting(this.deps.dir) ? { waiting: waitingMessage(this.deps.dir) } : {};
    const w = this.working, o = this.offered;
    if (w) return { paired: false, url: w.config.url, name: w.config.name, busy: w.busy, ...waiting };
    if (o) return { paired: false, url: o.config.url, name: o.config.name, offer: { message: offerMessage(o.offer), offer: o.offer }, ...waiting };
    return { paired: false, url: '', name: this.deps.machineName, ...waiting };
  }

  /** The block's information told to the window: after each change of the pairing (B2). */
  private tell(): void {
    this.deps.window.server(this.info());
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
    this.ready = true;
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

  /**
   * Quitting: a first sync under way aborted, an offer left unanswered given up (its token stays at the server until
   * `revoquer`: quitting does not wait on the network), the client stopped (the reconciliations under way rejected
   * first: detach), nothing started again.
   */
  close(): Promise<void> {
    this.closed = true;
    this.offered = null;
    this.firstSync?.abort();
    this.detach();
    return this.step(() => this.client.stop());
  }

  /**
   * A local write (cirrus:commit), with the interface's identifier: written at the time of this PC corrected by the
   * server's (D4), the client told. Its journal number and that time, which the interface's pending write carries.
   * Every local write passes here, paired or not: one the server's gate would refuse (writeRefusal: its form, its
   * operations, its size) is refused now, in French, before anything is written (R32) — never undone after the fact by
   * a reconciliation, never a line that would stop the base's seed. Costs the write, never the base.
   */
  commit(action: Action, unit: unknown): Committed {
    if (!isBaseId(unit)) throw new Error('Action refusée : identifiant d’écriture invalide.');
    const at = this.deps.now() + this.client.clockOffset();
    // An action that changes nothing writes no line, and sends nothing.
    if (!Array.isArray(action.ops) || action.ops.length > 0) {
      const refusal = writeRefusal({ unit, action: action.id, label: action.label, at, pc: this.deps.pc, ops: action.ops });
      if (refusal !== null) throw new Error(refusal);
    }
    const seq = this.deps.store.commit(action, { at, unit });
    this.client.kick();
    return { seq, at };
  }

  /**
   * Settings changed in Réglages (cirrus:settings:set, task 6): only those changed, key: value, null back to the
   * default. Written to settings.json; with a server paired, each waits too, at this PC's time corrected by the
   * server's (D4), and the client is told. Without one, nothing else happens (plan 4c). Returns what is now written for
   * each of these keys, which the interface adopts (review of task 6, Minor 2).
   */
  setSettings(changes: unknown): Record<string, unknown> {
    const paired = this.config !== null;
    const clock = paired ? { at: this.deps.now() + this.client.clockOffset(), latest: this.client.latestSettingTime() } : null;
    const written = this.settings.local(changes, clock);
    if (paired) this.client.kick();
    return written;
  }

  /**
   * The client's reconcile (task 3): the writes received sent to the interface, which reconciles them on its state; once
   * the base has written its reconciliation (`reconciled`), resolved. Rejected with SyncDivergedError when the
   * interface's reconcile threw it, with an Error for any other failure, or at once without a window, or a page, ready to
   * answer (R13).
   */
  reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void> {
    // A page loading (or none): rejected at once, the client tries again later, and the new page asks to start.
    if (!this.ready) return Promise.reject(new Error('Interface pas prête : réconciliation remise à plus tard.'));
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
   * (the interface names the same, in order, by identifier and number); the replayed writes this PC's, as the base will
   * keep them. Their
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

  /**
   * The window is gone (closed, its page reloaded or crashed): the reconciliations it held rejected, so that stop() never
   * waits for them; none sent until a page asks to start again (R13).
   */
  detach(): void {
    this.ready = false;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) w.reject(new Error('Fenêtre fermée : réconciliation abandonnée.'));
  }

  /**
   * Pairs this PC (D3), the code `jumeler` showed traded for a token. Refused, in French, before anything is asked of
   * the server: without encryption (no token in clear), an http: address off this machine (R10), without a code or a
   * name. Then /pair and /hello, which tells the server's base (its identity too, R31) and format (D10). The base this
   * PC follows already, paired again: at once, no offer (R31). Otherwise D7 decides: both empty, paired at once — the
   * token kept encrypted in serveur.json, the interface then takes its pending writes and starts the sync (start), and
   * this PC's lobby becomes the server's first write —; a vierge base (pristine) and a server holding one, the server's
   * taken at once, without an offer, then the app restarts on it (adopt: after the short review of plan 5a,
   * 2026-11-09); otherwise the offer (`first` answers it). A refusal after /pair revokes the token (R15): nothing is
   * kept.
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
      this.tell();
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
    // An offer left unanswered (a page reloaded meanwhile): given up, its token revoked.
    await this.giveUp();
    // Each request within syncConnectTimeoutMs: a server that never answers holds neither the block nor the quit.
    const ms = this.deps.params().syncConnectTimeoutMs;
    const bounded: typeof fetch = (input, init) => this.deps.fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
    let config: ServerConfig;
    try {
      config = await pair(bounded, base, typedCode, this.deps.pc, typedName);
    } catch (e) {
      return no(messageOf(e));
    }
    // Refused from here: the token just given revoked (R15), so that the PC is not left registered.
    const refuse = async (message: string): Promise<PairResult> => {
      await revokeSelf(this.deps.fetch, config, ms);
      return no(message);
    };
    // The server's base (D7) and format (D10), which only a token may ask.
    let hello: unknown;
    try {
      const res = await bounded(`${config.url}/hello`, { headers: { ...FORMAT, Authorization: `Bearer ${config.token}` } });
      hello = await res.json().catch(() => null);
      if (!res.ok) return refuse(isObject(hello) && typeof hello.error === 'string' ? hello.error : `Réponse ${res.status} du serveur.`);
    } catch (e) {
      return refuse(`Serveur injoignable (${config.url}) : ${messageOf(e)}.`);
    }
    if (
      !isObject(hello) || typeof hello.empty !== 'boolean' || !Number.isSafeInteger(hello.lastSeq) || !Number.isSafeInteger(hello.nodes)
      || typeof hello.serverTime !== 'number' || !Number.isFinite(hello.serverTime)
      || !isBaseId(hello.baseId)
    ) {
      return refuse('Réponse du serveur illisible à /hello : mets à jour Cirrus, ou le serveur.');
    }
    const server = { lastSeq: hello.lastSeq as number, empty: hello.empty, nodes: hello.nodes as number }, baseId = hello.baseId;
    // A seed this PC sent, which the server took, its done's answer lost (the app quit, the network failed: short
    // review after plan 5a, B1): the server's base has the identity it gave that seed at its start. Its lines numbered
    // now, as the answer would have done, and its settings stamped at that pairing's time (R23): then it rejoins.
    const seed = this.deps.store.pendingSeed();
    const seeded = seed !== null && seed.id === baseId && seed.last <= server.lastSeq;
    if (seeded) this.deps.store.numberSeeded(seed.last, seed.id);
    // R31: the base this PC follows, its token lost since (dissociated, revoked, serveur.db reset), the server holding
    // every line this PC received: paired again at once, no offer — the sync picks up where it stopped, and the writes
    // made meanwhile go as any pending write. Its settings are not stamped again: the server's, newer maybe, stay.
    if (this.deps.store.baseId() === baseId && this.deps.store.lastServerSeq() <= server.lastSeq) {
      this.joined(config, seeded ? seed.at : null, null);
      return { ok: true };
    }
    const offer = firstSyncOffer(this.deps.store, this.deps.dir, server, new Date(this.deps.now()));
    // A vierge base holds nothing of the user's, nothing to keep nor ask: it takes the server's at once, as « adopt ».
    if (offer?.kind === 'adopt' && pristine(this.deps.store, this.deps.dir)) return this.adopt(config, baseId);
    // The pairing's time, the server's: this PC's settings are stamped with it when they are sent (R23).
    const at = Math.round(hello.serverTime);
    if (offer) {
      this.offered = { config, offer, at, baseId };
      return { ok: false, message: offerMessage(offer), offer };
    }
    this.joined(config, at, baseId);
    return { ok: true };
  }

  /**
   * Paired, the first sync settled (R8): this PC's settings wait, stamped `at`, the pairing's time (R23: two empty
   * bases, or this PC's sent — a seed whose done's answer was lost too, at its own pairing's time, B1; null for a
   * rejoin, R31: nothing stamped); the server's base identity kept, `baseId` (two empty bases; a seed keeps the one the
   * server gave it with the numbers, numberSeeded; null: kept already) — both before
   * serveur.json: a stop between leaves them for no server, and the next pairing writes them again —, then the server.
   * A seed still pending is dropped (numbered already when this join settles it): the base now follows this server,
   * and pairing the seed's server again later must not renumber it (re-review of the fixes, N1).
   */
  private joined(config: ServerConfig, at: number | null, baseId: string | null): void {
    if (at !== null) this.settings.pairedAt(at);
    if (baseId !== null) this.deps.store.setBaseId(baseId);
    this.deps.store.setPendingSeed(null);
    this.deps.secrets.write(config);
    this.config = config;
  }

  /** An offer left unanswered given up: its token revoked, at best (R15). */
  private async giveUp(): Promise<void> {
    const left = this.offered;
    this.offered = null;
    if (left) await revokeSelf(this.deps.fetch, left.config, this.deps.params().syncConnectTimeoutMs);
  }

  /**
   * The user's answer to D7's offer (the block « Serveur »), after whatever step runs:
   * - « seed », to a server that holds no base: this PC's sent (seedBase), its lines numbered, then paired — the
   *   interface takes its pending writes (those made meanwhile) and starts the sync;
   * - « adopt », to a server that holds one (this PC's base empty but used, or to be replaced): taken (adopt);
   * - « cancel », or a choice not offered: given up.
   * Any failure, and a cancel, revoke the token (R15): this PC stays unpaired, its base as it was.
   */
  async first(choice: unknown): Promise<PairResult> {
    let result: PairResult = { ok: false, message: 'Jumelage interrompu.' };
    await this.step(async () => {
      try {
        result = await this.firstNow(choice);
      } catch (e) {
        result = { ok: false, message: `Jumelage interrompu : ${messageOf(e)}` };
      }
      this.tell();
    });
    return result;
  }

  private async firstNow(choice: unknown): Promise<PairResult> {
    const no = (message: string): PairResult => ({ ok: false, message });
    const offered = this.offered;
    if (!offered) return no('Aucun jumelage n’attend de réponse.');
    this.offered = null;
    const { config, offer, at, baseId } = offered, { deps } = this;
    const revoke = () => revokeSelf(deps.fetch, config, deps.params().syncConnectTimeoutMs);
    if (choice === 'cancel') {
      await revoke();
      return no('Jumelage annulé : ce PC n’est pas jumelé.');
    }
    if (this.closed || !(choice === 'seed' ? offer.kind === 'seed' : choice === 'adopt' && offer.kind !== 'seed')) {
      await revoke();
      return no('Ce choix n’est pas proposé : jumelage annulé, ce PC n’est pas jumelé.');
    }
    if (choice === 'adopt') return this.adopt(config, baseId);
    const abort = (this.firstSync = new AbortController());
    this.working = { config, busy: 'Envoi de la base au serveur…' };
    this.tell();
    try {
      try {
        await seedBase({ fetch: deps.fetch, store: deps.store, dir: deps.dir, config, pairedAt: at, signal: abort.signal });
      } catch (e) {
        if (!this.closed) await revoke();
        return no(`Base non envoyée : ${sentence(messageOf(e))} ${UNTOUCHED}`);
      }
      this.joined(config, at, null);
      return { ok: true };
    } finally {
      this.firstSync = null;
      this.working = null;
    }
  }

  /**
   * Takes the server's base (D7): staged beside this one (adoptBase), then the app starts again on it (relaunch),
   * paired; this base is never touched here. The answer « adopt » to the offer (firstNow), or at once for a vierge base
   * (pairNow), inside their step. The block says the download meanwhile (`working`). A failure revokes the token (R15):
   * this PC stays unpaired, its base as it was; the app quitting meanwhile gives it up, as an offer left unanswered.
   */
  private async adopt(config: ServerConfig, baseId: string): Promise<PairResult> {
    const { deps } = this;
    if (this.closed) return { ok: false, message: 'Cirrus se ferme.' };
    const abort = (this.firstSync = new AbortController());
    this.working = { config, busy: 'Téléchargement de la base du serveur…' };
    this.tell();
    try {
      try {
        await adoptBase({ fetch: deps.fetch, dir: deps.dir, pc: deps.pc, config, baseId, secrets: deps.secretsAt(stagedDir(deps.dir)), signal: abort.signal });
      } catch (e) {
        if (!this.closed) await revokeSelf(deps.fetch, config, deps.params().syncConnectTimeoutMs);
        return { ok: false, message: `Base du serveur non prise : ${sentence(messageOf(e))} ${UNTOUCHED}` };
      }
      this.restarting = config;
      deps.relaunch();
      return { ok: true, restarting: true };
    } finally {
      this.firstSync = null;
      this.working = null;
    }
  }

  /**
   * Unpairs this PC: the client stopped (a reconciliation under way ends first), serveur.json removed, its token revoked
   * by itself at the server (R15, at best, within syncConnectTimeoutMs), then the list of downloads to do (at best: a
   * failure is only reported). The base then behaves as without a server (plan 4c); its pending writes stay pending.
   */
  unpair(): Promise<void> {
    return this.step(async () => {
      this.started = false;
      await this.client.stop();
      // Unpaired first: a list that cannot be removed (a file held), or a server gone, leaves a base without a server, as wanted.
      const config = this.config;
      this.deps.secrets.write(null);
      this.config = null;
      if (config) await revokeSelf(this.deps.fetch, config, this.deps.params().syncConnectTimeoutMs);
      try {
        rmSync(join(this.deps.dir, DOWNLOADS_FILE), { force: true });
      } catch (e) {
        console.warn(`Liste des téléchargements non effacée (${DOWNLOADS_FILE}) : ${messageOf(e)}`);
      }
      // The settings stay this PC's; none waits for a server any more (task 6).
      try {
        this.settings.unpaired();
      } catch (e) {
        console.warn(`Réglages en attente non effacés : ${messageOf(e)}`);
      }
      // The next server starts from nothing known: its files, its clock.
      this.client = this.newClient();
      this.last = { state: 'off' };
      this.deps.window.status(this.last);
      this.tell();
    });
  }

  /** cirrus-file:'s fetcher of an absent blob (D6): the client's, with a server paired; none otherwise (plan 4c's 404). */
  blobFetcher(): ((hash: string) => Promise<boolean>) | null {
    return this.config ? (hash) => this.client.fetchBlob(hash) : null;
  }
}
