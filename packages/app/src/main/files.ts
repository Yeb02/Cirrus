import { randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, createReadStream, type Dirent, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { type FileRef, plainName } from '@cirrus/core';
import { type ChangeRow, filePath, importFile, storeBytes, storeBytesAsync } from '@cirrus/store';
import { checkFileName } from '../renderer/files/merge.ts';

/**
 * The nodes' files on the main process's side (plan 4a, D1, D5, D6): the store's blobs served read-only to the
 * interface by the cirrus-file: protocol, with HTTP ranges; paths copied into the store; read-only copies handed to
 * the system's applications.
 */

/**
 * The files' scheme: cirrus-file://blob/<sha256>/<name, encoded by encodeURIComponent>, the store's blobs, and
 * cirrus-file://latex/<cache key>/<name>, the compiled PDFs (plan 4b, D2); the name only gives the type.
 */
export const FILE_SCHEME = 'cirrus-file';
const BLOB_PREFIX = `${FILE_SCHEME}://blob/`;
const LATEX_PREFIX = `${FILE_SCHEME}://latex/`;
const HASH = /^[0-9a-f]{64}$/;
const RANGE = /^bytes=(\d*)-(\d*)$/i;

export type BlobAnswer =
  | { status: 400 | 404 | 416 | 503; headers: Record<string, string> }
  | { status: 200 | 206; headers: Record<string, string>; path: string; start: number; end: number };

/** The extension as Windows reads it: after the last dot, trailing dots and spaces dropped (« a.bat. » opens as « a.bat »). */
function extensionOf(name: string): string {
  const n = name.replace(/[. ]+$/, '');
  const dot = n.lastIndexOf('.');
  return dot < 0 ? '' : n.slice(dot + 1).toLowerCase();
}

const CONTENT_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['bmp', 'image/bmp'],
  ['svg', 'image/svg+xml'], ['avif', 'image/avif'], ['ico', 'image/x-icon'], ['pdf', 'application/pdf'],
]);

/** The type a blob is served with: the images and the PDF by their extension; the interface decodes the rest itself. */
export function contentTypeOf(name: string): string {
  return CONTENT_TYPES.get(extensionOf(name)) ?? 'application/octet-stream';
}

/**
 * The protocol's answer to `url` with the Range header `range` (plan 4a, D1). Only a valid SHA-256 is served, at the
 * path filePath gives it: anything else is 400 (Chromium already resolves « .. » and turns « \ » into « / » before the
 * handler; this does not rely on it). One range (`bytes=a-b`, `bytes=a-`, `bytes=-n`) is 206, one past the end 416; a
 * header not understood (several ranges, reversed, another unit) is ignored and the whole file served, as HTTP allows
 * (RFC 9110, 14.2). `end` is included, as in createReadStream.
 */
export function blobRequest(storeDir: string, url: string, range: string | null): BlobAnswer {
  const parsed = parseUrl(url, BLOB_PREFIX);
  if (!parsed) return bare(400);
  return served(filePath(storeDir, { name: parsed.name, hash: parsed.hash, size: 0 }), contentTypeOf(parsed.name), range);
}

/**
 * The same for a compiled PDF (plan 4b, D2): cirrus-file://latex/<64 hex>/<name>, served from <cacheDir>/<key>.pdf as
 * application/pdf, by the same rules (400, 404, ranges, sandboxed).
 */
export function latexRequest(cacheDir: string, url: string, range: string | null): BlobAnswer {
  const parsed = parseUrl(url, LATEX_PREFIX);
  if (!parsed) return bare(400);
  return served(join(cacheDir, `${parsed.hash}.pdf`), 'application/pdf', range);
}

const bare = (status: 400 | 404 | 416 | 503, more?: Record<string, string>): BlobAnswer =>
  ({ status, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '0', ...more } });

