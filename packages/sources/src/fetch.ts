import type { FileRef } from '@cirrus/core';
import { type Csl, cslToFields } from './csl.ts';
import { type OpenDeps, openFetch } from './guard.ts';
import { citationMeta } from './html.ts';
import { arxivDoi, isAddress, MAX_ADDRESS_CHARS, parseIdentifier, type PublicationId } from './identifier.ts';
import { PUBLICATION_SOURCES, type PublicationSources } from './sources.ts';
import {
  duration, INVALID_DELAY, lateRefusal, MAX_REDIRECTS, mediaType, messageOf, NOT_FOUND, OFFLINE, readBody, REDIRECTS, Refusal, Transfer, validLimits,
} from './transfer.ts';

/**
 * A publication's import (plan 4c, D5, D6): its CSL-JSON and its BibTeX asked of its DOI's resolver (content
 * negotiation), then, for an arXiv article, its PDF put into the store. Reached only by an import the user asks for (the
 * app's IPC, main/ipc/publications.ts; the server's route, plan 5b, D2), never at startup nor in the background. Every
 * request is guarded (Review Focus 1, 5 of plan 4c): HTTPS to a host of PUBLICATION_SOURCES only, redirects followed by
 * hand and each target checked before it is asked, every body read under its cap, a delay, the answers parsed as data.
 * The network is handed in (`fetch`): Electron's (the app's requestFetch), Node's at the server, a replay of recorded
 * answers (the app's replay.ts), a test's fake. A package of its own, without Electron, so that the app and the server
 * share one copy of these guards (plan 5b, D2).
 */

