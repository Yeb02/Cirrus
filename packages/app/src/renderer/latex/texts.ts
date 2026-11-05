import type { FileRef, State } from '@cirrus/core';
import { decodeText } from '../files/decode.ts';
import { fileKind } from '../files/kind.ts';
import { readHead } from '../files/read.ts';

/** How many .tex are read at once. */
const AT_ONCE = 4;

/**
 * The texts of the .tex files of the nodes outside the trash, by hash, for the registry (plan 4b, D8): those of `have`
 * kept, the others read by cirrus-file: (readHead, decodeText), four at a time; the texts of files no longer there are
 * left out. A .tex longer than `maxBytes` (textViewMaxMb), whose text would be cut, is not read; it counts as empty, as
 * a binary does, and one the store cannot serve (said in the console): the registry never stops at them (Review Focus
 * 5). `signal` gives the reading up, and rejects with its reason.
 */
export async function loadTexTexts(s: State, have: ReadonlyMap<string, string>, maxBytes: number, signal: AbortSignal): Promise<Map<string, string>> {
  signal.throwIfAborted();
  const out = new Map<string, string>(), queued = new Set<string>(), todo: FileRef[] = [];
  for (const n of s.nodes.values()) {
    if (n.trashedAt !== undefined) continue;
    for (const f of n.files) {
      if (fileKind(f.name) !== 'tex' || out.has(f.hash) || queued.has(f.hash)) continue;
      const text = have.get(f.hash);
      if (text !== undefined) out.set(f.hash, text);
      else {
        queued.add(f.hash);
        todo.push(f);
      }
    }
  }
  let next = 0;
  const reader = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      out.set(f.hash, await texText(f, maxBytes, signal));
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, reader));
  return out;
}

/** One .tex's text, '' for one that is too long, binary or unreadable. */
async function texText(f: FileRef, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (f.size > maxBytes) return '';
  try {
    const decoded = decodeText((await readHead(f, maxBytes, signal)).bytes);
    return 'binary' in decoded ? '' : decoded.text;
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn(`« ${f.name} » n’a pas pu être lu pour ses labels : ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

/** Whether two sets of texts hold the same ones (the app keeps the one it has). */
export function sameTexts(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [hash, text] of a) if (b.get(hash) !== text) return false;
  return true;
}
