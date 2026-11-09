import { extensionOf } from './kind.ts';

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
type Decoded = { text: string; encoding: Encoding } | { binary: true };

/** How far a zero byte is looked for: one there, without a UTF-16 BOM, makes the file a binary. */
const BINARY_PROBE = 8192;

/**
 * A text with invalid UTF-8 sequences is still read as UTF-8, each shown as U+FFFD, while its valid multi-byte
 * sequences are at least this many times as many (ruling of the final review on its Minor 1): a UTF-8 text where a
 * stray byte of another encoding lies (a log or a CSV two tools wrote to) keeps its accents, instead of being read
 * whole as Windows-1252, every accent garbled. A real Windows-1252 text has almost no valid multi-byte sequence — each
 * would need an accented letter followed by exactly the right symbols of 0x80–0xBF —, so it does not get there.
 * Twice rather than once, a margin against those chance sequences: a mixed file is read as UTF-8 once its UTF-8 part
 * is clearly the larger. Its cost: a short UTF-8 text with one accent and one stray byte is read as Windows-1252. A
 * decoding threshold, not a setting.
 */
const UTF8_VALID_PER_INVALID = 2;
/**
 * The invalid sequences counted before the count may stop (performance): past them, the first time the valid ones are
 * fewer than UTF8_VALID_PER_INVALID times as many, the text is read as Windows-1252 without counting the rest. A real
 * Windows-1252 text gets there within its first lines, so it costs no more to read than before; only a text mostly in
 * UTF-8 is counted to its end. A decoding threshold, not a setting.
 */
const UTF8_EVIDENCE = 64;

/**
 * Whether bytes that are not UTF-8 throughout are mostly UTF-8 (UTF8_VALID_PER_INVALID, UTF8_EVIDENCE): their
 * multi-byte sequences, valid and invalid, counted as TextDecoder reads them — the Encoding standard's decoder, for
 * which an invalid sequence is what one U+FFFD replaces —, in one pass over the bytes, without decoding them.
 * `truncated`: a character cut at the end of a head read is left out.
 */
function mostlyUtf8(bytes: Uint8Array, truncated: boolean): boolean {
  const n = bytes.length;
  let valid = 0, invalid = 0, i = 0;
  while (i < n) {
    const c = bytes[i++];
    if (c < 0x80) continue;
    // Two bytes, as a Latin accent is, at once.
    if (c >= 0xc2 && c <= 0xdf && i < n && (bytes[i] & 0xc0) === 0x80) {
      i++;
      valid++;
      continue;
    }
    // The continuation bytes the lead byte needs, and the range of the first one (the standard's boundaries).
    const needed = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
    let lower = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80, upper = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf, k = 0;
    // A byte out of range ends the sequence short: it is read again, as the start of what follows.
    while (k < needed && i < n && bytes[i] >= lower && bytes[i] <= upper) {
      i++;
      k++;
      lower = 0x80;
      upper = 0xbf;
    }
    if (needed > 0 && k === needed) valid++;
    else if (needed > 0 && i === n && truncated) break;
    else if (++invalid > UTF8_EVIDENCE && valid < UTF8_VALID_PER_INVALID * invalid) return false;
  }
  return valid >= UTF8_VALID_PER_INVALID * invalid;
}

/**
 * A text file's bytes as text (Review Focus 4). The BOM decides first (UTF-16LE, UTF-16BE, UTF-8), and is left out; a
 * zero byte in the first 8 KiB, without a UTF-16 BOM, means a binary; otherwise strict UTF-8. When that fails, UTF-8
 * still if its invalid sequences are rare (UTF8_VALID_PER_INVALID), each shown as U+FFFD; else Windows-1252, which
 * decodes any byte (the French Excel's CSV). `truncated`: the bytes are a longer file's head (readHead), whose last
 * character may be cut: it is left out instead of failing UTF-8.
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
    if (mostlyUtf8(bytes, truncated)) return { text: decode('utf-8', 0), encoding: 'utf-8' };
    return { text: decode('windows-1252', 0), encoding: 'windows-1252' };
  }
}

type Delimiter = ',' | ';' | '\t';
interface Table { rows: string[][]; delimiter: Delimiter; truncated: boolean }

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
