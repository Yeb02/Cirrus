// BibTeX as Cirrus reads it (plan 4c, D7, D9): a parser of our own (no dependency), the normalisations a publication's
// node takes from an entry — its title and authors in Unicode, its year, its identifiers —, its key, and the entry
// written back as a file of its own. Every input is the user's or a server's, possibly hostile (Review Focus 1): nothing
// recurses, every value is bounded, every name is a Map's key (never an object's property), and a broken entry is set
// aside with its line, the next ones read all the same.
import { safeLabel } from './latex.ts';

/** An entry of a .bib. */
export interface BibEntry {
  /** Its type, in lower case (article, book, misc…). */
  type: string;
  /** Its key as written; '' when it has none. */
  key: string;
  /**
   * Its fields by name, in lower case, in their order: their values with the file's @string macros resolved, a month
   * macro named (jul: July), concatenations (#) joined, the LaTeX kept as it is (latexToUnicode reads it).
   */
  fields: Map<string, string>;
  /** The same fields as BibTeX writes them: braced text, a bare number, a macro the file does not define kept as one. */
  raw: Map<string, string>;
  /** The line of its « @ », from 1. */
  line: number;
  /** The line of the entry above whose key is this one's, without case, if any: a problem says so (repeatedKeyMessage). */
  repeats?: number;
}

/** What is wrong in a .bib, in French, at the line of the entry concerned. */
export interface BibProblem { line: number; message: string }

/**
 * A text longer than this is not read at all (a fixed bound of security, the controller's ruling M8, task 6): about
 * 150 Mo held at the bound while it is read (the text, the table of its braces, its values), some 8 000 entries with
 * their abstracts. parseBibtex checks it itself, so every path is bounded: a server's answer, a .bib dropped or chosen.
 */
export const BIB_MAX_CHARS = 16 * 2 ** 20;
/**
 * A file larger than this cannot be a text of BIB_MAX_CHARS characters, whatever its encoding — UTF-16 with its BOM,
 * two bytes a character; UTF-8 and Windows-1252, one at least —: the main process does not read it (task 6).
 */
export const BIB_MAX_BYTES = 2 * BIB_MAX_CHARS + 2;
/**
 * A name taken from a file — a key, a type, a field's or a macro's name, a title — is said in a message with this many
 * characters at most, then « … » (a fixed bound of security: 200 problems naming a macro of a megabyte each would hold
 * 400 Mo; and a notification stays legible, task 6).
 */
export const BIB_NAME_CHARS = 80;

/** `s` as a message says it: BIB_NAME_CHARS characters at most, then « … », never cutting a character in two. */
export function bibShort(s: string): string {
  if (s.length <= BIB_NAME_CHARS) return s;
  const c = s.charCodeAt(BIB_NAME_CHARS - 1);
  return `${s.slice(0, c >= 0xd800 && c <= 0xdbff ? BIB_NAME_CHARS - 1 : BIB_NAME_CHARS)}…`;
}

/** An entry as a problem names it: by its key, cut, or by its type without one. */
const entryName = (e: BibEntry) => (e.key === '' ? `Entrée @${bibShort(e.type)}` : `Entrée « ${bibShort(e.key)} »`);
/**
 * What parseBibtex says, at its line, of an entry whose key an entry above has (`repeats`): the import, which sets such
 * an entry aside as a duplicate, says it once (task 6, review M2).
 */
export function repeatedKeyMessage(e: BibEntry): string {
  return `${entryName(e)} : la clé est déjà celle de l’entrée de la ligne ${e.repeats}.`;
}

/**
 * A .bib read: its entries, its problems; `omitted`, the problems past BIB_MAX_PROBLEMS, which the problem « Et N
 * autres problèmes. » counts; `stopped`, why the reading stopped before the end of the text if it did (too large, too
 * many entries, too broken), the last of the problems too.
 */
export interface BibRead { entries: BibEntry[]; problems: BibProblem[]; omitted: number; stopped: BibProblem | null }

/** A value longer than this, its macros resolved, is refused: its entry set aside (a fixed bound of security). */
export const BIB_MAX_VALUE_CHARS = 1 << 20;
/** The problems listed at most; one more counts the others (a fixed bound). */
export const BIB_MAX_PROBLEMS = 200;
/** The entries read at most, 25 times the 2 000 of a large library (plan 4c): those past it are said, not read (a fixed bound). */
export const BIB_MAX_ENTRIES = 50_000;
/**
 * The characters the reading examines at most, BIB_WORK_PER_CHAR times the text's length plus BIB_WORK_SLACK: past it,
 * it stops, the entries read kept, and says where (a fixed bound of security, the controller's ruling of re-review N1).
 * A broken entry is read again from its next « @ » at the start of a line, and entries broken on purpose can make each
 * one read the same long tail. A sound file examines each character once at most, braced values jumped over (they are
 * the value budget's): the real one of the tests, 2 000 entries included, 0.4 times its length.
 */
export const BIB_WORK_PER_CHAR = 8;
export const BIB_WORK_SLACK = 1 << 20;

/** The months BibTeX's styles define, as BibTeX's own (plain.bst) names them. */
const MONTHS = new Map(Object.entries({
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
}));
/**
 * A month written whole, as Crossref writes it (`month=July`), is that month's macro, written back under it (`jul`):
 * the controller's ruling of the review. An @string of the file of that name is read first.
 */
const MONTH_NAMES = new Map([...MONTHS].map(([macro, name]) => [name.toLowerCase(), macro]));

