import { isStandalone } from '@cirrus/core';

/**
 * name: as TeX reads it; from, to: the offsets of its first and last character inside its braces, a comment between
 * them included (`\ref{kc%⏎:def}`: text.slice(from, to) is then not the name); line: 1-based, its first character's.
 */
export interface TexMark { name: string; from: number; to: number; line: number }
export interface TexScan { labels: TexMark[]; refs: TexMark[]; cites: TexMark[]; standalone: boolean }

/** The commands that refer to a label (the kernel, amsmath, hyperref, nameref, varioref, cleveref): cleveref's take a list. */
export const REFS: ReadonlySet<string> = new Set(['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'vref']);
export const REF_LISTS: ReadonlySet<string> = new Set(['cref', 'Cref']);
/** The citation commands (the kernel, natbib, biblatex): up to two optional arguments, then a list of keys. */
export const CITES: ReadonlySet<string> = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'parencite', 'textcite']);
/** The environments whose content is not LaTeX, read up to their \end whatever it holds; their starred forms too. */
const VERBATIM = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'lstlisting']);

const BACKSLASH = 92, PERCENT = 37, LF = 10, STAR = 42, OPEN = 123, CLOSE = 125, OPEN_OPT = 91, CLOSE_OPT = 93;
/** A letter of a control word's name (ASCII, as TeX reads one): the editor's completion reads names so too. */
export const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * What a LaTeX source defines and cites (plan 4b, D7), in one pass: its \label, its references (REFS) and its citations
 * (CITES), their starred forms included, each with its name's offsets and its line. A list (\cref, the citations)
 * gives one mark per name, without the spaces around it; a single name is taken as written, as LaTeX reads it. A « % »
 * that no backslash escapes starts a comment, to the end of its line (« \% » is text, « \\% » a comment): inside an
 * argument, it is taken out as TeX does, the spaces that start the next line with it, so that a list may go on there
 * (`\cite{a,%⏎ b}`). The VERBATIM environments are skipped. Not marks: an argument never closed, an empty name, a
 * macro's parameter (« #1 », in a definition), \nocite{*}. `standalone` is the main process's rule (isStandalone):
 * \documentclass outside a comment.
 */
export function scanTex(text: string): TexScan {
  const out: TexScan = { labels: [], refs: [], cites: [], standalone: isStandalone(text) };
  // Lines are counted as the marks come, in the order of their offsets.
  let counted = 0, line = 1;
  const lineOf = (at: number) => {
    for (; counted < at; counted++) if (text.charCodeAt(counted) === LF) line++;
    return line;
  };
  /** A name, from its characters: its offsets run from the first to the last, a comment inside them included. */
  const mark = (list: TexMark[], chars: Char[]) => {
    if (chars.length === 0) return;
    const name = chars.map((c) => c.ch).join(''), first = chars[0].at, last = chars[chars.length - 1];
    if (name.trim() !== '' && !name.includes('#')) list.push({ name, from: first, to: last.at + last.ch.length, line: lineOf(first) });
  };
  const one = (list: TexMark[], from: number, to: number) => mark(list, charsOf(text, from, to));
  const marks = (list: TexMark[], from: number, to: number) => {
    const chars = charsOf(text, from, to);
    for (let start = 0, k = 0; k <= chars.length; k++) {
      if (k < chars.length && chars[k].ch !== ',') continue;
      let a = start, b = k;
      while (a < b && isSpace(chars[a].ch.charCodeAt(0))) a++;
      while (b > a && isSpace(chars[b - 1].ch.charCodeAt(0))) b--;
      if (!(b === a + 1 && chars[a].ch === '*')) mark(list, chars.slice(a, b));
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
      if (a) { one(out.labels, a.from, a.to); i = a.to + 1; }
    } else if (REFS.has(name)) {
      const a = argument(text, j, true, 0);
      if (a) { (REF_LISTS.has(name) ? marks : one)(out.refs, a.from, a.to); i = a.to + 1; }
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

/** A character of an argument as TeX reads it, and its offset; an escaped one with its backslash (`\,` is no comma). */
interface Char { ch: string; at: number }

/**
 * The characters of text[from, to), an argument's content, as TeX reads them: a comment taken out, from an unescaped
 * « % » to the end of its line, with the spaces that start the next one.
 */
function charsOf(text: string, from: number, to: number): Char[] {
  const out: Char[] = [];
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c === PERCENT) {
      const end = text.indexOf('\n', i);
      if (end < 0 || end >= to) break;
      for (i = end + 1; i < to && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9); i++);
      i--;
    } else if (c === BACKSLASH && i + 1 < to) {
      out.push({ ch: text.slice(i, i + 2), at: i });
      i++;
    } else out.push({ ch: text[i], at: i });
  }
  return out;
}

/**
 * A command's argument, its name ending at `at`: its star if `star`, up to `optionals` arguments in brackets, then the
 * one in braces, TeX skipping the spaces and comments before each. The offsets of what its braces hold; null when
 * there are none, or when the end of the text comes before they close.
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

/** Past the spaces and the comments from `i`. */
function skipSpaces(text: string, i: number): number {
  for (;;) {
    while (i < text.length && isSpace(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i) !== PERCENT) return i;
    const end = text.indexOf('\n', i);
    if (end < 0) return text.length;
    i = end + 1;
  }
}

/**
 * The offset of `end` outside any braces from `from`, an escaped character and the comments skipped; −1 at an
 * unbalanced brace or the end of the text.
 */
function closing(text: string, from: number, end: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) i++;
    else if (c === PERCENT) {
      const eol = text.indexOf('\n', i);
      if (eol < 0) return -1;
      i = eol;
    } else if (c === end && depth === 0) return i;
    else if (c === OPEN) depth++;
    else if (c === CLOSE && --depth < 0) return -1;
  }
  return -1;
}
