import { parseIdentifier, type PublicationId } from '@cirrus/sources/identifier';

/**
 * A PDF's own identifier (plan 4c, D8), looked for in what pdf.js reads of it: its metadata (the information dictionary,
 * the XMP), then the text of its first pages. Pure: the dialog hands in what pdf.js gave (PublicationDialog). Every
 * candidate is checked by parseIdentifier, as the main process checks the text it is sent.
 */

/** The text read at most, and each metadata value: a hostile PDF's pages are bounded (fixed bounds of security). */
export const MAX_TEXT_CHARS = 200_000;
const MAX_META_CHARS = 2000;
const MAX_META_KEYS = 100;
/** The longest DOI or arXiv identifier taken: real ones are a few dozen characters. */
const MAX_ID_CHARS = 300;

/** A DOI in running text: « 10. », its registrant, « / », then up to a blank or a quote (trimmed below). */
const DOI = /10\.\d{4,9}\/[^\s"'’”]{1,300}/g;
/** An address in running text (a link to an arXiv page, to a DOI's resolver). */
const LINK = /https?:\/\/[^\s"'<>’”]{1,500}/gi;
/** What follows « arXiv: »: an identifier, then, in arXiv's stamp in the margin, its category in brackets. */
const AFTER_ARXIV = /\s{0,4}([^\s[\]]{1,40})(\s{0,10}\[[\w.-]{1,20}\])?/y;

/** A candidate without the punctuation that ends a sentence, nor a closing bracket it does not open. */
function trimmed(c: string): string {
  for (;;) {
    const last = c[c.length - 1];
    if (last === undefined) return c;
    if ('.,;:!?'.includes(last)) { c = c.slice(0, -1); continue; }
    const open = ({ ')': '(', ']': '[', '}': '{', '>': '<' } as Record<string, string>)[last];
    if (open !== undefined && c.split(open).length <= c.split(last).length - 1) { c = c.slice(0, -1); continue; }
    return c;
  }
}

/** The identifiers « arXiv:… » of a text, in order: those of arXiv's stamp (`stamp`), or all. */
function arxivMentions(text: string, stamp: boolean): PublicationId[] {
  const out: PublicationId[] = [];
  const lower = text.toLowerCase();
  for (let at = lower.indexOf('arxiv:'); at >= 0; at = lower.indexOf('arxiv:', at + 6)) {
    AFTER_ARXIV.lastIndex = at + 6;
    const m = AFTER_ARXIV.exec(text);
    if (!m || (stamp && m[2] === undefined)) continue;
    const id = parseIdentifier(`arXiv:${trimmed(m[1])}`);
    if (id) out.push(id);
    if (stamp) break;
  }
  return out;
}

/** The first DOI of a text that parseIdentifier takes (arXiv's own DOI giving its article). */
function firstDoi(text: string): PublicationId | null {
  for (const m of text.matchAll(DOI)) {
    const id = parseIdentifier(`doi:${trimmed(m[0]).slice(0, MAX_ID_CHARS)}`);
    if (id) return id;
  }
  return null;
}

/** The first link of a text to an arXiv page or a DOI's resolver. */
function firstLink(text: string): PublicationId | null {
  for (const m of text.matchAll(LINK)) {
    const id = parseIdentifier(trimmed(m[0]));
    if (id) return id;
  }
  return null;
}

/**
 * The identifier a PDF gives of itself (D8), or null. In this order:
 * - its metadata (`meta`: the information dictionary's and the XMP's values), those whose name says DOI first: a DOI,
 *   then an arXiv identifier;
 * - in `text` (its first pages): arXiv's stamp in the margin (« arXiv:1706.03762v7 [cs.CL] … »), which no other PDF has;
 * - the first DOI, which a publisher prints on the first page;
 * - another « arXiv:… », then a link to an arXiv page or a DOI.
 * A DOI cited further on comes after the document's own. Bounded: MAX_TEXT_CHARS of text, each value 2 000 characters.
 */
export function findIdentifier(text: string, meta: Record<string, string>): { doi: string } | { arxiv: string } | null {
  const values = Object.entries(meta).slice(0, MAX_META_KEYS)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .sort(([a], [b]) => Number(!/doi/i.test(a)) - Number(!/doi/i.test(b)))
    .map(([, v]) => v.slice(0, MAX_META_CHARS));
  for (const v of values) {
    const id = firstDoi(v);
    if (id) return id;
  }
  for (const v of values) {
    const id = arxivMentions(v, false)[0];
    if (id) return id;
  }
  const t = text.slice(0, MAX_TEXT_CHARS);
  return arxivMentions(t, true)[0] ?? firstDoi(t) ?? arxivMentions(t, false)[0] ?? firstLink(t);
}
