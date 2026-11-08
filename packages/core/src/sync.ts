import { addedViolation } from './commands.ts';
import { groupOf, type Violation } from './invariants.ts';
import { rebaseUnit } from './merge.ts';
import type { Id, NodeRec } from './model.ts';
import { invertOp, MAX_ID_CHARS, MAX_LABEL_CHARS, type Op, parseOp, SyncFormatError } from './ops.ts';
import { applyOp, canonical, rollback, type State } from './state.ts';

// The synchronisation's model (plan 5a): the writes a PC sends, those the server relays, and the reconciliation that
// replays the pending ones on what arrives (D4, D5).

/**
 * One write: one call to LocalStore.commit, with its identifier (unit), its action's (several writes may share one: the
 * saves of a .tex, plan 4b), its label, its time (the PC's, corrected by the server's, D4), its PC, its operations.
 */
export interface Unit { unit: Id; action: Id; label: string; at: number; pc: string; ops: Op[] }

/** A write as the server relays it: `seq`, the number of its last line there; its lines go from `seq - ops.length + 1` to `seq`. */
export interface RemoteUnit extends Unit { seq: number }

/**
 * What a reconciliation did to the interface's state, for the base to write it in one transaction
 * (LocalStore.applyReconciliation):
 * - `acked`: the pending writes at the head that the server relayed back as they were, the first received ones: their
 *   lines are kept, and take their numbers;
 * - `rewind`: the inverses of the other pending writes, the last first, when there was anything to replay them on
 *   (empty otherwise);
 * - `remote`: every write received, in the server's order, the acknowledged ones included;
 * - `rebased`: the pending writes once it is done, in order — replayed when `rewind` is not empty (the same object for
 *   one nothing changed), as they were otherwise;
 * - `dropped`: the pending writes refused by the server, or that would now add a violation, each with its notification;
 * - `notices`: the other notifications (the .tex conflict copies).
 * A pending write found in none of `acked`, `rebased` and `dropped` was received after other writes (its lines are
 * written again with the received ones), or no longer changes anything.
 */
export interface Reconciliation {
  rewind: Op[];
  remote: RemoteUnit[];
  rebased: Unit[];
  dropped: { unit: Unit; message: string }[];
  acked: Id[];
  notices: string[];
}

/**
 * The server's answer to one write sent (POST /units, plan 5a): accepted with the number of its last line; stale, with
 * the number to have received before sending it again (one of its "before" no longer holds there); refused, why.
 */
export type UnitResult = { accepted: number } | { stale: number } | { refused: string };

/** The version of the protocol between a PC and its server (D10): /hello refuses another. */
export const SYNC_PROTOCOL_VERSION = 1;

/** A write's most operations (a server bound, Global Constraints: packages/server/src/bounds.ts); its longest label is ops.ts's. */
export const MAX_OPS_PER_UNIT = 200_000;

/**
 * The bounds of the requests a PC sends that the PC must respect too (task 3: its client cuts its batches to them), the
 * server refusing more (its bounds.ts re-exports them): the largest body of POST /units, and of its other JSON requests;
 * the most writes in one POST /units; the most hashes in one POST /files/missing.
 */
export const MAX_BODY_BYTES = 64 * 2 ** 20;
export const MAX_UNITS_PER_REQUEST = 100;
export const MAX_HASHES_PER_REQUEST = 10_000;
/**
 * The first sync's bounds (task 5, D7), which the PC respects too: the most lines in one page of a journal — one the
 * server serves (GET /journal, and the pages its event streams read to catch up), one a PC sends when it seeds an
 * empty server (POST /seed/journal) —; the largest snapshot a PC sends then (POST /seed).
 */
export const MAX_JOURNAL_PAGE = 10_000;
export const MAX_SEED_BYTES = 2 * 2 ** 30;
/**
 * The most shared settings in one POST /settings (task 6, R24), which the PC respects too (its client cuts its changes
 * to it): more than twice the settings there are.
 */
export const MAX_SETTINGS_PER_REQUEST = 500;
/**
 * How far ahead of the server's clock a setting's time may be (task 6, R26): one day. The server refuses a change
 * stamped later, so that no stamp can hold a setting for long against every other PC; the PC never stamps past it (its
 * clock corrected by the server's, less its margin, syncClockSkewWarnMs).
 */
