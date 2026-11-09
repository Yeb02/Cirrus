import type { FileRef } from '@cirrus/core';
import { decodeText } from '../../files/decode.ts';
import { MB, readHead } from '../../files/read.ts';

// A .tex's text as its editors read it: the .tex full screen's (TexWorkbench) and the comparison's (CompareView, plan 5b,
// D7) — one reading for both (fix round 1 of the review of task 5).

/**
 * A .tex's bytes as the editor reads them (decodeText: UTF-8 with or without a BOM, Windows-1252, UTF-16), its line
 * breaks « \n »: a binary, or a head read of a longer file, is said so.
 */
export function texTextOf(bytes: Uint8Array, truncated: boolean): { text: string } | { binary: true } | { tooLong: true } {
  const d = decodeText(bytes, truncated);
  if ('binary' in d) return { binary: true };
  if (truncated) return { tooLong: true };
  return { text: d.text.replace(/\r\n?/g, '\n') };
}

/** A .tex read by readHead, up to `maxMb` (textViewMaxMb), and decoded (texTextOf). A file the store cannot serve rejects with readHead's ReadError. */
export async function readTexText(file: FileRef, maxMb: number, signal?: AbortSignal): Promise<{ text: string } | { binary: true } | { tooLong: true }> {
  const { bytes, truncated } = await readHead(file, maxMb * MB, signal);
  return texTextOf(bytes, truncated);
}