/** <prefix><sha256>/<name>, the name decoded; null for anything else. */
function parseUrl(url: string, prefix: string): { hash: string; name: string } | null {
  if (!url.startsWith(prefix) || url.includes('\\')) return null;
  // Chromium hands over the query and the fragment too; encodeURIComponent escapes « ? » and « # » in a name.
  const parts = url.slice(prefix.length).split(/[?#]/)[0].split('/');
  if (parts.length !== 2 || !HASH.test(parts[0]) || parts[1] === '') return null;
  try {
    return { hash: parts[0], name: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

/** The answer for the file at `path`, whole or by the range asked: 404 if it is not a file. */
function served(path: string, contentType: string, range: string | null): BlobAnswer {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return bare(404);
    size = st.size;
  } catch {
    return bare(404);
  }
  // Sandboxed: should the window ever navigate to a served SVG or HTML, its scripts would run with the bridge exposed
  // (checked in Electron 45); the header is ignored by <img>, fetch and XHR.
  const answer = (status: 200 | 206, start: number, end: number): BlobAnswer => ({
    status, path, start, end,
    headers: {
      'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Content-Type': contentType, 'Content-Security-Policy': 'sandbox',
    },
  });
  const m = range === null ? null : RANGE.exec(range.trim());
  const first = m && m[1] !== '' ? Number(m[1]) : null, last = m && m[2] !== '' ? Number(m[2]) : null;
  if (!m || (first === null && last === null) || (first !== null && last !== null && last < first)) return answer(200, 0, size - 1);
  // A suffix of n bytes is the last n (all of them if the file is shorter); a suffix of 0, or an empty file, starts at
  // the end: unsatisfiable.
  const start = first ?? Math.max(0, size - last!);
  if (start >= size) return bare(416, { 'Content-Range': `bytes */${size}` });
  return answer(206, start, first === null || last === null ? size - 1 : Math.min(last, size - 1));
}

/** The protocol's response (protocol.handle): the range streamed from the disk, never the blob read whole. */
export function blobResponse(storeDir: string, request: Request): Response {
  return respond(blobRequest(storeDir, request.url, request.headers.get('range')));
}

/**
 * A request that never downloads (plan 5a, D6, R12): a thumbnail's (`?vignette`: the pop-up shows the kind's icon
 * instead), or one asking only a version's size (`?taille`: an annotation listed). Served if the store holds the blob.
 */
export function isNoDownloadRequest(url: string): boolean {
  const query = url.split('#')[0].split('?')[1];
  if (query === undefined) return false;
  const params = new URLSearchParams(query);
  return params.has('vignette') || params.has('taille');
}

/** A blob the server must give: `true` once it is in the store, checked against its hash (SyncClient.fetchBlob). */
export type FetchBlob = (hash: string) => Promise<boolean>;

/**
 * The protocol's response for either host: the store's blobs (blob) or the compiled PDFs of `cacheDir` (latex). With a
 * server paired (`fetchBlob`, plan 5a, D6), a blob absent from the store — a PDF at its first reading, a file whose
 * download has not come yet — is fetched from it, checked, kept, then served; when it cannot be had (offline, absent
 * there, bytes that are not its hash's), 503. A request that never downloads (a thumbnail's, a size's) answers 503 at
 * once for an absent blob: not downloaded yet (R12). Without a server, an absent blob is 404, as in plan 4c.
 */
export function fileResponse(storeDir: string, cacheDir: string, request: Request, fetchBlob: FetchBlob | null = null): Response | Promise<Response> {
  const range = request.headers.get('range'), url = request.url;
  if (url.startsWith(LATEX_PREFIX)) return respond(latexRequest(cacheDir, url, range));
  const answer = blobRequest(storeDir, url, range);
  if (answer.status !== 404 || !fetchBlob) return respond(answer);
  if (isNoDownloadRequest(url)) return respond(bare(503));
  const hash = parseUrl(url, BLOB_PREFIX)?.hash;
  if (!hash) return respond(answer);
  return fetchBlob(hash).then(
    (ok) => respond(ok ? blobRequest(storeDir, url, range) : bare(503)),
    () => respond(bare(503)),
  );
}

function respond(a: BlobAnswer): Response {
  // The same stream at run time; Node's and the DOM's typings of it differ.
  const body = 'path' in a && a.end >= a.start
    ? Readable.toWeb(createReadStream(a.path, { start: a.start, end: a.end })) as unknown as ReadableStream<Uint8Array>
    : null;
  return new Response(body, { status: a.status, headers: a.headers });
}

export interface ImportResult { refs: FileRef[]; refused: { name: string; reason: string }[] }

/**
 * Copies files into the store (spec 5.2), each by importFile, before any action refers to them (plan 4a, D6). A
 * folder, a file over `maxBytes` and a path gone since it was dropped are refused with their reason, in French; the
 * others go in (Review Focus 2). Only local regular files are read (I1 of the review): a UNC or device path
 * (`\\server\…`, `//…`, `\\?\…`, `\\.\…`) is refused before any access, which would open an SMB connection with the
 * user's credentials, and a link is not followed (lstat).
 */
export function importPaths(storeDir: string, paths: string[], maxBytes: number): ImportResult {
  const out: ImportResult = { refs: [], refused: [] };
  const limit = (maxBytes / 2 ** 20).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  for (const p of paths) {
    const name = basename(p);
    try {
      if (/^[\\/]{2}/.test(p)) {
        out.refused.push({ name, reason: 'chemin réseau ou de périphérique' });
        continue;
      }
      const st = lstatSync(p);
      if (st.isDirectory()) out.refused.push({ name, reason: 'c’est un dossier' });
      else if (!st.isFile()) out.refused.push({ name, reason: 'pas un fichier ordinaire' });
      else if (st.size > maxBytes) out.refused.push({ name, reason: `plus de ${limit} Mo` });
      else out.refs.push(importFile(storeDir, p));
    } catch (e) {
      // Gone since it was dropped (between the stat and the copy too), or held by another program, or forbidden.
      const code = (e as NodeJS.ErrnoException).code;
      out.refused.push({ name, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'introuvable' : 'illisible' });
    }
  }
  return out;
}

/**
 * A text saved from the app (plan 4b, D6: a .tex typed in its full screen) stored as `name` (storeBytes), in UTF-8
 * without a BOM (one leading the text is dropped). Refused, in French, whatever the interface did: a name that
 * checkFileName refuses (a separator, « .. », a name Windows reserves…), a text of more than `maxBytes` (maxImportMb),
 * what is not a string.
 */
export function storeText(storeDir: string, name: unknown, text: unknown, maxBytes: number): FileRef {
  return storeBytes(storeDir, name as string, textBytes(name, text, maxBytes));
}

const mb = (bytes: number) => (bytes / 2 ** 20).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
/** storeText's checks: a name checkFileName takes, a string of `maxBytes` at most in UTF-8 (a leading BOM dropped); its bytes. */
function textBytes(name: unknown, text: unknown, maxBytes: number): Buffer {
  if (typeof name !== 'string' || typeof text !== 'string') throw new Error('Enregistrement refusé : nom ou texte invalide.');
  const why = checkFileName(name, []);
  if (why) throw new Error(why);
  const bytes = Buffer.from(text.startsWith('\uFEFF') ? text.slice(1) : text, 'utf8');
  if (bytes.length > maxBytes) throw new Error(`Le texte fait plus de ${mb(maxBytes)} Mo : il n’est pas enregistré.`);
  return bytes;
}

/** The texts storeTexts takes in one call at most (a fixed bound of the IPC: the interface sends BIB_STORE_BATCH). */
export const STORE_TEXTS_MAX = 1000;
/**
 * The texts written at once (storeBytesAsync, by the file system's thread pool): the store's fsync and the antivirus
 * cost a few milliseconds a file (task 6: 2 000 files, 14 s one after the other, about 5 s eight at a time).
 */
const STORE_PARALLEL = 8;

/**
 * Texts stored as files, as storeText stores each, in one call (plan 4c, task 6: a .bib's entries, a file each), several
 * written at once without holding this process: their references, in order. Every one is checked before any is written
 * — a list of STORE_TEXTS_MAX at most, each storeText's checks, all of them `maxBytes` at most together —, and the first
 * refused rejects the call with its reason, in French, nothing written. A write that fails rejects it too; the others
 * already written stay (the store never erases).
 */
export async function storeTexts(storeDir: string, items: unknown, maxBytes: number): Promise<FileRef[]> {
  if (!Array.isArray(items) || items.length > STORE_TEXTS_MAX) throw new Error('Enregistrement refusé : liste de textes invalide.');
  let total = 0;
  const all = items.map((x: unknown) => {
    if (x === null || typeof x !== 'object') throw new Error('Enregistrement refusé : nom ou texte invalide.');
    const { name, text } = x as { name: unknown; text: unknown };
    const bytes = textBytes(name, text, maxBytes);
    total += bytes.length;
    return { name: name as string, bytes };
  });
  if (total > maxBytes) throw new Error(`Les textes font plus de ${mb(maxBytes)} Mo ensemble : ils ne sont pas enregistrés.`);
  const refs: FileRef[] = new Array(all.length);
  let next = 0;
  const worker = async () => {
    while (next < all.length) {
      const i = next++;
      try {
        refs[i] = await storeBytesAsync(storeDir, all[i].name, all[i].bytes);
      } catch (e) {
        // The others take no more.
        next = all.length;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STORE_PARALLEL, all.length) }, worker));
  return refs;
}

/**
 * Opened by Windows, these would run (a .py by Python, a .lnk its target, a .sh in Git Bash): the explorer shows them
 * instead (plan 4a, D5). The plan's list, plus sh, and Python's compiled files and zipped windowed applications (pyc, pyo,
 * pyzw: the Python launcher runs them), which Cirrus does not show and a click would otherwise hand to Windows (ruling
 * of the final review; the other scripts are text kinds, shown in Cirrus: kind.ts). A fixed security list, not a setting.
 */
const RUNNABLE = new Set([
  'exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msi', 'msp', 'msc', 'scr', 'pif', 'cpl', 'hta', 'lnk', 'url',
  'reg', 'jar', 'py', 'pyw', 'pyz', 'appref-ms', 'sh', 'pyc', 'pyo', 'pyzw',
]);

export function isRunnable(name: string): boolean {
  return RUNNABLE.has(extensionOf(name));
}

/** The code of the error openableCopy throws for a refused name or hash. */
const REFUSED_NAME = 'CIRRUS_REFUSED_NAME';

/** The rule of a plain file name, the core's since plan 5a: the server refuses a file added under another name (parseOp). */
export { plainName };

/**
 * The Mark-of-the-Web of the Internet zone (I2 of the review): the store keeps no file's origin, so every copy is
 * marked as if downloaded, and SmartScreen, Office's Protected View and the zone blocks of CHM and HTA stay on.
 */
const ZONE_MARK = '[ZoneTransfer]\r\nZoneId=3\r\n';
const zoneStream = (path: string) => `${path}:Zone.Identifier`;
const marked = (path: string) => {
  try {
    return readFileSync(zoneStream(path), 'utf8') === ZONE_MARK;
  } catch {
    return false;
  }
};

/** The start of a copy's temporary name, before it is renamed: what cleanCopies removes whatever its mode. */
const TEMPORARY = '.copie-';

/**
 * The copy of a blob handed to the system's application (plan 4a, D5), never the store's own file: root/<first 16 hex
 * of the hash>/<name>, marked from the Internet zone and read-only (a stream cannot be written to a read-only file, so
 * the mark comes first). Written under a temporary name then renamed, so a copy found there is whole; it is reused only
 * as it was left: read-only, the blob's size, marked. Otherwise (its flag lifted by hand, written to, its stream
 * removed) it is made again. A name or a hash that would leave `root`, and a blob missing from the store, throw. An old
 * copy that cannot be removed (still open in its application) gets its mode back, and the error is thrown: read-only,
 * it stays one of Cirrus's copies, which cleanCopies removes later (final review).
 */
export function openableCopy(storeDir: string, ref: FileRef, root: string): string {
  if (!HASH.test(ref.hash) || !plainName(ref.name)) throw Object.assign(new Error('nom de fichier refusé'), { code: REFUSED_NAME });
  const src = filePath(storeDir, ref);
  const size = statSync(src).size;
  const folder = join(root, ref.hash.slice(0, 16));
  const dest = join(folder, ref.name);
  const there = statSync(dest, { throwIfNoEntry: false });
  if (there && there.size === size && (there.mode & 0o200) === 0 && marked(dest)) return dest;
  if (there) {
    chmodSync(dest, 0o644);
    try {
      unlinkSync(dest);
    } catch (e) {
      try {
        chmodSync(dest, there.mode & 0o777);
      } catch {
        // gone after all
      }
      throw e;
    }
  }
  mkdirSync(folder, { recursive: true });
  const tmp = join(folder, `${TEMPORARY}${randomBytes(8).toString('hex')}`);
  try {
    copyFileSync(src, tmp);
    try {
      writeFileSync(zoneStream(tmp), ZONE_MARK);
    } catch {
      // not NTFS: no streams, so no mark to give (the copy is then made again at each opening)
    }
    chmodSync(tmp, 0o444);
    renameSync(tmp, dest);
  } catch (e) {
    try {
      chmodSync(tmp, 0o644);
      unlinkSync(tmp);
    } catch {
      // never written; or left to cleanCopies
    }
    throw e;
  }
  return dest;
}

/**
 * How a file is opened (plan 4a, D5; Review Focus 3): its read-only copy, by its application, or shown in the explorer
 * when Windows would run it.
 */
export function openTarget(storeDir: string, ref: FileRef, root: string): { path: string; shown: 'app' | 'folder' } {
  return { path: openableCopy(storeDir, ref, root), shown: isRunnable(ref.name) ? 'folder' : 'app' };
}

/** What cirrus:files:open answers: opened by its application, or shown in the explorer; else why not, in French. */
export type OpenResult = { ok: true; shown: 'app' | 'folder' } | { ok: false; message: string };

/**
 * Why the file `name` did not open, in French: a sentence per known cause, a generic one otherwise. No English text of
 * Node or Windows reaches the user (the caller logs it). `e` is the error thrown, or shell.openPath's failure string.
 */
export function openFailure(name: string, e: unknown): string {
  if (typeof e === 'string') return `Windows n’a pas pu ouvrir « ${name} » : aucune application ne semble associée à ce type de fichier.`;
  const why = (e as NodeJS.ErrnoException | null)?.code;
  const reason = why === 'ENOENT' ? 'le fichier manque dans la base'
    : why === 'EBUSY' ? 'sa copie est encore ouverte dans une autre application'
    : why === 'EACCES' || why === 'EPERM' ? 'Windows refuse l’accès à sa copie'
    : why === 'ENOSPC' ? 'le disque est plein'
    : why === REFUSED_NAME ? 'ce nom de fichier n’est pas permis'
    : 'une erreur inattendue s’est produite';
  return `Impossible d’ouvrir « ${name} » : ${reason}.`;
}

/**
 * Clears what Cirrus left of earlier sessions, at startup: its copies — the files still read-only, as openableCopy leaves
 * them — and the temporaries of a copy cut short (TEMPORARY), whatever their mode, then the emptied folders. A writable
 * file is kept, and its folder with it: an application's « Enregistrer sous » proposes the copy's folder, so it may be
 * the user's (I3 of the final review, a plan defect: « efface ce qu'il peut »). A copy's write right is given back to
 * remove it (Electron's Node refuses to remove a read-only file otherwise); one still open in its application gets its
 * mode back, read-only, for the next startup.
 */
export function cleanCopies(root: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      cleanCopies(p);
      try {
        rmdirSync(p);
      } catch {
        // holds a copy still open, or a file of the user's
      }
      continue;
    }
    let mode: number;
    try {
      mode = lstatSync(p).mode;
    } catch {
      continue;
    }
    if ((mode & 0o200) !== 0 && !e.name.startsWith(TEMPORARY)) continue;
    try {
      chmodSync(p, 0o644);
      unlinkSync(p);
    } catch {
      try {
        chmodSync(p, mode & 0o777);
      } catch {
        // gone after all
      }
    }
  }
}

export interface HistorySummary { created: number | null; modified: number | null; changes: number }

/** A node's history in three figures, for its pop-up: its first and last change, and how many actions made them. */
export function historySummary(rows: ChangeRow[]): HistorySummary {
  let created: number | null = null, modified: number | null = null;
  const actions = new Set<string>();
  for (const r of rows) {
    if (created === null || r.at < created) created = r.at;
    if (modified === null || r.at > modified) modified = r.at;
    actions.add(r.actionId);
  }
  return { created, modified, changes: actions.size };
}
