/**
 * @cirrus/sources: where a publication comes from and how it is asked for (plan 5b, D2), shared by the app's main
 * process and the server so that one copy of the network's guards exists. It depends on @cirrus/core only, never on
 * Electron, and is handed its network (a FetchFn), so that its tests never reach the Internet.
 *
 * The interface (a browser bundle) imports only the pure parts, by their own entries: `@cirrus/sources/identifier`
 * and `@cirrus/sources/csl`, never this one.
 */
export { type Csl, cslToFields } from './csl.ts';
export { type FetchFn, fetchPublication, importPublication, type PublicationDeps, type PublicationResult } from './fetch.ts';
export { arxivDoi, MAX_IDENTIFIER_CHARS, parseIdentifier, type PublicationId } from './identifier.ts';
export { IDENTIFIER_LINKS, PUBLICATION_SOURCES, type PublicationSources } from './sources.ts';
