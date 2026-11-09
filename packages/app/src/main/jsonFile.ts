import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * `value` as JSON in `file` (JSON.stringify's `space`), written whole to a temporary file beside it, then renamed over
 * it: a crash never leaves half a file. `sync`: the temporary file is flushed to the disk before the rename, so that a
 * power cut leaves the old file or the new one, never an empty one. The one writer of the small JSON files the
 * settings and the synchronisation keep beside the base (short review after plan 5a, D4): settings.json,
 * settings-pending.json, serveur.json, a staged base's pc.json and mark, all synced; downloads.json not — rewritten at
 * each batch received that brings files, and losing it only leaves those files to come at their first opening (R9).
 * A value JSON cannot write (a BigInt, a cycle) throws before any file is opened; a write or a rename refused (a full
 * disk; on Windows, the target held by an antivirus or the indexer) removes the temporary file, at best, so that none
 * piles up beside the base (re-review of the fixes, N5). Costs the text, and with `sync` one flush.
 */
export function writeJsonAtomic(file: string, value: unknown, o: { sync: boolean; space?: number }): void {
  const text = JSON.stringify(value, null, o.space), tmp = `${file}.${process.pid}.tmp`, fd = openSync(tmp, 'w');
  try {
    try {
      writeFileSync(fd, text, 'utf8');
      if (o.sync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // left beside the base: the error that matters is the write's
    }
    throw e;
  }
}
