/**
 * A publication's CSL-JSON (plan 4c, D5), as the DOI resolver's content negotiation gives it: an object parsed from
 * JSON, read as data only. Pure: the interface reads it too (task 5).
 */
export type Csl = Record<string, unknown>;

/** What a publication's node takes from its CSL (D7): its title, its authors « Prénom Nom », its year. */
export interface PublicationFields { title: string; authors: string[]; year: string | null }

/** `o`'s own field `key`: never one inherited (`toString`, `constructor`), whatever the JSON named. */
const field = (o: unknown, key: string): unknown =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;

/** An inline tag of the markup Crossref leaves in titles (<i>, <sub>, <scp>, <mml:math …>); a « < » that opens none stays. */
const TAG = /<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

/** A code point an entity may give: not a control character, nor a surrogate. */
const printable = (n: number) => Number.isInteger(n) && n >= 32 && n !== 127 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff);

/** A text field as plain text: its tags dropped, its entities decoded, its blanks made one space; '' if not a string. */
function plain(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(TAG, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (all, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return ENTITIES[name.toLowerCase()] ?? all;
      const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return printable(n) ? String.fromCodePoint(n) : all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** A name: its literal form, else given name, particles, family name and suffix, in reading order. */
function nameOf(a: unknown): string {
  const literal = plain(field(a, 'literal'));
  if (literal) return literal;
  return ['given', 'dropping-particle', 'non-dropping-particle', 'family', 'suffix'].map((k) => plain(field(a, k))).filter((s) => s !== '').join(' ');
}

/** A CSL date's year: its first date-part, a whole number of at most four digits, else four digits of its raw text. */
function yearOf(d: unknown): string | null {
  const parts = field(d, 'date-parts');
  const first = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : undefined;
  const n = typeof first === 'string' && /^\d{1,4}$/.test(first) ? Number(first) : first;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 9999) return String(n);
  for (const k of ['raw', 'literal']) {
    const m = /\b(\d{4})\b/.exec(plain(field(d, k)));
    if (m) return m[1];
  }
  return null;
}

/**
 * The fields of a publication's node (D7) from its CSL, read defensively (Review Focus 1): null if it is no object or
 * has no title. A field of an unexpected type is ignored, never run nor followed: a title of several (the first one), an
 * author that is not an object, a date without year. The year comes from `issued`, else the print, else the online
 * publication.
 */
export function cslToFields(csl: unknown): PublicationFields | null {
  const t = field(csl, 'title');
  const title = plain(Array.isArray(t) ? t[0] : t);
  if (title === '') return null;
  const list = field(csl, 'author');
  const authors = Array.isArray(list) ? list.map(nameOf).filter((n) => n !== '') : [];
  let year: string | null = null;
  for (const k of ['issued', 'published-print', 'published-online']) if (year === null) year = yearOf(field(csl, k));
  return { title, authors, year };
}
