import { readFileSync } from 'node:fs';
import type { State } from '@cirrus/core';
import { filePath } from '@cirrus/store';
import { fileKind } from '../../src/renderer/files/kind.ts';

// What the LaTeX tests share: the texts of a base's .tex, and the wait for what the service does in the background.

/** The texts of the .tex of `s`, by hash, read from the store in `dir` as loadTexTexts would. */
export function texTexts(s: State, dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of s.nodes.values()) for (const f of n.files) if (fileKind(f.name) === 'tex') out.set(f.hash, readFileSync(filePath(dir, f), 'utf8'));
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves once `cond` holds, looked at every 20 ms; throws past `ms`. */
export async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  for (const t0 = performance.now(); !cond(); await sleep(20)) if (performance.now() - t0 > ms) throw new Error('attente trop longue');
}
