import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { BIB_MAX_BYTES, bibShort } from '@cirrus/core';
import { testPickOf } from './pick.ts';

/** A .bib read by the main process (plan 4c, D9, task 6): its name and bytes, or why it is not read, in French. */
export type BibFile = { name: string; bytes: Uint8Array } | { refused: string };

/**
 * A .bib the user dropped on the graph's background or chose in the system's dialog: its bytes, `maxBytes` at most
 * (BIB_MAX_BYTES: a larger file cannot be a text of BIB_MAX_CHARS characters, whatever its encoding), or why not. Read
 * as importPaths reads (plan 4a, I1 of the review): a network or device path refused before any access, which would
 * open an SMB connection with the user's credentials; a link not followed (lstat); a folder or what is not a regular
 * file refused. Read by its descriptor, never past maxBytes + 1 bytes: a file grown since its size was read is refused
 * all the same. The interface decodes the bytes (decodeText) and parses them; only this process touches the disk.
 */
export function readBib(path: unknown, maxBytes = BIB_MAX_BYTES): BibFile {
  if (typeof path !== 'string' || path === '') return { refused: 'Lecture refusée : chemin invalide.' };
  const name = basename(path), said = `« ${bibShort(name)} »`;
  const tooLarge = { refused: `${said} fait plus de ${(maxBytes / 2 ** 20).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo : un .bib de cette taille n’est pas lu.` };
  if (/^[\\/]{2}/.test(path)) return { refused: `${said} est sur un chemin réseau ou de périphérique : il n’est pas lu.` };
  try {
    const st = lstatSync(path);
    if (st.isDirectory()) return { refused: `${said} est un dossier : rien n’est importé.` };
    if (!st.isFile()) return { refused: `${said} n’est pas un fichier ordinaire : rien n’est importé.` };
    if (st.size > maxBytes) return tooLarge;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > maxBytes) return tooLarge;
      // A buffer of its own (never Node's shared pool): its bytes alone cross the IPC.
      const buf = Buffer.alloc(size + 1);
      let n = 0;
      for (let r = 0; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0; n += r);
      if (n > maxBytes) return tooLarge;
      return { name, bytes: new Uint8Array(buf.buffer, buf.byteOffset, n) };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // Gone since it was dropped or chosen, held by another program, or forbidden.
    const code = (e as NodeJS.ErrnoException).code;
    return { refused: `${said} ${code === 'ENOENT' || code === 'ENOTDIR' ? 'est introuvable' : 'est illisible'} : rien n’est importé.` };
  }
}

/**
 * CIRRUS_BIB_PICK, the .bib « Importer un fichier .bib… » takes instead of opening the system's dialog: taken only on
 * a test base in a window out of the user's way — with CIRRUS_DATA, and in capture mode or with CIRRUS_BACKGROUND=1
 * (scripts/interface.mjs, the captures), as CIRRUS_PUBLICATIONS_REPLAY (replayDirOf). Never on the user's own base.
 * The rule is testPickOf's, shared with CIRRUS_PDF_PICK (plan 5b, D5).
 */
export const bibPickOf = (env: Record<string, string | undefined>, capture: boolean): string | null => testPickOf(env, 'CIRRUS_BIB_PICK', capture);
