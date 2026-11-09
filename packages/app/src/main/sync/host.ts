import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Action, fileNameKey, type Id, MAX_ID_CHARS, plainName, type RemoteUnit } from '@cirrus/core';
import type { LocalStore } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import type { ServerImport } from '../publications/via.ts';
import { SharedSettings } from '../settings.ts';
import { type OpenFile, SyncClient } from './client.ts';
import type { SecretStore } from './config.ts';
import { messageOf } from './connection.ts';
import { DOWNLOADS_FILE } from './downloads.ts';
import { isBaseId } from './firstSync.ts';
import { Pairing } from './pairing.ts';
import type {
  Committed, DownloadAllPlan, DownloadAllProgress, DownloadAllStart, OpenElsewhere, PairResult, ReconcileOutcome, ServerInfo, ServerStatus, SyncIncoming, SyncStatus,
} from './protocol.ts';
import { Reconciliations } from './reconciliations.ts';
import { writeRefusal } from './sender.ts';

// The synchronisation in the app's main process (plan 5a, task 4), without Electron (wire.ts binds it to IPC, the
// window, safeStorage and powerMonitor): the sync client's life — started once the interface holds its pending writes,
// stopped and started again at wake, stopped at quit, never two of these at once —; the reconciliation's round trip
// through the interface, which holds the state; the pairing, its first sync (task 5, D7: firstSync.ts), and the
// unpairing; each local write's time; the settings changed in Réglages, shared with a server paired (task 6, D9); the
// .tex open in full screen, which the server tells the other PCs of (plan 5b, D6); the server's state and « Tout
// télécharger » (plan 5b, D8).
// SyncHost is what the IPC calls (wire.ts), one method per call, and what keeps them in order (step); their work is
// in their parts: the client's in client.ts, the round trip's in reconciliations.ts, the pairing's in pairing.ts.

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
  /** « Tout télécharger » at its start, at each file's end, and at its end (cirrus:sync:download-all, plan 5b, D8). */
  downloadAll(p: DownloadAllProgress): void;
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
  /** The free space of this PC's disk for « Tout télécharger » (plan 5b, D8): the disk's when absent (CIRRUS_FREE_BYTES: freeBytesOf). */
  freeBytes?: (dir: string) => Promise<number>;
  /** The name proposed for this PC: the machine's. */
  machineName: string;
  window: HostWindow;
  /** The app quits and starts again: on the base taken from the server, swapped in before it opens (D7, R17). */
  relaunch(): void;
}

/** A file open in full screen as the interface names it (cirrus:sync:tex:opened, :closed): null for anything that is not one. */
function openFile(node: unknown, name: unknown): OpenFile | null {
  return typeof node === 'string' && node.length > 0 && node.length <= MAX_ID_CHARS && typeof name === 'string' && plainName(name) ? { node, name } : null;
}

/** A file's key among those open: its node and its name as the reimport compares them (the core's fileNameKey). */
const openKey = (f: OpenFile): string => `${f.node}\u0000${fileNameKey(f.name)}`;