export const MAX_SETTING_AHEAD_MS = 24 * 3_600_000;

/**
 * A shared setting's change as a PC sends it (POST /settings, task 6, D9): its value, JSON, null going back to the
 * default; its time, the server's clock (D4).
 */
export interface SettingChange { value: unknown; at: number }
/** A shared setting as the server keeps it: its last change, and the PC that made it (the more recent wins: `newer`). */
export interface SettingRow extends SettingChange { pc: string }
/**
 * A setting's time as the PCs make them (now + the server's offset, rounded): whole milliseconds, from 0 to 2^53 − 1.
 * Past it `at + 1 === at`, and a PC could never pass a change it has seen (review of task 6, Minor 4): checked by the
 * server on receipt, and by the PC in what the server gives and in its own pending changes.
 */
export const isSettingTime = (at: unknown): at is number => Number.isSafeInteger(at) && (at as number) >= 0;

/** A received operation that does not apply to this PC's state: it no longer follows the server's. */
export class SyncDivergedError extends Error {}

const UNIT_FIELDS = ['unit', 'action', 'label', 'at', 'pc', 'ops'] as const;

function parse(x: unknown, remote: boolean): RemoteUnit {
  const bad = (what: string): never => { throw new SyncFormatError(`Écriture mal formée : ${what}.`); };
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('ce n’est pas un objet');
  const u = x as Record<string, unknown>, known: readonly string[] = remote ? [...UNIT_FIELDS, 'seq'] : UNIT_FIELDS;
  for (const k of known) if (u[k] === undefined) bad(`${k} manque`);
  for (const k in u) if (u[k] !== undefined && !known.includes(k)) bad(`${k} est inattendu`);
  for (const k of ['unit', 'action', 'pc']) {
    const v = u[k];
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ID_CHARS) bad(`${k} n’est pas un identifiant de 1 à ${MAX_ID_CHARS} caractères`);
  }
  if (typeof u.label !== 'string' || u.label.length > MAX_LABEL_CHARS) bad(`le libellé n’est pas une chaîne de ${MAX_LABEL_CHARS} caractères au plus`);
  if (typeof u.at !== 'number' || !Number.isFinite(u.at)) bad('l’heure n’est pas un nombre fini');
  const ops = u.ops;
  if (!Array.isArray(ops) || ops.length === 0) bad('les opérations ne sont pas une liste non vide');
  if ((ops as unknown[]).length > MAX_OPS_PER_UNIT) bad(`plus de ${MAX_OPS_PER_UNIT} opérations`);
  (ops as unknown[]).forEach((op, i) => {
    try {
      parseOp(op);
    } catch (e) {
      if (e instanceof SyncFormatError) throw new SyncFormatError(`${e.message.slice(0, -1)} (opération ${i + 1}).`);
      throw e;
    }
  });
  if (remote && (!Number.isSafeInteger(u.seq) || (u.seq as number) < (ops as unknown[]).length)) bad('son numéro au serveur n’est pas un entier au moins égal à son nombre d’opérations');
  return x as RemoteUnit;
}

/** A write received from a PC (by the server): its shape checked whole, every operation (parseOp); SyncFormatError otherwise. */
export function parseUnit(x: unknown): Unit {
  return parse(x, false);
}

/** A write relayed by the server (by a PC): as parseUnit, with its number. */
export function parseRemoteUnit(x: unknown): RemoteUnit {
  return parse(x, true);
}

const sameOps = (a: readonly Op[], b: readonly Op[]): boolean => a.length === b.length && (JSON.stringify(a) === JSON.stringify(b) || canonical(a) === canonical(b));

/** The notification of a replayed write that would add a violation (D4), read on the state without it. */
function dropMessage(s: State, u: Unit, replayed: Unit, v: Violation): string {
  let why = v.message;
  const node = v.code === 'twoGroups' ? s.nodes.get(v.subject) : undefined;
  if (node) {
    for (const op of replayed.ops) {
      const g = op.t === 'branch' ? groupOf(s, op.key.plan, v.subject) : undefined, group = g === undefined ? undefined : s.nodes.get(g);
      if (group) { why = `« ${node.title} » est déjà dans le groupe « ${group.title} », depuis un autre PC.`; break; }
    }
  }
  return `« ${u.label} » écartée : ${why}`;
}

