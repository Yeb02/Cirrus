import { existsSync, readFileSync, rmSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { type FileRef, isObject, type Op, type Unit } from '@cirrus/core';
import { BlobError, filePath, receiveBlob } from '@cirrus/store';
import { writeJsonAtomic } from '../jsonFile.ts';
import { messageOf } from './connection.ts';
import type { DownloadAllProgress } from './protocol.ts';

// The files of the synchronisation (plan 5a, D6): those a write adds go to the server before it; those of the records
// received come down at once, in the background, a few at a time — but the PDFs, fetched at their first reading
// (SyncClient.fetchBlob). Each is checked against its hash before the store keeps it (receiveBlob). « Tout
// télécharger » (plan 5b, D8: DownloadAll) brings every PDF of the base by the same queue; the transfers' throughput is
// measured here and by uploads.ts (TransferRates).

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

/**
 * A download's end: the blob is there; it could not be had (absent from the server, refused by it, its own failure,
 * bytes that are not their hash's); the network broke, the server out of reach (`lost`); this PC could not keep it; or
 * it was aborted (a stop, « Arrêter »).
 */
export type Outcome = 'done' | 'failed' | 'lost' | 'not-stored' | 'aborted';

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

// The server's state (plan 5b, D8): the medians of what the main process measures.

/** How many measures a median is taken of (D8): the latency's round trips, the throughput's transfers. */
export const MEDIAN_OF = 5;

/** The smallest transfer the throughput counts (D8): a smaller one measures the round trip more than the bytes. */
export const THROUGHPUT_MIN_BYTES = 2 ** 20;

/** The median of `xs`: the one in the middle, or the mean of the two in the middle; null without any. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b), m = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** The last MEDIAN_OF measures, the oldest dropped first. */
export class LastMeasures {
  private readonly xs: number[] = [];

  add(x: number): void {
    this.xs.push(x);
    if (this.xs.length > MEDIAN_OF) this.xs.shift();
  }

  median(): number | null {
    return median(this.xs);
  }
}

/**
 * The throughput (D8): the rates of the last transfers of files of THROUGHPUT_MIN_BYTES at least, either way — the
 * downloads (Downloads), the files sent (uploads.ts) —, each from its request to its last byte kept, on `clock` (ms,
 * monotonic). No transfer is made to measure it: those of the synchronisation only.
 */
export class TransferRates {
  readonly clock: () => number;
  private readonly rates = new LastMeasures();

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** A transfer of `bytes`, begun at `since` (clock), ended now: counted if large enough. */
  measured(bytes: number, since: number): void {
    const ms = this.clock() - since;
    if (bytes >= THROUGHPUT_MIN_BYTES && ms > 0) this.rates.add(bytes / (ms / 1000));
  }

  /** Bytes per second; null before any transfer counted. */
  median(): number | null {
    return this.rates.median();
  }
}

/** The free space of the disk that holds `dir`, for this user (bytes): « Tout télécharger » compares its bytes to it (D8). */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * The files `refs` names — the interface's references (D8: referencedPdfs), checked here: a name, a hash, a size — that
 * the store lacks, each hash once, with the size its first reference gives. Anything else is left out.
 */
export function missingFiles(storeDir: string, refs: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(refs)) return out;
  for (const r of refs as unknown[]) {
    if (!isObject(r) || typeof r.name !== 'string' || !isHash(r.hash) || !Number.isSafeInteger(r.size) || (r.size as number) < 0) continue;
    if (!out.has(r.hash) && !hasBlob(storeDir, r.hash)) out.set(r.hash, r.size as number);
  }
  return out;
}

/**
 * The eager downloads still to do — queued, under way, broken by the network — kept beside the base (R9): a stop
 * (sleep) or a quit loses none. `{ hashes: [...] }`; read back by the next Downloads on the same base. Those of « Tout
 * télécharger » are never in it (D8: not resumed).
 */
