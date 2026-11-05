import type { FileRef } from '@cirrus/core';

/**
 * A file's kind, which picks its view (plan 4a): an image, a PDF, LaTeX source, text or code, a table; `other` is opened
 * by the system's application.
 */
export type FileKind = 'image' | 'pdf' | 'tex' | 'text' | 'table' | 'other';

const KINDS = new Map<string, FileKind>([
  ...words('image', 'png jpg jpeg gif webp bmp svg avif ico'),
  ...words('pdf', 'pdf'),
  ...words('tex', 'tex'),
  ...words('table', 'csv tsv'),
  // Scripts are text, shown in Cirrus and never handed to Windows, which may run them: Perl, Ruby and PHP too (ruling of
  // the final review). Python's compiled files, which Cirrus cannot show, are in the main process's runnable list.
  ...words('text', 'txt md bib py ipynb js mjs ts tsx jsx json yaml yml toml ini cfg c h cpp hpp cc rs go java kt jl r m sh ps1 bat lua sql html css xml log rst pl pm rb php'),
]);
/** Text files known by their whole name, without an extension (in any case). */
const BARE_TEXT = new Set(['makefile', 'dockerfile', 'license', 'readme']);

function words(kind: FileKind, list: string): [string, FileKind][] {
  return list.split(' ').map((ext) => [ext, kind]);
}

/**
 * The extension as Windows reads it, in lower case: after the last dot, trailing dots and spaces dropped. The same as the
 * main process's, so a file's kind and the type it is served with agree.
 */
export function extensionOf(name: string): string {
  const n = name.replace(/[. ]+$/, '');
  const dot = n.lastIndexOf('.');
  return dot < 0 ? '' : n.slice(dot + 1).toLowerCase();
}

export function fileKind(name: string): FileKind {
  const ext = extensionOf(name);
  if (ext === '') return BARE_TEXT.has(name.toLowerCase()) ? 'text' : 'other';
  return KINDS.get(ext) ?? 'other';
}

/**
 * A file a view shows: one of the store's (plan 4a), or a PDF the main process compiled (`store: 'latex'`, plan 4b,
 * D2), its hash then the key of the compile cache.
 */
export type ViewRef = FileRef & { store?: 'latex' };

/** Where the views keep what they opened of a file (pdf.ts's documents): its store, then its hash. */
export const viewKey = (ref: ViewRef): string => `${ref.store ?? 'blob'}:${ref.hash}`;

/**
 * The file's address under the main process's cirrus-file: protocol (FILE_SCHEME, plan 4a, D1): the store's blobs, or
 * the compiled PDFs (`latex`); the name only gives its type.
 */
export function fileUrl(ref: ViewRef): string {
  return `cirrus-file://${ref.store === 'latex' ? 'latex' : 'blob'}/${ref.hash}/${encodeURIComponent(ref.name)}`;
}

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** A size in base 1024, the French way: « 812 o », « 12,3 Ko », one decimal under 100, « 150 Ko » from there. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  let v = bytes, u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  const tenths = Math.round(v * 10) / 10;
  if (tenths < 100) return `${tenths.toFixed(1).replace('.', ',')} ${UNITS[u]}`;
  const whole = Math.round(v);
  // 1023,6 Ko rounds to 1024 Ko: 1,0 Mo instead.
  return whole >= 1024 && u < UNITS.length - 1 ? `1,0 ${UNITS[u + 1]}` : `${whole} ${UNITS[u]}`;
}
