import { type FileRef, isObject, plainName } from '@cirrus/core';
import {
  type Csl, MAX_IDENTIFIER_CHARS, type PublicationFound, type PublicationId, type PublicationRequest, type PublicationResult,
} from '@cirrus/sources';
import type { RenderParams } from '@cirrus/view';
import { messageOf, reasonOf } from '../sync/connection.ts';

/**
 * A publication's import, by the server or by this PC (plan 5b, task 3, D2): the main process's choice of path, without
 * Electron (ipc/publications.ts wires it).
 * - Paired, the client connected (SyncHost.publicationImporter): the server imports it by its own network, under the same
 *   guards, and keeps its PDF, whose reference comes back. The PC downloads that PDF at its first reading (D6 of plan
 *   5a), and never sends it back: before the action that creates the node is sent, the server is asked which files it
 *   lacks (uploads.ts), and it holds this one. The PC's settings are the caps; the server brings them under its bounds.
 * - The server's answer a PublicationResult (a 200): the import's outcome, a refusal included (« Publication
 *   introuvable. », an address of the local network), said as it is and never made again here.
 * - Anything else — the network failing, an answer other than a 200 (the server's own network not reached, 502, review
 *   of task 3, I1; busy, 503; an older server without the route, 404; a request refused, 4xx, a token revoked among
 *   them; its own failure, 5xx), an answer this PC cannot read —: the server did not import it, and this PC does, as in
 *   plan 4c, one line in the console saying why.
 * - Not paired, not connected, or a text that is no request (not a string, or too long): this PC, as in plan 4c.
 * What the PC sends is a PublicationRequest of @cirrus/sources, the shape the server reads.
 */

/** The server's import (SyncHost.publicationImporter): its answer as it comes; rejects when the network fails. */
export type ServerImport = (request: PublicationRequest) => Promise<Response>;

export interface ViaDeps {
  /** This PC's own import (importPublication on its network, the PDF into its store): plan 4c's. */
  local(text: unknown, options: unknown): Promise<PublicationResult>;
  /** The server's import, with a server paired and connected; null otherwise (and with the recorded answers: replay). */
  server(): ServerImport | null;
  /** The settings sent as the caps. */
  params(): Pick<RenderParams, 'publicationMaxKb' | 'maxImportMb' | 'publicationTimeoutMs' | 'publicationPdfMaxMs'>;
  /** The console. */
  log(message: string): void;
}

/** `{ pdf: false }` exactly, as importPublication reads its options: a PDF dropped, which the node keeps (plan 4c, D8). */
const leavesPdf = (options: unknown) => isObject(options) && Object.hasOwn(options, 'pdf') && options.pdf === false;

const HASH = /^[0-9a-f]{64}$/;

/** A FileRef as a node may hold one: exactly a plain name (plainName), a SHA-256, a size; null otherwise. */
function fileRefOf(x: unknown): FileRef | null {
  if (!isObject(x) || Object.keys(x).length !== 3) return null;
  const { name, hash, size } = x;
  if (typeof name !== 'string' || !plainName(name) || typeof hash !== 'string' || !HASH.test(hash) || !Number.isSafeInteger(size) || (size as number) < 0) return null;
  return { name, hash, size: size as number };
}

/** A publication's identifier: exactly a DOI or an arXiv identifier, MAX_IDENTIFIER_CHARS at most. */
function idOf(x: unknown): PublicationId | null {
  if (!isObject(x) || Object.keys(x).length !== 1) return null;
  const { doi, arxiv } = x;
  if (typeof doi === 'string' && doi !== '' && doi.length <= MAX_IDENTIFIER_CHARS) return { doi };
  if (typeof arxiv === 'string' && arxiv !== '' && arxiv.length <= MAX_IDENTIFIER_CHARS) return { arxiv };
  return null;
}

/**
 * The server's answer as a PublicationResult, read as data, each field the interface reads checked (its CSL read
 * later by cslToFields, its BibTeX by the parser); null if it is none.
 */
function resultOf(x: unknown): PublicationResult | null {
  if (!isObject(x)) return null;
  if (x.ok === false) return typeof x.message === 'string' && x.message !== '' ? { ok: false, message: x.message } : null;
  if (x.ok !== true) return null;
  if (x.kind !== undefined) {
    const pdf = x.kind === 'pdf' ? fileRefOf(x.pdf) : null;
    return pdf ? { ok: true, kind: 'pdf', pdf } : null;
  }
  const id = idOf(x.id);
  if (id === null || !isObject(x.csl) || typeof x.bibtex !== 'string') return null;
  const found: PublicationFound = { ok: true, id, csl: x.csl as Csl, bibtex: x.bibtex };
  if (x.pdf !== undefined) {
    const pdf = fileRefOf(x.pdf);
    if (pdf === null) return null;
    found.pdf = pdf;
  }
  if (x.pdfMessage !== undefined) {
    if (typeof x.pdfMessage !== 'string') return null;
    found.pdfMessage = x.pdfMessage;
  }
  return found;
}

/** The import of `text` (the interface's, unchecked), by the server or by this PC: see above. */
export async function importPublicationVia(text: unknown, options: unknown, deps: ViaDeps): Promise<PublicationResult> {
  const server = typeof text === 'string' && text.length <= MAX_IDENTIFIER_CHARS ? deps.server() : null;
  if (server !== null && typeof text === 'string') {
    const p = deps.params();
    const request: PublicationRequest = {
      text, ...(leavesPdf(options) ? { pdf: false as const } : {}),
      maxKb: p.publicationMaxKb, maxPdfBytes: p.maxImportMb * 2 ** 20, timeoutMs: p.publicationTimeoutMs, pdfMaxMs: p.publicationPdfMaxMs,
    };
    let why: string;
    try {
      const res = await server(request);
      if (res.status === 200) {
        const r = resultOf(await res.json().catch(() => null));
        if (r !== null) return r;
        why = 'réponse illisible';
      } else {
        why = await reasonOf(res);
      }
    } catch (e) {
      why = messageOf(e);
    }
    deps.log(`Publication : le serveur ne l’a pas importée (${why}) ; ce PC l’importe lui-même.`);
  }
  return deps.local(text, options);
}
