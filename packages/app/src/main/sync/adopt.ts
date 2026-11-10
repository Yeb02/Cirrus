import { copyFileSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeState, MAX_JOURNAL_PAGE, MAX_SEED_BYTES, type State, SyncFormatError } from '@cirrus/core';
import { type ChangeRow, filePath, LocalStore, parseChangeRow, receiveBlob } from '@cirrus/store';
import { writeJsonAtomic } from '../jsonFile.ts';
import { parseSettingRows, SharedSettings } from '../settings.ts';
import type { SecretStore, ServerConfig } from './config.ts';
import { messageOf } from './connection.ts';
import { chunks, hasBlob, isPdf } from './downloads.ts';
import { READY_FILE, requests, stagedDir } from './firstSync.ts';

// An adopt (plan 5a, task 5, D7, R17): the server's base taken, staged beside this PC's (`<base>-nouvelle`), complete
// once its mark is written, last; swap.ts swaps it in at the next start.

/**
 * A line of the server's journal, as the adopting PC keeps it (parseChangeRow): numbered by the server as its own
 * (R6), this PC's own lines local, the other PCs' remote, an inverse an inverse. Every line taken is covered by the
 * server's snapshot: history (R32) — its shape checked, not today's content bounds (a line a seeding PC's older app
 * wrote, which the server took as history), so that the numbering is the server's, whole.
 */
function adoptedRow(x: unknown, expected: number, pc: string): ChangeRow {
  let r: ChangeRow;
  try {
    r = parseChangeRow(x, expected, true);
  } catch (e) {
    if (e instanceof SyncFormatError) throw new Error(`Ligne ${expected} du journal du serveur : ${e.message}`);
    throw e;
  }
  if (r.serverSeq !== expected) throw new Error(`Ligne ${expected} du journal du serveur : son numéro au serveur n’est pas le sien.`);
  return { ...r, kind: r.kind === 'rewind' ? 'rewind' : r.pc === pc ? 'local' : 'remote' };
}

/** The files a base keeps at once (D6): those of its nodes now, those in the trash included, but the PDFs. */
function currentFiles(s: State): Set<string> {
  const out = new Set<string>();
  for (const n of s.nodes.values()) for (const f of n.files) if (!isPdf(f.name)) out.add(f.hash);
  return out;
}

/** `from`'s blob as `to`'s too: linked (blobs never change), else copied. */
function shareBlob(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * What an adopt needs: the network, this base's folder, this PC's identifier (the token's, R17), the server paired and
 * the identity of its base (its /hello's, R31), the configuration file of the staged base (its token encrypted as the
 * app keeps it), the abort of the app's quit, the requests' delay (syncRequestTimeoutMs, plan 9).
 */
interface AdoptDeps { fetch: typeof fetch; dir: string; pc: string; config: ServerConfig; baseId: string; secrets: SecretStore; signal: AbortSignal; timeoutMs: number }

/**
 * Takes the server's base (D7, R17), staged in `<base>-nouvelle` beside this one, which nothing here touches: its
 * snapshot (GET /snapshot, MAX_SEED_BYTES at most) and the line it covers; its journal up to that line, by pages
 * (MAX_JOURNAL_PAGE), each line checked as history (R32); its state written whole, with the identity of the server's
 * base (R31); then the files of its nodes but the PDFs — this base's own copy when it has one, downloaded and checked
 * otherwise (one the server lacks too is left: opened later, it says so) —; the server's settings (R23: this PC's are
 * not kept, nor sent), this PC's identifier, the server and its token. Its mark last: complete. Any failure removes the
 * staged base and throws, in French.
 */
export async function adoptBase(o: AdoptDeps): Promise<{ last: number }> {
  const staged = stagedDir(o.dir);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  try {
    // The snapshot, the journal's pages and the files are transfers (plan 9, D7): given up when idle, never for their length.
    const { send, json } = requests(o.fetch, o.config, o.signal, o.timeoutMs);
    const snap = await send('/snapshot', {}, { transfer: true });
    const last = Number(snap.headers.get('cirrus-seq') ?? Number.NaN), size = Number(snap.headers.get('content-length') ?? Number.NaN);
    if (!Number.isSafeInteger(last) || last < 0 || !Number.isSafeInteger(size) || size > MAX_SEED_BYTES) {
      await snap.body?.cancel();
      throw new Error('Réponse du serveur illisible à /snapshot : mets à jour Cirrus, ou le serveur.');
    }
    // Read first: the network failing says so, not the snapshot.
    const data = await snap.arrayBuffer();
    let state: State;
    try {
      state = decodeState(data);
    } catch (e) {
      throw new Error(`Instantané du serveur illisible : ${messageOf(e)}`);
    }
    const store = LocalStore.open(staged, { pc: o.pc });
    try {
      for (let after = 0; after < last; ) {
        const page = ((await json(`/journal?after=${after}&limit=${Math.min(MAX_JOURNAL_PAGE, last - after)}`, undefined, { transfer: true })) as { rows?: unknown } | null)?.rows;
        if (!Array.isArray(page)) throw new Error('Réponse du serveur illisible à /journal : mets à jour Cirrus, ou le serveur.');
        if (page.length === 0) throw new Error(`Le journal du serveur s’arrête à la ligne ${after}, avant la ${last}.`);
        const rows = page.slice(0, last - after).map((x, i) => adoptedRow(x, after + i + 1, o.pc));
        store.importJournal(rows);
        after = rows.at(-1)!.localSeq;
      }
      store.importState(state, last);
      // The base it follows (R31): pairing this PC again with this server picks up where it stopped.
      store.setBaseId(o.baseId);
    } finally {
      store.close();
    }
    for (const hash of currentFiles(state)) {
      const to = filePath(staged, { name: '', hash, size: 0 });
      if (hasBlob(o.dir, hash)) {
        shareBlob(filePath(o.dir, { name: '', hash, size: 0 }), to);
        continue;
      }
      const res = await send(`/files/${hash}`, {}, { answered: [404], transfer: true });
      // Absent from the server too: the node says so when the file is opened.
      if (res.status === 404) {
        await res.body?.cancel();
        continue;
      }
      const length = Number(res.headers.get('content-length') ?? Number.NaN);
      if (!res.body || !Number.isSafeInteger(length) || length < 0) throw new Error(`Réponse du serveur illisible à /files/${hash}.`);
      await receiveBlob(staged, hash, chunks(res.body), length);
    }
    // The server's settings, not this PC's (task 6, R23): bounded as the app reads them, and nothing of this PC's sent.
    new SharedSettings(staged, o.pc, () => {}).adopt(parseSettingRows(await json('/settings')));
    // On the disk before the mark (review, Minor 1): a power cut never leaves a complete base without its PC or its
    // server. The mark itself synced, after everything else is there.
    writeJsonAtomic(join(staged, 'pc.json'), { id: o.pc }, { sync: true });
    o.secrets.write(o.config);
    writeJsonAtomic(join(staged, READY_FILE), { server: o.config.url, seq: last }, { sync: true });
    return { last };
  } catch (e) {
    rmSync(staged, { recursive: true, force: true });
    throw e;
  }
}