export const DOWNLOADS_FILE = 'downloads.json';

/**
 * The downloads: those wanted (the files of received records) queued, `limit()` of them at once; one asked for now
 * (fetch: a PDF opened, a file absent) starts at once, outside the limit, or joins the same one under way. An eager
 * download the network broke, or that a stop interrupted, is tried again at the next connection (retry), after a
 * restart too (DOWNLOADS_FILE); one the server does not have, or whose bytes are not those of their hash, is not.
 * « Tout télécharger » (plan 5b, D8: wantOnce) queues its own with them, neither kept nor tried again. Each download's
 * end is told (onSettled), and each one of THROUGHPUT_MIN_BYTES at least measured (`rates`).
 */
export class Downloads {
  private readonly storeDir: string;
  private readonly request: BlobRequest;
  private readonly limit: () => number;
  private readonly file: string;
  private readonly rates: TransferRates;
  /** The queued hashes, in order (a Set: queued once, taken from the front). */
  private readonly queue = new Set<string>();
  private readonly running = new Map<string, Promise<Outcome>>();
  /** The eager downloads under way (the others were asked for: fetch); those of « Tout télécharger » among them. */
  private readonly eager = new Set<string>();
  /** The eager downloads to try again at the next connection. */
  private readonly failed = new Set<string>();
  /**
   * The downloads of « Tout télécharger » (D8) queued or under way, each with its own abort (dropOnce): neither written
   * beside the base nor tried again. One asked for meanwhile (fetch), or wanted as a file received (want), leaves it.
   */
  private readonly once = new Map<string, AbortController>();
  private abort = new AbortController();
  /** Whether DOWNLOADS_FILE may hold hashes: found at the start, or written since it was last removed. */
  private saved = false;
  /** Told the end of each download, of any kind, and each blob found there already when queued (DownloadAll). */
  onSettled: ((hash: string, outcome: Outcome) => void) | null = null;

  constructor(storeDir: string, request: BlobRequest, limit: () => number, rates = new TransferRates(() => performance.now())) {
    this.storeDir = storeDir;
    this.request = request;
    this.limit = limit;
    this.rates = rates;
    this.file = join(storeDir, DOWNLOADS_FILE);
    for (const h of this.load()) this.failed.add(h);
  }

  /** Queues the blobs of `hashes` that the store does not hold; the list beside the base written when that adds any. */
  want(hashes: Iterable<string>): void {
    let added = false;
    for (const h of hashes) {
      // One of « Tout télécharger », wanted now as a file received: kept, and tried again if broken.
      if (this.once.delete(h)) {
        added = true;
        continue;
      }
      if (this.queue.has(h) || this.running.has(h) || hasBlob(this.storeDir, h)) continue;
      this.queue.add(h);
      added = true;
    }
    if (added) this.save();
    this.pump();
  }

  /**
   * « Tout télécharger » (D8): the blobs of `hashes` queued as want queues them — `limit()` at once with the others,
   * each checked —, but never written beside the base nor tried again. One queued or under way already stays as it is,
   * its end told as any; one the store holds already is told done at once.
   */
  wantOnce(hashes: Iterable<string>): void {
    for (const h of hashes) {
      if (this.queue.has(h) || this.running.has(h)) continue;
      if (hasBlob(this.storeDir, h)) {
        this.ended(h, 'done');
        continue;
      }
      this.once.set(h, new AbortController());
      this.queue.add(h);
    }
    this.pump();
  }

  /**
   * « Tout télécharger » stopped: its downloads still queued dropped, those under way aborted — receiveBlob removes their
   * temporaries, so that the store never keeps half a file.
   */
  dropOnce(): void {
    for (const [h, abort] of this.once) {
      if (this.queue.delete(h)) this.once.delete(h);
      else abort.abort();
    }
  }

