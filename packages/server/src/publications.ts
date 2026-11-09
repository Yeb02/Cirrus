import { isObject } from '@cirrus/core';
import {
  type FetchFn, httpsConnect, importPublication, type OpenDeps, type PublicationRequest, type PublicationResult, systemResolve,
} from '@cirrus/sources';
import { storeBytes } from '@cirrus/store';
import {
  MAX_FILE_BYTES, MAX_IDENTIFIER_CHARS, MAX_PUBLICATION_FETCHES, MAX_PUBLICATION_META_BYTES, MAX_PUBLICATION_PDF_MS, MAX_PUBLICATION_TIMEOUT_MS,
} from './bounds.ts';

// A publication imported by the server for a paired PC (plan 5b, task 3, D2): the PC's own import (@cirrus/sources,
// D3's guards of the open web included), made by the server's network, its PDF kept in the server's store, whose
// reference the PC gets back. The server reaches the network only so, at a paired PC's explicit request (POST
// /publications): never by itself. The request is checked whole before anything is asked; a refusal writes nothing.

/** The server's network for an import: the metadata's requests, and the open web's resolution and connection (D3). */
export interface PublicationNetwork { fetch: FetchFn; open: Pick<OpenDeps, 'resolve' | 'connect'> | null }

/** What the server's requests say they are, as the open web's (guard.ts). */
const USER_AGENT = 'Cirrus (import de publication)';

/**
 * The server's FetchFn: Node's fetch, its redirects never followed (a 3xx comes back as it is, its Location with it,
 * which @cirrus/sources checks before asking it), no cookie kept, no cache.
 */
export const nodeFetch: FetchFn = (url, init) => fetch(url, { headers: { ...init.headers, 'User-Agent': USER_AGENT }, redirect: 'manual', signal: init.signal });

/** The server's own network (startServer's default): nodeFetch, and the system's resolver and httpsConnect for the open web. */
export const serverNetwork = (): PublicationNetwork => ({ fetch: nodeFetch, open: { resolve: systemResolve, connect: httpsConnect() } });

/** A refusal of POST /publications before anything is asked: its status (400, 503), its reason in French. */
export class PublicationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const FIELDS = new Set(['text', 'pdf', 'maxKb', 'maxPdfBytes', 'timeoutMs', 'pdfMaxMs']);
const CAPS = ['maxKb', 'maxPdfBytes', 'timeoutMs', 'pdfMaxMs'] as const;
const invalid = (why: string) => new PublicationError(400, `Demande d’import invalide : ${why}.`);
const BUSY = 'Le serveur importe déjà d’autres publications : réessaie dans un instant.';

/**
 * POST /publications's body, a PublicationRequest of @cirrus/sources exactly, `{ text, pdf?: false, maxKb, maxPdfBytes,
 * timeoutMs, pdfMaxMs }`: `text` a string of MAX_IDENTIFIER_CHARS at most, `pdf` false or absent, each cap a finite
 * positive number, no other field; else PublicationError (400). Read as the same shape, each cap brought under its bound
 * (bounds.ts): the PC's settings ask, the server decides.
 */
export function parsePublicationRequest(body: unknown): PublicationRequest {
  if (!isObject(body)) throw invalid('un objet { text, pdf?: false, maxKb, maxPdfBytes, timeoutMs, pdfMaxMs } attendu');
  const unknown = Object.keys(body).find((k) => !FIELDS.has(k));
  if (unknown !== undefined) throw invalid(`champ inconnu « ${unknown.slice(0, 64)} »`);
  const { text } = body;
  if (typeof text !== 'string' || text.length > MAX_IDENTIFIER_CHARS) throw invalid(`« text » attendu, une chaîne de ${MAX_IDENTIFIER_CHARS} caractères au plus`);
  if (Object.hasOwn(body, 'pdf') && body.pdf !== false) throw invalid('« pdf » vaut false, ou est absent');
  for (const k of CAPS) {
    const v = body[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw invalid(`« ${k} » attendu, un nombre positif`);
  }
  const cap = (k: (typeof CAPS)[number], bound: number) => Math.min(body[k] as number, bound);
  return {
    text, ...(body.pdf === false ? { pdf: false as const } : {}),
    maxKb: cap('maxKb', MAX_PUBLICATION_META_BYTES / 1024), maxPdfBytes: cap('maxPdfBytes', MAX_FILE_BYTES),
    timeoutMs: cap('timeoutMs', MAX_PUBLICATION_TIMEOUT_MS), pdfMaxMs: cap('pdfMaxMs', MAX_PUBLICATION_PDF_MS),
  };
}

/** `p`, or `signal`'s reason once it aborts (a resolution, which no signal stops). */
function givenUp<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    void p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** `network`, each of its requests ended by `signal` too: an import stopped at once. */
function bound(network: PublicationNetwork, signal: AbortSignal): PublicationNetwork {
  const both = (s: AbortSignal) => AbortSignal.any([s, signal]);
  const open = network.open;
  return {
    fetch: (url, init) => network.fetch(url, { ...init, signal: both(init.signal) }),
    open: open && {
      resolve: (host) => givenUp(open.resolve(host), signal),
      connect: (req) => open.connect({ ...req, signal: both(req.signal) }),
    },
  };
}

/** The imports under way: MAX_PUBLICATION_FETCHES at most, all PCs together. */
export class PublicationImports {
  private readonly storeDir: string;
  private readonly network: PublicationNetwork;
  private active = 0;

  constructor(storeDir: string, network: PublicationNetwork) {
    this.storeDir = storeDir;
    this.network = network;
  }

  /**
   * `request` imported (importPublication), its PDF into the server's store (`storeDir`, the base's): what the PC's own
   * import gives, a refusal of the network included (`{ ok: false }`). Past MAX_PUBLICATION_FETCHES imports at once,
   * PublicationError (503) before anything is asked. `signal`: the PC gone, or the server stopping — every request under
   * way aborted, the import ends at once. The causes the PC is not told go to the server's console.
   */
  async run(request: PublicationRequest, signal: AbortSignal): Promise<PublicationResult> {
    if (this.active >= MAX_PUBLICATION_FETCHES) throw new PublicationError(503, BUSY);
    this.active++;
    try {
      const net = bound(this.network, signal);
      const log = (m: string) => console.warn(m);
      const { maxKb, maxPdfBytes, timeoutMs, pdfMaxMs } = request;
      return await importPublication(request.text, {
        fetch: net.fetch, store: (name, bytes) => storeBytes(this.storeDir, name, bytes), maxKb, maxPdfBytes, timeoutMs, pdfMaxMs, log,
        open: net.open && { ...net.open, timeoutMs, pdfMaxMs, log },
      }, request.pdf === false ? { pdf: false } : undefined);
    } finally {
      this.active--;
    }
  }
}
