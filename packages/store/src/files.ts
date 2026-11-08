import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FileRef } from '@cirrus/core';

const CHUNK = 1 << 20;

/** The blob's path: files/<first two hex>/<sha256>, a neutral name whatever the original was called. */
export function filePath(storeDir: string, ref: FileRef): string {
  return join(storeDir, 'files', ref.hash.slice(0, 2), ref.hash);
}

/**
 * Copies a file into the store (spec 5.2): the node keeps its own copy, so editing or deleting the original changes
 * nothing. One pass hashes and writes a temporary file, which is renamed into place, or dropped when the same content
 * is already stored.
 */
export function importFile(storeDir: string, srcPath: string): FileRef {
  const filesDir = join(storeDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const tmp = join(filesDir, `.import-${randomBytes(8).toString('hex')}`);
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  let size = 0;
  const src = openSync(srcPath, 'r');
  const out = openSync(tmp, 'w');
  try {
    for (let n; (n = readSync(src, buf, 0, CHUNK, null)) > 0; size += n) {
      hash.update(buf.subarray(0, n));
      writeSync(out, buf, 0, n);
    }
  } catch (e) {
    closeSync(out);
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    closeSync(src);
  }
  // On disk before the base can refer to it: after a power cut, a reference never points at a truncated copy.
  fsyncSync(out);
  closeSync(out);
  const ref: FileRef = { name: basename(srcPath), hash: hash.digest('hex'), size };
  place(storeDir, ref, tmp);
  return ref;
}

/** The temporary file `tmp`, written and synced, renamed into place as the blob of `ref`; dropped when that blob is stored already. */
function place(storeDir: string, ref: FileRef, tmp: string): void {
  const dest = filePath(storeDir, ref);
  if (existsSync(dest)) {
    rmSync(tmp);
  } else {
    mkdirSync(join(storeDir, 'files', ref.hash.slice(0, 2)), { recursive: true });
    renameSync(tmp, dest);
  }
}

/**
 * Bytes made by the app (plan 4b: a .tex saved from its editor) stored as `name`, with importFile's guarantees: a
 * temporary file synced to the disk then renamed into place, nothing written when the same content is stored already.
 */
export function storeBytes(storeDir: string, name: string, bytes: Uint8Array): FileRef {
  const ref: FileRef = { name, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  if (existsSync(filePath(storeDir, ref))) return ref;
  const filesDir = join(storeDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const tmp = join(filesDir, `.import-${randomBytes(8).toString('hex')}`);
  const out = openSync(tmp, 'w');
  try {
    for (let at = 0; at < bytes.length; ) at += writeSync(out, bytes, at, bytes.length - at);
    fsyncSync(out);
  } catch (e) {
    closeSync(out);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(out);
  place(storeDir, ref, tmp);
  return ref;
}

/**
 * storeBytes without holding the process (plan 4c, task 6: a .bib's thousands of entries, a file each): the same
 * temporary file synced then renamed into place, nothing written when the same content is stored already, by the file
 * system's thread pool, so that several run at once. Two of the same content at once both end on that one blob: a
 * rename that finds it there already drops its temporary. A temporary the antivirus holds a moment after it is closed
 * (EPERM, EBUSY, EACCES) is renamed again, RENAME_TRIES times at most, a short pause between (as graceful-fs does;
 * review of task 6, M5); a temporary that cannot be removed never hides a blob that is there.
 */
export async function storeBytesAsync(storeDir: string, name: string, bytes: Uint8Array): Promise<FileRef> {
  const ref: FileRef = { name, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  const dest = filePath(storeDir, ref);
  if (existsSync(dest)) return ref;
  const filesDir = join(storeDir, 'files');
  await mkdir(filesDir, { recursive: true });
  const tmp = join(filesDir, `.import-${randomBytes(8).toString('hex')}`);
  const out = await open(tmp, 'w');
  try {
    await out.writeFile(bytes);
    await out.sync();
  } catch (e) {
    await out.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await out.close();
  await placeAsync(storeDir, ref.hash, tmp);
  return ref;
}

/**
 * The temporary `tmp`, written and synced, renamed into place as the blob of `hash`, without holding the process: a
 * rename that finds the blob there already drops its temporary; one the antivirus holds a moment is tried again (see
 * storeBytesAsync).
 */
async function placeAsync(storeDir: string, hash: string, tmp: string): Promise<void> {
  const dest = join(storeDir, 'files', hash.slice(0, 2), hash);
  await mkdir(join(storeDir, 'files', hash.slice(0, 2)), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, dest);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < RENAME_TRIES && HELD.has(code ?? '') && !existsSync(dest)) {
        await new Promise((r) => setTimeout(r, RENAME_PAUSE_MS * attempt));
        continue;
      }
      await rm(tmp, { force: true }).catch(() => {});
      if (existsSync(dest)) return;
      throw e;
    }
  }
}

/** A hash as the store names its blobs: 64 lower-case hexadecimal digits. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * Every blob the store holds (files/<first two hex>/<hash>), its temporaries and anything else aside: what a PC sends
 * when it seeds an empty server, old versions included (plan 5a, task 5, D7). Lists the folders, reads no file.
 */
export function storedHashes(storeDir: string): string[] {
  const root = join(storeDir, 'files'), out: string[] = [];
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const d of list(root)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const name of list(join(root, d))) if (HASH.test(name) && name.startsWith(d)) out.push(name);
  }
  return out;
}

/** Bytes received that the store refuses (receiveBlob): more than allowed (`tooBig`), or not those of their hash. */
export class BlobError extends Error {
  readonly tooBig: boolean;

  constructor(message: string, tooBig: boolean) {
    super(message);
    this.tooBig = tooBig;
  }
}

/**
 * Bytes received from elsewhere (plan 5a: a file a PC sends to the server, one a PC downloads), kept as the blob of
 * `hash` only once checked: streamed into a temporary while hashed, `maxBytes` at most, then synced and renamed into
 * place, as storeBytesAsync does. A hash that is not one, more bytes than `maxBytes`, bytes of another hash: BlobError,
 * in French, and nothing is kept, the temporary removed. A blob already there is kept as it is. Returns the size.
 */
export async function receiveBlob(storeDir: string, hash: string, source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ size: number }> {
  if (!HASH.test(hash)) throw new BlobError('Empreinte mal formée : 64 chiffres hexadécimaux en minuscules attendus.', false);
  const filesDir = join(storeDir, 'files');
  await mkdir(filesDir, { recursive: true });
  const tmp = join(filesDir, `.import-${randomBytes(8).toString('hex')}`);
  const out = await open(tmp, 'w');
  const digest = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new BlobError(`Fichier trop gros : au plus ${maxBytes} octets.`, true);
      digest.update(chunk);
      for (let at = 0; at < chunk.length; ) at += (await out.write(chunk, at, chunk.length - at)).bytesWritten;
    }
    if (digest.digest('hex') !== hash) throw new BlobError('Les octets reçus ne correspondent pas à leur empreinte : rien n’est gardé.', false);
    await out.sync();
  } catch (e) {
    await out.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await out.close();
  if (existsSync(join(filesDir, hash.slice(0, 2), hash))) await rm(tmp, { force: true });
  else await placeAsync(storeDir, hash, tmp);
  return { size };
}

/** The errors of a file another program holds a moment (the antivirus scanning it): its rename is tried again. */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** A temporary's renames at most, and the pause before the next one, times the attempt (fixed bounds of the store). */
const RENAME_TRIES = 3;
const RENAME_PAUSE_MS = 30;
