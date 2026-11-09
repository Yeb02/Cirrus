import { type FileRef, fileNameKey, isCopyOf } from '@cirrus/core';

/** What a drop does to a node's files: the new list, and the names, as they read in it, added, replaced or left as they were. */
export interface Merge { files: FileRef[]; added: string[]; replaced: string[]; unchanged: string[] }

/**
 * What two names are compared by: Unicode NFC (an « é » an archive decomposed is the composed one), then the case, the
 * French way — the core's rule, which the synchronisation's merge of files shares (plan 5a, D4).
 */
export const nameKey = fileNameKey;

/** Whether two names are one file's (Review Focus 1): Windows ignores the case, and the user sees no normalization. */
export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/** « a.txt » numbered n: « a (n).txt », before the extension; a name whose only dot leads it (« .env ») has none. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/**
 * A drop merged into a node's files (spec 5.2, Review Focus 1). A name already there (sameName) is replaced in its place
 * and takes the new spelling, unless the content is the same (same hash): unchanged, the old spelling kept. A new name
 * goes at the end. Two files of one name in the same drop: the next is numbered « (2) », « (3) »…, the first number that
 * no file of the drop is called, then merges like any other; so the same drop twice changes nothing.
 */
export function mergeFiles(existing: FileRef[], incoming: FileRef[]): Merge {
  const out: Merge = { files: [...existing], added: [], replaced: [], unchanged: [] };
  const at = new Map<string, number>();
  for (let i = existing.length - 1; i >= 0; i--) at.set(nameKey(existing[i].name), i); // the first of two alike, should there be
  const dropped = new Set(incoming.map((f) => nameKey(f.name)));
  const given = new Set<string>();
  for (const f of incoming) {
    let name = f.name, key = nameKey(name);
    if (given.has(key)) {
      for (let n = 2; ; n++) {
        name = numbered(f.name, n);
        key = nameKey(name);
        if (!given.has(key) && !dropped.has(key)) break;
      }
    }
    given.add(key);
    const i = at.get(key);
    if (i === undefined) {
      out.files.push(name === f.name ? f : { ...f, name });
      out.added.push(name);
    } else if (out.files[i].hash === f.hash) out.unchanged.push(out.files[i].name);
    else {
      out.files[i] = name === f.name ? f : { ...f, name };
      out.replaced.push(name);
    }
  }
  return out;
}

/**
 * The .tex of which `copy` is the conflict copy (plan 5b, D7), among its node's `files`: the one whose name the copy's
 * is « nom (conflit du AAAA-MM-JJ HHhMM).tex » of (isCopyOf; « (2) » after it when that name was taken). Null when there
 * is none — the original renamed or removed since, `copy` no copy at all — and for a file that is not a .tex: only a
 * .tex is compared.
 */
export function conflictOriginal(files: readonly FileRef[], copy: FileRef): FileRef | null {
  if (!/\.tex$/i.test(copy.name)) return null;
  return files.find((f) => f !== copy && /\.tex$/i.test(f.name) && isCopyOf(copy.name, nameKey(f.name))) ?? null;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Why `name` cannot name a file of a node holding `files`, in French; null when it can. Refused: what Windows refuses or
 * rewrites (the names the main process will not copy for the system's applications, openableCopy) and another file's
 * name (sameName). `except`: the file being renamed, by its exact name, which may keep its name in another case.
 */
export function checkFileName(name: string, files: FileRef[], except?: string): string | null {
  if (name === '') return 'Le nom ne peut pas être vide.';
  for (const c of name) {
    if (c.charCodeAt(0) < 32) return 'Le nom ne peut pas contenir de caractère de contrôle.';
    if ('<>:"/\\|?*'.includes(c)) return `Le caractère « ${c} » n’est pas permis dans un nom de fichier.`;
  }
  if (/[. ]$/.test(name)) return 'Le nom ne peut pas finir par un point ou un espace.';
  if (RESERVED.test(name)) return `« ${name} » est un nom réservé par Windows.`;
  const other = files.find((f) => f.name !== except && sameName(f.name, name));
  return other ? `Ce nœud a déjà un fichier « ${other.name} ».` : null;
}
