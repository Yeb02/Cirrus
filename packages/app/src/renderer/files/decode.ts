import { extensionOf } from './kind.ts';

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
export type Decoded = { text: string; encoding: Encoding } | { binary: true };

/** How far a zero byte is looked for: one there, without a UTF-16 BOM, makes the file a binary. */
const BINARY_PROBE = 8192;

/**
 * A text file's bytes as text (Review Focus 4). The BOM decides first (UTF-16LE, UTF-16BE, UTF-8), and is left out; a
 * zero byte in the first 8 KiB, without a UTF-16 BOM, means a binary; otherwise strict UTF-8, and Windows-1252 when that
 * fails (the French Excel's CSV), which decodes any byte. `truncated`: the bytes are a longer file's head (readHead),
 * whose last character may be cut: it is left out instead of failing UTF-8.
 */
export function decodeText(bytes: Uint8Array, truncated = false): Decoded {
  const decode = (encoding: Encoding, from: number, fatal = false) =>
    new TextDecoder(encoding, { fatal, ignoreBOM: true }).decode(bytes.subarray(from), { stream: truncated });
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decode('utf-16le', 2), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decode('utf-16be', 2), encoding: 'utf-16be' };
  if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { binary: true };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: decode('utf-8', 3), encoding: 'utf-8' };
  try {
    return { text: decode('utf-8', 0, true), encoding: 'utf-8' };
  } catch {
    return { text: decode('windows-1252', 0), encoding: 'windows-1252' };
  }
}

export type Delimiter = ',' | ';' | '\t';
export interface Table { rows: string[][]; delimiter: Delimiter; truncated: boolean }

/** The delimiters tried, by preference when two are as constant: a tab or a semicolon rarely shows in a value, a comma often does (French decimals). */
const DELIMITERS: Delimiter[] = ['\t', ';', ','];
/** How many records the delimiter is guessed from. */
const SNIFF_ROWS = 20;
const QUOTE = 34, LF = 10, CR = 13;

/** A .tsv is read with tabs; any other table has its delimiter guessed (undefined). */
export function delimiterFor(name: string): Delimiter | undefined {
  return extensionOf(name) === 'tsv' ? '\t' : undefined;
}

/**
 * A CSV or TSV text as rows (plan 4a, D4): quotes as in RFC 4180, a doubled quote inside them is one, and line breaks
 * inside them are kept; records end at CRLF, LF or CR. At most `maxRows` rows (`truncated` when more follow). Without a
 * `delimiter`, the one whose count per record, outside quotes, is the most constant over the first 20 records.
 */
export function parseDelimited(text: string, maxRows: number, delimiter?: Delimiter): Table {
  const d = delimiter ?? guessDelimiter(text);
  return { ...parse(text, d.charCodeAt(0), maxRows), delimiter: d };
}

/**
 * The delimiter of the most constant count: for each, the share of the first records (blank lines aside) that have its
 * most frequent count, that count above zero. Two as constant: the first of DELIMITERS (a French CSV whose every line has
 * as many decimal commas as semicolons is read with semicolons). None found: a comma.
 */
function guessDelimiter(text: string): Delimiter {
  let best: Delimiter = ',', bestShare = 0;
  for (const d of DELIMITERS) {
    const counts = parse(text, d.charCodeAt(0), SNIFF_ROWS).rows.filter((r) => r.length > 1 || r[0] !== '').map((r) => r.length - 1);
    const seen = new Map<number, number>();
    let mode = 0, times = 0;
    for (const c of counts) {
      const t = (seen.get(c) ?? 0) + 1;
      seen.set(c, t);
      if (t > times || (t === times && c > mode)) { mode = c; times = t; }
    }
    if (mode > 0 && times / counts.length > bestShare) { best = d; bestShare = times / counts.length; }
  }
  return best;
}

/**
 * The records of `text`, `d` the delimiter's char code. A field opening with a quote runs to the next lone quote (to the
 * end of the text if none); what follows that quote up to the delimiter is kept, as lenient readers do. A quote inside an
 * unquoted field is a character like any other.
 */
function parse(text: string, d: number, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [], n = text.length;
  let i = 0;
  while (i < n) {
    if (rows.length >= maxRows) return { rows, truncated: true };
    const row: string[] = [];
    for (;;) {
      let field = '';
      if (text.charCodeAt(i) === QUOTE) {
        for (let from = i + 1; ;) {
          const q = text.indexOf('"', from);
          if (q < 0) { field += text.slice(from); i = n; break; }
          if (text.charCodeAt(q + 1) === QUOTE) { field += text.slice(from, q + 1); from = q + 2; continue; }
          field += text.slice(from, q);
          i = q + 1;
          break;
        }
      }
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === d || c === LF || c === CR) break;
        j++;
      }
      row.push(j > i ? field + text.slice(i, j) : field);
      i = j;
      if (i >= n) break;
      if (text.charCodeAt(i) === d) { i++; continue; }
      i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      break;
    }
    rows.push(row);
  }
  return { rows, truncated: false };
}