  /**
   * The blob of `hash` in the store now: true once it is there, checked; false when it could not be had (the network,
   * the server, bytes that are not its hash's). Rejects, its code NOT_STORED, when this PC could not keep the bytes it
   * received (final review, Minor 4).
   */
  fetch(hash: string): Promise<boolean> {
    if (hasBlob(this.storeDir, hash)) return Promise.resolve(true);
    // One of « Tout télécharger » asked for now (a PDF opened): no longer stopped with it, and kept as any.
    this.once.delete(hash);
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
   * connection, and in the list beside the base for the next start (R9). Those of « Tout télécharger » are (D8).
   */
  async stop(): Promise<void> {
    this.abort.abort();
    for (const h of [...this.queue, ...this.eager]) if (!this.once.has(h)) this.failed.add(h);
    this.queue.clear();
    await Promise.allSettled([...this.running.values()]);
    this.once.clear();
    // One that ended before its abort is there: done.
    for (const h of this.failed) if (hasBlob(this.storeDir, h)) this.failed.delete(h);
    this.save();
    this.abort = new AbortController();
  }

  private pump(): void {
    while (this.eager.size < Math.max(1, this.limit())) {
      const next = this.queue.values().next();
      if (next.done) return;
      const h = next.value;
      this.queue.delete(h);
      // Under way already (asked for: fetch): its end is told as any.
      if (this.running.has(h)) continue;
      if (hasBlob(this.storeDir, h)) this.ended(h, 'done');
      else void this.start(h, true);
    }
  }

  private start(hash: string, eager: boolean): Promise<Outcome> {
    if (eager) this.eager.add(hash);
    // Its end told before the next one starts: a listener that holds the network (a test) holds that one too.
    const p = this.download(hash, eager).then((o) => {
      this.running.delete(hash);
      if (eager) this.eager.delete(hash);
      this.ended(hash, o);
      if (eager) {
        this.pump();
        this.tidy();
      }
      return o;
    });
    this.running.set(hash, p);
    return p;
  }

  /** A download's end, or a blob found there: no longer one of « Tout télécharger », and told. */
  private ended(hash: string, outcome: Outcome): void {
    this.once.delete(hash);
    try {
      this.onSettled?.(hash, outcome);
    } catch (e) {
      console.error('Téléchargement :', e);
    }
  }

  /** An eager download to try again when broken: not one of « Tout télécharger » (D8). */
  private kept(hash: string, eager: boolean): boolean {
    return eager && !this.once.has(hash);
  }

  /**
   * One download: the request, then the bytes kept (receiveBlob). Never rejects: its outcome. A failure of the network,
   * or a server's own (5xx), is tried again at the next connection when eager; bytes that are not their hash's are said,
   * and not tried again; a failure of this PC's disk while they were written (full, a folder it may not write: final
   * review, Minor 4) is said with its cause, and tried again when eager — the disk may have room by then. One of « Tout
   * télécharger » is never tried again, and is aborted with it (dropOnce). Measured for the throughput once kept.
   */
  private async download(hash: string, eager: boolean): Promise<Outcome> {
    const once = this.once.get(hash);
    const signal = once ? AbortSignal.any([this.abort.signal, once.signal]) : this.abort.signal;
    const since = this.rates.clock();
    let res: Response | null;
    try {
      res = await this.request(hash, signal);
    } catch {
      if (signal.aborted) return 'aborted';
      if (this.kept(hash, eager)) this.failed.add(hash);
      return 'lost';
    }
    if (!res) return 'failed';
    const length = res.headers.get('content-length'), size = length === null ? Number.NaN : Number(length);
    if (res.status !== 200 || !res.body || !Number.isSafeInteger(size) || size < 0) {
      await res.body?.cancel().catch(() => {});
      // Absent from the server (404), or a server that refuses (a token, a format): not tried again; its own failure is.
      if (res.status >= 500 && this.kept(hash, eager)) this.failed.add(hash);
      return 'failed';
    }
    try {
      // The bytes announced at most, checked against the hash before anything is kept.
      const got = await receiveBlob(this.storeDir, hash, fromNetwork(chunks(res.body)), size);
      this.rates.measured(got.size, since);
      return 'done';
    } catch (e) {
      if (e instanceof BlobError) {
        console.warn(`Fichier ${hash} reçu du serveur refusé : ${e.message}`);
        return 'failed';
      }
      if (signal.aborted) return 'aborted';
      if (e instanceof NetworkFailure) {
        if (this.kept(hash, eager)) this.failed.add(hash);
        return 'lost';
      }
      console.warn(`Fichier ${hash} reçu du serveur, mais non enregistré dans la base : ${messageOf(e)}`);
      if (this.kept(hash, eager)) this.failed.add(hash);
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
   * opening (R9), the server holding them all. Those of « Tout télécharger » are left out (D8).
   */
  private save(): void {
    const pending = [...this.queue, ...this.eager].filter((h) => !this.once.has(h));
    const hashes = [...new Set([...pending, ...this.failed])];
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

/**
 * « Télécharger tous les PDF… » (plan 5b, D8): the files a plan counted missing, downloaded by the queue of the eager
 * downloads (Downloads.wantOnce: syncDownloads at a time with them, each checked against its hash), told at its start
 * and at each file's end. It stops at the first file the network lost (the server out of reach) or this PC's disk
 * refused, at « Arrêter », and when the synchronisation stops: those still queued dropped, those under way aborted,
 * their temporaries removed — the store never keeps half a file. Neither written beside the base nor resumed: started
 * again, it counts what is still missing.
 */
export class DownloadAll {
  private readonly downloads: Downloads;
  private readonly tell: (p: DownloadAllProgress) => void;
  /** The files it still waits for, by hash: their sizes, the references'. */
  private readonly left = new Map<string, number>();
  private progress: DownloadAllProgress | null = null;

  constructor(downloads: Downloads, tell: (p: DownloadAllProgress) => void) {
    this.downloads = downloads;
    this.tell = tell;
    downloads.onSettled = (hash, outcome) => this.settled(hash, outcome);
  }

  /** Where the one under way is, or how the last one ended; null before any. */
  current(): DownloadAllProgress | null {
    return this.progress;
  }

  running(): boolean {
    return this.progress !== null && this.progress.end === undefined;
  }

  /** Downloads `missing` (hash: size), told now and at each file's end. */
  start(missing: ReadonlyMap<string, number>): void {
    this.left.clear();
    let bytes = 0;
    for (const [h, size] of missing) {
      this.left.set(h, size);
      bytes += size;
    }
    this.progress = { done: 0, failed: 0, total: this.left.size, doneBytes: 0, totalBytes: bytes };
    this.tell(this.progress);
    this.downloads.wantOnce([...this.left.keys()]);
  }

  /** « Arrêter » (`stopped`), or the synchronisation stopped (`interrupted`): what is left given up. */
  stop(end: 'stopped' | 'interrupted'): void {
    if (this.running()) this.end(end);
  }

  private settled(hash: string, outcome: Outcome): void {
    const size = this.left.get(hash);
    if (size === undefined || !this.running()) return;
    // Aborted while this one runs: a download of the one before, stopped a moment ago — asked again.
    if (outcome === 'aborted') {
      this.downloads.wantOnce([hash]);
      return;
    }
    this.left.delete(hash);
    if (outcome === 'lost') return this.end('lost');
    if (outcome === 'not-stored') return this.end('disk');
    const p = this.progress!;
    this.progress = outcome === 'done' ? { ...p, done: p.done + 1, doneBytes: p.doneBytes + size } : { ...p, failed: p.failed + 1 };
    if (this.left.size === 0) this.end('done');
    else this.tell(this.progress);
  }

  private end(end: NonNullable<DownloadAllProgress['end']>): void {
    this.left.clear();
    this.downloads.dropOnce();
    this.progress = { ...this.progress!, end };
    this.tell(this.progress);
  }
}
