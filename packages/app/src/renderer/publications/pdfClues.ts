import type { FileRef } from '@cirrus/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { openPdf } from '../files/pdf.ts';
import { MAX_TEXT_CHARS } from './identify.ts';

// The dialog loads this module when a PDF is dropped (with pdf.js, in its chunk): why a PDF cannot be read, from it too.
export { pdfFailure } from '../files/pdf.ts';

/** What a dropped PDF says of itself (D8): its metadata's text values, the text of its first pages, its title if it has one. */
interface PdfClues { text: string; meta: Record<string, string>; title: string | null }

/** The longest title taken from a PDF's metadata; a longer one is cut there. */
const MAX_TITLE_CHARS = 300;

/** A text value as a title: control characters and blanks made one space, trimmed; null when nothing is left. */
function titleOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  return t === '' ? null : t;
}

async function read(doc: PDFDocumentProxy, pages: number): Promise<PdfClues> {
  // A name a PDF gives (« __proto__ » among them) is an own key of an object without prototype.
  const meta: Record<string, string> = Object.create(null);
  const { info, metadata } = await doc.getMetadata();
  const take = (o: unknown) => {
    if (typeof o !== 'object' || o === null) return;
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') meta[k] = v;
  };
  take(info);
  take((info as { Custom?: unknown } | null)?.Custom);
  // The XMP's values, by their names (dc:title, prism:doi…): pdf.js iterates over them.
  if (metadata) for (const [k, v] of metadata as Iterable<[string, unknown]>) if (typeof v === 'string') meta[k] = v;
  let text = '';
  for (let i = 1; i <= Math.min(pages, doc.numPages) && text.length < MAX_TEXT_CHARS; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : ' ');
      if (text.length >= MAX_TEXT_CHARS) break;
    }
    page.cleanup();
  }
  return { text, meta, title: titleOf((info as { Title?: unknown } | null)?.Title) ?? titleOf(meta['dc:title']) };
}

/**
 * What pdf.js reads of a PDF dropped in the import dialog (D8), already in the store: its metadata, the text of its
 * first `pages` pages (publicationPdfPages), MAX_TEXT_CHARS at most, its title. Rejects if it cannot be read (pdfFailure
 * says why); the document is let go once read, among the `kept` open (pdfDocsKept).
 */
export async function readPdfClues(ref: FileRef, pages: number, kept: number): Promise<PdfClues> {
  const held = await openPdf(ref, kept);
  try {
    return await Promise.race([read(held.doc, pages), held.failure]);
  } finally {
    held.release();
  }
}