/** A refusal of the entry being read: its reason, in French. */
class Broken extends Error {}
/** The work's cap reached (BIB_WORK_PER_CHAR): the reading stops. */
class Exhausted extends Error {}

const OPEN = 123, CLOSE = 125, QUOTE = 34, HASH = 35, PERCENT = 37, COMMA = 44, EQUALS = 61, AT = 64, LPAREN = 40, RPAREN = 41, NEWLINE = 10;
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
/** A character of a type, a field's or a macro's name: BibTeX's, any but blanks and " # % ' ( ) , = { }. */
const isIdent = (c: number) => !isSpace(c) && c !== QUOTE && c !== HASH && c !== PERCENT && c !== 39 && c !== LPAREN && c !== RPAREN && c !== COMMA
  && c !== EQUALS && c !== OPEN && c !== CLOSE && !Number.isNaN(c);
/** A character of a key: any but blanks , = { } ( ) " # % (a DataCite key is an address, and is read as one). */
const isKeyChar = (c: number) => !isSpace(c) && c !== COMMA && c !== EQUALS && c !== OPEN && c !== CLOSE && c !== LPAREN && c !== RPAREN && c !== QUOTE
  && c !== HASH && c !== PERCENT && !Number.isNaN(c);
const isDigit = (c: number) => c >= 48 && c <= 57;
const fr = (n: number) => n.toLocaleString('fr-FR');

/** A value as it is read: its text, and its parts as BibTeX writes them (text, braced, the parts in a row joined; a number or a macro, bare). */
interface Value { text: string; parts: { s: string; bare: boolean }[] }

/**
 * A .bib read (plan 4c, D9): its entries in order, and its problems. Read as BibTeX and biber read it: `@type{key,
 * name = value, …}` or with parentheses; a value braced (nested braces kept), quoted (a quote inside braces is text), a
 * number, or a macro — @string's, defined before its use, without case, or a month —, joined by « # »; @comment and
 * @preamble are no entries; outside an entry everything is a comment, and so is a « % » to the end of its line between
 * an entry's tokens (biber's, JabRef's), which puts an entry out of use. A broken entry is set aside and said, at its
 * line, and reading goes on from the next « @ » at the start of a line; a field twice keeps the first, a key twice is
 * said (both entries kept); a macro defined nowhere is left empty, and said. Each brace's match is found once,
 * beforehand (a parenthesis's, at the first @comment(), so a group is jumped over at once. Bounded: a value of
 * BIB_MAX_VALUE_CHARS at most, all of them four times the text's length (plus one value's cap), BIB_MAX_ENTRIES
 * entries read, BIB_MAX_PROBLEMS problems listed, and the characters examined — every scan counted, a broken entry's
 * read again included — BIB_WORK_PER_CHAR times the text's length plus BIB_WORK_SLACK: the time is linear whatever
 * the file (re-review N1). A text of more than BIB_MAX_CHARS characters is not read (task 6, M8); a name the file
 * gives is said in a problem cut to BIB_NAME_CHARS (bibShort).
 */
