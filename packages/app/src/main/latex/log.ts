import type { KnownLabel, TexError } from '@cirrus/core';

/**
 * What pdfLaTeX's log and .aux say (plan 4b, task 3). The service runs it with max_print_line raised, so that no line of
 * the log is cut: the stack of open files can then be read from its parentheses, TeX printing « (name » when it opens a
 * file and « ) » when it closes it.
 */

const WARNING = /^(?:(?:LaTeX|Package|Class|Module)\b[^:]*Warning|pdfTeX warning)/;
const PAGES = /^Output written on .*\((\d+) pages?\b/;
/** A box's excerpt follows these lines until an empty one: typeset text, whose parentheses open no file. */
const BOX = /^(?:Over|Under)full \\[hv]box/;
/** The name in « (name »: a path, or a name quoted for its spaces. */
const OPENED = /^(?:"([^"]+)"|([^\s()"]+))/;

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/** The files open at the end of `lines`, innermost last. */
function openFiles(lines: string[]): string[] {
  const stack: (string | null)[] = [];
  let inBox = false;
  for (const line of lines) {
    if (inBox) {
      inBox = line !== '';
      continue;
    }
    if (BOX.test(line)) {
      inBox = true;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ')') stack.pop();
      else if (line[i] === '(') {
        const m = OPENED.exec(line.slice(i + 1));
        const name = m ? (m[1] ?? m[2]) : '';
        // A file's name has an extension; « (Font) », « (12.3pt too wide) » open no file, but close as files do.
        stack.push(/\.[A-Za-z0-9]+$/.test(name) ? name : null);
      }
    }
  }
  return stack.filter((f): f is string => f !== null);
}

/**
 * The first error (the first line starting with « ! »), with its line when the source was the file being read; its
 * place: the preamble when it came before the driver said CIRRUS-READY, the line then being the preamble's; the source
 * otherwise (a standalone document's whole file is the source). Also the pages written and the warnings.
 */
export function parseLog(log: string, src: string): { error: TexError | null; pages: number; warnings: number } {
  const lines = log.split(/\r?\n/);
  let pages = 0, warnings = 0;
  for (const line of lines) {
    const m = PAGES.exec(line);
    if (m) pages = Number(m[1]);
    if (WARNING.test(line)) warnings++;
  }
  const bang = lines.findIndex((l) => l.startsWith('!'));
  if (bang < 0) return { error: null, pages, warnings };
  const message = lines[bang].replace(/^!\s*/, '');
  let at: number | null = null;
  for (let i = bang + 1; i < lines.length && at === null; i++) {
    const m = /^l\.(\d+)/.exec(lines[i]);
    if (m) at = Number(m[1]);
  }
  const open = openFiles(lines.slice(0, bang)).map(baseName);
  const innermost = open.at(-1);
  if (open.includes(src)) return { error: { message, line: innermost === src ? at : null, where: 'source' }, pages, warnings };
  const ready = lines.findIndex((l) => l.includes('CIRRUS-READY'));
  if (ready < 0 || ready > bang) {
    return { error: { message: `Le préambule ne compile pas : ${message}`, line: innermost === 'preamble.tex' ? at : null, where: 'preamble' }, pages, warnings };
  }
  // After the preamble and before the source: the app's own body.
  return { error: { message, line: null, where: 'source' }, pages, warnings };
}

/** The group `{…}` starting at s[i], and the index after it; null if it does not close. */
function group(s: string, i: number): [string, number] | null {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return null;
}

/**
 * This source's labels, from its .aux: \newlabel{name}{{number}{page}{title}{anchor}{…}} (five fields, the kernel's and
 * hyperref's; two in an older kernel, without anchor). A label written twice keeps its last value, in its first place.
 */
export function readAux(aux: string): KnownLabel[] {
  const out = new Map<string, KnownLabel>();
  for (const m of aux.matchAll(/\\newlabel(?=\{)/g)) {
    const name = group(aux, m.index + m[0].length);
    const value = name && group(aux, name[1]);
    if (!name || !value) continue;
    const fields: string[] = [];
    for (let i = 0, f; (f = group(value[0], i)) !== null; i = f[1]) fields.push(f[0]);
    if (fields.length < 2) continue;
    out.set(name[0], { label: name[0], number: fields[0], page: fields[1], anchor: fields[3] ?? '' });
  }
  return [...out.values()];
}
