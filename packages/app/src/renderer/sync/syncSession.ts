import { SyncDivergedError, type Unit } from '@cirrus/core';
import type { FirstSyncChoice, PairResult, ReconcileOutcome, ServerInfo, SyncIncoming, SyncStatus } from '../../main/sync/protocol.ts';
import { type EditSession, messageOf, type Opened } from '../session.ts';

// The synchronisation in the interface (plan 5a, task 4, D8): the writes received reconciled by the session and written
// by the main process; the veil « Synchronisation… », which holds the actions at startup and on waking until this PC
// has caught up with the server, or syncConnectTimeoutMs; the chip in the tabs' bar; the pairing. Without a server
// paired, nothing of it shows, and nothing runs.

/** The calls of the preload this needs (CirrusBridge). */
export interface SyncBridge {
  syncStart(): Promise<SyncStatus>;
  syncRetry(): void;
  syncReconciled(id: number, outcome: ReconcileOutcome): Promise<number | null>;
  syncPending(): Promise<string>;
  syncPair(url: string, code: string, name: string): Promise<PairResult>;
  syncFirst(choice: FirstSyncChoice): Promise<PairResult>;
  syncUnpair(): Promise<void>;
  syncServer(): Promise<ServerInfo>;
  onSyncIncoming(fn: (m: SyncIncoming) => void): () => void;
  onSyncStatus(fn: (s: SyncStatus) => void): () => void;
  onSyncVeil(fn: () => void): () => void;
  onSyncServer(fn: (info: ServerInfo) => void): () => void;
}

/** The chip in the tabs' bar: its text, its tooltip, whether a click tries again. */
export interface Chip { text: string; title: string; retry: boolean; tone: 'ok' | 'busy' | 'off' | 'refused' }

/** What the interface shows of the synchronisation. */
export interface SyncView { veil: boolean; status: SyncStatus; chip: Chip | null }

/** What the chip says once an update is checked and armed for the app's quit (plan 9, D4). */
export const UPDATE_READY = 'Mise à jour prête : elle s’installera à la fermeture.';

/**
 * The chip (D8): none without a server; « À jour »; « Envoi de n actions… »; « Hors ligne », a click trying again — so
 * too a first connection still under way once the veil gave up (`gaveUp`); « Serveur : <raison> ». The clock's
 * warning in its tooltip. An update armed (plan 9, D4) takes the place of « À jour » and of a refusal — the server's
 * other format among them, which the update resolves —, the refusal kept in the tooltip; the other states keep their
 * text, the update in their tooltip.
 */
export function chipOf(status: SyncStatus, gaveUp: boolean): Chip | null {
  const clock = `${status.clockWarning ? `\n${status.clockWarning}` : ''}${status.updateReady ? `\n${UPDATE_READY}` : ''}`;
  const chip = (text: string, tone: Chip['tone'], retry = false): Chip => ({ text, title: `${retry ? 'Réessayer' : text}${clock}`, retry, tone });
  if (status.updateReady && ((status.state === 'live' && status.pending === 0) || status.state === 'refused')) {
    const why = status.state === 'refused' ? `\nServeur : ${status.message}` : '';
    return { text: UPDATE_READY, title: `${UPDATE_READY}${why}${status.clockWarning ? `\n${status.clockWarning}` : ''}`, retry: false, tone: 'ok' };
  }
  switch (status.state) {
    case 'off': return null;
    case 'connecting': return gaveUp ? chip('Hors ligne', 'off', true) : chip('Connexion…', 'busy');
    case 'catching-up': return chip('Synchronisation…', 'busy');
    case 'live':
      return status.pending === 0 ? chip('À jour', 'ok') : chip(`Envoi de ${status.pending} action${status.pending > 1 ? 's' : ''}…`, 'busy');
    case 'offline': return chip('Hors ligne', 'off', true);
    case 'refused': return chip(`Serveur : ${status.message}`, 'refused', true);
  }
}

interface SyncSessionDeps {
  bridge: SyncBridge;
  session: EditSession;
  /** The state, read again from the base (after a reconciliation the base refused, or a divergence). */
  load(): Promise<Opened>;
  /** syncConnectTimeoutMs, read when the veil rises on waking (the startup's is open's). */
  timeoutMs(): number;
  toast(text: string): void;
  onView(v: SyncView): void;
  /** What the block « Serveur » shows, as the main process holds it (server): App's state. */
  onServer?(info: ServerInfo): void;
}

export class SyncSession {
  private readonly deps: SyncSessionDeps;
  private status: SyncStatus = { state: 'off' };
  private veil = false;
  /** The last veil ended by its timeout: a connection still under way then reads « Hors ligne ». */
  private gaveUp = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clockTold: string | undefined;
  private updateTold: string | undefined;
  /** This PC's identifier, which signs its writes (from the load). */
  private pc = '';
  /** The statuses the main process sent: one sent after a call began is newer than that call's answer. */
  private told = 0;
  /** The view last given (as text): an identical one is not given again (review of task 4, Minor 5). */
  private shown = '';
  /** The interface has opened its state (open): this PC's identifier is known, a pairing told may be followed. */
  private opened = false;
  /**
   * The session follows the pending writes for the server paired, and the synchronisation is started (or starting):
   * once per pairing, whoever sees it first — the pairing's answer, or the main process's message (B2).
   */
  private following: Promise<void> | null = null;
  private readonly off: (() => void)[] = [];

