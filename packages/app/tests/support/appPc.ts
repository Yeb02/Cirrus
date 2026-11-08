import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalStore } from '@cirrus/store';
import { DEFAULT_PARAMS, type RenderParams } from '@cirrus/view';
import { loadPayload, openBase, pcId } from '../../src/main/base.ts';
import type { SyncStatus } from '../../src/main/sync/client.ts';
import { fileSecrets, type TokenCipher } from '../../src/main/sync/config.ts';
import { type HostWindow, type ServerInfo, type SyncIncoming, SyncHost } from '../../src/main/sync/host.ts';
import { EditSession, openState } from '../../src/renderer/session.ts';
import { type SyncBridge, SyncSession, type SyncView } from '../../src/renderer/sync/syncSession.ts';
import { type Lab, Net, TEST_PARAMS } from './virtualPc.ts';

// The app as a PC of the lab (plan 5a, task 4), without Electron: its main process's SyncHost on a base opened as the
// app opens it (a lobby), and its interface's session and SyncSession, joined by a bridge that copies every message as
// IPC would (structuredClone) and delivers it a turn later.

/** A cipher that does not leave the token readable in serveur.json (the app's is safeStorage). */
export const XOR: TokenCipher = {
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
};

const clone = <T>(x: T): T => structuredClone(x);
const later = (fn: () => void) => { setTimeout(fn, 0); };

export class AppPc {
  /** Its folder's name in the lab: the same name opens the same base again (a restart). */
  readonly name: string;
  readonly dir: string;
  readonly net = new Net();
  readonly store: LocalStore;
  readonly host: SyncHost;
  readonly bridge: SyncBridge;
  session!: EditSession;
  sync!: SyncSession;
  readonly statuses: SyncStatus[] = [];
  readonly views: SyncView[] = [];
  readonly toasts: string[] = [];
  /** What the session gave the interface of the server (App's state for the block « Serveur »), in order. */
  readonly servers: ServerInfo[] = [];
  readonly incoming: SyncIncoming[] = [];
  /** The shared settings received, each batch as the window was told it (cirrus:settings:changed, task 6). */
  readonly settingsTold: Record<string, unknown>[] = [];
  veils = 0;
  /** The app's relaunches asked for (a base taken from the server, D7): the test restarts it itself. */
  relaunched = 0;
  /** Whether the window is there: closed, the host's messages find no one. */
  windowOpen = true;
  canEncrypt = true;
  /** The interface answers its reconciliations itself (true), or the test does (false: they are only recorded). */
  answers = true;
  params: RenderParams;
  private readonly listeners = { incoming: [] as ((m: SyncIncoming) => void)[], status: [] as ((s: SyncStatus) => void)[], veil: [] as (() => void)[] };

  constructor(lab: Lab, name: string, params: Partial<RenderParams> = {}) {
    this.name = name;
    this.dir = join(lab.root, name);
    mkdirSync(this.dir, { recursive: true });
    this.params = { ...DEFAULT_PARAMS, ...TEST_PARAMS, ...params };
    this.store = openBase(this.dir);
    const window: HostWindow = {
      incoming: (m) => {
        if (!this.windowOpen) return false;
        this.incoming.push(m);
        const copy = clone(m);
        if (this.answers) later(() => { for (const fn of this.listeners.incoming) fn(copy); });
        return true;
      },
      status: (s) => {
        this.statuses.push(s);
        const copy = clone(s);
        later(() => { for (const fn of this.listeners.status) fn(copy); });
      },
      veil: () => {
        this.veils++;
        later(() => { for (const fn of this.listeners.veil) fn(); });
      },
      settings: (changes) => { this.settingsTold.push(clone(changes)); },
    };
    this.host = new SyncHost({
      fetch: this.net.fetch, store: this.store, dir: this.dir, pc: pcId(this.dir), secrets: fileSecrets(this.dir, XOR), secretsAt: (d) => fileSecrets(d, XOR),
      canEncrypt: () => this.canEncrypt, params: () => this.params, now: () => lab.clock, machineName: 'PORTABLE', window, relaunch: () => { this.relaunched++; },
    });
    const on = <K extends keyof AppPc['listeners']>(k: K) => (fn: AppPc['listeners'][K][number]) => {
      (this.listeners[k] as unknown[]).push(fn);
      return () => {};
    };
    this.bridge = {
      syncStart: async () => clone(await this.host.start()),
      syncRetry: () => this.host.retry(),
      syncReconciled: async (id, outcome) => clone(this.host.reconciled(id, clone(outcome))),
      syncPending: async () => this.host.pending(),
      syncPair: async (url, code, name) => clone(await this.host.pair(url, code, name)),
      syncFirst: async (choice) => clone(await this.host.first(choice)),
      syncUnpair: () => this.host.unpair(),
      syncServer: async () => clone(this.host.info()),
      onSyncIncoming: on('incoming'),
      onSyncStatus: on('status'),
      onSyncVeil: on('veil'),
    };
  }

  /** cirrus:load as index.ts answers it: the payload, the pending writes when paired, this PC's identifier. */
  private load = async (fromTables: boolean) => clone({ ...loadPayload(this.store, fromTables, this.host.paired()).payload, pc: pcId(this.dir) });

  /** The interface opens: its state from the base, its session, and the synchronisation started if paired. */
  async open(): Promise<this> {
    const opened = await openState(this.load);
    this.session = new EditSession(opened.state, async (a, unit) => clone(this.host.commit(clone(a), unit)), () => {}, opened.seq);
    this.sync = new SyncSession({
      bridge: this.bridge, session: this.session, timeoutMs: () => this.params.syncConnectTimeoutMs, toast: (t) => this.toasts.push(t), onView: (v) => this.views.push(v),
      onServer: (i) => { this.servers.push(i); },
      load: () => openState(this.load),
    });
    const info = await this.bridge.syncServer();
    await this.sync.open({ paired: info.paired, pc: opened.pc, pending: opened.pending, timeoutMs: this.params.syncConnectTimeoutMs, waiting: info.waiting });
    return this;
  }

  get status(): SyncStatus | undefined {
    return this.statuses.at(-1);
  }

  get view(): SyncView | undefined {
    return this.views.at(-1);
  }

  async close(): Promise<void> {
    this.sync?.dispose();
    this.windowOpen = false;
    this.host.detach();
    await this.host.close();
    this.store.close();
  }
}
