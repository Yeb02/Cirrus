import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';

/**
 * `value` as JSON in `file` (JSON.stringify's `space`), written whole to a temporary file beside it, then renamed over
 * it: a crash never leaves half a file. `sync`: the temporary file is flushed to the disk before the rename, so that a
 * power cut leaves the old file or the new one, never an empty one. The one writer of the small JSON files the
 * settings and the synchronisation keep beside the base (short review after plan 5a, D4): settings.json,
 * settings-pending.json, serveur.json, a staged base's pc.json and mark, all synced; downloads.json not — rewritten at
 * each batch received that brings files, and losing it only leaves those files to come at their first opening (R9).
 * Costs the text, and with `sync` one flush.
 */
export function writeJsonAtomic(file: string, value: unknown, o: { sync: boolean; space?: number }): void {
  const tmp = `${file}.${process.pid}.tmp`, fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(value, null, o.space), 'utf8');
    if (o.sync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
