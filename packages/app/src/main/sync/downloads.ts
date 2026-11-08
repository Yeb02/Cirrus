import { existsSync } from 'node:fs';
import type { FileRef, Op, Unit } from '@cirrus/core';
import { BlobError, filePath, receiveBlob } from '@cirrus/store';

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
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
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
export type BlobRequest = (hash: string, signal: AbortSignal) => Promise<Response> | null;

/**
 * The downloads: those wanted (the files of received records) queued, `limit()` of them at once; one asked for now
 * (fetch: a PDF opened, a file absent) starts at once, outside the limit, or joins the same one under way. A download
 * the network broke is tried again at the next connection (retry); one the server does not have, or whose bytes are not
 * those of their hash, is not.
 */
export class Downloads {
  private readonly storeDir: string;
  private readonly request: BlobRequest;
  private readonly limit: () => number;
  /** The queued hashes, in order (a Set: queued once, taken from the front). */
  private readonly queue = new Set<string>();
  private readonly running = new Map<string, Promise<boolean>>();
  private readonly failed = new Set<string>();
  private abort = new AbortController();
  /** The queued downloads running, within `limit()`. */
  private active = 0;

  constructor(storeDir: string, request: BlobRequest, limit: () => number) {
    this.storeDir = storeDir;
    this.request = request;
    this.limit = limit;
  }

  /** Queues the blobs of `hashes` that the store does not hold. */
  want(hashes: Iterable<string>): void {
    for (const h of hashes) if (!this.queue.has(h) && !this.running.has(h) && !hasBlob(this.storeDir, h)) this.queue.add(h);
    this.pump();
  }

  /** The blob of `hash` in the store now: true once it is there, checked; false when it could not be had. */
  fetch(hash: string): Promise<boolean> {
    if (hasBlob(this.storeDir, hash)) return Promise.resolve(true);
    const under = this.running.get(hash);
    if (under) return under;
    this.queue.delete(hash);
    return this.start(hash, false);
  }

  /** The downloads the network broke, queued again (a connection is back). */
  retry(): void {
    const hashes = [...this.failed];
    this.failed.clear();
    this.want(hashes);
  }

  /** Every download stopped and awaited, the queue emptied. */
  async stop(): Promise<void> {
    this.abort.abort();
    this.queue.clear();
    await Promise.allSettled([...this.running.values()]);
    this.abort = new AbortController();
  }

  private pump(): void {
    while (this.active < Math.max(1, this.limit())) {
      const next = this.queue.values().next();
      if (next.done) return;
      this.queue.delete(next.value);
      if (!this.running.has(next.value) && !hasBlob(this.storeDir, next.value)) void this.start(next.value, true);
    }
  }

  private start(hash: string, queued: boolean): Promise<boolean> {
    if (queued) this.active++;
    const p = this.download(hash).finally(() => {
      this.running.delete(hash);
      if (queued) {
        this.active--;
        this.pump();
      }
    });
    this.running.set(hash, p);
    return p;
  }

  private async download(hash: string): Promise<boolean> {
    const signal = this.abort.signal;
    try {
      const res = await this.request(hash, signal);
      if (!res) return false;
      const size = Number(res.headers.get('content-length'));
      if (res.status !== 200 || !res.body || !Number.isSafeInteger(size) || size < 0) {
        await res.body?.cancel().catch(() => {});
        // Absent from the server (404), or a server that refuses (a token, a format): not tried again; its own failure is.
        if (res.status >= 500) this.failed.add(hash);
        return false;
      }
      // The bytes announced at most, checked against the hash before anything is kept.
      await receiveBlob(this.storeDir, hash, chunks(res.body), size);
      return true;
    } catch (e) {
      if (e instanceof BlobError) {
        console.warn(`Fichier ${hash} reçu du serveur refusé : ${e.message}`);
      } else if (!signal.aborted) {
        this.failed.add(hash);
      }
      return false;
    }
  }
}
