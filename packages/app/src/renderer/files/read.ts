import { fileKind, fileUrl, type ViewRef } from './kind.ts';

/** A mebibyte: the « Mo » of the settings (textViewMaxMb, tableViewMaxMb), as formatSize counts them. */
export const MB = 2 ** 20;

/**
 * The Range header that reads a file's first `maxBytes` (plan 4a, D1): none when the whole file is within them, else
 * `bytes=0-<maxBytes − 1>` (the end is included).
 */
export function rangeHeader(size: number, maxBytes: number): string | null {
  return size > maxBytes ? `bytes=0-${maxBytes - 1}` : null;
}

/** A file the store could not serve, said in French (the view shows the message). */
export class ReadError extends Error {}

/**
 * A file the store does not hold yet, which the server paired may give (503, plan 5a, D6): not downloaded, rather than
 * unreadable.
 */
export class NotDownloadedError extends ReadError {}

/**
 * Why a blob the store does not hold yet could not be had from the server (503, plan 5a, D6): offline, mostly. A PDF
 * comes down at its first reading; another file is downloaded in the background, and may not have come yet.
 */
export function notDownloaded(name: string): string {
  return fileKind(name) === 'pdf' ? 'PDF pas encore téléchargé : serveur injoignable.' : `« ${name} » pas encore téléchargé : serveur injoignable.`;
}

/**
 * Why a blob the server gave could not be kept by this PC (507, final review of plan 5a, Minor 4): its disk full, or a
 * folder it may not write — the server was reached; the main process's console has the cause. Not downloaded either:
 * it is asked again at its next opening.
 */
export function notStored(name: string): string {
  return `${fileKind(name) === 'pdf' ? 'PDF' : `« ${name} »`} non enregistré sur ce PC : le disque est plein, ou Windows y refuse l’écriture.`;
}

/**
 * A file's head, at most `maxBytes` (a view's ceiling: « une vue ne lit jamais plus que son plafond »), by the
 * cirrus-file: protocol; `truncated` when the file is longer. The body is read as a stream and let go at the ceiling, so
 * a server that would ignore the range (200, the whole file) is not read further either. A blob missing from the store
 * (404), not downloaded from the server (503) or an answer in error rejects with a ReadError, in French; `signal` gives
 * the reading up (a view closed meanwhile). `thumbnail`: a thumbnail's request, which never downloads (plan 5a, D6).
 */
export async function readHead(ref: ViewRef, maxBytes: number, signal?: AbortSignal, opts: { thumbnail?: boolean } = {}): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const range = rangeHeader(ref.size, maxBytes);
  const res = await fetch(fileUrl(ref, opts), { headers: range ? { Range: range } : {}, signal });
  if (res.status === 404) throw new ReadError(`« ${ref.name} » est introuvable dans la base.`);
  if (res.status === 503) throw new NotDownloadedError(notDownloaded(ref.name));
  if (res.status === 507) throw new NotDownloadedError(notStored(ref.name));
  if (!res.ok) throw new ReadError(`« ${ref.name} » n’a pas pu être lu (${res.status}).`);
  const out = new Uint8Array(Math.min(ref.size, maxBytes));
  let n = 0;
  const reader = res.body?.getReader();
  if (reader) {
    try {
      while (n < out.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, out.length - n);
        out.set(value.subarray(0, take), n);
        n += take;
      }
    } finally {
      // Read to the ceiling (or to its end): the rest, if any, is not fetched.
      void reader.cancel().catch(() => {});
    }
  }
  return { bytes: n === out.length ? out : out.subarray(0, n), truncated: range !== null };
}

/**
 * The size of a version of a file the store keeps (plan 4c, D2: the one an annotation was made on, re-imported since;
 * the node no longer holds its FileRef), by the length the cirrus-file: protocol answers it with: its content is not
 * read, the answer's stream let go at once. A blob missing from the store, or an answer without its length, rejects
 * with a ReadError, in French; one the server paired may give, with a NotDownloadedError (plan 5a). `sizeOnly`: only
 * its size is wanted (an annotation listed, R12), never a download; otherwise the version is being opened, and the
 * protocol fetches it from the server.
 */
export async function blobSize(ref: { name: string; hash: string }, signal?: AbortSignal, opts: { sizeOnly?: boolean } = {}): Promise<number> {
  const res = await fetch(fileUrl({ ...ref, size: 0 }, opts), { signal });
  void res.body?.cancel().catch(() => {});
  if (res.status === 404) throw new ReadError(`Cette version de « ${ref.name} » est introuvable dans la base.`);
  if (res.status === 503) throw new NotDownloadedError(opts.sizeOnly ? notDownloadedYet(ref.name) : notDownloaded(ref.name));
  if (res.status === 507) throw new NotDownloadedError(notStored(ref.name));
  const size = Number(res.headers.get('content-length') ?? Number.NaN);
  if (!res.ok || !Number.isSafeInteger(size) || size < 0) throw new ReadError(`Cette version de « ${ref.name} » n’a pas pu être lue (${res.status}).`);
  return size;
}

/** A version the server may give, never asked of it here (R12): it comes down when it is opened. */
function notDownloadedYet(name: string): string {
  return `${fileKind(name) === 'pdf' ? 'PDF' : `« ${name} »`} pas encore téléchargé : il le sera à son ouverture.`;
}

/**
 * Why a version an annotation is on is not in the store, from blobSize's failure: `blocks`, it cannot be opened (missing
 * from the base, unreadable); a version not downloaded yet opens, and is downloaded then (plan 5a, R12).
 */
export function absentVersion(e: unknown, name: string): { text: string; blocks: boolean } {
  if (e instanceof NotDownloadedError) return { text: e.message, blocks: false };
  return { text: e instanceof ReadError ? e.message : `Cette version de « ${name} » n’a pas pu être lue.`, blocks: true };
}

/** What the views are still reading or loading: a file, a view's code, a language, an image. */
const pending = new Set<Promise<unknown>>();

/** `p`, counted among what the views are loading until it settles (viewsSettled). */
export function loading<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.then(() => pending.delete(p), () => pending.delete(p));
  return p;
}

/**
 * A quiet turn after the last load settled, for what it made React render, and that render's effects, to start their
 * own loads (a compilation answered: its snippet's chunk, then its PDF). A wait of the capture harness, not a setting.
 */
const QUIET_MS = 50;

/**
 * Once nothing the views load is pending: a capture waits for it before it is taken (CIRRUS_CLICK opens a view, whose
 * file, code and language arrive later), so that it shows the view as it settles. What a settled load starts is waited
 * for too, at once or after the render it causes (QUIET_MS).
 */
export async function viewsSettled(): Promise<void> {
  do {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    await new Promise((r) => setTimeout(r, QUIET_MS));
  } while (pending.size > 0);
}
