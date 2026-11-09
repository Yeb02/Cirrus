import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FileRef, Op, Unit } from '@cirrus/core';
import { BlobError, filePath, receiveBlob } from '@cirrus/store';
import { writeJsonAtomic } from '../jsonFile.ts';
import { messageOf } from './connection.ts';

// The files of the synchronisation (plan 5a, D6): those a write adds go to the server before it; those of the records
// received come down at once, in the background, a few at a time — but the PDFs, fetched at their first reading
// (SyncClient.fetchBlob). Each is checked against its hash before the store keeps it (receiveBlob).

/** A PDF, by its name's extension, whatever its case (the controller's ruling): downloaded on demand only. */
export const isPdf = (name: string): boolean => /\.pdf$/i.test(name);

/** Whether the store holds the blob of `hash`. */
export const hasBlob = (storeDir: string, hash: string): boolean => existsSync(filePath(storeDir, { name: '', hash, size: 0 }));

/**
 * The files a node operation adds — in its "after", not (by hash) in its "before" — and its anchor's PDF when that is
 * new: as the server reads it (Canon.missingFile), what it must hold before it takes the write.
 */
function added(op: Op): { files: FileRef[]; anchor: string | null } {
  if (op.t !== 'node' || !op.after) return { files: [], anchor: null };
  const had = new Set(op.before?.files.map((f) => f.hash));
  if (op.before?.anchor) had.add(op.before.anchor.hash);
  const anchor = op.after.anchor && !had.has(op.after.anchor.hash) ? op.after.anchor.hash : null;
  return { files: op.after.files.filter((f) => !had.has(f.hash)), anchor };
}

/** The hashes the writes add to nodes, each once, in order: to send to the server before the writes (D6). */
export function filesToSend(units: readonly Unit[]): string[] {
  const out = new Set<string>();
  for (const u of units) {
    for (const op of u.ops) {
      const { files, anchor } = added(op);
      for (const f of files) out.add(f.hash);
      if (anchor) out.add(anchor);
    }
  }
  return [...out];
}

/** The hashes the received writes add to nodes, each once, but the PDFs': to download now (D6). */
export function filesToFetch(units: readonly Unit[]): string[] {
  const out = new Set<string>();
  for (const u of units) for (const op of u.ops) for (const f of added(op).files) if (!isPdf(f.name)) out.add(f.hash);
  return [...out];
}

/** A response's body, chunk by chunk; cancelled when its reader stops early (too many bytes, the wrong hash). */
export async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** GET /files/<hash> on the paired server, with its token; null without a server. */
type BlobRequest = (hash: string, signal: AbortSignal) => Promise<Response> | null;

/** A hash as the store names its blobs: 64 lower-case hexadecimal digits. */
export const isHash = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/**
 * The code of the error a download asked for now (Downloads.fetch) rejects with when this PC could not keep the bytes it
 * received — a disk full, a folder it may not write (final review, Minor 4): not the server out of reach, which is a
 * plain `false`. cirrus-file: answers it 507, and the system's opening says it (files.ts).
 */
export const NOT_STORED = 'CIRRUS_NOT_STORED';

/** A download's end: the blob is there; it could not be had (the network, the server); or this PC could not keep it. */
type Outcome = 'done' | 'failed' | 'not-stored';

/** A failure of the network while the bytes were read: told apart from one of the disk while they were written. */
class NetworkFailure extends Error {}

/** A response's bytes, a failure to read them marked as the network's (NetworkFailure). */
async function* fromNetwork(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    yield* source;
  } catch (e) {
    throw new NetworkFailure(messageOf(e), { cause: e });
  }
}

/**
 * The eager downloads still to do — queued, under way, broken by the network — kept beside the base (R9): a stop
 * (sleep) or a quit loses none. `{ hashes: [...] }`; read back by the next Downloads on the same base.
 */
export const DOWNLOADS_FILE = 'downloads.json';

/**
 * The downloads: those wanted (the files of received records) queued, `limit()` of them at once; one asked for now
 * (fetch: a PDF opened, a file absent) starts at once, outside the limit, or joins the same one under way. An eager
 * download the network broke, or that a stop interrupted, is tried again at the next connection (retry), after a
 * restart too (DOWNLOADS_FILE); one the server does not have, or whose bytes are not those of their hash, is not.
 */
export class Downloads {
  private readonly storeDir: string;
  private readonly request: BlobRequest;
  private readonly limit: () => number;
  private readonly file: string;
  /** The queued hashes, in order (a Set: queued once, taken from the front). */
  private readonly queue = new Set<string>();
  private readonly running = new Map<string, Promise<Outcome>>();
  /** The eager downloads under way (the others were asked for: fetch). */
  private readonly eager = new Set<string>();
  /** The eager downloads to try again at the next connection. */
  private readonly failed = new Set<string>();
  private abort = new AbortController();
  /** Whether DOWNLOADS_FILE may hold hashes: found at the start, or written since it was last removed. */
  private saved = false;

  constructor(storeDir: string, request: BlobRequest, limit: () => number) {
    this.storeDir = storeDir;
    this.request = request;
    this.limit = limit;
    this.file = join(storeDir, DOWNLOADS_FILE);
    for (const h of this.load()) this.failed.add(h);
  }

  /** Queues the blobs of `hashes` that the store does not hold; the list beside the base written when that adds any. */
  want(hashes: Iterable<string>): void {
    let added = false;
    for (const h of hashes) {
      if (this.queue.has(h) || this.running.has(h) || hasBlob(this.storeDir, h)) continue;
      this.queue.add(h);
      added = true;
    }
    if (added) this.save();
    this.pump();
  }

