import type { Id, Reconciliation, RemoteUnit } from '@cirrus/core';

// The synchronisation's contract between the main process and the interface (plan 5a; short review after it, A2): the
// types its IPC carries, and nothing else. The interface imports only these, never client.ts, host.ts or firstSync.ts,
// so that splitting those, or plan 9's transport, leaves it untouched.

/**
 * What the client is doing, for the interface (D8: the veil, the chip):
 * - off: no server paired, or stopped;
 * - connecting: its first connection since start, under way;
 * - catching-up: connected, `behind` server lines short of what the server held when it connected;
 * - live: caught up; `pending` writes of this PC not yet acknowledged;
 * - offline: the server lost, tried again at growing intervals (syncRetryMinMs to syncRetryMaxMs);
 * - refused: the server refuses (a token, a format, data replaced: its reason), or a write received does not apply here
 *   (`diverged`: this PC's state no longer follows the server's); not tried again until start().
 * `clockWarning` (D4), once the server's time is known, when this PC's clock differs from it by more than
 * syncClockSkewWarnMs.
 */
export type SyncStatus = (
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'catching-up'; behind: number }
  | { state: 'live'; pending: number }
  | { state: 'offline'; pending: number }
  | { state: 'refused'; message: string; diverged?: true }
) & { clockWarning?: string };

/** The writes received, sent to the interface to reconcile (cirrus:sync:incoming); `id` names its answer. */
export interface SyncIncoming { id: number; units: RemoteUnit[]; refused: { unit: Id; message: string }[] }

/**
 * A reconciliation as the interface sends it back: the received writes named only, by identifier and number (main
 * holds them: it sent them); the rest whole.
 */
type ReconciliationAnswer = Omit<Reconciliation, 'remote'> & { remote: { unit: Id; seq: number }[] };

/**
 * The interface's answer (cirrus:sync:reconciled): its reconciliation, for the base to write; or why it could not make
 * one — `diverged`, a received write that does not apply to its state (SyncDivergedError); `error`, anything else.
 */
export type ReconcileOutcome = { reconciliation: ReconciliationAnswer } | { diverged: string } | { error: string };

/**
 * D7's question to the user, after /pair and /hello (task 5):
 * - seed: this PC's base to the server, which holds none (its nodes and its store's files);
 * - adopt: the server's base on this PC, which holds none (the server's nodes), its own kept as `archive` — asked of a
 *   base that was used only: a vierge one takes the server's at once, and is deleted (after the short review of plan
 *   5a, 2026-11-09);
 * - replace: both hold one, which Cirrus does not merge — refused, but the server's may replace this PC's (`local`
 *   nodes), kept as `archive`.
 */
export type FirstSyncOffer =
  | { kind: 'seed'; nodes: number; files: number }
  | { kind: 'adopt'; nodes: number; archive: string }
  | { kind: 'replace'; nodes: number; local: number; archive: string };

/**
 * A pairing's outcome: paired (`restarting`: the app starts again on the base taken from the server — that `first`
 * took, or that a vierge PC took at its pairing); refused, why; or D7's question (`offer`), which `first` answers —
 * until then nothing is kept, the token in memory only.
 */
export type PairResult = { ok: true; restarting?: true } | { ok: false; message: string; offer?: FirstSyncOffer };

/** The answers to D7's offer: send this PC's base, take the server's (or replace this PC's with it), or give up. */
export type FirstSyncChoice = 'seed' | 'adopt' | 'cancel';

/**
 * The block « Serveur » of the settings: the server paired, its address and this PC's name there, and « Tout
 * télécharger » under way or the way the last one ended (`downloadAll`, plan 5b, D8: a block shown again finds it); not
 * paired, the name to propose (the machine's) and no address (the interface proposes its own), or, a pairing awaiting
 * its answer, its server, name and D7's question (`offer`, with its explanation) — shown again whenever the block is —,
 * or a first sync under way (`busy`: what it does). Not paired, `waiting` says a base taken from the server waits beside
 * this one, its swap failed at the start (review of task 5, Important 2).
 */
export interface ServerInfo {
  paired: boolean; url: string; name: string; offer?: { message: string; offer: FirstSyncOffer }; busy?: string; waiting?: string;
  downloadAll?: DownloadAllProgress;
}

/**
 * The server's space, as GET /status answers it (plan 5b, D8): the size of its base's database files, of its store and
 * the number of its files — what is known so far, `counting` until their first count at its start ends —, and the free
 * space of its disk; in bytes.
 */
export interface ServerSpace { baseBytes: number; storeBytes: number; storeFiles: number; freeBytes: number; counting: boolean }

/**
 * The server's state for the block « Serveur » (cirrus:sync:server:status, D8), the main process's measures: the latency,
 * the median of the last round trips of GET /status (ms), null while not connected; the throughput, the median of the
 * last transfers of files of 1 Mio at least, either way (bytes per second), null before any; the server's space, null
 * when it could not be asked now.
 */
export interface ServerStatus { latencyMs: number | null; throughput: number | null; server: ServerSpace | null }

/**
 * « Télécharger tous les PDF… » (D8), asked of the PDFs the interface counted (referencedPdfs): those missing on this PC,
 * their bytes by their references' sizes, and the free space of this PC's disk.
 */
export interface DownloadAllPlan { count: number; bytes: number; freeBytes: number }

/**
 * Its start: under way, or refused — no connection to the server, one under way already, nothing missing (`none`), or
 * not room enough for it and downloadAllReserveMb besides (`room`), the plan of now then given.
 */
export type DownloadAllStart =
  | { ok: true } | { ok: false; reason: 'offline' | 'running' } | { ok: false; reason: 'none' | 'room'; plan: DownloadAllPlan };

/**
 * Where it is, told at its start and at each file's end (cirrus:sync:download-all): the files done, those that could not
 * be had (absent from the server, bytes not their hash's), of the total; the bytes done, of the total, by the
 * references' sizes. Once ended, `end`: all settled (`done`), « Arrêter » (`stopped`), the server lost (`lost`), this
 * PC's disk refusing a file (`disk`), the synchronisation stopped — the app quitting, sleep, an unpairing
 * (`interrupted`). Never resumed by itself: started again, it counts what is still missing.
 */
export interface DownloadAllProgress {
  done: number; failed: number; total: number; doneBytes: number; totalBytes: number; end?: 'done' | 'stopped' | 'lost' | 'disk' | 'interrupted';
}

/** What a local write's commit gives the interface: its journal number, and its time, the server's clock's (D4). */
export interface Committed { seq: number; at: number }

/**
 * The .tex this PC opens in full screen, open on another PC (plan 5b, task 5, D6: cirrus:sync:tex:opened): that PC's
 * name at the server (the one `jumeler` gave it), and since when, on this PC's clock.
 */
export interface OpenElsewhere { pc: string; since: number }
