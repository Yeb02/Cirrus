import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openAsBlob, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  decodeState, encodeState, MAX_BODY_BYTES, MAX_HASHES_PER_REQUEST, MAX_JOURNAL_PAGE, MAX_SEED_BYTES, SNAPSHOT_VERSION, type State, SyncFormatError,
} from '@cirrus/core';
import { type ChangeRow, filePath, LocalStore, parseChangeRow, receiveBlob, storedHashes } from '@cirrus/store';
import { SERVER_FILE, type SecretStore, type ServerConfig } from './config.ts';
import { chunks, DOWNLOADS_FILE, hasBlob, isPdf } from './downloads.ts';

// The first pairing of a base (plan 5a, task 5, D7): what the PC and the server hold decides it — both empty, the sync
// starts; a full PC and an empty server, the PC sends its base (seed); an empty PC and a server holding one, the PC
// takes the server's (adopt); both full, refused, the replacement of the PC's base proposed (adopt too, its own kept).
// A base taken is staged beside the PC's (`<base>-nouvelle`), complete once its mark is written, last; the app then
// starts again, and the next start swaps it in before the base opens, the old one kept as
// `<base>-avant-jumelage-AAAA-MM-JJ` (R17). Nothing here depends on Electron: the network is given.

/**
 * D7's question to the user, after /pair and /hello:
 * - seed: this PC's base to the server, which holds none (its nodes and its store's files);
 * - adopt: the server's base on this PC, which holds none (the server's nodes), its own kept as `archive`;
 * - replace: both hold one, which Cirrus does not merge — refused, but the server's may replace this PC's (`local`
 *   nodes), kept as `archive`.
 */
export type FirstSyncOffer =
  | { kind: 'seed'; nodes: number; files: number }
  | { kind: 'adopt'; nodes: number; archive: string }
  | { kind: 'replace'; nodes: number; local: number; archive: string };

/** What /hello says of the server's base: its last number, whether it is empty (D7), its nodes. */
export interface ServerBase { lastSeq: number; empty: boolean; nodes: number }

/** Where a base taken from the server is staged: beside the base, `<base>-nouvelle`. */
export const stagedDir = (dir: string): string => `${resolve(dir)}-nouvelle`;

/** A staged base's mark, written last: without it, the staged base is incomplete. */
export const READY_FILE = 'complete.json';

/** The name the base's folder takes once a base taken from the server replaces it, on `day` (local time). */
export function archiveName(dir: string, day: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${basename(resolve(dir))}-avant-jumelage-${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

/**
 * D7's offer for this base and the server's (null: both empty, the sync starts as it is). This base is empty when it
 * holds nothing (isEmpty) and never received anything from a server: one that did has lines another server numbered.
 * The server holds no base when it accepted no write and its state is empty: a server holding only another PC's lobby
 * holds one (R7: an empty PC takes it, rather than bring a second lobby). Counts the nodes and the store's files: a
 * pairing's cost, never paid otherwise.
 */
export function firstSyncOffer(store: LocalStore, dir: string, server: ServerBase, day: Date): FirstSyncOffer | null {
  const empty = store.isEmpty() && store.lastServerSeq() === 0;
  if (server.lastSeq === 0 && server.empty) return empty ? null : { kind: 'seed', nodes: store.nodeCount(), files: storedHashes(dir).length };
  const archive = archiveName(dir, day);
  return empty ? { kind: 'adopt', nodes: server.nodes, archive } : { kind: 'replace', nodes: server.nodes, local: store.nodeCount(), archive };
}

/** The offer's explanation, in French (the block « Serveur » adds its buttons). */
export function offerMessage(o: FirstSyncOffer): string {
  switch (o.kind) {
    case 'seed': return 'Le serveur ne tient encore aucune base : ce PC peut lui envoyer la sienne, avec son historique et ses fichiers.';
    case 'adopt': return 'Le serveur tient déjà une base : ce PC peut la prendre. Cirrus redémarre alors sur elle ; la base actuelle de ce PC est gardée à part.';
    case 'replace': return 'Ce PC et le serveur tiennent chacun une base : Cirrus ne fusionne pas deux bases, le jumelage est refusé. Seule la base du serveur peut remplacer celle de ce PC, qui est alors gardée à part.';
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A reason as a sentence of a message: its full stop. */
export const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * The server's requests for one first sync: its token on each, one abort for all; a refused one throws its reason, but
 * the statuses `answered` lets through.
 */
function requests(fetchFn: typeof fetch, config: ServerConfig, signal: AbortSignal) {
  const send = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}, answered: number[] = []): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchFn(config.url + path, { ...init, headers: { Authorization: `Bearer ${config.token}`, ...init.headers }, signal });
    } catch (e) {
      if (signal.aborted) throw new Error('Cirrus se ferme.');
      throw new Error(`Serveur injoignable (${config.url}) : ${sentence(messageOf(e))}`);
    }
    if (res.ok || answered.includes(res.status)) return res;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `Réponse ${res.status} du serveur à ${path}.`);
  };
  const json = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await send(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return res.json();
  };
  return { send, json };
}

