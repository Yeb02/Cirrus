import { randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, createReadStream, type Dirent, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { FileRef } from '@cirrus/core';
import { type ChangeRow, filePath, importFile } from '@cirrus/store';

/**
 * The nodes' files on the main process's side (plan 4a, D1, D5, D6): the store's blobs served read-only to the
 * interface by the cirrus-file: protocol, with HTTP ranges; paths copied into the store; read-only copies handed to
 * the system's applications.
 */

/** The files' scheme: cirrus-file://blob/<sha256>/<name, encoded by encodeURIComponent>; the name only gives the type. */
export const FILE_SCHEME = 'cirrus-file';
const URL_PREFIX = `${FILE_SCHEME}://blob/`;
const HASH = /^[0-9a-f]{64}$/;
const RANGE = /^bytes=(\d*)-(\d*)$/i;

export type BlobAnswer =
  | { status: 400 | 404 | 416; headers: Record<string, string> }
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
  const bare = (status: 400 | 404 | 416, more?: Record<string, string>): BlobAnswer =>
    ({ status, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': '0', ...more } });
  if (!url.startsWith(URL_PREFIX) || url.includes('\\')) return bare(400);
  // Chromium hands over the query and the fragment too; encodeURIComponent escapes « ? » and « # » in a name.
  const parts = url.slice(URL_PREFIX.length).split(/[?#]/)[0].split('/');
  if (parts.length !== 2 || !HASH.test(parts[0]) || parts[1] === '') return bare(400);
  let name: string;
  try {
    name = decodeURIComponent(parts[1]);
  } catch {
    return bare(400);
  }
  const path = filePath(storeDir, { name, hash: parts[0], size: 0 });
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
  const served = (status: 200 | 206, start: number, end: number): BlobAnswer => ({
    status, path, start, end,
    headers: {
      'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Content-Type': contentTypeOf(name), 'Content-Security-Policy': 'sandbox',
    },
  });
  const m = range === null ? null : RANGE.exec(range.trim());
  const first = m && m[1] !== '' ? Number(m[1]) : null, last = m && m[2] !== '' ? Number(m[2]) : null;
  if (!m || (first === null && last === null) || (first !== null && last !== null && last < first)) return served(200, 0, size - 1);
  // A suffix of n bytes is the last n (all of them if the file is shorter); a suffix of 0, or an empty file, starts at
  // the end: unsatisfiable.
  const start = first ?? Math.max(0, size - last!);
  if (start >= size) return bare(416, { 'Content-Range': `bytes */${size}` });
  return served(206, start, first === null || last === null ? size - 1 : Math.min(last, size - 1));
}

/** The protocol's response (protocol.handle): the range streamed from the disk, never the blob read whole. */
export function blobResponse(storeDir: string, request: Request): Response {
  const a = blobRequest(storeDir, request.url, request.headers.get('range'));
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
 * Opened by Windows, these would run or load code (a .py by Python, a .lnk its target, a .chm its scripts): the explorer
 * shows them instead (plan 4a, D5). Microsoft's list of attachments Outlook blocks (« Blocked attachments in Outlook »,
 * table « File types blocked in Outlook », formerly Level 1, read on 2026-11-04 at
 * https://support.microsoft.com/office/434752e1-02d3-4e90-9124-8b81e49a8519), then the plan's entries missing from it
 * and the other application packages. A fixed security list, not a setting.
 */
const RUNNABLE = new Set([
  'ade', 'adp', 'apk', 'app', 'appcontent-ms', 'application', 'appref-ms', 'appx', 'asp', 'aspx', 'asx', 'bas', 'bat', 'bgi', 'cab', 'cdxml', 'cer',
  'chm', 'cmd', 'cnt', 'com', 'cpl', 'crt', 'csh', 'der', 'diagcab', 'exe', 'fxp', 'gadget', 'grp', 'hlp', 'hpj', 'hta', 'htc', 'img', 'inf', 'ins',
  'iso', 'isp', 'its', 'jar', 'jnlp', 'js', 'jse', 'ksh', 'library-ms', 'lnk', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau', 'mav',
  'maw', 'mcf', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'mht', 'mhtml', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'msi', 'msp',
  'mst', 'msu', 'ops', 'osd', 'pcd', 'pif', 'pl', 'plg', 'prf', 'prg', 'printerexport', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1',
  'psdm1', 'pssc', 'pst', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'reg', 'scf', 'scr', 'sct', 'search-ms', 'settingcontent-ms', 'shb', 'shs', 'theme',
  'tmp', 'udl', 'url', 'vb', 'vbe', 'vbp', 'vbs', 'vhd', 'vhdx', 'vsmacros', 'vsw', 'webpnp', 'website', 'ws', 'wsb', 'wsc', 'wsf', 'wsh', 'xbap', 'xll',
  'xnk',
  'psm1', 'msix', 'msixbundle', 'appxbundle',
]);

export function isRunnable(name: string): boolean {
  return RUNNABLE.has(extensionOf(name));
}

/** A name that is one plain file of a folder: no separator, no stream (« : »), no device, nothing Windows would rewrite. */
function plainName(name: string): boolean {
  if (name === '' || /[<>:"/\\|?*]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return false;
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) < 32) return false;
  return true;
}

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

/**
 * The copy of a blob handed to the system's application (plan 4a, D5), never the store's own file: root/<first 16 hex
 * of the hash>/<name>, marked from the Internet zone and read-only (a stream cannot be written to a read-only file, so
 * the mark comes first). Written under a temporary name then renamed, so a copy found there is whole; it is reused only
 * as it was left: read-only, the blob's size, marked. Otherwise (its flag lifted by hand, written to, its stream
 * removed) it is made again. A name or a hash that would leave `root`, and a blob missing from the store, throw.
 */
export function openableCopy(storeDir: string, ref: FileRef, root: string): string {
  if (!HASH.test(ref.hash) || !plainName(ref.name)) throw new Error('nom de fichier refusé');
  const src = filePath(storeDir, ref);
  const size = statSync(src).size;
  const folder = join(root, ref.hash.slice(0, 16));
  const dest = join(folder, ref.name);
  const there = statSync(dest, { throwIfNoEntry: false });
  if (there && there.size === size && (there.mode & 0o200) === 0 && marked(dest)) return dest;
  if (there) {
    chmodSync(dest, 0o644);
    unlinkSync(dest);
  }
  mkdirSync(folder, { recursive: true });
  const tmp = join(folder, `.copie-${randomBytes(8).toString('hex')}`);
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

/** Why a file did not open, in French: Node's or Windows' own text, in English, follows the colon. */
export function openFailure(e: unknown): string {
  const reason = (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'il manque dans la base' : e instanceof Error ? e.message : String(e);
  return `Impossible d’ouvrir le fichier : ${reason}`;
}

/**
 * Clears the copies of earlier sessions, at startup: every file it can, its write right given back first (Electron's
 * Node refuses to remove a read-only file otherwise), then the emptied folders. A copy still open in its application
 * is left, read-only again, for the next startup.
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
        // holds a copy still open
      }
      continue;
    }
    try {
      chmodSync(p, 0o644);
      unlinkSync(p);
    } catch {
      try {
        chmodSync(p, 0o444);
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