export function parseBibtex(text: string): BibRead {
  const n = text.length;
  if (n > BIB_MAX_CHARS) {
    const tooLarge = { line: 1, message: `Le fichier fait ${fr(n)} caractères, plus que les ${fr(BIB_MAX_CHARS)} qu’un .bib peut compter : il n’est pas lu.` };
    return { entries: [], problems: [tooLarge], omitted: 0, stopped: tooLarge };
  }
  const entries: BibEntry[] = [], problems: BibProblem[] = [];
  let omitted = 0, omittedLine = 0;
  // Every brace's match, beforehand: a value never closed costs one look-up, not a reading to the end of the file.
  const match = new Int32Array(n).fill(-1);
  {
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === OPEN) stack.push(i);
      else if (c === CLOSE && stack.length > 0) match[stack.pop()!] = i;
    }
  }
  // The parentheses' matches, once, at the first @comment( (whose body is skipped balanced): an unclosed one costs a look-up.
  let parens: Int32Array | null = null;
  const parenMatch = (p: number): number => {
    if (parens === null) {
      parens = new Int32Array(n).fill(-1);
      const stack: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = text.charCodeAt(i);
        if (c === LPAREN) stack.push(i);
        else if (c === RPAREN && stack.length > 0) parens[stack.pop()!] = i;
      }
    }
    return parens[p];
  };
  /** Where the entries past BIB_MAX_ENTRIES begin, if any. */
  let tooMany = -1;
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (at: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const problem = (at: number, message: string) => {
    if (problems.length < BIB_MAX_PROBLEMS) problems.push({ line: lineOf(at), message });
    else if (omitted++ === 0) omittedLine = lineOf(at);
  };
  const strings = new Map<string, string>();
  const keys = new Map<string, number>();
  let budget = 4 * n + BIB_MAX_VALUE_CHARS;
  /** The characters examined so far, every scan's (BIB_WORK_PER_CHAR); `stoppedAt`, where the reading stopped at its cap. */
  let work = 0, stoppedAt = -1;
  const workCap = BIB_WORK_PER_CHAR * n + BIB_WORK_SLACK;
  /** `k` characters examined: past the cap, the reading stops (Exhausted). A scan is charged once done, n at most. */
  const charge = (k: number) => {
    work += k;
    if (work > workCap) throw new Exhausted();
  };

  /** Past blanks, and « % » comments to the end of their line. */
  const skip = (from: number) => {
    let p = from;
    for (;;) {
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (p < n && text.charCodeAt(p) === PERCENT) {
        const eol = text.indexOf('\n', p);
        p = eol < 0 ? n : eol + 1;
      } else {
        charge(p - from);
        return p;
      }
    }
  };
  const ident = (p: number) => {
    let q = p;
    while (q < n && isIdent(text.charCodeAt(q))) q++;
    charge(q - p);
    return q;
  };
  const end = () => new Broken('le fichier finit avant la fin de l’entrée.');

  /**
   * The value at `p`: its parts joined by « # ». `unknown`: a macro defined nowhere, said once read. Throws Broken
   * past the caps or on a part that does not end.
   */
  const value = (p: number, unknown: (name: string) => void): { v: Value; p: number } => {
    const v: Value = { text: '', parts: [] };
    /** `bare`: how BibTeX writes the part (a number, a macro); null for text. */
    const add = (s: string, bare: string | null) => {
      if (v.text.length + s.length > BIB_MAX_VALUE_CHARS) throw new Broken(`la valeur fait plus de ${fr(BIB_MAX_VALUE_CHARS)} caractères.`);
      if (s.length > budget) throw new Broken(`les valeurs du fichier, ses macros remplacées, font plus de ${fr(4 * n + BIB_MAX_VALUE_CHARS)} caractères.`);
      budget -= s.length;
      v.text += s;
      // Text joins the text before it; a number or a macro is a part of its own.
      const last = v.parts[v.parts.length - 1];
      if (bare !== null) v.parts.push({ s: bare, bare: true });
      else if (last !== undefined && !last.bare) last.s += s;
      else v.parts.push({ s, bare: false });
    };
    for (;;) {
      if (p >= n) throw end();
      const c = text.charCodeAt(p);
      if (c === OPEN) {
        const q = match[p];
        if (q < 0) throw new Broken(`l’accolade ouverte ligne ${lineOf(p)} n’est jamais fermée.`);
        add(text.slice(p + 1, q), null);
        p = q + 1;
      } else if (c === QUOTE) {
        // Up to the quote outside braces, a brace group jumped over at once; a closing brace that closes none of
        // them stops it (BibTeX refuses it too). So the walks of two different quotes never cross the same character:
        // one that starts in a group another jumped over ends at that group's closing brace at the latest (review,
        // I1). The same quote, walked again by entries read again after a broken one, is charged each time (N1).
        let q = p + 1, steps = 0;
        try {
          for (; q < n; q++, steps++) {
            const d = text.charCodeAt(q);
            if (d === QUOTE) break;
            if (d === CLOSE) throw new Broken(`l’accolade fermante de la ligne ${lineOf(q)} ne ferme rien entre les guillemets.`);
            if (d === OPEN) {
              if (match[q] < 0) throw new Broken(`l’accolade ouverte ligne ${lineOf(q)} n’est jamais fermée.`);
              q = match[q];
            }
          }
        } finally {
          charge(steps);
        }
        if (q >= n) throw new Broken(`le guillemet ouvert ligne ${lineOf(p)} n’est jamais fermé.`);
        add(text.slice(p + 1, q), null);
        p = q + 1;
      } else if (isDigit(c)) {
        let q = p;
        while (q < n && isDigit(text.charCodeAt(q))) q++;
        charge(q - p);
        add(text.slice(p, q), text.slice(p, q));
        p = q;
      } else if (isIdent(c)) {
        const q = ident(p), name = text.slice(p, q), lower = name.toLowerCase();
        const defined = strings.get(lower), month = MONTH_NAMES.get(lower) ?? lower;
        if (defined !== undefined) add(defined, null);
        else if (MONTHS.has(month)) add(MONTHS.get(month)!, month);
        else {
          unknown(bibShort(name));
          add('', name);
        }
        p = q;
      } else throw new Broken('une valeur est attendue.');
      p = skip(p);
      if (p < n && text.charCodeAt(p) === HASH) p = skip(p + 1);
      else return { v, p };
    }
  };
  const rawOf = (v: Value) => v.parts.map((x) => (x.bare ? x.s : `{${x.s}}`)).join(' # ');

  /** The command at `at` (its « @ »); where reading goes on after it. */
  const command = (at: number): number => {
    let p = skip(at + 1);
    const typeEnd = ident(p);
    const type = text.slice(p, typeEnd).toLowerCase();
    // An « @ » without a type is no command.
    if (type === '') return at + 1;
    /** What is said broken: the entry, by its key once read, a macro, the preamble, a comment. */
    let label = `Entrée @${bibShort(type)} abîmée`;
    try {
      p = skip(typeEnd);
      const open = p < n ? text.charCodeAt(p) : -1;
      if (type === 'comment') {
        label = 'Commentaire abîmé';
        // Its body, balanced, without being read; without one, only the word.
        if (open === OPEN) {
          if (match[p] < 0) throw new Broken(`l’accolade ouverte ligne ${lineOf(p)} n’est jamais fermée.`);
          return match[p] + 1;
        }
        if (open === LPAREN) {
          const q = parenMatch(p);
          if (q < 0) throw new Broken('la parenthèse ouverte n’est jamais fermée.');
          return q + 1;
        }
        return typeEnd;
      }
      if (open !== OPEN && open !== LPAREN) throw new Broken(`« { » ou « ( » est attendu après « @${bibShort(text.slice(skip(at + 1), typeEnd))} ».`);
      const closer = open === OPEN ? CLOSE : RPAREN;
      const closeName = open === OPEN ? '}' : ')';
      p = skip(p + 1);
      if (type === 'preamble') {
        label = 'Préambule abîmé';
        const r = value(p, () => {});
        if (r.p >= n) throw end();
        if (text.charCodeAt(r.p) !== closer) throw new Broken(`« ${closeName} » est attendu.`);
        return r.p + 1;
      }
      if (type === 'string') {
        for (;;) {
          if (p >= n) throw end();
          if (text.charCodeAt(p) === closer) return p + 1;
          const q = ident(p);
          const name = text.slice(p, q), said = bibShort(name);
          if (name === '') throw new Broken('le nom d’une macro est attendu.');
          label = `Macro « ${said} » abîmée`;
          p = skip(q);
          if (p >= n) throw end();
          if (text.charCodeAt(p) !== EQUALS) throw new Broken(`« = » est attendu après « ${said} ».`);
          const r = value(skip(p + 1), (m) => problem(at, `Macro « ${said} » : la macro « ${m} » n’est définie nulle part ; elle est laissée vide.`));
          strings.set(name.toLowerCase(), r.v.text);
          p = r.p;
          if (p >= n) throw end();
          const c = text.charCodeAt(p);
          if (c === COMMA) p = skip(p + 1);
          else if (c !== closer) throw new Broken(`« , » ou « ${closeName} » est attendu après la macro « ${said} ».`);
        }
      }
      // An entry (none past BIB_MAX_ENTRIES: reading stops there): its key, unless its first word is a field's name.
      if (entries.length >= BIB_MAX_ENTRIES) {
        tooMany = at;
        return n;
      }
      let q = p;
      while (q < n && isKeyChar(text.charCodeAt(q))) q++;
      charge(q - p);
      let key = text.slice(p, q);
      const after = skip(q);
      if (after < n && text.charCodeAt(after) === EQUALS) key = '';
      else {
        if (key !== '') label = `Entrée « ${bibShort(key)} » abîmée`;
        p = after;
        if (p >= n) throw end();
        const c = text.charCodeAt(p);
        if (c === COMMA) p = skip(p + 1);
        else if (c !== closer) throw new Broken(key === '' ? 'sa clé est attendue.' : `« , » est attendu après la clé « ${bibShort(key)} ».`);
      }
      const entry: BibEntry = { type, key, fields: new Map(), raw: new Map(), line: lineOf(at) };
      const warnings: string[] = [];
      for (;;) {
        if (p >= n) throw end();
        if (text.charCodeAt(p) === closer) { p++; break; }
        const nameEnd = ident(p);
        const name = text.slice(p, nameEnd).toLowerCase(), said = bibShort(name);
        if (name === '') throw new Broken('le nom d’un champ est attendu.');
        p = skip(nameEnd);
        if (p >= n) throw end();
        if (text.charCodeAt(p) !== EQUALS) throw new Broken(`« = » est attendu après le champ « ${said} ».`);
        p = skip(p + 1);
        const r = value(p, (m) => warnings.push(`la macro « ${m} » n’est définie nulle part ; elle est laissée vide.`));
        if (entry.fields.has(name)) warnings.push(`le champ « ${said} » est en double ; le premier est gardé.`);
        else {
          entry.fields.set(name, r.v.text);
          entry.raw.set(name, rawOf(r.v));
        }
        p = r.p;
        if (p >= n) throw end();
        const c = text.charCodeAt(p);
        if (c === COMMA) p = skip(p + 1);
        else if (c !== closer) throw new Broken(`« , » ou « ${closeName} » est attendu après le champ « ${said} » (ligne ${lineOf(p)}).`);
      }
      const named = entryName(entry);
      for (const w of warnings) problem(at, `${named} : ${w}`);
      if (key !== '') {
        const lower = key.toLowerCase(), first = keys.get(lower);
        if (first !== undefined) {
          entry.repeats = first;
          problem(at, repeatedKeyMessage(entry));
        } else keys.set(lower, entry.line);
      }
      entries.push(entry);
      return p;
    } catch (e) {
      // Said with what was being read: the entry, by its key once read, or the macro.
      if (e instanceof Broken) throw new Broken(`${label} : ${e.message}`);
      throw e;
    }
  };

  /**
   * The next « @ » that may start a command, from `p`: at the start of a line or after a blank or the end of an entry
   * (an address's « @ » starts none), past « % » comments; `lineStart`, after a broken entry: at a line's start only.
   */
  const next = (from: number, lineStart: boolean): number => {
    // What it examines, charged on the way out: the characters passed, and the blanks looked at behind an « @ ».
    let p = from, behind = 0;
    const found = (at: number) => { charge(at - from + behind); return at; };
    for (; p < n; p++) {
      const c = text.charCodeAt(p);
      if (c === PERCENT) {
        const eol = text.indexOf('\n', p);
        if (eol < 0) break;
        p = eol;
      } else if (c === AT) {
        let b = p - 1;
        if (lineStart) {
          while (b >= 0 && isSpace(text.charCodeAt(b)) && text.charCodeAt(b) !== NEWLINE) b--;
          behind += p - 1 - b;
          if (b < 0 || text.charCodeAt(b) === NEWLINE) return found(p);
        } else {
          const d = b < 0 ? NEWLINE : text.charCodeAt(b);
          if (isSpace(d) || d === CLOSE || d === RPAREN) return found(p);
        }
      }
    }
    charge(n - from + behind);
    return -1;
  };
  for (let p = 0, afterError = false; p < n;) {
    // Where the reading is, should the work's cap stop it: the « @ » looked for, then the command read.
    let at = p;
    try {
      at = next(p, afterError);
      if (at < 0) break;
      p = command(at);
      afterError = false;
    } catch (e) {
      if (e instanceof Exhausted) {
        stoppedAt = at;
        break;
      }
      if (!(e instanceof Broken)) throw e;
      problem(at, e.message);
      p = at + 1;
      afterError = true;
    }
  }
  if (omitted > 0) problems.push({ line: omittedLine, message: `Et ${fr(omitted)} autre${omitted > 1 ? 's' : ''} problème${omitted > 1 ? 's' : ''}.` });
  // At most one: past BIB_MAX_ENTRIES, the reading goes to the end of the text at once.
  let stopped: BibProblem | null = null;
  if (tooMany >= 0) stopped = { line: lineOf(tooMany), message: `Le fichier compte plus de ${fr(BIB_MAX_ENTRIES)} entrées : les suivantes ne sont pas lues.` };
  else if (stoppedAt >= 0) stopped = { line: lineOf(stoppedAt), message: `Le fichier est trop abîmé pour être lu en entier : la lecture s’arrête ligne ${lineOf(stoppedAt)}.` };
  if (stopped) problems.push(stopped);
  return { entries, problems, omitted, stopped };
}