/** R15: this PC's token revoked by itself (POST /unpair), within `ms`; at best — a server gone keeps it until `revoquer`. */
export async function revokeSelf(fetchFn: typeof fetch, config: ServerConfig, ms: number): Promise<boolean> {
  try {
    const res = await fetchFn(`${config.url}/unpair`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(ms) });
    await res.body?.cancel();
    return res.ok;
  } catch (e) {
    console.warn(`Jeton de ce PC non révoqué au serveur (${config.url}) : ${messageOf(e)}`);
    return false;
  }
}

/**
 * What a seed sends of the base, read in one go (nothing is written in between): its stored snapshot, when it is of
 * this format, and the journal line it covers — the server replays the lines after it —, or else the state of its
 * tables, covering the whole journal; and the journal's last line now. A write made later stays pending.
 */
function capture(store: LocalStore): { data: ArrayBuffer; seq: number; last: number } {
  const last = store.lastSeq(), snap = store.readSnapshot();
  if (snap && snap.version === SNAPSHOT_VERSION && snap.seq <= last) return { data: snap.data, seq: snap.seq, last };
  return { data: encodeState(store.loadState()), seq: last, last };
}

/** What a seed needs: the network, this PC's base and its folder, the server paired (its token), the abort of the app's quit. */
export interface SeedDeps { fetch: typeof fetch; store: LocalStore; dir: string; config: ServerConfig; signal: AbortSignal }

/**
 * Sends this PC's base to the server, which holds none (D7, R16), in the brief's order: every blob of its store (old
 * versions too) the server lacks; its snapshot (POST /seed, MAX_SEED_BYTES at most), which makes this PC the seed's
 * owner; its journal up to the snapshot's capture, by pages of MAX_JOURNAL_PAGE lines and MAX_BODY_BYTES at most; then
 * done, which makes the server not empty. Then this PC's lines up to there take their numbers (the server's are its
 * journal numbers): none is pending, and its stream resumes after them. Writes made meanwhile stay pending, sent
 * once the sync starts. Throws, in French: nothing written here then, the base as it was. Returns its last line sent.
 */
