import { readFileSync } from 'node:fs';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * A page as the tests read it: its size in points, its text (spaces collapsed, end-of-line hyphens joined), its links'
 * addresses, its images, the RGB fill colours it sets (« #ff0000 »), and its text's baselines (points above its bottom).
 */
export interface PdfPage { width: number; height: number; text: string; links: string[]; images: number; colors: string[]; baselines: number[] }

/** A PDF read by pdf.js under Node (its legacy build, the one that runs without a DOM): a test utility. */
export async function readPdf(path: string): Promise<PdfPage[]> {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false });
  const doc = await task.promise;
  try {
    const pages: PdfPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const [x0, y0, x1, y1] = page.view;
      const content = await page.getTextContent();
      const raw = content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
      const baselines = content.items.flatMap((it) => ('str' in it && it.str.trim() !== '' ? [it.transform[5] - y0] : []));
      const links = (await page.getAnnotations()).filter((a) => a.subtype === 'Link').map((a) => String(a.url ?? a.unsafeUrl ?? ''));
      const ops = await page.getOperatorList();
      const images = ops.fnArray.filter((f) => f === OPS.paintImageXObject).length;
      const colors = ops.fnArray.flatMap((f, j) => (f === OPS.setFillRGBColor ? [String(ops.argsArray[j][0])] : []));
      pages.push({ width: x1 - x0, height: y1 - y0, text: raw.replace(/-\n/g, '').replace(/\s+/g, ' ').trim(), links, images, colors, baselines });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
