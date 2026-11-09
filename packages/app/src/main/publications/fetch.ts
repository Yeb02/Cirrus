import { Readable } from 'node:stream';
import type { FileRef } from '@cirrus/core';
import { type Csl, cslToFields } from './csl.ts';
import { arxivDoi, parseIdentifier, type PublicationId } from './identifier.ts';
import { PUBLICATION_SOURCES, type PublicationSources } from './sources.ts';

/**
 * A publication's import on the main process's side (plan 4c, D5, D6): its CSL-JSON and its BibTeX asked of its DOI's
 * resolver (content negotiation), then, for an arXiv article, its PDF put into the store. Reached only by the IPC that
 * the user's import calls (main/ipc/publications.ts), never at startup nor in the background. Every request is guarded
 * (Review Focus 1, 5): HTTPS to a host of PUBLICATION_SOURCES only, redirects followed by hand and each target checked before
 * it is asked, every body read under its cap, a delay, the answers parsed as data. The network is handed in (`fetch`):
 * Electron's (requestFetch), a replay of recorded answers (replay.ts), a test's fake.
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
  /** Where the causes the user is not shown go (the console). */
  log?: (message: string) => void;
  sources?: PublicationSources;
}

/**
 * What the import gives the interface (task 5): the identifier read, the CSL and the BibTeX entry; for an arXiv article
 * its PDF's reference in the store, or why it is not there (`pdfMessage`, in French: the publication comes without it).
 * Or why nothing came, in French; nothing was stored then.
 */
export type PublicationResult =
  | { ok: true; id: PublicationId; csl: Csl; bibtex: string; pdf?: FileRef; pdfMessage?: string }
  | { ok: false; message: string };

export const UNRECOGNIZED = 'Identifiant non reconnu.';
export const NOT_FOUND = 'Publication introuvable.';
export const OFFLINE = 'Pas de connexion.';

