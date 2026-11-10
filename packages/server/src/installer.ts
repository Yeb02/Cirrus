import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { plainName } from '@cirrus/core';
import { MAX_PAIR_CODE_CHARS, MAX_VERSION_FILE_BYTES } from './bounds.ts';

// The download page (plan 9, D5): what a PC without Cirrus yet opens, at the address `jumeler` prints
// (https://<nom>/installer). GET, a form without script; POST, its pairing code, and for a good one the official
// installer, which version.json names in <data>/versions/ (D4). Its route, the code's check and the bounds of its body:
// server.ts. The files of versions/ are opened here, for the page and for the signed updates (task 4: GET /versions/*,
// the official version /hello says): each one checked as it is opened (openChecked).

/**
 * The page's headers: HTML in UTF-8, never kept nor sniffed; a CSP that lets nothing run nor load — its own inline
 * style only —, its form post only here, no <base>, no frame; X-Frame-Options for the browsers that ignore
 * frame-ancestors; no referrer.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/** What the page says to a code that is not a pending one: wrong, expired, burnt or spent. */
export const WRONG_CODE = 'Code inconnu ou expiré.';
/** What it says to a good code when no installer can be served: none published yet, or a manifest broken. */
export const NOTHING_PUBLISHED = 'Aucune version n’est encore publiée sur ce serveur.';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** A text as HTML shows it, in an element or a quoted attribute: its five special characters escaped. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * The page, in French: its title, the line that says what to type, the field and its button; `message` above the
 * field, escaped. Nothing the client sent is ever shown: not even the code typed.
 */