  constructor(deps: SyncSessionDeps) {
    this.deps = deps;
    const { bridge } = deps;
    this.off.push(
      bridge.onSyncIncoming((m) => { void this.incoming(m); }),
      bridge.onSyncStatus((s) => {
        this.told++;
        this.setStatus(s);
      }),
      bridge.onSyncVeil(() => this.raise(deps.timeoutMs())),
      bridge.onSyncServer((info) => this.heard(info)),
    );
  }

  /**
   * The main process's word on the pairing (cirrus:sync:server; short review after plan 5a, B2): given to the block
   * (onServer); paired while this session does not follow — a page that opened while a pairing or a first sync was
   * under way (reloaded meanwhile, Ctrl+R): it follows and starts now, as a pairing done here would. Unpaired while
   * it follows — a page that opened paired while an unpairing was under way —: it no longer follows, as after an
   * unpairing done here, so that the next pairing starts again (re-review of the fixes, N2).
   */
  private heard(info: ServerInfo): void {
    this.deps.onServer?.(info);
    if (info.paired && this.opened && !this.following) void this.follow();
    else if (!info.paired && this.following) {
      this.following = null;
      void this.deps.session.unfollow();
      this.lower(false);
    }
  }

  /**
   * The interface has opened its state: with a server paired, the session keeps the pending writes the base gave,
   * the veil rises for `timeoutMs` at most — the settings just loaded (review of task 4, Important 3) — and the
   * synchronisation starts (the main process waits for this to reconcile anything). `paired`: the main process's
   * answer, asked before the state, so that the pending writes given are all of them. `since`: its word since that
   * answer, while the page loaded (short review after plan 5a, B2), newer: it decides instead, before anything is
   * awaited, as if it came now — paired, the pending writes read again —, so that a word heard meanwhile is never
   * overwritten; App gave it to the block already (re-review of the fixes, N3). `waiting`: a base taken from the
   * server that could not be swapped in at the start, said in a notification.
   */
  async open(o: { paired: boolean; pc: string; pending: Unit[]; timeoutMs: number; waiting?: string; since?: ServerInfo }): Promise<void> {
    this.pc = o.pc;
    this.opened = true;
    // A base taken from the server waits beside this one, its swap failed at the start: said at once (review, Important 2).
    if (o.waiting) this.deps.toast(o.waiting);
    if (o.since) {
      if (o.since.paired) await this.follow();
      return;
    }
    // Without a server, nothing to show: the interface is as in plan 4c — until the main process says it is paired.
    if (o.paired) {
      this.following = (async () => {
        await this.deps.session.follow(o.pc, async () => o.pending);
        this.raise(o.timeoutMs);
        await this.start();
      })();
      await this.following;
    }
  }

  /** The synchronisation started; its status as the main process answers, unless a newer one came meanwhile. */
  private async start(): Promise<void> {
    const told = this.told, s = await this.deps.bridge.syncStart();
    if (this.told === told) this.setStatus(s);
  }

  /**
   * Pairs this PC (the block « Serveur »): the main process pairs, or asks D7's question (`offer`, which `first`
   * answers); paired, the session takes every pending write, read in its queue (none written meanwhile), and the
   * synchronisation starts. The refusal, in French. Paired by the main
   * process, it is done, whatever follows (review of task 4, Minor 3): a start that fails is said, and only the next
   * launch starts it — the main process never started the client, so there is no chip, and nothing to try again.
   */
  async pair(url: string, code: string, name: string): Promise<PairResult> {
    try {
      return this.paired(await this.deps.bridge.syncPair(url, code, name));
    } finally {
      // What the main process holds, whatever happened here (review of task 4, Minor 3).
      await this.reread();
    }
  }

  /**
   * The answer to D7's offer that a pairing returned (the block « Serveur »): this PC's base sent, then as a pairing
   * done; the server's taken, the app restarting on it (nothing more here); given up. The outcome, in French.
   */
  async first(choice: FirstSyncChoice): Promise<PairResult> {
    try {
      return this.paired(await this.deps.bridge.syncFirst(choice));
    } finally {
      await this.reread();
    }
  }

  /**
   * What the block « Serveur » shows, read again from the main process and given to onServer: at each mounting of the
   * block — the settings panel opened, its rubric unfolded —, so that a first sync under way shows as such (`busy`)
   * rather than the offer the interface last held (review of task 5, round 2); and after each pairing, answer and
   * unpairing. Taken as the main process's message is (heard): paired while not following, it follows.
   */
  async server(): Promise<ServerInfo> {
    const info = await this.deps.bridge.syncServer();
    this.heard(info);
    return info;
  }