const CSL_TYPE = 'application/vnd.citationstyles.csl+json';
const BIBTEX_TYPE = 'application/x-bibtex';
/** The media types a CSL answer may have (Crossref's, DataCite's, plain JSON), and a BibTeX one. */
const JSON_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json$/;
const BIBTEX_TYPES = new Set(['application/x-bibtex', 'text/x-bibtex']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** The redirects followed at most, per request (the DOI resolver's chains take one or two). A fixed bound, as browsers have one. */
const MAX_REDIRECTS = 5;

/** A refusal, its message for the user, in French. */
class Refusal extends Error {}

/** Who answers, as the messages name it. */
type Server = 'doi' | 'arxiv';
const serverOf = (s: Server) => (s === 'doi' ? 'serveur de DOI' : 'serveur d’arXiv');
const unexpected = (s: Server) => new Refusal(`Réponse inattendue du ${serverOf(s)}.`);
const seconds = (ms: number) => `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;

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

/** The media type of a Content-Type, lower case, without its parameters. */
const mediaType = (header: string | null) => (header ?? '').split(';')[0].trim().toLowerCase();

/**
 * One answer to `href`: its media type and its body, `cap` bytes at most, read as they come and never further (the
 * declared length refused before any read). Redirects are followed by hand, each target checked first (permitted).
 * A 404 or 410 is `notFound`, another status than 200 an error with its code. The delay (`timeoutMs`): the whole
 * exchange's, or, with `stall`, the longest wait for data (re-armed at each piece; a PDF is larger than metadata).
 * Whatever the network does, the request is aborted once the answer is read, or given up. `cancel`: a refusal that
 * stops it at once (its sibling's, fetchPublication), which it then throws.
 */
async function exchange(
  deps: PublicationDeps, href: string, accept: string, cap: number, server: Server, notFound: string, tooBig: string, stall: boolean,
  cancel?: AbortSignal,
): Promise<{ type: string; bytes: Uint8Array }> {
  const hosts = (deps.sources ?? PUBLICATION_SOURCES).hosts;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire: (e: Refusal) => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => { expire = reject; });
  expired.catch(() => {});
  /** Given up with `e`: the request aborted, and any step waiting on the network rejected (a fetch may ignore its signal). */
  const stop = (e: Refusal) => {
    abort.abort(e);
    expire(e);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new Refusal(`Le ${serverOf(server)} ne répond pas (délai de ${seconds(deps.timeoutMs)} dépassé).`)), deps.timeoutMs);
  };
  const cancelled = () => stop(cancel!.reason instanceof Refusal ? cancel!.reason : unexpected(server));
  if (cancel?.aborted) cancelled();
  else cancel?.addEventListener('abort', cancelled, { once: true });
  /** A step of the network, raced against the delay (a fetch may ignore its signal): its failure is the connection's. */
  const network = async <T>(step: Promise<T>): Promise<T> => {
    try {
      return await Promise.race([step, expired]);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      if (abort.signal.reason instanceof Refusal) throw abort.signal.reason;
      deps.log?.(`Publication, ${href} : ${e instanceof Error ? e.message : String(e)}`);
      throw new Refusal(server === 'doi' ? OFFLINE : 'Pas de connexion : le PDF d’arXiv n’a pas été téléchargé.');
    }
  };
  const drop = (res: Response) => { void res.body?.cancel().catch(() => {}); };
  try {
    arm();
    let url = permitted(href, hosts, null);
    for (let redirects = 0; ; redirects++) {
      const res = await network(deps.fetch(url.href, { headers: { Accept: accept }, redirect: 'manual', signal: abort.signal }));
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
        if (stall) arm();
        continue;
      }
      if (res.status === 404 || res.status === 410) { drop(res); throw new Refusal(notFound); }
      if (res.status !== 200) { drop(res); throw new Refusal(`Le ${serverOf(server)} a répondu par une erreur (HTTP ${res.status}).`); }
      const declared = Number(res.headers.get('content-length') ?? Number.NaN);
      if (declared > cap) { drop(res); throw new Refusal(tooBig); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await network(reader.read());
            if (done) break;
            size += value.byteLength;
            if (size > cap) throw new Refusal(tooBig);
            chunks.push(value);
            if (stall) arm();
          }
        } finally {
          // Not waited for: a stalled source may never answer it.
          void reader.cancel().catch(() => {});
        }
      }
      const bytes = new Uint8Array(size);
      for (let at = 0, i = 0; i < chunks.length; at += chunks[i].byteLength, i++) bytes.set(chunks[i], at);
      return { type: mediaType(res.headers.get('content-type')), bytes };
    }
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', cancelled);
    abort.abort();
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
export async function fetchPublication(id: PublicationId, deps: PublicationDeps, options: { pdf?: boolean } = {}): Promise<PublicationResult> {
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
 * The IPC's entry (`cirrus:publications:fetch`): `text`, whatever the interface sent, must be a string that
 * parseIdentifier reads (MAX_IDENTIFIER_CHARS at most), or nothing is asked of the network. `options`: `{ pdf: false }`
 * only, exactly, leaves an arXiv article's PDF out (a PDF dropped, task 5); anything else, the PDF is downloaded.
 */
export async function importPublication(text: unknown, deps: PublicationDeps, options?: unknown): Promise<PublicationResult> {
  const id = typeof text === 'string' ? parseIdentifier(text) : null;
  const pdf = !(typeof options === 'object' && options !== null && !Array.isArray(options) && Object.hasOwn(options, 'pdf') && (options as { pdf: unknown }).pdf === false);
  return id ? fetchPublication(id, deps, { pdf }) : { ok: false, message: UNRECOGNIZED };
}

/** What requestFetch needs of Electron's net.request: a ClientRequest's few calls and events. */
export interface RequestLike {
  setHeader(name: string, value: string): void;
  on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string) => void): this;
  on(event: 'response', listener: (response: IncomingLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  abort(): void;
  end(): void;
}
/** Electron's IncomingMessage: a Node Readable, with its status and headers. */
export interface IncomingLike { statusCode: number; headers: Record<string, string | string[]> }
export interface RequestOptions { url: string; method: 'GET'; redirect: 'manual'; credentials: 'omit'; cache: 'no-store' }

/** The statuses a Response cannot have a body with. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The production FetchFn, over Electron's net.request (its network stack: the system's proxy and certificates, as
 * TinyTeX's download): net.fetch cannot give a redirect back (in `manual` mode, Electron 45 rejects it, « Redirect was
 * cancelled »; in `follow`, it hides where it went). A redirect is answered here as its status and its Location, the
 * request stopped before Electron follows it; fetch.ts checks the target and asks it, or not. No cookie is sent nor
 * kept, no cache used. The signal aborts the request, before an answer or while its body is read.
 */
export function requestFetch(request: (options: RequestOptions) => RequestLike): FetchFn {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    if (init.signal.aborted) { reject(init.signal.reason); return; }
    const req = request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    init.signal.addEventListener('abort', () => { req.abort(); reject(init.signal.reason); }, { once: true });
    req.setHeader('Accept', init.headers.Accept);
    // A listener that throws would be an uncaught exception of the main process: what a server sent that a Response
    // cannot hold (a status out of range, a header value refused) rejects instead.
    const settle = (make: () => Response) => {
      try {
        resolve(make());
      } catch (e) {
        req.abort();
        reject(e);
      }
    };
    req.on('redirect', (status, _method, location) => {
      req.abort();
      settle(() => new Response(null, { status, headers: { location } }));
    });
    req.on('response', (res) => settle(() => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        try {
          headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        } catch {
          // a name or a value Headers refuses: left out
        }
      }
      // The same stream at run time; Node's and the DOM's typings of it differ.
      const body = NULL_BODY.has(res.statusCode) ? null : Readable.toWeb(res as unknown as Readable) as unknown as ReadableStream<Uint8Array>;
      return new Response(body, { status: res.statusCode, headers });
    }));
    req.on('error', reject);
    req.end();
  });
}
