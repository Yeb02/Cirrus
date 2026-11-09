import { IDENTIFIER_LINKS } from './sources.ts';

/**
 * A publication's identifier as the user gives it (plan 4c, D5): a DOI, or an arXiv identifier, which keeps its version
 * if it has one. Pure: the interface may read it too (task 5).
 */
export type PublicationId = { doi: string } | { arxiv: string };

/** A longer text is no identifier (the IPC's bound too): no pattern runs on it. */
export const MAX_IDENTIFIER_CHARS = 1000;

/** arXiv's identifiers since 2007 (4 then 5 digits after the dot), then before: an archive, its class, 7 digits. */
const NEW_ARXIV = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const OLD_ARXIV = /^[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/;
/** A DOI: « 10. », its registrant's digits, « / », a suffix without blanks (checked further in doiOf). */
const DOI = /^10\.\d{4,9}\/\S+$/;
/** The DOIs arXiv gives its articles (DataCite's prefix 10.48550): `arXiv.<identifier without version>`. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The DOI arXiv gives the article `id` (D5): its identifier without version. */
export function arxivDoi(id: string): string {
  return `10.48550/arXiv.${id.replace(/v\d+$/, '')}`;
}

function arxivOf(s: string): PublicationId | null {
  const id = s.trim();
  return NEW_ARXIV.test(id) || OLD_ARXIV.test(id) ? { arxiv: id } : null;
}

/**
 * A DOI, refused with a control character or a segment « . » or « .. » (which an address would resolve away). arXiv's
 * own DOI is its article: its PDF comes too (D6).
 */
function doiOf(s: string): PublicationId | null {
  const doi = s.trim();
  if (!DOI.test(doi) || CONTROL.test(doi) || doi.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  const ax = ARXIV_DOI.exec(doi);
  return (ax && arxivOf(ax[1])) || { doi };
}

/** A DOI from a segment's start in a path, to its end (plan 5b, D4). */
const DOI_IN_PATH = /(?:^|\/)(10\.\d{4,9}\/[^]*)$/;
/** The last segment a publisher puts after a DOI for a view of the article (D4): « …/10.1145/123.456/abstract ». */
const VIEW_SEGMENT = /\/(?:full|abs|abstract|pdf|epdf|fulltext)$/i;

/**
 * The DOI a publisher's address holds in its path, decoded (plan 5b, D4): `dl.acm.org/doi/pdf/10.1145/…`,
 * `link.springer.com/article/10.1007/…`, `onlinelibrary.wiley.com/doi/full/10.1111/…`. Its trailing « / », then a
 * final « .pdf », then one last segment of VIEW_SEGMENT placed after the DOI's suffix, are dropped: ACM's
 * `/doi/pdf/10.1145/…` has its « pdf » before the DOI, kept out of it by the match; `10.1000/abs`'s « abs » is its
 * suffix, kept. Read as an identifier, without any request, as a resolver's link is: the host is never asked.
 */
function publisherDoi(path: string): PublicationId | null {
  const m = DOI_IN_PATH.exec(path);
  if (!m) return null;
  let doi = m[1].replace(/\/+$/, '').replace(/\.pdf$/i, '');
  const view = VIEW_SEGMENT.exec(doi);
  // The segment only when a suffix stays before it (« 10.1145/123/abs », not « 10.1145/abs »).
  if (view && doi.indexOf('/') < view.index) doi = doi.slice(0, view.index);
  return doiOf(doi);
}

/**
 * A link to a DOI's resolver or to an arXiv page (abs, pdf): its identifier; another http(s) address whose path holds
 * a DOI (a publisher's, plan 5b, D4): that DOI; any other address, none.
 */
function fromLink(text: string): PublicationId | null {
  let url: URL;
  let path: string;
  try {
    url = new URL(text);
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (IDENTIFIER_LINKS.doi.includes(url.hostname)) return doiOf(path.slice(1));
  if (IDENTIFIER_LINKS.arxiv.includes(url.hostname)) {
    const m = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/.exec(path);
    return m ? arxivOf(m[1]) : null;
  }
  return publisherDoi(path);
}

/** An address, as a user pastes one: a scheme, then « // » (« doi: » or « arXiv: » are not). */
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Whether `text` is an address (plan 5b, D3 and D5), whatever its scheme: a scheme, « // », and an address the platform
 * parses, MAX_IDENTIFIER_CHARS at most. The one rule of the import's entry (importPublication) and of the dialog's check
 * before the request (importByIdentifier), so the dialog never refuses an address the main process would take — and the
 * main process, not the dialog, says why one is refused (an address that is not https, a local machine).
 */
export function isAddress(text: string): boolean {
  if (typeof text !== 'string' || text.length > MAX_IDENTIFIER_CHARS) return false;
  const t = text.trim();
  return ADDRESS.test(t) && URL.canParse(t);
}

/**
 * The identifier `text` gives (plan 4c, task 4), or null: a DOI, bare or after « doi: », or as a link to its resolver
 * or as a publisher's address holding it (plan 5b, D4); an arXiv identifier, new (`2401.01234v2`) or old
 * (`hep-th/9901001`), bare or after « arXiv: », or as a link to its abstract or its PDF. Blanks around are ignored, the
 * case of the prefixes too.
 */
export function parseIdentifier(text: string): PublicationId | null {
  if (typeof text !== 'string' || text.length > MAX_IDENTIFIER_CHARS) return null;
  const t = text.trim();
  if (ADDRESS.test(t)) return fromLink(t);
  const ax = /^arxiv:(.*)$/is.exec(t);
  if (ax) return arxivOf(ax[1]);
  const doi = /^doi:(.*)$/is.exec(t);
  if (doi) return doiOf(doi[1]);
  return arxivOf(t) ?? doiOf(t);
}
