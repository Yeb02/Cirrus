/**
 * PDFs written by hand, without any dependency (plan 4a, task 6): pages of text in Helvetica, its accents in
 * Windows-1252 (WinAnsiEncoding), with links to a page of the document or to an address. The file is ASCII only — a
 * byte above 127 is an octal escape in its string —, so an object's offset in the cross-reference table is its index
 * in the text.
 */

export interface PdfLine { x: number; y: number; size: number; text: string; bold?: boolean }
type Rect = [number, number, number, number];
/** A link's area, in the page's points: to the top of a page of the document (by index), or to an address. */
type PdfLink = { rect: Rect; page: number } | { rect: Rect; uri: string };
/** A page: its size in points, its lines of text, its links, and raw content drawn after the text (`content`). */
export interface PdfPageSpec { width: number; height: number; lines: PdfLine[]; links?: PdfLink[]; content?: string }

/** Windows-1252's characters outside Latin-1, by code point. */
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** A literal string in WinAnsiEncoding: « ( », « ) » and « \ » escaped, every byte past ASCII written in octal. */
function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const b = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252[c];
    if (b === undefined) throw new Error(`Caractère hors de Windows-1252 : « ${ch} »`);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (b < 0x20 || b >= 0x7f) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

/** The PDF of `pages`: catalog, page tree, two standard fonts (not embedded), each page's content and links. */
export function writePdf(pages: PdfPageSpec[]): Uint8Array {
  // Numbers: 1 catalog, 2 page tree, 3 and 4 the fonts, then a page and its content for each page, then the links.
  const pageObj = (i: number) => 5 + 2 * i;
  let next = 5 + 2 * pages.length;
  const annots = pages.map((p) => (p.links ?? []).map(() => next++));
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const links = annots[i].length > 0 ? ` /Annots [${annots[i].map((n) => `${n} 0 R`).join(' ')}]` : '';
    objects[pageObj(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Contents ${pageObj(i) + 1} 0 R`
      + ` /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >>${links} >>`;
    const text = p.lines.map((l) => `BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf ${l.x} ${l.y} Td ${pdfString(l.text)} Tj ET`);
    const content = [...text, ...(p.content ? [p.content] : [])].join('\n');
    objects[pageObj(i) + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    (p.links ?? []).forEach((l, k) => {
      const to = 'uri' in l
        ? `/A << /S /URI /URI ${pdfString(l.uri)} >>`
        : `/Dest [${pageObj(l.page)} 0 R /XYZ null ${pages[l.page].height} null]`;
      objects[annots[i][k]] = `<< /Type /Annot /Subtype /Link /Rect [${l.rect.join(' ')}] /Border [0 0 0] ${to} >>`;
    });
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A line of 12 points, and the area of its text from `from` (its characters, Helvetica's mean width estimated). */
const line = (x: number, y: number, text: string, size = 12, bold = false): PdfLine => ({ x, y, size, text, bold });
const area = (l: PdfLine, from = 0, to = l.text.length): Rect =>
  [l.x + from * l.size * 0.5, l.y - l.size * 0.25, l.x + to * l.size * 0.5, l.y + l.size * 0.9];

/** Helvetica's widths in thousandths of its size (its AFM, as pdf.js lays it out): ASCII from the space, in order. */
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** And the others of French text in WinAnsiEncoding that the chapter's lines may hold. */
const HELVETICA_OTHERS: Record<string, number> = {
  à: 556, á: 556, â: 556, ç: 500, é: 556, è: 556, ê: 556, î: 278, ô: 556, ù: 556, û: 556, É: 667, '’': 222, '«': 556, '»': 556, '—': 1000,
};

/** The width of `text` in Helvetica (not bold), in thousandths of its size. */
function helveticaUnits(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const u = c >= 0x20 && c < 0x7f ? HELVETICA_ASCII[c - 0x20] : HELVETICA_OTHERS[ch];
    if (u === undefined) throw new Error(`Largeur Helvetica inconnue : « ${ch} »`);
    w += u;
  }
  return w;
}

/** The area of a line's characters [from, to), from Helvetica's widths: where they are drawn (summed in thousandths, exact). */
function textArea(l: PdfLine, from: number, to: number): Rect {
  const x = (k: number) => (1000 * l.x + helveticaUnits(l.text.slice(0, k)) * l.size) / 1000;
  return [x(from), l.y - l.size * 0.25, x(to), l.y + l.size * 0.9];
}

/**
 * A passage of a page as a selection gives it (plan 4c, D3): from the first `from` of its lines to the end of the first
 * `to` after it, its lines joined by a line break, and a rectangle per line in the page's coordinates. Regular lines only.
 */
export function passage(page: PdfPageSpec, from: string, to: string): { text: string; rects: Rect[] } {
  const lines = page.lines, first = lines.findIndex((l) => l.text.includes(from));
  if (first < 0) throw new Error(`« ${from} » n’est pas sur la page.`);
  const start = lines[first].text.indexOf(from), parts: string[] = [], rects: Rect[] = [];
  for (let i = first; i < lines.length; i++) {
    const l = lines[i], a = i === first ? start : 0, at = l.text.indexOf(to, a), b = at < 0 ? l.text.length : at + to.length;
    parts.push(l.text.slice(a, b));
    rects.push(textArea(l, a, b));
    if (at >= 0) return { text: parts.join('\n'), rects };
  }
  throw new Error(`« ${to} » ne suit pas « ${from} » sur la page.`);
}

/**
 * The test base's chapter in three A4 pages (« Li_Vitányi_chapitre_1.pdf », publication node): a summary whose
 * entries lead to pages 2 and 3, a web address and a mail address on page 1, a way back to it from the other two.
 * `earlier`: the version the base had first, re-imported since (plan 4c, D2), page 1's paragraph worded otherwise.
 */
export function chapterPdf(opts: { earlier?: boolean } = {}): Uint8Array {
  return writePdf(chapterPages(opts));
}

/** The pages of chapterPdf, for the passages its annotations highlight (passage). */
export function chapterPages({ earlier = false }: { earlier?: boolean } = {}): PdfPageSpec[] {
  const W = 595, H = 842;
  const toPage2 = line(90, 668, '1.1  Notations et définitions . . . . . . . . . . . . . . . page 2');
  const toPage3 = line(90, 648, '1.2  Complexité de Kolmogorov . . . . . . . . . . . . . . page 3');
  const web = line(72, 520, 'Page de référence : https://example.org/complexite-de-kolmogorov');
  const mail = line(72, 500, 'Écrire à l’auteur : auteur@example.org');
  const back = (y: number) => line(72, y, '« Retour au sommaire »');
  const back2 = back(560), back3 = back(540);
  const footer = (n: number) => line(W / 2 - 3, 40, String(n), 10);
  return [
    {
      width: W, height: H,
      lines: [
        line(72, 770, 'Chapitre 1 — Préliminaires', 20, true),
        line(72, 745, 'Ming Li et Paul Vitányi, An Introduction to Kolmogorov Complexity and Its Applications', 10),
        line(72, 730, 'Fichier d’exemple de la base de test de Cirrus (publication fictive, trois pages).', 10),
        line(72, 694, 'Sommaire', 13, true),
        toPage2, toPage3,
        line(72, 600, 'Ce chapitre fixe les notations du livre : chaînes binaires, longueur |x|, codes'),
        line(72, 584, 'préfixes et machines de Turing universelles. La complexité de Kolmogorov d’une'),
        line(72, 568, earlier ? 'chaîne est la taille du plus petit programme qui l’engendre.' : 'chaîne est la longueur du plus court programme qui l’écrit, à une constante près.'),
        web, mail, footer(1),
      ],
      links: [
        { rect: area(toPage2), page: 1 }, { rect: area(toPage3), page: 2 },
        { rect: area(web, 20), uri: 'https://example.org/complexite-de-kolmogorov' },
        { rect: area(mail, 20), uri: 'mailto:auteur@example.org' },
      ],
    },
    {
      width: W, height: H,
      lines: [
        line(72, 770, '1.1  Notations et définitions', 16, true),
        line(72, 730, 'Une chaîne binaire x est un mot sur l’alphabet {0, 1} ; |x| est sa longueur,'),
        line(72, 714, 'et e la chaîne vide. Un code est préfixe si aucun de ses mots n’est le début'),
        line(72, 698, 'd’un autre : il se lit sans séparateur. L’inégalité de Kraft borne alors les'),
        line(72, 682, 'longueurs l(i) de ses mots : la somme des 2^-l(i) vaut au plus 1.'),
        line(72, 650, 'Une machine de Turing préfixe U est universelle si elle simule toute autre'),
        line(72, 634, 'machine préfixe, pour un programme allongé d’une longueur fixe.'),
        back2, footer(2),
      ],
      links: [{ rect: area(back2), page: 0 }],
    },
    {
      width: W, height: H,
      lines: [
        line(72, 770, '1.2  Complexité de Kolmogorov', 16, true),
        line(72, 730, 'K(x) = min { |p| : U(p) = x }, où U est une machine universelle préfixe.'),
        line(72, 714, 'Théorème d’invariance : pour deux machines universelles U et V, il existe'),
        line(72, 698, 'une constante c telle que |K_U(x) - K_V(x)| <= c pour toute chaîne x.'),
        line(72, 666, 'La plupart des chaînes sont incompressibles : moins de 2^(n-c) chaînes'),
        line(72, 650, 'de longueur n ont une complexité inférieure à n - c.'),
        back3, footer(3),
      ],
      links: [{ rect: area(back3), page: 0 }],
    },
  ];
}
