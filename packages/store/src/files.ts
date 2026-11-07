import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
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
 * rename that finds it there already drops its temporary.
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
  await mkdir(join(filesDir, ref.hash.slice(0, 2)), { recursive: true });
  try {
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    if (!existsSync(dest)) throw e;
  }
  return ref;
}