/** What watchWindow listens to: a window and its page, as Electron's BrowserWindow and WebContents emit them. */
interface Emitter { on(event: string, listener: (...args: unknown[]) => void): unknown }
type WatchedWindow = Emitter & { webContents: Emitter };

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
  /** The server paired, a pairing and its first sync, the block's information (pairing.ts). */
  private readonly pairing: Pairing;
  /** The reconciliations sent to the interface, awaiting its answer (reconciliations.ts). */
  private readonly reconciliations: Reconciliations;
  private last: SyncStatus = { state: 'off' };
  /** The interface asked for the synchronisation (cirrus:sync:start), a server being paired. */
  private started = false;
  private closed = false;
  /** start, stop, pairing, unpairing, waking: one at a time, in order (never a start while a stop runs). */
  private cycle: Promise<void> = Promise.resolve();
  /** The .tex the interface has open in full screen (plan 5b, D6), by openKey: what the client sends the server. */
  private readonly openTex = new Map<string, OpenFile>();

  constructor(deps: HostDeps) {
    this.deps = deps;
    const config = deps.secrets.read();
    this.settings = new SharedSettings(deps.dir, deps.pc, (changes) => deps.window.settings(changes));
    // The block shows « Tout télécharger » of the client of now (D8): read when asked, the client replaced at an unpairing.
    this.pairing = new Pairing(deps, this.settings, config, () => this.client.downloadAllProgress());
    this.reconciliations = new Reconciliations(deps);
    this.client = this.newClient();
  }

  private newClient(): SyncClient {
    const { deps } = this;
    return new SyncClient({
      fetch: deps.fetch, store: deps.store, storeDir: deps.dir, secrets: deps.secrets, now: deps.now, params: deps.params, settings: this.settings,
      presence: () => [...this.openTex.values()],
      ...(deps.freeBytes ? { freeBytes: deps.freeBytes } : {}),
      downloadAll: (p) => deps.window.downloadAll(p),
      reconcile: (incoming, refused) => this.reconcile(incoming, refused),
      status: (s) => {
        this.last = s;
        deps.window.status(s);
      },
    });
  }

  /** Whether a server is paired (serveur.json read, its token opened). */
  paired(): boolean {
    return this.pairing.paired();
  }

  /** What the block « Serveur » shows (cirrus:sync:server:get): Pairing.info. */
  info(): ServerInfo {
    return this.pairing.info();
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
    this.reconciliations.ready = true;
    await this.step(() => {
      if (this.closed || !this.pairing.paired()) return;
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
   * first, the .tex open forgotten: detach) once the list of those has left, syncSuspendFlushMs at most (D6: closed by
   * the window, a .tex is no longer said open elsewhere); nothing started again.
   */
  close(): Promise<void> {
    this.closed = true;
    this.pairing.close();
    this.detach();
    return this.step(async () => {
      await this.client.presenceSent(this.deps.params().syncSuspendFlushMs);
      await this.client.stop();
    });
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
    const paired = this.pairing.paired();
    const clock = paired ? { at: this.deps.now() + this.client.clockOffset(), latest: this.client.latestSettingTime() } : null;
    const written = this.settings.local(changes, clock);
    if (paired) this.client.kick();
    return written;
  }

  /** The client's reconcile (task 3): the writes received sent to the interface (Reconciliations.reconcile). */
  reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void> {
    return this.reconciliations.reconcile(incoming, refused);
  }

  /** The interface's answer to reconciliation `id` (cirrus:sync:reconciled): written by the base (Reconciliations.reconciled). */
  reconciled(id: number, outcome: ReconcileOutcome): number | null {
    return this.reconciliations.reconciled(id, outcome);
  }

  /**
   * The window is gone (closed, its page reloaded or crashed): what it held abandoned (Reconciliations.detach, R13), its
   * .tex open in full screen too, the server told while connected (D6).
   */
  detach(): void {
    this.reconciliations.detach();
    if (this.openTex.size === 0) return;
    this.openTex.clear();
    void this.client.presence();
  }

  /**
   * A .tex opened in full screen (cirrus:sync:tex:opened, plan 5b, task 5, D6): kept among this PC's open ones, the list
   * sent to the server if connected (SyncClient.presence). Resolves with the first other PC that has it open (the
   * earliest): its name at the server, since when on this PC's clock (the server's, less the offset measured at the
   * hello). Null when none has, or the answer cannot be had now — not paired, not connected (the list leaves at the next
   * connection), a request that failed —: nothing is said then. Null at once for a node or a name that is not one.
   */
  async texOpened(node: unknown, name: unknown): Promise<OpenElsewhere | null> {
    const file = openFile(node, name);
    if (!file || this.closed) return null;
    const key = openKey(file);
    this.openTex.set(key, file);
    if (!this.pairing.paired()) return null;
    const client = this.client, others = await client.presence();
    const other = others?.find((o) => openKey(o) === key);
    return other ? { pc: other.pc, since: other.since - client.clockOffset() } : null;
  }

  /** A .tex's full screen closed (cirrus:sync:tex:closed): no longer among the open ones, the server told while connected. */
  texClosed(node: unknown, name: unknown): void {
    const file = openFile(node, name);
    if (!file || !this.openTex.delete(openKey(file))) return;
    void this.client.presence();
  }

  /** Pairs this PC (cirrus:sync:pair: Pairing.pairNow), after whatever step runs; the block told then (B2). */
  async pair(url: unknown, code: unknown, name: unknown): Promise<PairResult> {
    let result: PairResult = { ok: false, message: 'Jumelage interrompu.' };
    await this.step(async () => {
      try {
        result = await this.pairing.pairNow(url, code, name);
      } catch (e) {
        // serveur.json not written (a disk full, a folder refused): not paired.
        result = { ok: false, message: `Jumelage interrompu : ${messageOf(e)}` };
      }
      this.pairing.tell();
    });
    return result;
  }

  /** The user's answer to D7's offer (cirrus:sync:first: Pairing.firstNow), after whatever step runs; the block told then. */
  async first(choice: unknown): Promise<PairResult> {
    let result: PairResult = { ok: false, message: 'Jumelage interrompu.' };
    await this.step(async () => {
      try {
        result = await this.pairing.firstNow(choice);
      } catch (e) {
        result = { ok: false, message: `Jumelage interrompu : ${messageOf(e)}` };
      }
      this.pairing.tell();
    });
    return result;
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
      await this.pairing.unpair();
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
      this.pairing.tell();
    });
  }

  /**
   * The server's state for the block « Serveur » (cirrus:sync:server:status, plan 5b, D8), asked every
   * serverStatusPollMs while the block is shown: the client's measures and GET /status (SyncClient.serverStatus);
   * nothing without a server.
   */
  serverStatus(): Promise<ServerStatus> {
    if (!this.pairing.paired() || this.closed) return Promise.resolve({ latencyMs: null, throughput: null, server: null });
    return this.client.serverStatus();
  }

  /** « Télécharger tous les PDF… » (D8): its plan, of the PDFs the interface counted (SyncClient.downloadAllPlan). */
  downloadAllPlan(refs: unknown): Promise<DownloadAllPlan> {
    return this.client.downloadAllPlan(refs);
  }

  /** Its start (SyncClient.downloadAllStart), told by cirrus:sync:download-all; without a server, or quitting, refused. */
  downloadAllStart(refs: unknown): Promise<DownloadAllStart> {
    if (!this.pairing.paired() || this.closed) return Promise.resolve({ ok: false, reason: 'offline' });
    return this.client.downloadAllStart(refs);
  }

  /** « Arrêter ». */
  downloadAllStop(): void {
    this.client.downloadAllStop();
  }

  /** cirrus-file:'s fetcher of an absent blob (D6): the client's, with a server paired; none otherwise (plan 4c's 404). */
  blobFetcher(): ((hash: string) => Promise<boolean>) | null {
    return this.pairing.paired() ? (hash) => this.client.fetchBlob(hash) : null;
  }

  /**
   * A publication's import by the server (plan 5b, task 3, D2: publications/via.ts), as blobFetcher hands cirrus-file:
   * its fetcher: with a server paired and the client connected (SyncClient.connected: its stream open), the request
   * through that connection; none otherwise, and this PC imports it itself, as in plan 4c.
   */
  publicationImporter(): ServerImport | null {
    if (!this.pairing.paired() || !this.client.connected()) return null;
    const client = this.client;
    return (request) => client.publication(request);
  }
}
