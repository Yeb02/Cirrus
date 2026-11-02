import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
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
  closeSync(out);
  const ref: FileRef = { name: basename(srcPath), hash: hash.digest('hex'), size };
  const dest = filePath(storeDir, ref);
  if (existsSync(dest)) {
    rmSync(tmp);
  } else {
    mkdirSync(join(filesDir, ref.hash.slice(0, 2)), { recursive: true });
    renameSync(tmp, dest);
  }
  return ref;
}