/** A request: always GET, its Accept, redirects never followed by the network (`manual`: a 3xx comes back as it is). */
export type FetchFn = (url: string, init: { headers: { Accept: string }; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export interface PublicationDeps {
  fetch: FetchFn;
  /** Puts bytes into the store under `name`, before any action refers to them (storeBytes). */
  store(name: string, bytes: Uint8Array): FileRef;
  /** publicationMaxKb: the cap of each metadata answer. */
  maxKb: number;
  /** maxImportMb, in bytes: the cap of the PDF, as of a file dropped. */
  maxPdfBytes: number;
  /** publicationTimeoutMs: a metadata exchange's whole delay; the PDF's wait for data. */
  timeoutMs: number;
  /** publicationPdfMaxMs: a PDF's whole download at most, arXiv's as the open web's (review of task 2, I2). */
  pdfMaxMs: number;
  /** Where the causes the user is not shown go (the console). */
  log?: (message: string) => void;
  sources?: PublicationSources;
  /**
   * The open web (plan 5b, D3): an address of any site that is no identifier is asked through its guards (guard.ts).
   * Null or absent, such an address is « Identifiant non reconnu. », as in plan 4c.
   */
  open?: OpenDeps | null;
}

/**
 * A publication found (plan 4c, task 5): the identifier read, the CSL and the BibTeX entry; for an arXiv article, or a
 * page that gives its PDF (plan 5b, D3), its PDF's reference in the store, or why it is not there (`pdfMessage`, in
 * French: the publication comes without it).
 */
export type PublicationFound = { ok: true; id: PublicationId; csl: Csl; bibtex: string; pdf?: FileRef; pdfMessage?: string };

/**
 * What the import gives the interface: a publication found; a PDF without identifier, which an address gave (plan 5b,
 * D3), in the store, to take as a PDF dropped (D8 of plan 4c); or why nothing came, in French — nothing was stored then.
 */
export type PublicationResult =
  | PublicationFound
  | { ok: true; kind: 'pdf'; pdf: FileRef }
  | Failure;
type Failure = { ok: false; message: string };

const UNRECOGNIZED = 'Identifiant non reconnu.';
const NO_PDF = 'Cette page ne mène à aucun PDF.';

const CSL_TYPE = 'application/vnd.citationstyles.csl+json';
const BIBTEX_TYPE = 'application/x-bibtex';
/** The media types a CSL answer may have (Crossref's, DataCite's, plain JSON), and a BibTeX one. */
const JSON_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json$/;
const BIBTEX_TYPES = new Set(['application/x-bibtex', 'text/x-bibtex']);
/** What a page's address is asked with: a page, else a PDF, else anything (the answer says what it is). */
const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8';

/** Who answers, as the messages name it. */
type Server = 'doi' | 'arxiv';
const serverOf = (s: Server) => (s === 'doi' ? 'serveur de DOI' : 'serveur d’arXiv');
const unexpected = (s: Server) => new Refusal(`Réponse inattendue du ${serverOf(s)}.`);

/**
 * `href` as a URL a request may reach: HTTPS, on the default port, without credentials, to a host of `hosts` (its
 * name exactly, as the URL parser writes it). `from`: the host that redirected to it, which the refusal names.
 */
function permitted(href: string, hosts: readonly string[], from: string | null): URL {
  const url = new URL(href);
  const refuse = (what: string) =>
    new Refusal(from === null ? `Adresse refusée : ${what}.` : `Redirection refusée : « ${from} » renvoie vers ${what}.`);
  if (url.protocol !== 'https:') throw refuse('une adresse qui n’est pas en HTTPS');
  if (url.port !== '' || url.username !== '' || url.password !== '' || !hosts.includes(url.hostname)) {
    throw refuse(`« ${url.host.slice(0, 255)} », qui n’est pas un serveur permis`);
  }
  return url;
}

/**
 * One answer to `href`: its media type and its body, `cap` bytes at most, read as they come and never further (the
 * declared length refused before any read), into one buffer (readBody). Redirects are followed by hand, each target
 * checked first (permitted). A 404 or 410 is `notFound`, another status than 200 an error with its code. The delays
 * (Transfer): the whole exchange's (`timeoutMs`); with `stall` (a PDF, larger than metadata), the longest wait for
 * data instead, and publicationPdfMaxMs for the whole download (review of task 2, I2). Whatever the network does, the
 * request is aborted once the answer is read, or given up. `cancel`: a refusal that stops it at once (its sibling's,
 * fetchPublication), which it then throws. Both delays must be finite numbers above zero (validLimits), else it throws
 * « Délai invalide. » at once, a refusal like the others, before anything is asked.
 */
async function exchange(
  deps: PublicationDeps, href: string, accept: string, cap: number, server: Server, notFound: string, tooBig: string, stall: boolean,
  cancel?: AbortSignal,
): Promise<{ type: string; bytes: Uint8Array }> {
  // Before the Transfer, whose check is a throw: unusable delays are a refusal like any other, nothing is asked.
  if (!validLimits(deps)) throw new Refusal(INVALID_DELAY);
  const hosts = (deps.sources ?? PUBLICATION_SOURCES).hosts;
  const t = new Transfer(deps, {
    late: () => lateRefusal(`Le ${serverOf(server)}`, deps.timeoutMs),
    // Only a PDF's download is bounded so: arXiv's.
    tooLong: () => new Refusal(`Le téléchargement du PDF d’arXiv a dépassé ${duration(deps.pdfMaxMs)} : arrêté.`),
    offline: (e) => {
      deps.log?.(`Publication, ${href} : ${messageOf(e)}`);
      return new Refusal(server === 'doi' ? OFFLINE : 'Pas de connexion : le PDF d’arXiv n’a pas été téléchargé.');
    },
  });
  const cancelled = () => t.stop(cancel!.reason instanceof Refusal ? cancel!.reason : unexpected(server));
  if (cancel?.aborted) cancelled();
  else cancel?.addEventListener('abort', cancelled, { once: true });
  const drop = (res: Response) => { void res.body?.cancel().catch(() => {}); };
  const rule = { cap, tooBig: new Refusal(tooBig), stall };
  try {
    if (stall) t.stall();
    let url = permitted(href, hosts, null);
    for (let redirects = 0; ; redirects++) {
      const asked = url;
      const res = await t.network(() => deps.fetch(asked.href, { headers: { Accept: accept }, redirect: 'manual', signal: t.signal }));
      if (REDIRECTS.has(res.status)) {
        drop(res);
        const location = res.headers.get('location');
        let next: URL;
        try {
          if (location === null) throw new Error();
          next = new URL(location, url);
        } catch {
          throw unexpected(server);
        }
        if (redirects >= MAX_REDIRECTS) throw new Refusal(`Trop de redirections depuis « ${url.host} ».`);
        url = permitted(next.href, hosts, url.host);
        t.touch();
        continue;
      }
      if (res.status === 404 || res.status === 410) { drop(res); throw new Refusal(notFound); }
      if (res.status !== 200) { drop(res); throw new Refusal(`Le ${serverOf(server)} a répondu par une erreur (HTTP ${res.status}).`); }
      const { bytes } = await readBody(res, t, () => rule);
      return { type: mediaType(res.headers.get('content-type')), bytes };
    }
  } finally {
    cancel?.removeEventListener('abort', cancelled);
    t.close();
  }
}

/** UTF-8 text, a BOM dropped; a byte that is not UTF-8 becomes U+FFFD (never an error). */
const textOf = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);

/** The CSL of the DOI: JSON, said so, an object with a title (cslToFields); anything else is unexpected. */
async function cslOf(deps: PublicationDeps, url: string, cap: number, tooBig: string, cancel: AbortSignal): Promise<Csl> {
  const a = await exchange(deps, url, CSL_TYPE, cap, 'doi', NOT_FOUND, tooBig, false, cancel);
  if (!JSON_TYPE.test(a.type)) throw unexpected('doi');
  let csl: unknown;
  try {
    csl = JSON.parse(textOf(a.bytes));
  } catch {
    throw unexpected('doi');
  }
  if (cslToFields(csl) === null) throw unexpected('doi');
  return csl as Csl;
}

/** The BibTeX entry of the DOI: said BibTeX, an entry (« @… »); anything else is unexpected. */
async function bibtexOf(deps: PublicationDeps, url: string, cap: number, tooBig: string, cancel: AbortSignal): Promise<string> {
  const a = await exchange(deps, url, BIBTEX_TYPE, cap, 'doi', NOT_FOUND, tooBig, false, cancel);
  const bibtex = textOf(a.bytes).trim();
  if (!BIBTEX_TYPES.has(a.type) || !bibtex.startsWith('@')) throw unexpected('doi');
  return bibtex;
}

/** The store's name of an arXiv article's PDF: its identifier, « / » of an old one made « _ » (`hep-th_9901001.pdf`). */
const pdfName = (id: string) => `${id.replace('/', '_')}.pdf`;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** The arXiv article's PDF into the store (D6): a FileRef, or why not, in French. */
async function pdfOf(deps: PublicationDeps, id: string): Promise<{ pdf: FileRef } | { pdfMessage: string }> {
  const sources = deps.sources ?? PUBLICATION_SOURCES;
  const mb = (deps.maxPdfBytes / 2 ** 20).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  let bytes: Uint8Array;
  try {
    ({ bytes } = await exchange(
      deps, sources.arxivPdfUrl(id), 'application/pdf', deps.maxPdfBytes, 'arxiv', 'Le PDF est introuvable sur arXiv.', `Le PDF d’arXiv fait plus de ${mb} Mo.`, true,
    ));
  } catch (e) {
    if (e instanceof Refusal) return { pdfMessage: e.message };
    throw e;
  }
  if (bytes.length < PDF_MAGIC.length || PDF_MAGIC.some((b, i) => bytes[i] !== b)) return { pdfMessage: 'Le fichier reçu d’arXiv n’est pas un PDF.' };
  try {
    return { pdf: deps.store(pdfName(id), bytes) };
  } catch (e) {
    deps.log?.(`Publication, PDF ${id} : ${e instanceof Error ? e.message : String(e)}`);
    return { pdfMessage: 'Le PDF d’arXiv n’a pas pu être enregistré dans la base.' };
  }
}

/**
 * The publication `id` (D5, D6): its CSL-JSON and BibTeX from the DOI resolver (an arXiv identifier by the DOI arXiv gives it),
 * both asked at once, both needed (the first that fails stops the other, and its reason alone is said); then, for an arXiv
 * article, its PDF, which only goes into the store if its first bytes are %PDF and it fits in maxImportMb; without it
 * the publication comes all the same, `pdfMessage` saying why; with `pdf: false` (a PDF the user dropped, which the node
 * keeps: plan 4c, D8), it is not asked for. Never throws: every failure is a refusal in French (the cause, if any, logged).
 */
export async function fetchPublication(id: PublicationId, deps: PublicationDeps, options: { pdf?: boolean } = {}): Promise<PublicationFound | Failure> {
  const sources = deps.sources ?? PUBLICATION_SOURCES;
  const url = sources.doiUrl('doi' in id ? id.doi : arxivDoi(id.arxiv));
  const cap = deps.maxKb * 1024;
  const tooBig = `Réponse trop grosse du serveur de DOI (plus de ${deps.maxKb.toLocaleString('fr-FR')} Ko).`;
  const failed = new AbortController();
  const first = <T>(p: Promise<T>) => p.catch((e: unknown) => { if (!failed.signal.aborted) failed.abort(e); throw e; });
  try {
    const [csl, bibtex] = await Promise.allSettled([
      first(cslOf(deps, url, cap, tooBig, failed.signal)), first(bibtexOf(deps, url, cap, tooBig, failed.signal)),
    ]);
    // The first failure, which stopped the other.
    if (failed.signal.aborted) throw failed.signal.reason;
    const found = { ok: true as const, id, csl: (csl as PromiseFulfilledResult<Csl>).value, bibtex: (bibtex as PromiseFulfilledResult<string>).value };
    return 'arxiv' in id && options.pdf !== false ? { ...found, ...(await pdfOf(deps, id.arxiv)) } : found;
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, message: e.message };
    deps.log?.(`Publication, ${url} : ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return { ok: false, message: 'L’import de la publication a échoué : erreur inattendue.' };
  }
}

/**
 * A PDF's name in the store, as Windows takes it (what a node's file name may not hold made « _ », 100 characters at
 * most, never a reserved name), « .pdf » after it; null if nothing is left.
 */
function fileNameOf(base: string): string | null {
  const name = base.replace(/\.pdf$/i, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').slice(0, 100).replace(/[. ]+$/, '');
  return name === '' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? null : `${name}.pdf`;
}

/**
 * The store's name of a PDF of the open web (plan 5b, D3): its address's own file name when it is one (« N19-1423.pdf »,
 * « radford21a.pdf »), else its publication's identifier, else « publication.pdf ».
 */
function openPdfName(href: string, id: PublicationId | null): string {
  let last = '';
  try {
    last = decodeURIComponent(new URL(href).pathname.split('/').pop() ?? '');
  } catch {
    // an address whose path is no UTF-8 once decoded: no name of its own
  }
  const own = /\.pdf$/i.test(last) ? fileNameOf(last) : null;
  if (own !== null) return own;
  if (id !== null) return 'arxiv' in id ? pdfName(id.arxiv) : (fileNameOf(id.doi) ?? 'publication.pdf');
  return 'publication.pdf';
}

/** A PDF of the open web into the store, under its name (openPdfName): a FileRef, or why not, in French. */
function storeOpenPdf(deps: PublicationDeps, url: string, bytes: Uint8Array, id: PublicationId | null): { pdf: FileRef } | { pdfMessage: string } {
  try {
    return { pdf: deps.store(openPdfName(url, id), bytes) };
  } catch (e) {
    deps.log?.(`Publication, PDF ${url} : ${e instanceof Error ? e.message : String(e)}`);
    return { pdfMessage: 'Le PDF n’a pas pu être enregistré dans la base.' };
  }
}

/** A page's PDF (its `citation_pdf_url`), asked under the same guards (D3): a FileRef, or why not, in French. */
async function pagePdf(deps: PublicationDeps, open: OpenDeps, href: string, id: PublicationId | null): Promise<{ pdf: FileRef } | { pdfMessage: string }> {
  // A PDF only: an answer that is none is not read further than its first bytes.
  const a = await openFetch(href, open, 'application/pdf', { page: 0, pdf: deps.maxPdfBytes });
  if (!a.ok) return { pdfMessage: a.message };
  if (!a.pdf) return { pdfMessage: NO_PDF };
  return storeOpenPdf(deps, a.url, a.bytes, id);
}

/**
 * The import of an address that is no identifier (plan 5b, D3), through the guards of the open web (openFetch):
 * - a PDF (by its type or its first bytes): into the store, `{ kind: 'pdf' }`, to take as a PDF dropped;
 * - a page, read under publicationMaxKb: its citation tags (citationMeta). Its DOI, else its arXiv identifier, imports
 *   the metadata (fetchPublication), and its PDF comes with them if it has one (`citation_pdf_url`), under the same
 *   guards, or `pdfMessage` says why not; without them, an arXiv article's PDF is arXiv's, as for its identifier.
 *   Without identifier, its PDF is `{ kind: 'pdf' }`;
 * - nothing of that: « Cette page ne mène à aucun PDF. ».
 * `pdf` false (a PDF dropped): with an identifier, the metadata only, the page's PDF not asked; without one, the PDF the
 * address leads to (itself, or its page's) is still what it gives.
 */
async function importOpen(href: string, deps: PublicationDeps, open: OpenDeps, pdf: boolean): Promise<PublicationResult> {
  const a = await openFetch(href, open, PAGE_ACCEPT, { page: deps.maxKb * 1024, pdf: deps.maxPdfBytes });
  if (!a.ok) return a;
  if (a.pdf) {
    const stored = storeOpenPdf(deps, a.url, a.bytes, null);
    return 'pdf' in stored ? { ok: true, kind: 'pdf', pdf: stored.pdf } : { ok: false, message: stored.pdfMessage };
  }
  const meta = citationMeta(textOf(a.bytes), a.url);
  const id = (meta.doi !== undefined ? parseIdentifier(meta.doi) : null)
    ?? (meta.arxiv !== undefined ? parseIdentifier(`arXiv:${meta.arxiv.replace(/^arxiv:\s*/i, '')}`) : null);
  if (id === null) {
    if (meta.pdfUrl === undefined) return { ok: false, message: NO_PDF };
    const p = await pagePdf(deps, open, meta.pdfUrl, null);
    return 'pdf' in p ? { ok: true, kind: 'pdf', pdf: p.pdf } : { ok: false, message: p.pdfMessage };
  }
  // The metadata first: when they fail, no PDF is downloaded for nothing.
  const r = await fetchPublication(id, deps, { pdf: pdf && meta.pdfUrl === undefined });
  if (!r.ok || !pdf || meta.pdfUrl === undefined) return r;
  return { ...r, ...(await pagePdf(deps, open, meta.pdfUrl, id)) };
}

/**
 * The import's entry (the app's IPC `cirrus:publications:fetch`): `text`, whatever the interface sent, must be a string
 * of MAX_ADDRESS_CHARS at most (an identifier, MAX_IDENTIFIER_CHARS: parseIdentifier), or nothing is asked of the
 * network. In this order (plan 5b):
 * 1. an identifier, or a link to a DOI's resolver or an arXiv page (parseIdentifier): the metadata, as in plan 4c;
 * 2. a publisher's address holding a DOI (D4): that DOI, the same way, without asking the publisher;
 * 3. any other address, with `deps.open`: the open web, under its guards (importOpen, D3);
 * 4. anything else: « Identifiant non reconnu. ».
 * `options`: `{ pdf: false }` only, exactly, leaves the PDF out (an arXiv article's, a page's: a PDF dropped, task 5 of
 * plan 4c); anything else, the PDF is downloaded.
 */
export async function importPublication(text: unknown, deps: PublicationDeps, options?: unknown): Promise<PublicationResult> {
  if (typeof text !== 'string' || text.length > MAX_ADDRESS_CHARS) return { ok: false, message: UNRECOGNIZED };
  const pdf = !(typeof options === 'object' && options !== null && !Array.isArray(options) && Object.hasOwn(options, 'pdf') && (options as { pdf: unknown }).pdf === false);
  const id = parseIdentifier(text);
  if (id) return fetchPublication(id, deps, { pdf });
  const address = text.trim();
  if (!deps.open || !isAddress(address)) return { ok: false, message: UNRECOGNIZED };
  return importOpen(address, deps, deps.open, pdf);
}
