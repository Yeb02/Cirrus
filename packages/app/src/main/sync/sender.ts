import { MAX_BODY_BYTES, MAX_LABEL_CHARS, MAX_OPS_PER_UNIT, MAX_UNITS_PER_REQUEST, parseUnit, SyncFormatError, truncateLabel, type Unit, type UnitResult } from '@cirrus/core';
import type { SyncDeps } from './client.ts';
import { type Connection, JSON_BODY, json, Refusal } from './connection.ts';
import { sendSettings } from './settingsSync.ts';
import type { Uploads } from './uploads.ts';

// The sync client's sender (plan 5a, task 3): this PC's pending writes sent to the server on a connection, in order, a
// batch per request, the files they add first (uploads.ts) and the shared settings changed here before them
// (settingsSync.ts); the server's answers kept on the connection until its stream brings the writes back. And the gate
// every local write passes before it is written (writeRefusal, R32): what the server would refuse of it.

/** A write as the client sends it (POST /units): a label past the bound, written before it was cut at its making, cut (R20). */
const sentUnit = (u: Unit): Unit => (u.label.length > MAX_LABEL_CHARS ? { ...u, label: truncateLabel(u.label) } : u);

/** The body of POST /units that sends `units`, as the client sends it: what the server's MAX_BODY_BYTES bounds. */
const unitsBody = (units: readonly Unit[]): string => JSON.stringify({ units: units.map(sentUnit) });

/**
 * Why the server would refuse `u` for its form, in French; null when it would not (R32: a base never holds a write the
 * server's gate refuses — SyncHost.commit asks this before anything is written). The server's own checks, in its order:
 * the most operations in one write (MAX_OPS_PER_UNIT: a deletion of that many records is done in parts), the write's
 * shape and each operation's (parseUnit, as POST /units reads it), then the body that sends it alone within
 * MAX_BODY_BYTES. Its label is taken as it will leave, cut (R20). Costs the write's operations, never the base.
 */
export function writeRefusal(u: Unit): string | null {
  const count = Array.isArray(u.ops) ? u.ops.length : 0;
  if (count > MAX_OPS_PER_UNIT) {
    return `Action refusée : elle compte ${count.toLocaleString('fr-FR')} opérations, et le serveur en prend ${MAX_OPS_PER_UNIT.toLocaleString('fr-FR')} au plus. Fais-la en plusieurs fois.`;
  }
  const sent = typeof u.label === 'string' ? sentUnit(u) : u;
  try {
    parseUnit(sent);
  } catch (e) {
    if (e instanceof SyncFormatError) return `Action refusée : ${e.message}`;
    throw e;
  }
  if (Buffer.byteLength(unitsBody([sent])) > MAX_BODY_BYTES) return `Action refusée : elle fait plus de ${MAX_BODY_BYTES / 2 ** 20} Mio, ce que le serveur ne prend pas.`;
  return null;
}

/** An answer to POST /units, as the server gives it. */
const isResult = (r: unknown): r is UnitResult => {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Record<string, unknown>;
  return Number.isSafeInteger(x.accepted) || Number.isSafeInteger(x.stale) || typeof x.refused === 'string';
};

/** What the sender works with besides its connection: its client's deps and files sent, and what it asks of that client. */
export interface SenderClient {
  readonly deps: SyncDeps;
  readonly uploads: Uploads;
  /** Resolves once no reconciliation is under way. */
  reconciled(): Promise<void>;
  /** The reconciliation of what arrived (the refusals among it), once its window has passed. */
  schedule(conn: Connection): void;
  /** The status given again, its counts read now. */
  report(): void;
  /** The latest time the server takes for a setting changed here (R26). */
  latestSettingTime(): number;
}

/**
 * The sender: the shared settings changed here first (task 6), whatever the writes wait for; then the pending writes,
 * in order, syncBatchUnits at most per request, the files they add first — when no reconciliation is under way, no
 * refusal waits for one, and the base has received what a stale answer asked for.
 */
export async function send(conn: Connection, client: SenderClient): Promise<void> {
  const { store } = client.deps;
  try {
    while (!conn.closed) {
      await sendSettings(conn, client.deps.settings, () => client.latestSettingTime());
      if (conn.closed) return;
      await client.reconciled();
      if (conn.closed) return;
      const at = store.lastServerSeq();
      if (conn.waitFor > at || conn.refused.length > 0) {
        await conn.sleep();
        continue;
      }
      for (const [unit, seq] of conn.accepted) if (seq <= at) conn.accepted.delete(unit);
      const limit = Math.max(1, Math.min(conn.batchLimit, client.deps.params().syncBatchUnits, MAX_UNITS_PER_REQUEST));
      const batch = store.pendingUnits(conn.accepted.size + limit).filter((u) => !conn.accepted.has(u.unit)).slice(0, limit);
      if (batch.length === 0) {
        conn.settled();
        await conn.sleep();
        continue;
      }
      await client.uploads.send(conn, batch);
      const results = await post(conn, batch, client);
      if (!results) continue;
      const miss = results.find((r) => !('accepted' in r));
      // Stale, though the base had everything up to that number when the write was read: it can never apply there.
      if (miss && 'stale' in miss && miss.stale <= at) {
        throw new Refusal('Une écriture de ce PC ne s’applique pas au serveur, qui n’a pourtant rien de plus que lui : la base de ce PC ne suit plus celle du serveur.', true);
      }
      results.forEach((r, i) => {
        if ('accepted' in r) conn.accepted.set(batch[i].unit, r.accepted);
        else if ('stale' in r) conn.waitFor = Math.max(conn.waitFor, r.stale);
        else conn.refused.push({ unit: batch[i].unit, message: r.refused });
      });
      if (conn.refused.length > 0) client.schedule(conn);
      client.report();
    }
  } catch (e) {
    conn.fail(e);
  }
}

/**
 * POST /units: the results, one per write. A body over MAX_BODY_BYTES is not sent: a smaller batch next (null), or,
 * for one write alone, a refusal, as the server would give it.
 */
async function post(conn: Connection, batch: Unit[], client: SenderClient): Promise<UnitResult[] | null> {
  // A label past the bound, written before it was cut at its making, is cut as it leaves (R20): the server refuses it.
  const body = unitsBody(batch);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    if (batch.length > 1) conn.batchLimit = Math.max(1, Math.floor(batch.length / 2));
    else {
      conn.refused.push({ unit: batch[0].unit, message: `Écriture trop grosse pour le serveur : ${MAX_BODY_BYTES} octets au plus.` });
      client.schedule(conn);
    }
    return null;
  }
  const answer = await json(await conn.request('/units', { method: 'POST', headers: JSON_BODY, body }));
  const results = (answer as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== batch.length || !results.every(isResult)) {
    throw new Refusal('Réponse du serveur illisible à /units : mets à jour Cirrus, ou le serveur.');
  }
  return results;
}
