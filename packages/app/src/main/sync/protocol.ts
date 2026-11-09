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
 * `clockWarning` (D4), once the server's time is known, when this PC's clock differs from it by more than syncClockSkewWarnMs.
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
export type ReconciliationAnswer = Omit<Reconciliation, 'remote'> & { remote: { unit: Id; seq: number }[] };

/**
 * The interface's answer (cirrus:sync:reconciled): its reconciliation, for the base to write; or why it could not make
 * one — `diverged`, a received write that does not apply to its state (SyncDivergedError); `error`, anything else.
 */
export type ReconcileOutcome = { reconciliation: ReconciliationAnswer } | { diverged: string } | { error: string };

/**
 * D7's question to the user, after /pair and /hello (task 5):
 * - seed: this PC's base to the server, which holds none (its nodes and its store's files);
 * - adopt: the server's base on this PC, which holds none (the server's nodes), its own kept as `archive`;
 * - replace: both hold one, which Cirrus does not merge — refused, but the server's may replace this PC's (`local`
 *   nodes), kept as `archive`.
 */
export type FirstSyncOffer =
  | { kind: 'seed'; nodes: number; files: number }
  | { kind: 'adopt'; nodes: number; archive: string }
  | { kind: 'replace'; nodes: number; local: number; archive: string };

/**
 * A pairing's outcome: paired (`restarting`: the app starts again on the base taken from the server); refused, why;
 * or D7's question (`offer`), which `first` answers — until then nothing is kept, the token in memory only.
 */
export type PairResult = { ok: true; restarting?: true } | { ok: false; message: string; offer?: FirstSyncOffer };

/** The answers to D7's offer: send this PC's base, take the server's (or replace this PC's with it), or give up. */
export type FirstSyncChoice = 'seed' | 'adopt' | 'cancel';

/**
 * The block « Serveur » of the settings: the server paired, its address and this PC's name there; not paired, the name
 * to propose (the machine's) and no address (the interface proposes its own), or, a pairing awaiting its answer, its
 * server, name and D7's question (`offer`, with its explanation) — shown again whenever the block is —, or a first sync
 * under way (`busy`: what it does). Not paired, `waiting` says a base taken from the server waits beside this one, its
 * swap failed at the start (review of task 5, Important 2).
 */
export interface ServerInfo {
  paired: boolean; url: string; name: string; offer?: { message: string; offer: FirstSyncOffer }; busy?: string; waiting?: string;
}

/** What a local write's commit gives the interface: its journal number, and its time, the server's clock's (D4). */
export interface Committed { seq: number; at: number }