  /** server(), its failure only reported: the block keeps what it had. */
  private async reread(): Promise<void> {
    await this.server().catch((e: unknown) => console.error('État du serveur non relu :', e));
  }

  /** A pairing the main process did (`ok`, not restarting): followed and started, unless its word came first. */
  private async paired(r: PairResult): Promise<PairResult> {
    if (!r.ok || r.restarting) return r;
    await (this.following ?? this.follow());
    return r;
  }

  /** Every pending write taken, then the sync started, once per pairing (`following`); a failure said, not thrown. */
  private follow(): Promise<void> {
    const { bridge, session } = this.deps;
    this.following = (async () => {
      try {
        await session.follow(this.pc, async () => JSON.parse(await bridge.syncPending()) as Unit[]);
        await this.start();
      } catch (e) {
        console.error('Synchronisation non démarrée :', e);
        this.deps.toast(`Ce PC est jumelé, mais la synchronisation n’a pas démarré (${messageOf(e)}) : relance Cirrus.`);
      }
    })();
    return this.following;
  }

  /** Unpairs: the main process stops and forgets the server; the session no longer keeps the pending writes. */
  async unpair(): Promise<void> {
    await this.deps.bridge.syncUnpair();
    this.following = null;
    await this.deps.session.unfollow();
    this.lower(false);
    this.setStatus({ state: 'off' });
    await this.reread();
  }

  /** The chip's click: offline or refused, try again now. */
  retry(): void {
    this.deps.bridge.syncRetry();
  }

  dispose(): void {
    for (const off of this.off.splice(0)) off();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Writes received: reconciled by the session, written by the main process (its answer resolves the client's
   * reconcile). The dropped writes and the other notifications said. A failure the main process is told of; a write the
   * base refused (it knows already) has the state read again.
   */
  private async incoming(m: SyncIncoming): Promise<void> {
    const { bridge, session } = this.deps;
    let written = false;
    try {
      const out = await session.reconcile(m.units, m.refused, async (r) => {
        written = true;
        // The received writes named only: the main process holds them (review of task 4, Minor 4).
        const reconciliation = { ...r, remote: r.remote.map((u) => ({ unit: u.unit, seq: u.seq })) };
        const seq = await bridge.syncReconciled(m.id, { reconciliation });
        if (seq === null) throw new Error('Réconciliation non écrite.');
        return seq;
      });
      for (const text of [...out.dropped, ...out.notices]) this.deps.toast(text);
    } catch (e) {
      if (written) {
        console.error('Réconciliation refusée par la base :', e);
        this.deps.toast(`La synchronisation n’a pas pu être écrite (${messageOf(e)}) : l’état est relu depuis la base.`);
        await this.reload();
        return;
      }
      // Diverged: the client stops, refused; its status has the state read again (setStatus).
      const outcome: ReconcileOutcome = e instanceof SyncDivergedError ? { diverged: e.message } : { error: messageOf(e) };
      if (!(e instanceof SyncDivergedError)) console.error('Réconciliation impossible :', e);
      await bridge.syncReconciled(m.id, outcome).catch((err: unknown) => console.error('Réconciliation :', err));
    }
  }

  private async reload(): Promise<void> {
    try {
      await this.deps.session.reload(this.deps.load);
    } catch (e) {
      console.error('État de la base non relu :', e);
    }
  }

  private setStatus(s: SyncStatus): void {
    const was = this.status;
    this.status = s;
    // This PC's state no longer follows the server's: read again from the base, once per refusal.
    if (s.state === 'refused' && s.diverged && !(was.state === 'refused' && was.diverged)) void this.reload();
    // The clock's warning said once per message in the session (each reconnection repeats it); the tooltip keeps it.
    if (s.clockWarning && s.clockWarning !== this.clockTold) {
      this.clockTold = s.clockWarning;
      this.deps.toast(s.clockWarning);
    }
    // An update refused (plan 9, D4): its notification, once in the session.
    if (s.updateRefused && s.updateRefused !== this.updateTold) {
      this.updateTold = s.updateRefused;
      this.deps.toast(s.updateRefused);
    }
    // Caught up, or refused (nothing more will come): the veil lifts. « off » does not: waking stops the client first.
    if (this.veil && (s.state === 'live' || s.state === 'refused')) this.lower(false);
    else {
      if (s.state === 'live') this.gaveUp = false;
      this.show();
    }
  }

  /** The veil rises (startup, waking), `ms` (syncConnectTimeoutMs) at most. */
  private raise(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.veil = true;
    this.gaveUp = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lower(true);
    }, Math.max(0, ms));
    this.show();
  }

  private lower(gaveUp: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.veil = false;
    this.gaveUp = gaveUp;
    this.show();
  }

  /** The view, given only when it changed: a status that changes nothing renders nothing (review of task 4, Minor 5). */
  private show(): void {
    const v: SyncView = { veil: this.veil, status: this.status, chip: chipOf(this.status, this.gaveUp) };
    const key = JSON.stringify(v);
    if (key === this.shown) return;
    this.shown = key;
    this.deps.onView(v);
  }
}
