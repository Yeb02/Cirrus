import { isStandalone } from '@cirrus/core';

/** from, to: the name's offsets inside its braces; line: 1-based. */
export interface TexMark { name: string; from: number; to: number; line: number }
export interface TexScan { labels: TexMark[]; refs: TexMark[]; cites: TexMark[]; standalone: boolean }

/** The commands that refer to a label (the kernel, amsmath, hyperref, nameref, varioref, cleveref): cleveref's take a list. */
const REFS = new Set(['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'vref']);
const REF_LISTS = new Set(['cref', 'Cref']);
/** The citation commands (the kernel, natbib, biblatex): up to two optional arguments, then a list of keys. */
const CITES = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'parencite', 'textcite']);
/** The environments whose content is not LaTeX, read up to their \end whatever it holds; their starred forms too. */
const VERBATIM = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'lstlisting']);

const BACKSLASH = 92, PERCENT = 37, LF = 10, COMMA = 44, STAR = 42, OPEN = 123, CLOSE = 125, OPEN_OPT = 91, CLOSE_OPT = 93;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * What a LaTeX source defines and cites (plan 4b, D7), in one pass: its \label, its references (REFS) and its citations
 * (CITES), their starred forms included, each with its name's offsets inside its braces and its line. A list (\cref,
 * the citations) gives one mark per name, without the spaces around it; a single name is taken as written, as LaTeX
 * reads it. A « % » that no backslash escapes starts a comment, to the end of its line (« \% » is text, « \\% » a
 * comment); the VERBATIM environments are skipped. Not marks: an argument never closed or holding a comment, an empty
 * name, a macro's parameter (« #1 », in a definition), \nocite{*}. `standalone` is the main process's rule
 * (isStandalone): \documentclass outside a comment.
 */
export function scanTex(text: string): TexScan {
  const out: TexScan = { labels: [], refs: [], cites: [], standalone: isStandalone(text) };
  // Lines are counted as the marks come, in the order of their offsets.
  let counted = 0, line = 1;
  const lineOf = (at: number) => {
    for (; counted < at; counted++) if (text.charCodeAt(counted) === LF) line++;
    return line;
  };
  const mark = (list: TexMark[], from: number, to: number) => {
    const name = text.slice(from, to);
    if (name.trim() !== '' && !name.includes('#')) list.push({ name, from, to, line: lineOf(from) });
  };
  const marks = (list: TexMark[], from: number, to: number) => {
    for (let start = from, k = from; k <= to; k++) {
      if (k < to && text.charCodeAt(k) !== COMMA) continue;
      let a = start, b = k;
      while (a < b && isSpace(text.charCodeAt(a))) a++;
      while (b > a && isSpace(text.charCodeAt(b - 1))) b--;
      if (!(b === a + 1 && text.charCodeAt(a) === STAR)) mark(list, a, b);
      start = k + 1;
    }
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === PERCENT) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c !== BACKSLASH) { i++; continue; }
    let j = i + 1;
    while (j < n && isLetter(text.charCodeAt(j))) j++;
    // A control symbol (\%, \\, \{…): its character is not read again.
    if (j === i + 1) { i += 2; continue; }
    const name = text.slice(i + 1, j);
    i = j;
    if (name === 'label') {
      const a = argument(text, j, false, 0);
      if (a) { mark(out.labels, a.from, a.to); i = a.to + 1; }
    } else if (REFS.has(name)) {
      const a = argument(text, j, true, 0);
      if (a) { (REF_LISTS.has(name) ? marks : mark)(out.refs, a.from, a.to); i = a.to + 1; }
    } else if (CITES.has(name)) {
      const a = argument(text, j, true, 2);
      if (a) { marks(out.cites, a.from, a.to); i = a.to + 1; }
    } else if (name === 'begin') {
      const a = argument(text, j, false, 0);
      if (!a) continue;
      i = a.to + 1;
      const env = text.slice(a.from, a.to);
      if (VERBATIM.has(env)) {
        const end = text.indexOf(`\\end{${env}}`, i);
        i = end < 0 ? n : end + `\\end{${env}}`.length;
      }
    }
  }
  return out;
}

/**
 * A command's argument, its name ending at `at`: its star if `star`, up to `optionals` arguments in brackets, then the
 * one in braces, TeX skipping the spaces before each. The offsets of what its braces hold; null when there are none,
 * or when the end of the text or a comment comes before they close.
 */
function argument(text: string, at: number, star: boolean, optionals: number): { from: number; to: number } | null {
  let i = skipSpaces(text, at);
  if (star && text.charCodeAt(i) === STAR) i = skipSpaces(text, i + 1);
  for (let k = 0; k < optionals && text.charCodeAt(i) === OPEN_OPT; k++) {
    const close = closing(text, i + 1, CLOSE_OPT);
    if (close < 0) return null;
    i = skipSpaces(text, close + 1);
  }
  if (text.charCodeAt(i) !== OPEN) return null;
  const close = closing(text, i + 1, CLOSE);
  return close < 0 ? null : { from: i + 1, to: close };
}

function skipSpaces(text: string, i: number): number {
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i;
}

/** The offset of `end` outside any braces from `from`, an escaped character skipped; −1 at a comment, an unbalanced brace or the end. */
function closing(text: string, from: number, end: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) i++;
    else if (c === PERCENT) return -1;
    else if (c === end && depth === 0) return i;
    else if (c === OPEN) depth++;
    else if (c === CLOSE && --depth < 0) return -1;
  }
  return -1;
}
