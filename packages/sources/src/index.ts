/**
 * @cirrus/sources: where a publication comes from and how it is asked for (plan 5b, D2), shared by the app's main
 * process and the server so that one copy of the network's guards exists: the hosts of the metadata, the reading of an
 * identifier (with a publisher's DOI, D4), the guarded exchange, the open web and its guards (D3). It depends on
 * @cirrus/core only, never on Electron, and is handed its network (a FetchFn, OpenDeps), so that its tests never reach
 * the Internet.
 *
 * The interface (a browser bundle) imports only the pure parts, by their own entries: `@cirrus/sources/identifier`
 * and `@cirrus/sources/csl`, never this one (guard.ts needs Node's network).
 */
export { type Csl, cslToFields } from './csl.ts';
export { type FetchFn, fetchPublication, importPublication, type PublicationDeps, type PublicationFound, type PublicationResult } from './fetch.ts';
export {
  type ConnectFn, type ConnectRequest, httpsConnect, isPublic, type OpenAnswer, type OpenCaps, type OpenDeps, openFetch, systemResolve,
} from './guard.ts';
export { type CitationMeta, citationMeta } from './html.ts';
export { arxivDoi, MAX_IDENTIFIER_CHARS, parseIdentifier, type PublicationId } from './identifier.ts';
export { IDENTIFIER_LINKS, PUBLICATION_SOURCES, type PublicationSources } from './sources.ts';
export { OFFLINE, unreachable } from './transfer.ts';

/**
 * A publication's import asked of the server by a paired PC (POST /publications, plan 5b, task 3, D2), as it travels:
 * the text typed; `pdf: false` for a PDF dropped, whose node keeps it (its PDF not asked); the PC's caps — its settings
 * publicationMaxKb, maxImportMb in bytes, publicationTimeoutMs, publicationPdfMaxMs —, which the server brings under its
 * bounds. The PC sends it (app, main/publications/via.ts), the server reads it (server, publications.ts).
 */
export interface PublicationRequest { text: string; pdf?: false; maxKb: number; maxPdfBytes: number; timeoutMs: number; pdfMaxMs: number }
