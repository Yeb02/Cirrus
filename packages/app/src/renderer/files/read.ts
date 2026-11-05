import { fileUrl, type ViewRef } from './kind.ts';

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
 * A file's head, at most `maxBytes` (a view's ceiling: « une vue ne lit jamais plus que son plafond »), by the
 * cirrus-file: protocol; `truncated` when the file is longer. The body is read as a stream and let go at the ceiling, so
 * a server that would ignore the range (200, the whole file) is not read further either. A blob missing from the store
 * (404) or an answer in error rejects with a ReadError, in French; `signal` gives the reading up (a view closed
 * meanwhile).
 */
export async function readHead(ref: ViewRef, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const range = rangeHeader(ref.size, maxBytes);
  const res = await fetch(fileUrl(ref), { headers: range ? { Range: range } : {}, signal });
  if (res.status === 404) throw new ReadError(`« ${ref.name} » est introuvable dans la base.`);
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