export function installerPage(message: string | null = null): string {
  const said = message === null ? '' : `<p class="message">${escapeHtml(message)}</p>\n`;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cirrus : installer</title>
<style>
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
h1 { font-size: 1.5rem; font-weight: 600; }
label { display: block; margin-bottom: 0.75rem; }
.message { font-weight: 600; border-left: 3px solid currentColor; padding-left: 0.75rem; }
input, button { font: inherit; padding: 0.4rem 0.6rem; }
input { display: block; width: 100%; box-sizing: border-box; margin-bottom: 0.75rem; letter-spacing: 0.05em; }
</style>
</head>
<body>
<h1>Cirrus : installer</h1>
<form method="post" action="/installer" accept-charset="utf-8">
<label for="code">Tape le code de jumelage que t’a donné <code>jumeler</code> sur le serveur.</label>
${said}<input id="code" name="code" type="text" required autofocus autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="${MAX_PAIR_CODE_CHARS}">
<button type="submit">Télécharger l’installateur</button>
</form>
</body>
</html>
`;
}

/** The installer's folder in the server's data, laid out by its update script (D6), and the manifest there (D4). */
const VERSIONS = 'versions';
const MANIFEST = 'version.json';

/**
 * A file of versions/ that cannot be served, or a manifest that names nothing the server can serve: why, for the
 * server's log (French, as its other messages).
 */
export class ManifestError extends Error {}

/** A file of versions/, opened as it was checked: its handle, which its reader closes, and its size, read on it. */
interface Checked { handle: FileHandle; size: number }

/**
 * A file of versions/, `name` a plain name there, opened as it was checked (task 4, after the review of task 5): a
 * regular file — not a folder, not a link (lstat), opened without following one where the system can (O_NOFOLLOW;
 * Windows has none) —; the file opened the one checked, the same device and inode read on the handle (bigint: exact),
 * so that a name swapped for a link between the check and the opening is refused; and its only name (nlink 1), so
 * that a hard link to a file elsewhere — serveur.db, anything the server's user reads — is never served. Null when there
 * is no such file; ManifestError, with why, for one that is not served.
 */
async function openChecked(name: string, dataDir: string): Promise<Checked | null> {
  const path = join(dataDir, VERSIONS, name);
  let st: BigIntStats;
  try {
    st = await lstat(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ManifestError(`${VERSIONS}/${name} illisible : ${(e as Error).message}`);
  }
  const refused = (why: string) => new ManifestError(`${VERSIONS}/${name} n’est pas servi : ${why}.`);
  if (!st.isFile()) throw refused('ce n’est pas un fichier ordinaire (dossier ou lien)');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((e: Error) => { throw refused(`ouverture impossible (${e.message})`); });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) throw refused('remplacé entre sa vérification et son ouverture');
    if (opened.nlink !== 1n) throw refused(`il a ${opened.nlink} noms (un lien dur)`);
    return { handle, size: Number(opened.size) };
  } catch (e) {
    await handle.close();
    throw e;
  }
}

/** A small file of versions/ (version.json, its signature, latest.yml), read whole from the handle checked; null without it. */
export async function readVersionFile(dataDir: string, name: string): Promise<Buffer | null> {
  const checked = await openChecked(name, dataDir);
  if (!checked) return null;
  try {
    if (checked.size > MAX_VERSION_FILE_BYTES) throw new ManifestError(`${VERSIONS}/${name} fait ${checked.size} octets, plus que ${MAX_VERSION_FILE_BYTES}.`);
    const bytes = await checked.handle.readFile();
    if (bytes.length > MAX_VERSION_FILE_BYTES) throw new ManifestError(`${VERSIONS}/${name} a grandi pendant sa lecture.`);
    return bytes;
  } finally {
    await checked.handle.close();
  }
}

/** A version as the CI makes them (D3: 0.1.<n>): three numbers, without a leading zero, nine digits at most each. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** <data>/versions/version.json, parsed: the object it holds; ManifestError otherwise; null without it. */
async function readManifest(dataDir: string): Promise<Record<string, unknown> | null> {
  const bytes = await readVersionFile(dataDir, MANIFEST);
  if (!bytes) return null;
  let m: unknown;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ManifestError(`${MANIFEST} n’est pas du JSON.`);
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new ManifestError(`${MANIFEST} ne tient pas un objet.`);
  return m as Record<string, unknown>;
}

/**
 * The official version this server serves (D4: /hello says it), version.json's `version` when it is one (VERSION); null
 * without a manifest. Its signature is not checked here: the update script checked it before laying it down (D6), and
 * the app checks it again before anything (task 4) — this only tells a PC to look. A manifest that holds none is written
 * to the server's log, and gives null.
 */
export async function officialVersion(dataDir: string): Promise<string | null> {
  try {
    const version = (await readManifest(dataDir))?.version;
    if (version === undefined) return null;
    if (typeof version === 'string' && VERSION.test(version)) return version;
    throw new ManifestError(`${MANIFEST} donne une version invalide : ${JSON.stringify(version).slice(0, 40)}.`);
  } catch (e) {
    if (!(e instanceof ManifestError)) throw e;
    console.warn(`Version officielle : ${e.message}`);
    return null;
  }
}

/** The official installer, opened: its name, its size, and the file, which its reader closes. */
export interface OpenInstaller { file: string; size: number; handle: FileHandle }

/**
 * The official installer, as <data>/versions/version.json names it ({ version, file, sha512, size, date }, D4: its
 * signature checked by the update script that lays it there): `file` a plain name (plainName: no separator, no « .. »,
 * no drive, so nothing outside versions/) and well-formed (no lone surrogate, which no header could carry); `size` a
 * positive integer; the file a regular one of versions/, opened as it was checked (openChecked: not a folder, not a
 * link, not a hard link, not swapped), of exactly `size` bytes, so that the Content-Length told is the one sent. Its
 * size read on the handle: replaced while it streams, the file served stays the one checked. Null when nothing is
 * published (no manifest); ManifestError, with why, for a manifest that names nothing it can serve.
 */
export async function openInstaller(dataDir: string): Promise<OpenInstaller | null> {
  const m = await readManifest(dataDir);
  if (!m) return null;
  const { file, size } = m;
  if (typeof file !== 'string' || !plainName(file) || /\p{Cs}/u.test(file)) {
    throw new ManifestError(`${MANIFEST} nomme ${JSON.stringify(file) ?? 'rien'} : un nom de fichier seul est attendu, dans ${VERSIONS}/.`);
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new ManifestError(`${MANIFEST} donne une taille invalide : ${JSON.stringify(size) ?? 'aucune'}.`);
  const checked = await openChecked(file, dataDir);
  if (!checked) throw new ManifestError(`${MANIFEST} nomme ${JSON.stringify(file)}, absent de ${VERSIONS}/.`);
  if (checked.size !== size) {
    await checked.handle.close();
    throw new ManifestError(`${MANIFEST} annonce ${size} octets pour ${JSON.stringify(file)}, qui en a ${checked.size}.`);
  }
  return { file, size, handle: checked.handle };
}

/**
 * The Content-Disposition of the installer `file`: an attachment, its name in ASCII for the old clients (any other
 * character, and « " », « \ », « % », as « _ ») and in full by RFC 5987's filename* (UTF-8, percent-encoded but for
 * its attr-chars).
 */
export function contentDisposition(file: string): string {
  const ascii = file.replace(/[^ -~]|["\\%]/gu, '_');
  const encoded = encodeURIComponent(file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