/**
 * Brings the received writes into a state that holds the server's state up to the last number received plus the
 * pending writes, in order (D4): the received writes that are the pending ones at the head, as they were, acknowledge
 * them; then, if anything remains to receive or was refused, the other pending writes are undone, the received ones
 * applied, and each pending one replayed on top (rebaseUnit), checked as a command — dropped with a notification when the
 * server refused it or it would add a violation, gone without a word when it no longer changes anything. `s` is left
 * reconciled; it is left as it was when a received operation (or an inverse) does not apply: SyncDivergedError. Costs
 * what the pending and received writes touch, never the size of the base.
 */
export function reconcile(s: State, pending: readonly Unit[], incoming: readonly RemoteUnit[], refused: readonly { unit: Id; message: string }[]): Reconciliation {
  let n = 0;
  while (n < pending.length && n < incoming.length && incoming[n].unit === pending[n].unit && sameOps(incoming[n].ops, pending[n].ops)) n++;
  const rest = pending.slice(n), later = incoming.slice(n), refusal = new Map(refused.map((r) => [r.unit, r.message]));
  const out: Reconciliation = { rewind: [], remote: [...incoming], rebased: [], dropped: [], acked: pending.slice(0, n).map((u) => u.unit), notices: [] };
  if (rest.length > 0 && later.length === 0 && !rest.some((u) => refusal.has(u.unit))) {
    out.rebased = [...rest];
    return out;
  }
  // Everything applied to `s` here, in order, to undo it all should anything go wrong.
  const log: Op[] = [];
  try {
    for (let i = rest.length - 1; i >= 0; i--) {
      for (let j = rest[i].ops.length - 1; j >= 0; j--) {
        const op = invertOp(rest[i].ops[j]);
        applyOp(s, op);
        log.push(op);
        out.rewind.push(op);
      }
    }
    for (const u of later) for (const op of u.ops) { applyOp(s, op); log.push(op); }
  } catch (e) {
    rollback(s, log, 0);
    throw new SyncDivergedError(`La base de ce PC ne suit plus celle du serveur : ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const received = new Set(later.map((u) => u.unit));
  /** The conflict copies the replayed writes made, by node: a later write of the same .tex may replace one. */
  const copies: { node: Id; name: string }[] = [];
  try {
    for (const u of rest) {
      // Accepted by the server after other writes: received above, as the server holds it.
      if (received.has(u.unit)) continue;
      const message = refusal.get(u.unit);
      if (message !== undefined) {
        out.dropped.push({ unit: u, message: `« ${u.label} » écartée : ${message}` });
        continue;
      }
      const { unit, conflictCopies } = rebaseUnit(s, u, later);
      if (!unit) continue;
      const mark = log.length;
      for (const op of unit.ops) { applyOp(s, op); log.push(op); }
      const v = addedViolation(s, unit.ops);
      if (v) {
        rollback(s, log, mark);
        out.dropped.push({ unit: u, message: dropMessage(s, u, unit, v) });
        continue;
      }
      out.rebased.push(unit);
      for (const name of conflictCopies) {
        const op = unit.ops.find((o) => o.t === 'node' && o.after?.files.some((f) => f.name === name));
        if (op) copies.push({ node: (op.after as NodeRec).id, name });
      }
    }
  } catch (e) {
    rollback(s, log, 0);
    throw e;
  }
  // One notification per conflict: for each copy the replayed writes leave in the end.
  const told = new Set<string>();
  for (const { node, name } of copies) {
    const key = `${node}\u0000${name}`;
    if (told.has(key) || !s.nodes.get(node)?.files.some((f) => f.name === name)) continue;
    told.add(key);
    out.notices.push(`Un .tex a été modifié sur deux PC : l’autre version est gardée sous « ${name} ».`);
  }
  return out;
}
