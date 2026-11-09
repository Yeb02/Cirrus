import { decodeEntities } from './csl.ts';
import { MAX_ADDRESS_CHARS, MAX_IDENTIFIER_CHARS } from './identifier.ts';

/**
 * A page's citation tags (plan 5b, D3): the <meta> tags of the Highwire standard, which OpenReview, PMLR, NeurIPS's
 * proceedings, the ACM, Springer and many others write in their articles' pages. The page is read as text, never as
 * code, without an HTML parser (no dependency): its `<meta` tags found by `indexOf`, each tag's attributes read by a
 * scanner that goes forward only. Linear in the page's length whatever it holds (Review Focus 1: a hostile page), and
 * the page is no longer than publicationMaxKb, which openFetch read at most.
 */
export interface CitationMeta {
  /** `citation_doi`: the text the page gives (a DOI, « doi:… », a resolver's link), which parseIdentifier then reads. */
  doi?: string;
  /** `citation_arxiv_id`. */
  arxiv?: string;
  /** `citation_pdf_url`, resolved against the page's address: an https address (an http one is asked in https). */
  pdfUrl?: string;
}

/** A tag longer than this is none of ours (a long abstract in `citation_abstract`, or a trap): skipped whole. */
const MAX_TAG_CHARS = 8192;
const NAMES = new Map<string, keyof CitationMeta>([['citation_doi', 'doi'], ['citation_arxiv_id', 'arxiv'], ['citation_pdf_url', 'pdfUrl']]);

const blank = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * The attributes of a tag's inside (what follows « <meta », up to its « > »): names lower case, values raw, the first
 * of a name kept. Quoted by « " » or « ' », or bare up to a blank. Each character is looked at a bounded number of times.
 */
function attributesOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = tag.length;
  let i = 0;
  while (i < n) {
    while (i < n && (blank(tag[i]) || tag[i] === '/')) i++;
    const start = i;
    while (i < n && !blank(tag[i]) && tag[i] !== '/' && tag[i] !== '=') i++;
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && blank(tag[i])) i++;
    let value = '';
    if (tag[i] === '=') {
      i++;
      while (i < n && blank(tag[i])) i++;
      const q = tag[i];
      if (q === '"' || q === '\'') {
        const end = tag.indexOf(q, i + 1);
        value = tag.slice(i + 1, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        const from = i;
        while (i < n && !blank(tag[i])) i++;
        value = tag.slice(from, i);
      }
    } else if (i === start) {
      // A character that starts no name (a stray « = » or quote): stepped over.
      i++;
    }
    if (name !== '' && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** The address of the page's PDF: resolved against the page, http made https, anything else dropped (never followed). */
function pdfUrlOf(value: string, pageUrl: string | undefined): string | undefined {
  if (value.length > MAX_ADDRESS_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(value, pageUrl);
  } catch {
    return undefined;
  }
  // An http link of a page (PMLR's older ones) is asked in https: the only scheme of the open web (D3).
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.protocol === 'https:' ? url.href : undefined;
}

/**
 * The citation tags of `html` (plan 5b, D3): the first `citation_doi`, `citation_arxiv_id` and `citation_pdf_url` of
 * the page whose value is not blank, in either order of `name` and `content`, the name in any case, the value's
 * entities decoded and its blanks around dropped. `pageUrl`: the page's address, which a relative `citation_pdf_url`
 * is resolved against (without it, only an absolute one is taken). An identifier longer than MAX_IDENTIFIER_CHARS is
 * none. Data only: nothing found here is followed but by the import, through the guards of the open web.
 */
export function citationMeta(html: string, pageUrl?: string): CitationMeta {
  const out: CitationMeta = {};
  // « <meta », in any case, found in the page itself (a lower-cased copy may differ in length: « İ » becomes two).
  const meta = /<meta/gi;
  for (let m = meta.exec(html); m !== null; m = meta.exec(html)) {
    const end = html.indexOf('>', m.index);
    // A tag never closed: nothing further is a tag.
    if (end < 0) break;
    meta.lastIndex = end + 1;
    // A tag of reasonable length (never copied otherwise); « <meta » itself, not « <metadata ».
    if (end - m.index - 5 > MAX_TAG_CHARS) continue;
    const inside = html.slice(m.index + 5, end);
    if (inside === '' || blank(inside[0]) || inside[0] === '/') {
      const attributes = attributesOf(inside);
      const key = NAMES.get((attributes.get('name') ?? '').trim().toLowerCase());
      const raw = attributes.get('content');
      if (key !== undefined && out[key] === undefined && raw !== undefined) {
        const value = decodeEntities(raw).trim();
        if (value !== '') {
          if (key === 'pdfUrl') {
            const url = pdfUrlOf(value, pageUrl);
            if (url !== undefined) out.pdfUrl = url;
          } else if (value.length <= MAX_IDENTIFIER_CHARS) {
            out[key] = value;
          }
        }
      }
    }
  }
  return out;
}