// LaTeX to Unicode (D7: a title's accents, `\'e` giving « é »).

/** The accents, by their command: the combining mark each puts on the next letter. */
const ACCENTS = new Map(Object.entries({
  '\'': '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307',
  u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328', r: '\u030a', d: '\u0323', b: '\u0331', t: '\u0361',
}));
/** Commands that are a character, or a space (' '), or nothing (''); the others are dropped, their argument kept. */
const WORDS = new Map(Object.entries({
  o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', ss: 'ß', SS: 'SS', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', dh: 'ð', DH: 'Ð', th: 'þ', TH: 'Þ',
  ng: 'ŋ', NG: 'Ŋ', dj: 'đ', DJ: 'Đ',
  textendash: '–', textemdash: '—', ldots: '…', dots: '…', textellipsis: '…', textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“',
  textquotedblright: '”', guillemotleft: '«', guillemotright: '»', guillemetleft: '«', guillemetright: '»', textbackslash: '\\', textasciitilde: '~',
  textasciicircum: '^', textunderscore: '_', textbar: '|', textless: '<', textgreater: '>', textdollar: '$', S: '§', P: '¶', copyright: '©',
  textcopyright: '©', textregistered: '®', texttrademark: '™', pounds: '£', textsterling: '£', euro: '€', texteuro: '€', textdegree: '°',
  quad: ' ', qquad: ' ', enspace: ' ', thinspace: ' ', newline: ' ', par: ' ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ',
  Psi: 'Ψ', Omega: 'Ω', infty: '∞', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', times: '×', cdot: '·', pm: '±',
  to: '→', rightarrow: '→', leftarrow: '←', ell: 'ℓ', partial: '∂', nabla: '∇', in: '∈', sum: '∑', prod: '∏', int: '∫',
}));
/** The control symbols that are a character, a space or nothing; any other is its character. */
const SYMBOLS = new Map(Object.entries({ '\\': ' ', ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', '-': '', '/': '', '@': '' }));
const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/**
 * The combining marks kept on a letter: real text has two or three; a long run of them, of alternated classes, would
 * make Unicode's normalisation reorder them for ever (a fixed bound of security).
 */
const MAX_MARKS = 8;
const MARK_RUN = /(\p{M}{8})\p{M}+/gu;

/**
 * A BibTeX value's LaTeX as Unicode text (D7): accents (`\'e`, `\"{o}`, `{\'e}`, `\c c`, `\'\i`) composed (NFC),
 * letters (`{\o}`, `\ss`, `\L`), dashes (`--` –, `---` —), quotes (``` `` ``` and `''`), ties (`~`) as spaces, protection
 * braces and `$` dropped, TeX's escaped characters (`\&`, `\%`…) and Greek letters as themselves; a command it does not
 * know is dropped and its argument kept (`\emph{x}`: x). Control characters become spaces, blanks one space, trimmed;
 * MAX_MARKS accents at most on a letter. One pass, without recursion, whatever the nesting.
 */
export function latexToUnicode(s: string): string {
  let out = '', pending = '';
  const put = (ch: string) => { out += ch + pending; pending = ''; };
  const n = s.length;
  for (let i = 0; i < n;) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      i++;
      if (i >= n) break;
      if (isAsciiLetter(s.charCodeAt(i))) {
        let j = i;
        while (j < n && isAsciiLetter(s.charCodeAt(j))) j++;
        const name = s.slice(i, j);
        // TeX skips the blanks after a control word.
        while (j < n && isSpace(s.charCodeAt(j))) j++;
        i = j;
        const accent = ACCENTS.get(name);
        if (accent !== undefined) { if (pending.length < MAX_MARKS) pending += accent; continue; }
        // A dotless i or j under an accent is the letter itself, which composes (\'\i: í).
        if ((name === 'i' || name === 'j') && pending !== '') { put(name); continue; }
        const word = WORDS.get(name);
        if (word === ' ') out += ' ';
        else if (word !== undefined) put(word);
        continue;
      }
      const sym = String.fromCodePoint(s.codePointAt(i)!);
      i += sym.length;
      const accent = ACCENTS.get(sym);
      if (accent !== undefined) { if (pending.length < MAX_MARKS) pending += accent; continue; }
      const v = SYMBOLS.get(sym);
      if (v === ' ') out += ' ';
      else if (v === undefined) put(sym);
      continue;
    }
    if (c === OPEN || c === CLOSE || c === 36) { i++; continue; } // braces, $
    // An accent waits for its letter, past blanks.
    if (isSpace(c) || c === 126) { // ~
      if (pending === '') out += ' ';
      i++;
      continue;
    }
    if (c === 45 && s.charCodeAt(i + 1) === 45) { // -- and ---
      if (s.charCodeAt(i + 2) === 45) { put('—'); i += 3; } else { put('–'); i += 2; }
      continue;
    }
    if (c === 96 && s.charCodeAt(i + 1) === 96) { put('“'); i += 2; continue; }
    if (c === 39 && s.charCodeAt(i + 1) === 39) { put('”'); i += 2; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    put(ch);
    i += ch.length;
  }
  return out.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().replace(MARK_RUN, '$1').normalize('NFC');
}

// Names (D7: a tag `auteur` each, « Prénom Nom »).

/** A name's parts, in Unicode: first names, particles (von), family name, suffix (Jr.). */
export interface BibName { first: string; von: string; last: string; jr: string }

/** Whether a word of a name starts in lower case, as BibTeX reads it: a braced word does not, unless it is an accent's (`{\'e}cole`). */
function lowerWord(w: string): boolean {
  if (w.charCodeAt(0) === OPEN && w.charCodeAt(1) !== 92) return false;
  const m = /\p{L}/u.exec(latexToUnicode(w));
  return m !== null && m[0] !== m[0].toUpperCase() && m[0] === m[0].toLowerCase();
}

/**
 * The names of an author field (« and » between two, outside braces, without case), each split as BibTeX splits it:
 * « Prénom von Nom », « von Nom, Prénom » or « von Nom, Jr, Prénom »; a braced name is one family name (`{Groupe de
 * travail}`); « others » (et al.) is none. One pass.
 */
export function bibNames(field: string): BibName[] {
  const names: string[][][] = [];
  let parts: string[][] = [[]], word = '', depth = 0;
  const endName = () => {
    while (parts.length > 1 && parts[parts.length - 1].length === 0) parts.pop();
    if (parts.some((x) => x.length > 0)) names.push(parts);
    parts = [[]];
  };
  const endWord = () => {
    if (word === '') return;
    if (word.toLowerCase() === 'and') endName();
    else parts[parts.length - 1].push(word);
    word = '';
  };
  for (let i = 0; i < field.length; i++) {
    const ch = field[i], c = field.charCodeAt(i);
    if (c === OPEN) { depth++; word += ch; } else if (c === CLOSE) { if (depth > 0) depth--; word += ch; } else if (depth === 0 && (isSpace(c) || c === 126)) endWord();
    else if (depth === 0 && c === COMMA) { endWord(); parts.push([]); } else word += ch;
  }
  endWord();
  endName();
  const text = (words: string[]) => latexToUnicode(words.join(' '));
  const out: BibName[] = [];
  for (const p of names) {
    let first: string[], von: string[], last: string[], jr: string[] = [];
    if (p.length === 1) {
      const w = p[0], m = w.length;
      let f = -1, l = -1;
      for (let i = 0; i < m - 1; i++) if (lowerWord(w[i])) { if (f < 0) f = i; l = i; }
      if (f < 0) { first = w.slice(0, m - 1); von = []; last = w.slice(m - 1); } else { first = w.slice(0, f); von = w.slice(f, l + 1); last = w.slice(l + 1); }
    } else {
      const a = p[0], m = a.length;
      let l = -1;
      for (let i = 0; i < m - 1; i++) if (lowerWord(a[i])) l = i;
      von = a.slice(0, l + 1);
      last = a.slice(l + 1);
      if (p.length >= 3) { jr = p[1]; first = p.slice(2).flat(); } else first = p[1];
    }
    const name = { first: text(first), von: text(von), last: text(last), jr: text(jr) };
    if (name.first === '' && name.von === '' && name.jr === '' && name.last.toLowerCase() === 'others') continue;
    out.push(name);
  }
  return out;
}

/** The authors of an author field, « Prénom Nom » each (D7): first names, particles, family name, suffix. */
export function bibAuthors(field: string): string[] {
  return bibNames(field).map((x) => [x.first, x.von, x.last, x.jr].filter((s) => s !== '').join(' ')).filter((s) => s !== '');
}

/** A suffix written after the family name, « Prénom Nom Jr. » (bibAuthors writes it there): it is no family name. */
const NAME_SUFFIX = /[\s,]+(?:jr|sr|ii|iii|iv)\.?$/i;

/**
 * The family name of an author as compared for duplicates (final review, R2 revised): « Prénom Nom », as the tags
 * `auteur` hold it, or « Nom, Prénom », split as BibTeX splits it (bibNames: its particles and a suffix « Jr. » are no
 * part of it), then without case, accents, punctuation nor blanks (normalizedTitle): « Vitányi » and « VITANYI » are
 * the same. Null when there is none.
 */
export function familyName(author: string): string | null {
  const last = bibNames(author.trim().replace(NAME_SUFFIX, ''))[0]?.last ?? '';
  const n = normalizedTitle(last).replaceAll(' ', '');
  return n === '' ? null : n;
}

/** The first four digits in a row of a text (a year, a date's year), or null. */
export function yearIn(s: string): string | null {
  return /(?<!\d)\d{4}(?!\d)/.exec(s)?.[0] ?? null;
}

/** What a publication's node takes from an entry (D7): its title in Unicode, its authors « Prénom Nom », its year. */
export interface BibFields { title: string; authors: string[]; year: string | null }

/** The fields of a node from an entry (D7): the editors never stand for absent authors (the tag is `auteur`). */
export function bibFields(e: BibEntry): BibFields {
  return {
    title: latexToUnicode(e.fields.get('title') ?? ''),
    authors: bibAuthors(e.fields.get('author') ?? ''),
    year: yearIn(e.fields.get('year') ?? '') ?? yearIn(e.fields.get('date') ?? ''),
  };
}

// Identifiers (D7: the tags `doi` and `arxiv`, and the duplicates).

const DOI = /^10\.\d{4,9}\/\S+$/;
const ARXIV_NEW = /^\d{4}\.\d{4,5}$/;
const ARXIV_OLD = /^[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7}$/;
/** The DOIs arXiv gives its articles (DataCite's prefix 10.48550), in any case. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

/** An identifier longer than this is none (identifier.ts's bound, MAX_IDENTIFIER_CHARS); a tag never holds a control character. */
const MAX_ID_CHARS = 1000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A DOI as written in a field: past « doi: » or a resolver's address, without the punctuation that ends a sentence
 * (« . », « , », « ; »: a DOI that differs is a veto against a duplicate, re-review N2); null if it is none. Its case
 * is kept.
 */
export function cleanDoi(s: string): string | null {
  if (s.length > MAX_ID_CHARS + 100) return null;
  const t = s.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/[^/\s]+\/(?=10\.)/i, '').replace(/[.,;]+$/, '');
  return t.length <= MAX_ID_CHARS && DOI.test(t) && !CONTROL.test(t) ? t : null;
}

/** An arXiv identifier as written: past « arXiv: », without its version; null if it is none. */
export function cleanArxiv(s: string): string | null {
  if (s.length > MAX_ID_CHARS) return null;
  const t = s.trim().replace(/^arxiv:\s*/i, '').replace(/v\d+$/, '');
  return ARXIV_NEW.test(t) || ARXIV_OLD.test(t) ? t : null;
}

/**
 * An entry's DOI and arXiv identifier, those it gives (D7): its `doi` — arXiv's own (10.48550/arXiv.<id>) being its
 * arXiv identifier —; its `eprint` when `archiveprefix` or `eprinttype` say arXiv; an « arXiv:<id> » in its `eprint`,
 * `journal`, `note` or `howpublished` (Google Scholar's « arXiv preprint arXiv:… »); an arXiv page in its `url`.
 */
export function bibIdentifiers(e: BibEntry): { doi?: string; arxiv?: string } {
  const out: { doi?: string; arxiv?: string } = {};
  const doi = cleanDoi(e.fields.get('doi') ?? '');
  const own = doi === null ? null : ARXIV_DOI.exec(doi);
  if (own) {
    const ax = cleanArxiv(own[1]);
    if (ax) out.arxiv = ax;
  } else if (doi !== null) out.doi = doi;
  if (out.arxiv === undefined) {
    const eprint = e.fields.get('eprint') ?? '';
    const prefix = `${e.fields.get('archiveprefix') ?? ''} ${e.fields.get('eprinttype') ?? ''}`;
    let ax = /arxiv/i.test(prefix) ? cleanArxiv(eprint) : null;
    // Each candidate is a few dozen characters, whatever the field's length: no pattern backtracks over a long one.
    for (const f of ['eprint', 'journal', 'note', 'howpublished']) {
      if (ax) break;
      const m = /arxiv:\s{0,4}([^\s,;{}]{1,60})/i.exec(e.fields.get(f) ?? '');
      if (m) ax = cleanArxiv(m[1].replace(/[.)\]]+$/, ''));
    }
    const url = e.fields.get('url') ?? '';
    if (!ax && url.length <= MAX_ID_CHARS && /arxiv/i.test(url)) {
      const m = /\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?\/?(?:[?#]|$)/i.exec(url);
      if (m) ax = cleanArxiv(m[1]);
    }
    if (ax) out.arxiv = ax;
  }
  return out;
}

/**
 * A title as compared for duplicates (the controller's ruling): without case, accents, punctuation or extra blanks. The
 * text's own marks are dropped before it is decomposed: a run of them is never reordered (a CSL's title read too).
 */
export function normalizedTitle(s: string): string {
  return s.replace(/\p{M}+/gu, '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Keys (D7).

/** What Windows reserves as a file's name, before its first dot (as files/merge.ts refuses it). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
/** The longest key kept (a fixed bound: a key is a word of \cite, 200 like a label, safeLabel). */
const MAX_KEY_CHARS = 200;
/** Printable ASCII but a blank or what BibTeX or LaTeX read otherwise in a key: \ { } % # , ~ " ' ( ) =. */
const SAFE_KEY = /^[!$&*+\-./0-9:;<>?@A-Z[\]^_`a-z|]+$/;

/**
 * Whether an entry's own key is kept (final review, R1 revised: a .bib imported « servira à charger la bibliographie
 * actuelle », whose \cite already name its keys): one that BibTeX and LaTeX both read — printable ASCII, 200 at most,
 * without a blank nor \ { } % # , ~ " ' ( ) =, without « :// » (an address: DataCite's keys) nor « ^^ » (which TeX
 * reads as a character's code: the compilations never inject it). DBLP's (`DBLP:conf/nips/…`) and « Author:Year » are
 * kept; only the name of their file is cleaned (bibFileName).
 */
export function safeCiteKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_CHARS && SAFE_KEY.test(key) && !key.includes('://') && !key.includes('^^') && safeLabel(key);
}

/** What a file's name cannot hold on Windows (as files/merge.ts refuses it). */
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*]/g;

/**
 * The name of a publication's entry as a file of its node (D7; final review, R1 revised): « <key>.bib », each of
 * < > : " / \ | ? * made « _ » (DBLP_conf_nips_VaswaniSPUJGKP17.bib), and « _ » after a name Windows reserves
 * (con_.bib). Only the file's name: the key itself stays in the tag `clé_bibtex` and in the entry. A node holds one .bib.
 */
export function bibFileName(key: string): string {
  const name = `${key.replace(UNSAFE_FILE_CHARS, '_')}.bib`;
  return name.replace(RESERVED, '$1_$2');
}

const LATIN = new Map(Object.entries({ ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i', ŋ: 'n', ȷ: 'j' }));
/** A word as a key's letters: without accents, in lower case, ASCII letters and digits only. */
const keyLetters = (s: string) => [...s.replace(/\p{M}+/gu, '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()].map((c) => LATIN.get(c) ?? c).join('').replace(/[^a-z0-9]/g, '');
/** b, c… z, then aa, ab…: the suffix of the n-th key alike (n ≥ 2). */
function letters(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor(n / 26)) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
  }
  return s;
}

/**
 * The keys held, compared without case as BibTeX compares them (a « Repeated entry » otherwise, review M1): kept in
 * lower case, and, for each base of the keys citeKey makes, the first suffix not known to be taken. Keys are only ever
 * added, so a suffix found taken stays so: a key made for each of a .bib's thousands of entries costs a few look-ups,
 * even when they all share a base (task 6: no author, no year, the same first word). Keys `reserve`d — a .bib's own
 * safe keys, all of them before any is made (the controller's ruling of the task 6 review, M3), DBLP's included since
 * the final review (R1) — are avoided by the keys made only: an entry keeps its own, and a \cite{li2008} already
 * written still means it.
 */
export class CiteKeys {
  private readonly lower = new Set<string>();
  private readonly held = new Set<string>();
  private readonly next = new Map<string, number>();
  constructor(keys: Iterable<string> = []) {
    for (const k of keys) this.add(k);
  }
  add(key: string): void {
    this.lower.add(key.toLowerCase());
  }
  has(key: string): boolean {
    return this.lower.has(key.toLowerCase());
  }
  /** `key` is an entry's own: no key made takes it. */
  reserve(key: string): void {
    this.held.add(key.toLowerCase());
  }
  reserved(key: string): boolean {
    return this.held.has(key.toLowerCase());
  }
  /** The first suffix of `base` that may be free (citeKey). */
  from(base: string): number {
    return this.next.get(base) ?? 1;
  }
  /** Every suffix of `base` before `i` is taken. */
  reached(base: string, i: number): void {
    this.next.set(base, i);
  }
}

/**
 * A publication's key (D7): the entry's if it has one that safeCiteKey takes (BibTeX and LaTeX read it: DBLP's and
 * « Author:Year » kept, final review R1) and no other node holds (`taken`, without case); otherwise one made of ASCII
 * letters and digits, its first author's family name and its year (`li2008`) — without an author, its title's first
 * word; without either, « publication » —, followed by b, c… z, aa… while a key of `taken` is the same, without case,
 * or a key it reserves. `taken` as CiteKeys for many keys made one after the other (a .bib's, task 6): a Set is read
 * whole at each call. Its file's name is bibFileName's.
 */
export function citeKey(entry: BibEntry, taken: ReadonlySet<string> | CiteKeys): string {
  const keys = taken instanceof CiteKeys ? taken : new CiteKeys(taken);
  if (entry.key !== '' && safeCiteKey(entry.key) && !keys.has(entry.key)) return entry.key;
  const family = keyLetters(bibNames(entry.fields.get('author') ?? '')[0]?.last ?? '');
  const firstWord = keyLetters(latexToUnicode(entry.fields.get('title') ?? '').split(' ').find((w) => keyLetters(w) !== '') ?? '');
  const year = yearIn(entry.fields.get('year') ?? '') ?? yearIn(entry.fields.get('date') ?? '') ?? '';
  const base = (family || firstWord || 'publication').slice(0, 60) + year;
  for (let i = keys.from(base); ; i++) {
    const key = i === 1 ? base : base + letters(i);
    if (!keys.has(key) && !keys.reserved(key) && safeCiteKey(key)) {
      keys.reached(base, i);
      return key;
    }
  }
}

/**
 * The entry as a file of its own (D7: « <key>.bib »), under `key`: its type, then each field as BibTeX writes it (`raw`:
 * the file's macros resolved, a month kept as a macro), one a line. Read again, it gives the same fields.
 */
export function bibtexEntry(entry: BibEntry, key: string): string {
  const fields = [...entry.raw];
  return [`@${entry.type}{${key}${fields.length > 0 ? ',' : ''}`, ...fields.map(([name, raw], i) => `  ${name} = ${raw}${i < fields.length - 1 ? ',' : ''}`), '}', ''].join('\n');
}
