import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { plainName } from '@cirrus/core';
import { MAX_PAIR_CODE_CHARS } from './bounds.ts';

// The download page (plan 9, D5): what a PC without Cirrus yet opens, at the address `jumeler` prints
// (https://<nom>/installer). GET, a form without script; POST, its pairing code, and for a good one the official
// installer, which version.json names in <data>/versions/ (D4). Its route, the code's check and the bounds of its body:
// server.ts.

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

/** A manifest that names nothing the server can serve: why, for the server's log (French, as its other messages). */
export class ManifestError extends Error {}

/** The official installer, opened: its name, its size, and the file, which its reader closes. */
export interface OpenInstaller { file: string; size: number; handle: FileHandle }

/**
 * The official installer, as <data>/versions/version.json names it ({ version, file, sha512, size, date }, D4: its
 * signature checked by the update script that lays it there): `file` a plain name (plainName: no separator, no « .. »,
 * no drive, so nothing outside versions/) and well-formed (no lone surrogate, which no header could carry); `size` a
 * positive integer; the file a regular one of versions/ — not a folder, not a link, opened without following one where
 * the system can — of exactly `size` bytes, so that the Content-Length told is the one sent. Opened here, its size read
 * on the handle: replaced while it streams, the file served stays the one checked. Null when nothing is published (no
 * manifest); ManifestError, with why, for a manifest that names nothing it can serve.
 */
export async function openInstaller(dataDir: string): Promise<OpenInstaller | null> {
  const dir = join(dataDir, VERSIONS);
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ManifestError(`${MANIFEST} illisible : ${(e as Error).message}`);
  }
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    throw new ManifestError(`${MANIFEST} n’est pas du JSON.`);
  }
  const { file, size } = (typeof m === 'object' && m !== null && !Array.isArray(m) ? m : {}) as Record<string, unknown>;
  if (typeof file !== 'string' || !plainName(file) || /\p{Cs}/u.test(file)) {
    throw new ManifestError(`${MANIFEST} nomme ${JSON.stringify(file) ?? 'rien'} : un nom de fichier seul est attendu, dans ${VERSIONS}/.`);
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new ManifestError(`${MANIFEST} donne une taille invalide : ${JSON.stringify(size) ?? 'aucune'}.`);
  const path = join(dir, file);
  const missing = () => new ManifestError(`${MANIFEST} nomme ${JSON.stringify(file)}, qui n’est pas un fichier de ${VERSIONS}/ (absent, dossier ou lien).`);
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile()) throw missing();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) throw missing();
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw missing();
    if (opened.size !== size) throw new ManifestError(`${MANIFEST} annonce ${size} octets pour ${JSON.stringify(file)}, qui en a ${opened.size}.`);
  } catch (e) {
    await handle.close();
    throw e;
  }
  return { file, size, handle };
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
