import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalStore } from '@cirrus/store';
import { DEFAULT_PARAMS, type RenderParams } from '@cirrus/view';
import { loadPayload, openBase, pcId } from '../../src/main/base.ts';
import { fileSecrets, type TokenCipher } from '../../src/main/sync/config.ts';
import { type HostWindow, SyncHost } from '../../src/main/sync/host.ts';
import type { DownloadAllProgress, ServerInfo, SyncIncoming, SyncStatus } from '../../src/main/sync/protocol.ts';
import { EditSession, type Opened, openState } from '../../src/renderer/session.ts';
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

/** A base folder's settings.json, as a PC had it before the test: its settings that differ from the defaults. */
export function writeSettings(dir: string, overrides: Record<string, unknown>): void {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(overrides, null, 2), 'utf8');
}

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
  /** App's state for the block « Serveur », in order: what each opening set it to, then what the session gave it. */
  readonly servers: ServerInfo[] = [];
  /** What the host told the window of the server, each change (cirrus:sync:server: short review after plan 5a, B2). */
  readonly serversTold: ServerInfo[] = [];
  readonly incoming: SyncIncoming[] = [];
  /** The shared settings received, each batch as the window was told it (cirrus:settings:changed, task 6). */
  readonly settingsTold: Record<string, unknown>[] = [];
  /** « Tout télécharger » as the window was told it, each change (cirrus:sync:download-all, plan 5b, D8). */
  readonly downloadAllTold: DownloadAllProgress[] = [];
  veils = 0;
  /** The app's relaunches asked for (a base taken from the server, D7): the test restarts it itself. */
  relaunched = 0;
  /** Whether the window is there: closed, the host's messages find no one. */
  windowOpen = true;
  canEncrypt = true;
  /** The interface answers its reconciliations itself (true), or the test does (false: they are only recorded). */
  answers = true;
  params: RenderParams;
  private readonly listeners = {
    incoming: [] as ((m: SyncIncoming) => void)[], status: [] as ((s: SyncStatus) => void)[], veil: [] as (() => void)[], server: [] as ((i: ServerInfo) => void)[],
  };

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
      downloadAll: (p) => { this.downloadAllTold.push(clone(p)); },
      server: (info) => {
        this.serversTold.push(info);
        const copy = clone(info);
        later(() => { for (const fn of this.listeners.server) fn(copy); });
      },
    };
    this.host = new SyncHost({
      fetch: this.net.fetch, store: this.store, dir: this.dir, pc: pcId(this.dir), secrets: fileSecrets(this.dir, XOR), secretsAt: (d) => fileSecrets(d, XOR),
      canEncrypt: () => this.canEncrypt, params: () => this.params, now: () => lab.clock, machineName: 'PORTABLE', window, relaunch: () => { this.relaunched++; },
    });
    // A page's listeners, until it goes (SyncSession.dispose: a reload, a close).
    const on = <K extends keyof AppPc['listeners']>(k: K) => (fn: AppPc['listeners'][K][number]) => {
      const list = this.listeners[k] as unknown[];
      list.push(fn);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
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
      onSyncServer: on('server'),
    };
  }

  /** cirrus:load as ipc/base.ts answers it: the payload, the pending writes when paired, this PC's identifier. */
  private load = async (fromTables: boolean) => clone({ ...loadPayload(this.store, fromTables, this.host.paired()).payload, pc: pcId(this.dir) });

  /**
   * The interface opens as App does (re-review of the fixes, N4): the server asked first, then the state from the base
   * (paired at the answer, its pending writes are all of them), its session, and the synchronisation started if paired;
   * what the main process said of the server since its answer, until the session listens, passed on (`since`).
   */
  async open(): Promise<this> {
    const told: { info: ServerInfo | null } = { info: null };
    const early = this.bridge.onSyncServer((i) => { told.info = i; });
    let opened: Opened, info: ServerInfo;
    try {
      const asked = this.bridge.syncServer().then((i) => { told.info = null; return i; });
      [opened, info] = await Promise.all([openState(this.load), asked]);
      this.session = new EditSession(opened.state, async (a, unit) => clone(this.host.commit(clone(a), unit)), () => {}, opened.seq);
      this.sync = new SyncSession({
        bridge: this.bridge, session: this.session, timeoutMs: () => this.params.syncConnectTimeoutMs, toast: (t) => this.toasts.push(t), onView: (v) => this.views.push(v),
        onServer: (i) => { this.servers.push(i); },
        load: () => openState(this.load),
      });
    } finally {
      early();
    }
    const since = told.info ?? undefined;
    this.servers.push(since ?? info);
    await this.sync.open({ paired: info.paired, pc: opened.pc, pending: opened.pending, timeoutMs: this.params.syncConnectTimeoutMs, waiting: info.waiting, since });
    return this;
  }

  /**
   * The page reloaded (Ctrl+R): the old one goes — its listeners, and the host detaches (did-navigate) —, and a new one
   * opens as App does. A call the old page made answers no one: the test makes it on the host itself.
   */
  async reload(): Promise<this> {
    this.sync.dispose();
    this.host.detach();
    return this.open();
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
