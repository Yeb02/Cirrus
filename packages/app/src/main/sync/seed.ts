import { openAsBlob } from 'node:fs';
import {
  applyOps, decodeState, encodeState, MAX_BODY_BYTES, MAX_HASHES_PER_REQUEST, MAX_JOURNAL_PAGE, MAX_LABEL_CHARS, MAX_SEED_BYTES, SNAPSHOT_VERSION, SyncFormatError,
  truncateLabel,
} from '@cirrus/core';
import { type ChangeRow, filePath, type LocalStore, parseChangeRow, storedHashes } from '@cirrus/store';
import type { ServerConfig } from './config.ts';
import { messageOf } from './connection.ts';
import { isBaseId, requests } from './firstSync.ts';

// A seed (plan 5a, task 5, D7, R16): this PC's base sent to a server that holds none — what it sends read and checked
// first, then its files, its snapshot, its journal, and done.

/** A journal line as a seed sends it: its label within MAX_LABEL_CHARS (R20: one written before the bound is cut). */
const sentRow = (r: ChangeRow): ChangeRow => (r.label.length > MAX_LABEL_CHARS ? { ...r, label: truncateLabel(r.label) } : r);

/** The journal's lines from `after`, `last` at most, by pages: each page to `each`. */
function eachPage(store: LocalStore, after: number, last: number, each: (rows: ChangeRow[]) => void): void {
  while (after < last) {
    const rows = store.changesSince(after, Math.min(MAX_JOURNAL_PAGE, last - after));
    if (rows.length === 0) throw new Error(`Le journal de ce PC s’arrête à la ligne ${after}, avant la ${last}.`);
    each(rows);
    after = rows.at(-1)!.localSeq;
  }
}

/**
 * A journal line as it will be sent (its label cut, R20), checked as the server checks it (parseChangeRow), numbered
 * `expected` (from 1 without a gap); `history` (R32), a line the snapshot covers: its shape only, not today's content
 * bounds. A line the server would refuse throws, said in French.
 */
function checkLine(r: ChangeRow, expected: number, history: boolean): void {
  try {
    parseChangeRow(sentRow(r), expected, history);
  } catch (e) {
    if (e instanceof SyncFormatError) throw new Error(`Ligne ${r.localSeq} du journal de ce PC : ${e.message}`);
    throw e;
  }
}

/**
 * What a seed sends of the base, read and checked here before any request (review of task 5, Important 3; R19, R20,
 * R32), in one go (nothing is written in between, so a write made later stays pending, and a file a line up to `last`
 * names is in the store already: blobs are stored before their write):
 * - the journal's last line, `last`;
 * - the stored snapshot, when it is of this format and the journal's lines after it — its tail, which the server
 *   replays on it as it applies a write — each pass the server's whole check (parseChangeRow) and replay on it, "before"
 *   checked; and the line it covers. Otherwise — none, or one whose tail does not replay or holds a line the server's
 *   check refuses (an older app's: reported) — the state of the tables, covering the whole journal, which then has no
 *   tail;
 * - every line up to what the snapshot covers, checked as the server checks a line of history (R32: its shape, not
 *   today's content bounds, so that a base the app opens and edits normally always seeds, its numbering whole): a line
 *   the server would refuse even so stops the seed here, said in French.
 * The rules of the graph are not judged: what the base already carries goes with it (R19). Costs a reading of the
 * journal and, with a stored snapshot, its decoding: a seed's, once.
 */
function prepareSeed(store: LocalStore): { data: ArrayBuffer; seq: number; last: number } {
  const last = store.lastSeq();
  let snapshot: { data: ArrayBuffer; seq: number } | null = null;
  const snap = store.readSnapshot();
  if (snap && snap.version === SNAPSHOT_VERSION && snap.seq <= last) {
    try {
      // A copy: a state decoded keeps views on its buffer, which the replay may write.
      const s = decodeState(snap.data.slice(0));
      let expected = snap.seq + 1;
      eachPage(store, snap.seq, last, (rows) => {
        for (const r of rows) checkLine(r, expected++, false);
        applyOps(s, rows.map((r) => r.op));
      });
      snapshot = { data: snap.data, seq: snap.seq };
    } catch (e) {
      console.warn(`Instantané de cette base inutilisable pour l’envoi (${messageOf(e)}) : l’état est relu de ses tables.`);
    }
  }
  const seq = snapshot?.seq ?? last;
  let expected = 1;
  eachPage(store, 0, seq, (rows) => { for (const r of rows) checkLine(r, expected++, true); });
  return snapshot ? { ...snapshot, last } : { data: encodeState(store.loadState()), seq: last, last };
}

