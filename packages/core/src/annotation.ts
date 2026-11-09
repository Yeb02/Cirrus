import type { Anchor } from './model.ts';

// PDF annotations (plan 4c, D1): a node that carries an anchor. Its creation is createAnnotation (commands.ts).

/** An anchor's bounds: its rectangles (a passage cut at the end of its page, D3) and its text. */
export const ANCHOR_MAX_RECTS = 500;
export const ANCHOR_MAX_TEXT = 20_000;
/** An annotation's title, in characters, before « … »: the default of the setting annotationTitleChars (plan 4c). */
export const ANNOTATION_TITLE_CHARS = 80;

/** A SHA-256 as the store names its blobs (files.ts: digest('hex'), lower case). */
const HASH = /^[0-9a-f]{64}$/;

/**
 * A plain object, neither null nor an array: what a reader of untrusted JSON checks before its fields. Exported for the
 * server's and the app's readers too (short review after plan 5a, D4: one copy instead of five).
 */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRect = (r: unknown): boolean => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite);

/**
 * Whether `a` is an anchor the state can hold: a PDF's node and a file name, not empty; a hash of 64 hexadecimal
 * digits; a page, an integer from 1; 1 to ANCHOR_MAX_RECTS rectangles of four finite numbers; at most ANCHOR_MAX_TEXT
 * characters of text. Checked by the state for every record it stores (checkRecord) and by the snapshot's decoder.
 */
export function validAnchor(a: unknown): a is Anchor {
  if (!isObject(a)) return false;
  const { pdf, file, hash, page, rects, text } = a;
  return typeof pdf === 'string' && pdf !== '' && typeof file === 'string' && file !== '' && typeof hash === 'string' && HASH.test(hash)
    && Number.isSafeInteger(page) && (page as number) >= 1
    && Array.isArray(rects) && rects.length >= 1 && rects.length <= ANCHOR_MAX_RECTS && rects.every(isRect)
    && typeof text === 'string' && text.length <= ANCHOR_MAX_TEXT;
}

/**
 * An annotation's title (D1): the start of its passage on one line (a selection breaks at each line of the page), its
 * first `max` characters, then « … » when there is more. Characters, not UTF-16 units: a letter outside the BMP is
 * never cut in two.
 */
export function annotationTitle(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  // Shorter in units than `max`, it is shorter in characters too.
  if (line.length <= max) return line;
  let head = '', n = 0;
  for (const ch of line) {
    if (n === max) return `${head.trimEnd()}…`;
    head += ch;
    n++;
  }
  return line;
}
