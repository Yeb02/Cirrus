import {
  getDocument, InvalidPDFException, PasswordException, PDFDataRangeTransport, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy,
  PDFWorker,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { fileUrl, type ViewRef, viewKey } from './kind.ts';
import type { PageSize } from './pdfLayout.ts';
import { ReadError, readHead } from './read.ts';

/**
 * pdf.js for the PDF reader and the pop-up's thumbnails (plan 4a, D2, task 6). Its worker, copied into the app by the
 * build (`?url`), and its data — character maps, standard fonts, image decoders, colour profile — copied next to the
 * page by the build (electron.vite.config.ts, `pdfjsData`): nothing is fetched from the network. Documents are read
 * from cirrus-file: by HTTP ranges (StoreRanges), only what the pages drawn need (disableAutoFetch, with the
 * disableStream it requires), and at most `kept` of them stay open.
 */

/** A point is 1/72 in, a CSS pixel 1/96 in: zoom 1 shows a page at its real size. */
export const CSS_PER_PT = 96 / 72;

/** Where the build puts pdf.js's data, next to the page (the dev server serves the same paths). */
const DATA = new URL('pdfjs/', document.baseURI).href;

let worker: PDFWorker | null = null;

/**
 * One worker thread for every document: pdf.js would start one per document otherwise. Made by us from the worker's
 * own address (allowed by the CSP's 'self'), not by pdf.js, which wraps an address of another origin — any file: one
 * — in a blob: script the CSP would have to allow.
 */
function sharedWorker(): PDFWorker {
  worker ??= PDFWorker.create({ port: new Worker(workerUrl, { type: 'module', name: 'pdf.js' }) });
  return worker;
}

/**
 * pdf.js's range size (its default `rangeChunkSize`): the head read before the document opens is one range. Not a
 * setting: the grain of pdf.js's reads, neither drawing nor interaction.
 */
const RANGE = 2 ** 16;

/**
 * Reading past a thumbnail's budget (thumbMaxMb): pdf.js reads the whole file of a PDF whose pages all hang from its
 * root (it fetches every page of the top level ahead), or of a damaged one (its objects indexed again); a thumbnail
 * then gives up, and shows the PDF's icon.
 */
export class BudgetError extends Error {
  override name = 'BudgetError';
}

/**
 * A document's bytes for pdf.js, by HTTP ranges on cirrus-file: (D1). pdf.js's own loaders ask ranges of http: and
 * https: addresses only, and would read any other file whole; through this transport, each range it needs is one
 * fetch with its Range header (`end` excluded). Its head, read beforehand (readHead, which says a blob missing from the
 * store in French), is the first range; a file within it is read once. At most `budget` bytes are read, the head
 * included (a thumbnail's: thumbMaxMb; a view's: no bound). A range that fails, or past the budget, calls `failed` (the
 * document is then closed: its views and thumbnails say so rather than wait); `abort` (closed) stops those under way.
 */
class StoreRanges extends PDFDataRangeTransport {
  private readonly url: string;
  private readonly stop = new AbortController();
  budget: number;
  private read: number;
  private broken = false;
  /** Called once, at the first range that fails or would go past the budget; none is fetched after it. */
  failed: (e: unknown) => void = () => {};

  constructor(ref: ViewRef, head: Uint8Array, budget: number) {
    super(ref.size, head, head.length >= ref.size);
    this.url = fileUrl(ref);
    this.budget = budget;
    this.read = head.length;
  }

  private fail(e: unknown): void {
    if (this.broken) return;
    this.broken = true;
    this.failed(e);
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.broken) return;
    if (this.read + end - begin > this.budget) {
      this.fail(new BudgetError(`plus de ${(this.budget / 2 ** 20).toLocaleString('fr-FR')} Mo à lire`));
      return;
    }
    this.read += end - begin;
    void (async () => {
      let bytes: Uint8Array;
      try {
        const res = await fetch(this.url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: this.stop.signal });
        if (res.status !== 206) throw new Error(`plage ${begin}-${end - 1} : réponse ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (!this.stop.signal.aborted) this.fail(e);
        return;
      }
      try {
        this.onDataRange(begin, bytes);
      } catch {
        // A range pdf.js no longer waits for (its page left meanwhile).
      }
    })();
  }

  override abort(): void {
    this.stop.abort();
  }
}

/**
 * A document open or opening: `destroy` closes it (and stops its opening); `unbound` lifts its budget (a view now
 * holds it); `failure` rejects if its bytes cannot all be read (StoreRanges.failed) — what pdf.js was then doing for it
 * would wait for ever (a document closed while it opens, or while a page is read, never settles), so its users race it.
 */
interface Entry { doc: Promise<PDFDocumentProxy>; failure: Promise<never>; users: number; destroy(): void; unbound(): void }
/** The documents open, by store and hash (viewKey), the one used longest ago first (a Map keeps its insertion order). */
const docs = new Map<string, Entry>();

/** Closes the documents used longest ago that no view holds, until at most `kept` stay open. */
function trim(kept: number): void {
  let open = docs.size;
  for (const [key, e] of docs) {
    if (open <= kept) break;
    if (e.users > 0) continue;
    docs.delete(key);
    open--;
    e.destroy();
  }
}

/**
 * A document held open by a view; `release` lets it go (it may stay open, among the `kept` last used); `failure`
 * rejects if it could not be read to the end (Entry).
 */
export interface PdfDoc { doc: PDFDocumentProxy; failure: Promise<never>; release(): void }

/**
 * The document of `ref`, opened once for all its views and thumbnails. A document no view holds is closed once more
 * than `kept` are open, the one used longest ago first; one a view holds stays open until it is let go. `budget`: the
 * bytes a thumbnail may read (StoreRanges); a view, which reads what it shows, gives none, and lifts the budget of a
 * document a thumbnail is opening.
 */
export async function openPdf(ref: ViewRef, kept: number, budget = Infinity): Promise<PdfDoc> {
  const key = viewKey(ref);
  let e = docs.get(key);
  if (e) docs.delete(key);
  else e = opening(ref, budget);
  if (budget === Infinity) e.unbound();
  const entry = e;
  docs.set(key, entry);
  entry.users++;
  try {
    const doc = await entry.doc;
    trim(kept);
    let held = true;
    return { doc, failure: entry.failure, release: () => { if (held) { held = false; entry.users--; trim(kept); } } };
  } catch (err) {
    // Not kept: the next view tries again.
    entry.users--;
    if (docs.get(key) === entry) docs.delete(key);
    entry.destroy();
    throw err;
  }
}

/** A document opening: its head read, then pdf.js asks the rest by ranges, none ahead, within `budget` bytes. */
function opening(ref: ViewRef, budget: number): Entry {
  let task: PDFDocumentLoadingTask | null = null, range: StoreRanges | null = null, closed = false, limit = budget;
  let fail: (e: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => { fail = reject; });
  failure.catch(() => {});
  const entry: Entry = {
    users: 0, failure,
    destroy: () => { closed = true; if (task) void task.destroy(); },
    unbound: () => { limit = Infinity; if (range) range.budget = Infinity; },
    doc: (async () => {
      if (Math.min(RANGE, ref.size) > limit) throw new BudgetError(`plus de ${(limit / 2 ** 20).toLocaleString('fr-FR')} Mo à lire`);
      const { bytes } = await readHead(ref, RANGE);
      if (closed) throw new Error('Fermé avant d’être ouvert.');
      const r = new StoreRanges(ref, bytes, limit);
      range = r;
      const t = getDocument({
        range: r, worker: sharedWorker(),
        disableAutoFetch: true, disableStream: true,
        cMapUrl: `${DATA}cmaps/`, standardFontDataUrl: `${DATA}standard_fonts/`, wasmUrl: `${DATA}wasm/`, iccUrl: `${DATA}iccs/`,
      });
      task = t;
      r.failed = (err) => {
        if (err instanceof BudgetError) console.info(`Vignette de « ${ref.name} » : ${err.message}, son icône à la place.`);
        else console.error(`Lecture de « ${ref.name} » par plages :`, err);
        if (docs.get(viewKey(ref)) === entry) docs.delete(viewKey(ref));
        fail(err);
        void t.destroy();
      };
      return Promise.race([t.promise, failure]);
    })(),
  };
  return entry;
}

/** Why a PDF could not be opened, in French; its cause in the console. */
export function pdfFailure(name: string, e: unknown): string {
  console.error(`PDF « ${name} » :`, e);
  if (e instanceof ReadError) return e.message;
  if (e instanceof PasswordException) return `« ${name} » est protégé par un mot de passe : ouvre-le avec l’application du système.`;
  if (e instanceof InvalidPDFException) return `« ${name} » n’est pas un PDF lisible.`;
  return `« ${name} » n’a pas pu être lu.`;
}

/** A page's size in CSS pixels at zoom 1, its rotation applied. */
export function pageSize(page: PDFPageProxy): PageSize {
  const v = page.getViewport({ scale: CSS_PER_PT });
  return { w: v.width, h: v.height };
}

/**
 * Where a link's destination leads (a name, or an explicit destination): the page's index, and the point of the page
 * (in its own coordinates) to bring to the view's top left, null on an axis it leaves as it is. Null for a destination
 * that leads nowhere in the document.
 */
export async function destination(doc: PDFDocumentProxy, dest: unknown): Promise<{ page: number; x: number | null; y: number | null } | null> {
  const explicit: unknown = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit.length < 2) return null;
  const [ref, kind, ...args] = explicit as [unknown, { name?: string } | null, ...unknown[]];
  let page: number;
  if (typeof ref === 'object' && ref !== null) page = await doc.getPageIndex(ref as { num: number; gen: number });
  else if (Number.isInteger(ref)) page = ref as number;
  else return null;
  if (page < 0 || page >= doc.numPages) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (kind?.name) {
    case 'XYZ': return { page, x: num(args[0]), y: num(args[1]) };
    case 'FitH': case 'FitBH': return { page, x: null, y: num(args[0]) };
    case 'FitV': case 'FitBV': return { page, x: num(args[0]), y: null };
    case 'FitR': return { page, x: num(args[0]), y: num(args[3]) };
    default: return { page, x: null, y: null };
  }
}

/** The thumbnails drawn, by store and hash, size, density and budget: blob: URLs, kept for the session (a failure too). */
const thumbs = new Map<string, Promise<string>>();
/** One thumbnail drawn at a time: a pop-up of many PDFs does not open them all at once. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The first page of `ref`, `px` CSS pixels on its longer side, at the screen's density, as a blob: URL — the pop-up's
 * thumbnail. Only what that page needs is read (openPdf: by ranges, nothing ahead), whatever the file's size, and at
 * most `budget` bytes (thumbMaxMb): past them, it is given up (BudgetError).
 */
export function pageThumbnail(ref: ViewRef, px: number, kept: number, budget: number): Promise<string> {
  const density = window.devicePixelRatio || 1;
  const key = `${viewKey(ref)}/${px}/${density}/${budget}`;
  let p = thumbs.get(key);
  if (!p) {
    p = queue.then(() => drawThumbnail(ref, px * density, kept, budget));
    queue = p.catch(() => {});
    thumbs.set(key, p);
  }
  return p;
}

async function drawThumbnail(ref: ViewRef, px: number, kept: number, budget: number): Promise<string> {
  const held = await openPdf(ref, kept, budget);
  try {
    return await Promise.race([firstPage(held.doc, px), held.failure]);
  } finally {
    held.release();
  }
}

/** The first page of `doc`, `px` device pixels on its longer side, as a blob: URL. */
async function firstPage(doc: PDFDocumentProxy, px: number): Promise<string> {
  const page = await doc.getPage(1);
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: px / Math.max(unit.width, unit.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport }).promise;
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
  canvas.width = canvas.height = 0;
  page.cleanup();
  if (!blob) throw new Error('vignette vide');
  return URL.createObjectURL(blob);
}