export async function seedBase(o: SeedDeps): Promise<number> {
  const { send, json } = requests(o.fetch, o.config, o.signal);
  const hashes = storedHashes(o.dir);
  for (let i = 0; i < hashes.length; i += MAX_HASHES_PER_REQUEST) {
    const chunk = hashes.slice(i, i + MAX_HASHES_PER_REQUEST);
    const missing = ((await json('/files/missing', { hashes: chunk })) as { missing?: unknown } | null)?.missing;
    if (!Array.isArray(missing)) throw new Error('Réponse du serveur illisible à /files/missing : mets à jour Cirrus, ou le serveur.');
    const wanted = new Set(chunk);
    for (const hash of missing) {
      if (typeof hash !== 'string' || !wanted.has(hash)) continue;
      const file = await openAsBlob(filePath(o.dir, { name: '', hash, size: 0 }));
      const res = await send(`/files/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file as unknown as Blob });
      await res.body?.cancel();
    }
  }
  const { data, seq, last } = capture(o.store);
  if (data.byteLength > MAX_SEED_BYTES) throw new Error(`La base de ce PC est trop grosse pour le serveur : son instantané fait ${data.byteLength} octets, ${MAX_SEED_BYTES} au plus.`);
  const sent = await send('/seed', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Cirrus-Seq': String(seq) }, body: new Uint8Array(data) });
  await sent.body?.cancel();
  for (let after = 0; after < last; ) {
    const rows = o.store.changesSince(after, Math.min(MAX_JOURNAL_PAGE, last - after));
    if (rows.length === 0) throw new Error(`Le journal de ce PC s’arrête à la ligne ${after}, avant la ${last}.`);
    let n = rows.length, body = JSON.stringify({ rows });
    // A page within the body's bound: halved until it fits.
    while (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      if (n === 1) throw new Error(`La ligne ${rows[0].localSeq} du journal de ce PC est trop grosse pour le serveur : ${MAX_BODY_BYTES} octets au plus.`);
      n = Math.ceil(n / 2);
      body = JSON.stringify({ rows: rows.slice(0, n) });
    }
    await json('/seed/journal', body);
    after = rows[n - 1].localSeq;
  }
  const done = (await json('/seed/done', { last })) as { lastSeq?: unknown } | null;
  if (done?.lastSeq !== last) throw new Error('Réponse du serveur illisible à /seed/done : mets à jour Cirrus, ou le serveur.');
  o.store.numberSeeded(last);
  return last;
}

/**
 * A line of the server's journal, as the adopting PC keeps it (parseChangeRow): numbered by the server as its own
 * (R6), this PC's own lines local, the other PCs' remote, an inverse an inverse.
 */
function adoptedRow(x: unknown, expected: number, pc: string): ChangeRow {
  let r: ChangeRow;
  try {
    r = parseChangeRow(x, expected);
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

/** A small file written and synced to the disk: the staged base's mark, after everything else is there. */
function writeSynced(file: string, text: string): void {
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * What an adopt needs: the network, this base's folder, this PC's identifier (the token's, R17), the server paired, the
 * configuration file of the staged base (its token encrypted as the app keeps it), the abort of the app's quit.
 */
export interface AdoptDeps { fetch: typeof fetch; dir: string; pc: string; config: ServerConfig; secrets: SecretStore; signal: AbortSignal }

/**
 * Takes the server's base (D7, R17), staged in `<base>-nouvelle` beside this one, which nothing here touches: its
 * snapshot (GET /snapshot, MAX_SEED_BYTES at most) and the line it covers; its journal up to that line, by pages
 * (MAX_JOURNAL_PAGE), each line checked; its state written whole; then the files of its nodes but the PDFs — this
 * base's own copy when it has one, downloaded and checked otherwise (one the server lacks too is left: opened later,
 * it says so) —; this PC's identifier, its settings, the server and its token. Its mark last: complete. Any failure
 * removes the staged base and throws, in French.
 */
export async function adoptBase(o: AdoptDeps): Promise<{ last: number }> {
  const staged = stagedDir(o.dir);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  try {
    const { send, json } = requests(o.fetch, o.config, o.signal);
    const snap = await send('/snapshot');
    const last = Number(snap.headers.get('cirrus-seq') ?? Number.NaN), size = Number(snap.headers.get('content-length') ?? Number.NaN);
    if (!Number.isSafeInteger(last) || last < 0 || !Number.isSafeInteger(size) || size > MAX_SEED_BYTES) {
      await snap.body?.cancel();
      throw new Error('Réponse du serveur illisible à /snapshot : mets à jour Cirrus, ou le serveur.');
    }
    let state: State;
    try {
      state = decodeState(await snap.arrayBuffer());
    } catch (e) {
      throw new Error(`Instantané du serveur illisible : ${messageOf(e)}`);
    }
    const store = LocalStore.open(staged, { pc: o.pc });
    try {
      for (let after = 0; after < last; ) {
        const page = ((await json(`/journal?after=${after}&limit=${Math.min(MAX_JOURNAL_PAGE, last - after)}`)) as { rows?: unknown } | null)?.rows;
        if (!Array.isArray(page)) throw new Error('Réponse du serveur illisible à /journal : mets à jour Cirrus, ou le serveur.');
        if (page.length === 0) throw new Error(`Le journal du serveur s’arrête à la ligne ${after}, avant la ${last}.`);
        const rows = page.slice(0, last - after).map((x, i) => adoptedRow(x, after + i + 1, o.pc));
        store.importJournal(rows);
        after = rows.at(-1)!.localSeq;
      }
      store.importState(state, last);
    } finally {
      store.close();
    }
    for (const hash of currentFiles(state)) {
      const to = filePath(staged, { name: '', hash, size: 0 });
      if (hasBlob(o.dir, hash)) {
        shareBlob(filePath(o.dir, { name: '', hash, size: 0 }), to);
        continue;
      }
      const res = await send(`/files/${hash}`, {}, [404]);
      // Absent from the server too: the node says so when the file is opened.
      if (res.status === 404) {
        await res.body?.cancel();
        continue;
      }
      const length = Number(res.headers.get('content-length') ?? Number.NaN);
      if (!res.body || !Number.isSafeInteger(length) || length < 0) throw new Error(`Réponse du serveur illisible à /files/${hash}.`);
      await receiveBlob(staged, hash, chunks(res.body), length);
    }
    writeFileSync(join(staged, 'pc.json'), JSON.stringify({ id: o.pc }), 'utf8');
    if (existsSync(join(o.dir, 'settings.json'))) copyFileSync(join(o.dir, 'settings.json'), join(staged, 'settings.json'));
    o.secrets.write(o.config);
    writeSynced(join(staged, READY_FILE), JSON.stringify({ server: o.config.url, seq: last }));
    return { last };
  } catch (e) {
    rmSync(staged, { recursive: true, force: true });
    throw e;
  }
}

/** The errors of a folder another program holds a moment (the antivirus scanning it): its rename is tried again. */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** A folder's renames at most at the swap, and the pause before the next one, times the attempt (fixed bounds, as the store's). */
const SWAP_TRIES = 5;
const SWAP_PAUSE_MS = 100;

function rename(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= SWAP_TRIES || !HELD.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SWAP_PAUSE_MS * attempt);
    }
  }
}

/** `path`, or `path (2)`, `path (3)`… : the first not taken. */
function freeName(path: string): string {
  if (!existsSync(path)) return path;
  for (let i = 2; ; i++) if (!existsSync(`${path} (${i})`)) return `${path} (${i})`;
}

/**
 * At the start, before the base opens and nothing holds its folder (R17): a base taken from the server and staged by
 * the last run replaces it — the old one renamed `<base>-avant-jumelage-AAAA-MM-JJ` (« (2) », … when that name is
 * taken), without a list of downloads to do nor a server; one that is not complete (no mark: an interrupted adopt) is
 * removed. Costs one stat when there is none. A folder that holds no base (an interruption between the two renames)
 * is not archived.
 */
export function swapStaged(dir: string, day = new Date()): 'none' | 'dropped' | 'swapped' {
  const staged = stagedDir(dir);
  if (!existsSync(staged)) return 'none';
  if (!existsSync(join(staged, READY_FILE))) {
    rmSync(staged, { recursive: true, force: true });
    return 'dropped';
  }
  let archive: string | null = null;
  if (existsSync(join(dir, 'cirrus.db'))) {
    archive = freeName(join(dirname(resolve(dir)), archiveName(dir, day)));
    rename(dir, archive);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    rename(staged, dir);
  } catch (e) {
    // The old base put back: it opens, and the staged one waits for the next start.
    if (archive) renameSync(archive, dir);
    throw e;
  }
  if (archive) for (const f of [DOWNLOADS_FILE, SERVER_FILE]) rmSync(join(archive, f), { force: true });
  rmSync(join(dir, READY_FILE), { force: true });
  return 'swapped';
}