/**
 * What a seed needs: the network, this PC's base and its folder, the server paired (its token), the pairing's time (its
 * /hello's: kept with the seed, B1), the abort of the app's quit, the requests' delay (syncRequestTimeoutMs, plan 9).
 */
interface SeedDeps { fetch: typeof fetch; store: LocalStore; dir: string; config: ServerConfig; pairedAt: number; signal: AbortSignal; timeoutMs: number }

/**
 * Sends this PC's base to the server, which holds none (D7, R16). First, before any request, what it sends is read
 * and checked (prepareSeed): a seed bound to be refused stops there. Then, in the brief's order: every blob of its
 * store (old versions too) the server lacks — listed after that reading, so that a file a sent line names is among
 * them (review, Important 1) —; its snapshot (POST /seed, MAX_SEED_BYTES at most), which makes this PC the seed's
 * owner, and whose answer is the identity the base will have (B1); its journal up to the reading, by pages of
 * MAX_JOURNAL_PAGE lines and MAX_BODY_BYTES at most, labels cut (R20); then done, which makes the server not empty.
 * Then this PC's lines up to there take their numbers (the server's are its journal numbers): none is pending, and its
 * stream resumes after them. Writes made meanwhile stay pending, sent once the sync starts, their files with them.
 * Just before done, the seed is kept in the base's meta (pendingSeed: its identity, its last line, the pairing's
 * time), until the numbers clear it: should done's answer be lost once the server has taken the base, the next pairing
 * recognises it (short review after plan 5a, B1). Throws, in French: nothing written here then but that, the base as it
 * was. Returns its last line sent.
 */
export async function seedBase(o: SeedDeps): Promise<number> {
  const { data, seq, last } = prepareSeed(o.store);
  if (data.byteLength > MAX_SEED_BYTES) throw new Error(`La base de ce PC est trop grosse pour le serveur : son instantané fait ${data.byteLength} octets, ${MAX_SEED_BYTES} au plus.`);
  // The files, the snapshot and the journal's pages are transfers (plan 9, D7): given up when idle, never for their length.
  const { send, json } = requests(o.fetch, o.config, o.signal, o.timeoutMs);
  const hashes = storedHashes(o.dir);
  for (let i = 0; i < hashes.length; i += MAX_HASHES_PER_REQUEST) {
    const chunk = hashes.slice(i, i + MAX_HASHES_PER_REQUEST);
    const missing = ((await json('/files/missing', { hashes: chunk })) as { missing?: unknown } | null)?.missing;
    if (!Array.isArray(missing)) throw new Error('Réponse du serveur illisible à /files/missing : mets à jour Cirrus, ou le serveur.');
    const wanted = new Set(chunk);
    for (const hash of missing) {
      if (typeof hash !== 'string' || !wanted.has(hash)) continue;
      const file = await openAsBlob(filePath(o.dir, { name: '', hash, size: 0 }));
      const res = await send(`/files/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file as unknown as Blob }, { transfer: true });
      await res.body?.cancel();
    }
  }
  const sent = await send('/seed', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Cirrus-Seq': String(seq) }, body: new Uint8Array(data) }, { transfer: true });
  const seedId = ((await sent.json().catch(() => null)) as { baseId?: unknown } | null)?.baseId;
  if (!isBaseId(seedId)) throw new Error('Réponse du serveur illisible à /seed : mets à jour Cirrus, ou le serveur.');
  for (let after = 0; after < last; ) {
    const rows = o.store.changesSince(after, Math.min(MAX_JOURNAL_PAGE, last - after)).map(sentRow);
    if (rows.length === 0) throw new Error(`Le journal de ce PC s’arrête à la ligne ${after}, avant la ${last}.`);
    let n = rows.length, body = JSON.stringify({ rows });
    // A page within the body's bound: halved until it fits.
    while (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      if (n === 1) throw new Error(`La ligne ${rows[0].localSeq} du journal de ce PC est trop grosse pour le serveur : ${MAX_BODY_BYTES} octets au plus.`);
      n = Math.ceil(n / 2);
      body = JSON.stringify({ rows: rows.slice(0, n) });
    }
    await json('/seed/journal', body, true);
    after = rows[n - 1].localSeq;
  }
  o.store.setPendingSeed({ id: seedId, last, at: o.pairedAt });
  const done = (await json('/seed/done', { last })) as { lastSeq?: unknown; baseId?: unknown } | null;
  if (done?.lastSeq !== last || done.baseId !== seedId) throw new Error('Réponse du serveur illisible à /seed/done : mets à jour Cirrus, ou le serveur.');
  // With the numbers, the identity of the base the server now holds (R31): pairing this PC again picks up from here.
  o.store.numberSeeded(last, seedId);
  return last;
}