  /**
   * The blob of `hash` in the store now: true once it is there, checked; false when it could not be had (the network,
   * the server, bytes that are not its hash's). Rejects, its code NOT_STORED, when this PC could not keep the bytes it
   * received (final review, Minor 4).
   */
  fetch(hash: string): Promise<boolean> {
    if (hasBlob(this.storeDir, hash)) return Promise.resolve(true);
    // Queued, it stays an eager download (tried again if it breaks), started now, outside the limit.
    return (this.running.get(hash) ?? this.start(hash, this.queue.delete(hash))).then((o) => {
      if (o === 'not-stored') throw Object.assign(new Error('fichier reçu du serveur, mais non enregistré sur ce PC'), { code: NOT_STORED });
      return o === 'done';
    });
  }

  /** The eager downloads broken, interrupted or left at the last quit, queued again (a connection is back). */
  retry(): void {
    const hashes = [...this.failed];
    this.failed.clear();
    this.want(hashes);
    this.tidy();
  }

  /**
   * Every download stopped and awaited. The eager ones queued or interrupted are not dropped: kept for the next
   * connection, and in the list beside the base for the next start (R9).
   */
  async stop(): Promise<void> {
    this.abort.abort();
    for (const h of [...this.queue, ...this.eager]) this.failed.add(h);
    this.queue.clear();
    await Promise.allSettled([...this.running.values()]);
    // One that ended before its abort is there: done.
    for (const h of this.failed) if (hasBlob(this.storeDir, h)) this.failed.delete(h);
    this.save();
    this.abort = new AbortController();
  }

  private pump(): void {
    while (this.eager.size < Math.max(1, this.limit())) {
      const next = this.queue.values().next();
      if (next.done) return;
      this.queue.delete(next.value);
      if (!this.running.has(next.value) && !hasBlob(this.storeDir, next.value)) void this.start(next.value, true);
    }
  }

  private start(hash: string, eager: boolean): Promise<Outcome> {
    if (eager) this.eager.add(hash);
    const p = this.download(hash, eager).finally(() => {
      this.running.delete(hash);
      if (eager) {
        this.eager.delete(hash);
        this.pump();
        this.tidy();
      }
    });
    this.running.set(hash, p);
    return p;
  }

  /**
   * One download: the request, then the bytes kept (receiveBlob). Never rejects: its outcome. A failure of the network,
   * or a server's own (5xx), is tried again at the next connection when eager; bytes that are not their hash's are said,
   * and not tried again; a failure of this PC's disk while they were written (full, a folder it may not write: final
   * review, Minor 4) is said with its cause, and tried again when eager — the disk may have room by then.
   */
  private async download(hash: string, eager: boolean): Promise<Outcome> {
    const signal = this.abort.signal;
    let res: Response | null;
    try {
      res = await this.request(hash, signal);
    } catch {
      if (!signal.aborted && eager) this.failed.add(hash);
      return 'failed';
    }
    if (!res) return 'failed';
    const length = res.headers.get('content-length'), size = length === null ? Number.NaN : Number(length);
    if (res.status !== 200 || !res.body || !Number.isSafeInteger(size) || size < 0) {
      await res.body?.cancel().catch(() => {});
      // Absent from the server (404), or a server that refuses (a token, a format): not tried again; its own failure is.
      if (res.status >= 500 && eager) this.failed.add(hash);
      return 'failed';
    }
    try {
      // The bytes announced at most, checked against the hash before anything is kept.
      await receiveBlob(this.storeDir, hash, fromNetwork(chunks(res.body)), size);
      return 'done';
    } catch (e) {
      if (e instanceof BlobError) {
        console.warn(`Fichier ${hash} reçu du serveur refusé : ${e.message}`);
        return 'failed';
      }
      if (signal.aborted || e instanceof NetworkFailure) {
        if (!signal.aborted && eager) this.failed.add(hash);
        return 'failed';
      }
      console.warn(`Fichier ${hash} reçu du serveur, mais non enregistré dans la base : ${messageOf(e)}`);
      if (eager) this.failed.add(hash);
      return 'not-stored';
    }
  }

  /** The list left by the last run on this base (none: empty); an unreadable one is reported and ignored. */
  private load(): string[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    this.saved = true;
    try {
      const hashes = (JSON.parse(text) as { hashes?: unknown }).hashes;
      if (Array.isArray(hashes)) return hashes.filter(isHash);
    } catch {
      // reported below
    }
    console.warn(`Liste des téléchargements illisible (${DOWNLOADS_FILE}) : ignorée.`);
    return [];
  }

  /**
   * Writes the eager downloads still to do beside the base (writeJsonAtomic: a crash never leaves half a file), or
   * removes the list when there are none. Costs what is pending. The list may name a file done since: the next want
   * skips it (in the store already). Not synced to the disk (short review after plan 5a, D4): it is rewritten at each
   * batch received that brings files, and a power cut that loses it only leaves its files to come at their first
   * opening (R9), the server holding them all.
   */
  private save(): void {
    const hashes = [...new Set([...this.queue, ...this.eager, ...this.failed])];
    try {
      if (hashes.length > 0) {
        writeJsonAtomic(this.file, { hashes }, { sync: false });
      } else if (this.saved) {
        rmSync(this.file, { force: true });
      }
      this.saved = hashes.length > 0;
    } catch (e) {
      console.warn(`Liste des téléchargements non enregistrée (${DOWNLOADS_FILE}) : ${messageOf(e)}`);
    }
  }

  /** The list removed once no eager download remains. */
  private tidy(): void {
    if (this.saved && this.queue.size === 0 && this.eager.size === 0 && this.failed.size === 0) this.save();
  }
}
