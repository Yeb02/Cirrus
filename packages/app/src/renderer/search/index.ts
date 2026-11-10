import {
  type Action, connId, connKind, connRelation, connRow, connRowCount, connTags, connTitle, connTrashed, type Id, KNOWLEDGE, type NodeRec, nodeRow,
  phantomsOf, placedIn, placedInCount, placementsIn, planId, planRow, type State, type TagValue,
} from '@cirrus/core';
import { fold } from '@cirrus/view';
import { fileKind } from '../files/kind.ts';

/**
 * The search of Ctrl+K (plan 6a, D1): an index in the interface's memory, over every node and every knowledge
 * connection outside the trash, kept up to date action by action as the annotations' index is (plan 4c), and the query
 * that reads it at each keystroke. Without the DOM: App builds it, SearchBox asks it.
 */

/** Which fields a query reads, and whether only what this plan shows is kept (D1: Titre, Tags, Résumé on; Contenu off). */
export interface SearchFilters { title: boolean; tags: boolean; summary: boolean; content: boolean; planOnly: boolean }
export const DEFAULT_FILTERS: SearchFilters = { title: true, tags: true, summary: true, content: false, planOnly: false };

/** A field of an object: its title; its tags (key and value); its summary, or a connection's relation; its .tex' text. */
export type SearchField = 'title' | 'tags' | 'summary' | 'content';
const FIELDS: readonly SearchField[] = ['title', 'tags', 'summary', 'content'];

/**
 * A result: `plan` is where its jump goes (D2) — this plan, else the lobby, else the first other plan in the tabs' order
 * then by name; null for an object in no plan (an annotation), whose pop-up opens instead. `field`: the field that
 * answers, the worst of each word's best field (the title when the title alone has every word).
 */
export interface SearchHit { id: Id; kind: 'node' | 'connection'; title: string; plan: Id | null; field: SearchField }
/** Where the query is made from: the plan shown, the lobby, and the open tabs in their order. */
export interface SearchWhere { plan: Id; lobby: Id; tabs: readonly Id[] }

/** The words of a query beyond this many are not read: a bit each in a 32-bit word. */
const MAX_QUERY_WORDS = 32;
const COLLATOR = new Intl.Collator('fr');
/**
 * A build by slices (SearchBuild, SearchRefresh) looks at its clock each time it has read this much (fix round 1 of
 * the review, Important 2): characters of text, an object counting OBJECT_WORK more. A long text — a .tex reaches
 * textViewMaxMb — is read by pieces of this size, over as many slices as it takes; a slice ends past its deadline by
 * one piece at most (about a third of a millisecond).
 */
export const CLOCK_WORK = 16_384;
const OBJECT_WORK = 256;
/** A « word » longer than this (a hash, a base64 blob in a .tex) is not indexed: nobody types it, and its reading may be cut. */
const MAX_WORD_CHARS = 100;

// Words (D1): runs of letters and digits, anything else separates them. A decomposed accent (a mark after its letter)
// belongs to its word; fold then drops it. Scanned by hand: a Unicode class in a regular expression costs a whole build
// most of its time at 50 000 long summaries (Ruling of task 1).

/** By UTF-16 unit: 1 a word's, 2 a separator, 0 not looked at yet. */
const UNITS = new Uint8Array(0x10000);
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
/** Code points beyond the first plane (a pair of surrogates): the same, by code point. */
const ASTRAL = new Map<number, boolean>();

/** The length of the word character at `i` (1, or 2 for a pair of surrogates), 0 for a separator. */
function wordUnitAt(t: string, i: number): number {
  const c = t.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length) {
    const cp = t.codePointAt(i)!;
    if (cp > 0xffff) {
      let yes = ASTRAL.get(cp);
      if (yes === undefined) ASTRAL.set(cp, (yes = WORD_CHAR.test(String.fromCodePoint(cp))));
      return yes ? 2 : 0;
    }
  }
  let k = UNITS[c];
  if (k === 0) UNITS[c] = k = WORD_CHAR.test(String.fromCharCode(c)) ? 1 : 2;
  return k === 1 ? 1 : 0;
}

/**
 * Where a reading of words stands within a text: `inLong` once it stopped inside a word already longer than
 * MAX_WORD_CHARS, whose rest is skipped.
 */
interface ScanState { inLong: boolean }

/**
 * The words of `t` as written, from `from`, to `f`, until the first word boundary at or past `limit`; where it stopped
 * (t.length once done). A word is never cut — but one longer than MAX_WORD_CHARS, which is dropped, and may be left
 * in its middle (`st.inLong`), its rest skipped by the next call.
 */
function scanWords(t: string, from: number, limit: number, st: ScanState, f: (raw: string) => void): number {
  const n = t.length;
  let i = from;
  if (st.inLong) {
    for (let len = 0; i < n && (len = wordUnitAt(t, i)) > 0;) { i += len; if (i >= limit && i < n) return i; }
    st.inLong = false;
  }
  while (i < n) {
    if (i >= limit) return i;
    let len = wordUnitAt(t, i);
    if (len === 0) { i++; continue; }
    const start = i;
    do i += len; while (i < n && (len = wordUnitAt(t, i)) > 0 && !(i - start > MAX_WORD_CHARS && i >= limit));
    if (i < n && len > 0 && i - start > MAX_WORD_CHARS) { st.inLong = true; return i; }
    if (i - start <= MAX_WORD_CHARS) f(t.slice(start, i));
  }
  return n;
}

/** A text's words as the index compares them (fold: no case, no accents, ligatures as two letters), in order. */
export function searchWords(text: string): string[] {
  const out: string[] = [];
  scanWords(text, 0, Infinity, { inLong: false }, (raw) => { const w = fold(raw); if (w !== '') out.push(w); });
  return out;
}

/**
 * A title as the results are ordered by it among equals (fix round 1, M1): its words, folded, one space between them —
 * the French order of a dictionary, which neither « ’ » nor « « » » change; the collator breaks its ties.
 */
const titleKey = (title: string): string => searchWords(title).join(' ');

/**
 * Every distinct word the index has met, once each, by number: the query reads each word once, not each object's.
 * `raw` gives a word as written its folded word's number (−1: none), so that each spelling is folded once.
 */
class Dictionary {
  readonly ids = new Map<string, number>();
  readonly words: string[] = [];
  readonly raw = new Map<string, number>();

  idOfRaw(raw: string): number {
    let id = this.raw.get(raw);
    if (id === undefined) {
      const w = fold(raw);
      if (w === '') id = -1;
      else {
        id = this.ids.get(w);
        if (id === undefined) {
          id = this.words.length;
          this.words.push(w);
          this.ids.set(w, id);
        }
      }
      this.raw.set(raw, id);
    }
    return id;
  }
}

/** An object as the index keeps it. */
interface Entry {
  readonly id: Id;
  readonly kind: 'node' | 'connection';
  readonly title: string;
  /** Its title's key (titleKey): the order of the results among equals, as a plain comparison. */
  readonly key: string;
  /** The numbers of its words, field after field (FIELDS), each field's without repeats; field f ends at `ends[f]`. */
  readonly words: Int32Array;
  readonly ends: readonly [number, number, number, number];
}

/** Collects an object's word numbers, field by field, each field without repeats (a stamp per word number). */
class WordBuffer {
  private buf = new Int32Array(1024);
  private n = 0;
  private seen = new Int32Array(1024);
  private stamp = 0;
  private readonly dict: Dictionary;
  readonly scan: ScanState = { inLong: false };
  private readonly add = (raw: string) => {
    const id = this.dict.idOfRaw(raw);
    if (id < 0) return;
    if (id >= this.seen.length) { const grown = new Int32Array(Math.max(id + 1, this.seen.length * 2)); grown.set(this.seen); this.seen = grown; }
    if (this.seen[id] === this.stamp) return;
    this.seen[id] = this.stamp;
    if (this.n === this.buf.length) { const grown = new Int32Array(this.buf.length * 2); grown.set(this.buf); this.buf = grown; }
    this.buf[this.n++] = id;
  };
  constructor(dict: Dictionary) { this.dict = dict; }

  /** A new object. */
  begin(): void { this.n = 0; this.scan.inLong = false; this.field(); }
  /** A new field (a word of the previous one counts again); where the field before it ended. */
  field(): number {
    if (++this.stamp === 0x7fffffff) { this.seen.fill(0); this.stamp = 1; }
    return this.n;
  }
  /** The words of `t` from `from`, until a word boundary past `limit`; where it stopped. */
  text(t: string, from: number, limit: number): number { return scanWords(t, from, limit, this.scan, this.add); }
  take(): Int32Array { return this.buf.slice(0, this.n); }
}

/** A text of an object, in its field (an index of FIELDS). */
type Part = readonly [field: number, text: string];

const tagParts = (field: number, tags: readonly TagValue[], out: Part[]) => {
  for (const t of tags) {
    out.push([field, t.key]);
    if (t.value !== undefined) out.push([field, String(t.value)]);
  }
};
/** The hashes of a node's .tex, read as its content; null for none. */
function texOf(n: NodeRec | undefined): string[] | null {
  let tex: string[] | null = null;
  for (const f of n?.files ?? []) if (fileKind(f.name) === 'tex') (tex ??= []).push(f.hash);
  return tex;
}
/** A node's texts, field by field: its title, its tags, its summary, its .tex (as `texts` has them, '' for one not read). */
function nodeParts(n: NodeRec, tex: readonly string[] | null, texts: ReadonlyMap<string, string>): Part[] {
  const out: Part[] = [[0, n.title]];
  tagParts(1, n.tags, out);
  out.push([2, n.summary]);
  for (const h of tex ?? []) out.push([3, texts.get(h) ?? '']);
  return out;
}

/** One object's words read by pieces (a long .tex over several slices), into a buffer of its own while it lasts. */
class EntryReader {
  private part = 0;
  private at = 0;
  private field = 0;
  private readonly ends = [0, 0, 0, 0];
  private readonly b: WordBuffer;
  private readonly parts: readonly Part[];

  constructor(b: WordBuffer, parts: readonly Part[]) {
    this.b = b;
    this.parts = parts;
    b.begin();
  }

  get done(): boolean { return this.part >= this.parts.length; }

  /** Reads about `budget` characters (a word is never cut but an overlong one); the characters read. */
  read(budget: number): number {
    let read = 0;
    while (this.part < this.parts.length && read < budget) {
      const [field, text] = this.parts[this.part];
      while (this.field < field) this.ends[this.field++] = this.b.field();
      const stop = this.b.text(text, this.at, this.at + (budget - read));
      read += stop - this.at;
      if (stop >= text.length) { this.part++; this.at = 0; this.b.scan.inLong = false; } else this.at = stop;
    }
    return read;
  }

  /** Once done, the entry: null without a word. */
  entry(id: Id, kind: 'node' | 'connection', title: string): Entry | null {
    while (this.field < 4) this.ends[this.field++] = this.b.field();
    const [t, g, m, c] = this.ends;
    return c === 0 ? null : { id, kind, title, key: titleKey(title), words: this.b.take(), ends: [t, g, m, c] };
  }
}

/**
 * Each entry's words in a bloom of BLOOM_BITS bits (a word number's hash: one bit), by slot: a query word that starts
 * only a few words of the dictionary sets few bits, and an entry whose bloom has none of them cannot hold it — its words
 * are not read. 64 bytes an entry; a long summary (80 distinct words) sets about 15 % of them.
 */
const BLOOM_BITS = 512, BLOOM_INTS = BLOOM_BITS / 32;
/** A query word starting more dictionary words than this marks every bit: nothing to skip by it. */
const BLOOM_WORDS_MAX = 256;
const bloomBit = (id: number) => (Math.imul(id, 0x9e3779b1) >>> 23) & (BLOOM_BITS - 1);

/** A knowledge connection outside the trash, by its row, whose words are read: never a structure (spec 5.3) nor an inclusion. */
const indexedConnection = (s: State, row: number) => row >= 0 && connKind(s, row) === KNOWLEDGE && !connTrashed(s, row);
function connectionParts(s: State, row: number): Part[] {
  const out: Part[] = [[0, connTitle(s, row)]];
  tagParts(1, connTags(s, row), out);
  out.push([2, connRelation(s, row)]);
  return out;
}

/**
 * The index's storage, handed from each index to the next (SearchIndex.build): only the latest index is to be asked.
 * The entries are in a list (the query reads it whole), each at its slot, its bloom at the same slot. `version` counts
 * the writes: a query's narrowing (LastQuery) holds while the slots it kept are those of the list.
 */
class Store {
  readonly dict = new Dictionary();
  /** The buffer of the reads made at once (an action's subjects); a build by slices has its own. */
  readonly words = new WordBuffer(this.dict);
  readonly list: Entry[] = [];
  readonly slots = new Map<Id, number>();
  blooms = new Int32Array(1024 * BLOOM_INTS);
  version = 0;
  /** The nodes that have a .tex, with the hashes they read. */
  readonly tex = new Map<Id, readonly string[]>();
  /** The texts of the .tex, newest known: what a node is read with. */
  texts: ReadonlyMap<string, string>;
  /** The nodes whose .tex texts changed since they were read (SearchIndex.build): read again by slices (SearchRefresh). */
  readonly stale = new Set<Id>();
  /** The query's marks, one bit per query word, by word number: zero between queries. */
  flags = new Int32Array(0);

  constructor(texts: ReadonlyMap<string, string>) { this.texts = texts; }

  set(id: Id, e: Entry | null): void {
    this.version++;
    const at = this.slots.get(id);
    if (e) {
      let slot = at;
      if (slot === undefined) {
        slot = this.list.length;
        this.slots.set(id, slot);
        this.list.push(e);
        if (this.blooms.length < this.list.length * BLOOM_INTS) { const grown = new Int32Array(this.blooms.length * 2); grown.set(this.blooms); this.blooms = grown; }
      } else this.list[slot] = e;
      const b = this.blooms, base = slot * BLOOM_INTS;
      b.fill(0, base, base + BLOOM_INTS);
      for (const w of e.words) { const bit = bloomBit(w); b[base + (bit >> 5)] |= 1 << (bit & 31); }
      return;
    }
    if (at === undefined) return;
    const last = this.list.pop()!, from = this.list.length;
    this.slots.delete(id);
    if (last.id !== id) {
      this.list[at] = last;
      this.slots.set(last.id, at);
      this.blooms.copyWithin(at * BLOOM_INTS, from * BLOOM_INTS, (from + 1) * BLOOM_INTS);
    }
  }

  /** A node read: its entry (null in the trash, without a word, or gone) and its .tex. */
  setNode(id: Id, entry: Entry | null, tex: readonly string[] | null): void {
    if (tex) this.tex.set(id, tex); else this.tex.delete(id);
    this.stale.delete(id);
    this.set(id, entry);
  }

  /** A node read again at once from the state (an action's subject). */
  readNode(s: State, id: Id): void {
    const n = s.nodes.get(id), tex = texOf(n);
    if (!n || n.trashedAt !== undefined) { this.setNode(id, null, tex); return; }
    const r = new EntryReader(this.words, nodeParts(n, tex, this.texts));
    r.read(Infinity);
    this.setNode(id, r.entry(id, 'node', n.title), tex);
  }

  /** A connection read again at once from the state, by its row (−1: gone). */
  readConnection(s: State, id: Id, row: number): void {
    if (!indexedConnection(s, row)) { this.set(id, null); return; }
    const r = new EntryReader(this.words, connectionParts(s, row));
    r.read(Infinity);
    this.set(id, r.entry(id, 'connection', connTitle(s, row)));
  }

  /** New texts: the nodes whose .tex are not those read are marked to be read again (SearchRefresh). */
  takeTexts(texts: ReadonlyMap<string, string>): void {
    if (texts === this.texts) return;
    for (const [id, hashes] of this.tex) if (hashes.some((h) => texts.get(h) !== this.texts.get(h))) this.stale.add(id);
    this.texts = texts;
  }
}

/** A reading in progress over slices: its object, the record it was started on, the texts it reads. */
interface Reading { id: Id; kind: 'node' | 'connection'; title: string; rec?: NodeRec; tex: string[] | null; texts: ReadonlyMap<string, string>; reader: EntryReader }

/**
 * The clock of a build by slices, and its work counted: it looks at the clock every `every` of work (CLOCK_WORK; a
 * test slices finer), and a long text is read by pieces of that size.
 */
class Slices {
  work = 0;
  readonly every: number;
  private next: number;
  private readonly clock: () => number;
  constructor(clock: () => number, every: number) {
    this.clock = clock;
    this.every = every;
    this.next = every;
  }
  /** Whether the deadline is passed, looked at once `every` more work is done. */
  late(deadline: number): boolean {
    if (this.work < this.next) return false;
    this.next = this.work + this.every;
    return this.clock() >= deadline;
  }
}

/**
 * A whole build made a slice at a time (Global Constraints, « La performance »: the window is never frozen by it — at
 * 50 000 nodes with long summaries it takes about two seconds). Each `step` reads until its deadline, by its clock
 * (performance.now unless given), looked at every CLOCK_WORK characters read: a long .tex is read over several slices.
 * Each object is read as the state is when its turn comes; the actions applied meanwhile are given to the index it ends
 * with (SearchIndex.build, by their subjects): what one of them changed after its object was read is read again.
 */
export class SearchBuild {
  private readonly s: State;
  private readonly st: Store;
  private readonly nodes: Id[];
  private node = 0;
  private row = 0;
  private reading: Reading | null = null;
  private readonly slices: Slices;

  constructor(s: State, texts: ReadonlyMap<string, string>, clock: () => number = () => performance.now(), every = CLOCK_WORK) {
    this.s = s;
    this.st = new Store(texts);
    this.nodes = [...s.nodes.keys()];
    this.slices = new Slices(clock, every);
  }

  /** The work done so far: characters read, OBJECT_WORK per object, one per connection row passed. */
  get work(): number { return this.slices.work; }

  /** Reads until `deadline`; the index once every object is read. */
  step(deadline: number): SearchIndex | null {
    const s = this.s, st = this.st, sl = this.slices;
    for (;;) {
      const r = this.reading;
      if (r) {
        sl.work += r.reader.read(sl.every);
        if (r.reader.done) {
          this.reading = null;
          const e = r.reader.entry(r.id, r.kind, r.title);
          if (r.kind === 'node') st.setNode(r.id, e, r.tex); else st.set(r.id, e);
        }
      } else if (this.node < this.nodes.length) {
        const id = this.nodes[this.node++], n = s.nodes.get(id), tex = texOf(n);
        sl.work += OBJECT_WORK;
        if (!n || n.trashedAt !== undefined) st.setNode(id, null, tex);
        else this.reading = { id, kind: 'node', title: n.title, tex, texts: st.texts, reader: new EntryReader(st.words, nodeParts(n, tex, st.texts)) };
      } else if (this.row < connRowCount(s)) {
        const row = this.row++;
        sl.work++;
        if (indexedConnection(s, row)) {
          sl.work += OBJECT_WORK;
          this.reading = { id: connId(s, row), kind: 'connection', title: connTitle(s, row), tex: null, texts: st.texts, reader: new EntryReader(st.words, connectionParts(s, row)) };
        }
      } else return SearchIndex.of(s, st);
      if (sl.late(deadline)) return null;
    }
  }
}

/**
 * The nodes whose .tex were read since the index read them (Store.stale), read again by slices as SearchBuild reads
 * (fix round 1, Important 2: never in a render). Each is written into the index's storage once read, unless an action
 * read it again meanwhile, or newer texts came (then it is read anew). The index it was made from is the latest until
 * then: App makes a new one (SearchIndex.build, without an action) after each slice that wrote.
 */
export class SearchRefresh {
  private readonly s: State;
  private readonly st: Store;
  private readonly words: WordBuffer;
  private reading: Reading | null = null;
  private readonly slices: Slices;

  constructor(index: SearchIndex, clock: () => number = () => performance.now(), every = CLOCK_WORK) {
    this.s = index.state;
    this.st = index.store;
    this.words = new WordBuffer(this.st.dict);
    this.slices = new Slices(clock, every);
  }

  get work(): number { return this.slices.work; }

  /** Reads until `deadline`; whether it wrote an entry, and whether no node is left to read. */
  step(deadline: number): { wrote: boolean; done: boolean } {
    const s = this.s, st = this.st, sl = this.slices;
    let wrote = false;
    for (;;) {
      const r = this.reading;
      if (r) {
        sl.work += r.reader.read(sl.every);
        if (r.reader.done) {
          this.reading = null;
          // Read again meanwhile by an action (no longer stale, or another record): its result stands. Newer texts: anew.
          if (st.stale.has(r.id) && s.nodes.get(r.id) === r.rec && st.texts === r.texts) {
            st.setNode(r.id, r.reader.entry(r.id, 'node', r.title), r.tex);
            wrote = true;
          }
        }
      } else {
        const id = st.stale.values().next().value;
        if (id === undefined) return { wrote, done: true };
        const n = s.nodes.get(id), tex = texOf(n);
        sl.work += OBJECT_WORK;
        if (!n || n.trashedAt !== undefined) { st.setNode(id, null, tex); wrote = true; }
        else this.reading = { id, kind: 'node', title: n.title, rec: n, tex, texts: st.texts, reader: new EntryReader(this.words, nodeParts(n, tex, st.texts)) };
      }
      if (sl.late(deadline)) return { wrote, done: false };
    }
  }
}

/** A result being chosen: its entry, its group of plans (0 this plan, 1 the lobby, 2 another, 3 none) and its field. */
interface Candidate { e: Entry; group: number; rank: number }

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** D1's order: this plan, the lobby, the others, none; then the title before the tags, the summary, the content; then the titles. */
function compare(group: number, rank: number, e: Entry, c: Candidate): number {
  return group - c.group || rank - c.rank || order(e.key, c.e.key) || COLLATOR.compare(e.title, c.e.title) || order(e.id, c.e.id);
}

/**
 * A query's words and fields, with what answered it: its objects' slots (any plan), valid while the storage is at
 * `version`, and each word's dictionary numbers.
 */
interface LastQuery { words: string[]; fields: string; version: number; slots: number[]; ids: Map<string, Int32Array> }

/**
 * The index (D1). Built whole once (SearchBuild; `build` without `previous`), it is then built again at each change of
 * the state from the last one (`previous`): with the actions applied since (`action`, their operations as one), only
 * the nodes and connections they touch are read again — whatever their operations say in between (a synchronisation's
 * rewinds: each subject is read as it now is). New `texts` (the registry's, plan 4b) only mark the nodes whose .tex
 * changed (`pending`): SearchRefresh reads them by slices (`refresh`). A null action (a reload), or another state,
 * builds it whole. The plans an object is in are not kept: the query reads them for what it finds, as the state now has
 * them. The storage goes from each index to the next: the previous one is not to be asked any more.
 */
export class SearchIndex {
  readonly state: State;
  /** @internal The storage, for SearchRefresh. */
  readonly store: Store;
  private last: LastQuery | null = null;

  private constructor(s: State, store: Store) {
    this.state = s;
    this.store = store;
  }

  /** @internal SearchBuild's end: its storage, as an index. */
  static of(s: State, store: Store): SearchIndex {
    return new SearchIndex(s, store);
  }

  static build(s: State, texts: ReadonlyMap<string, string>, previous?: SearchIndex, action?: Action | null): SearchIndex {
    if (!previous || previous.state !== s || action === null) return new SearchBuild(s, texts).step(Infinity)!;
    const st = previous.store, done = new Set<Id>();
    st.takeTexts(texts);
    for (const op of action?.ops ?? []) {
      if (op.t !== 'node' && op.t !== 'connection') continue;
      const id = (op.after ?? op.before)!.id;
      if (done.has(id)) continue;
      done.add(id);
      if (op.t === 'node') st.readNode(s, id); else st.readConnection(s, id, connRow(s, id));
    }
    return new SearchIndex(s, st);
  }

  /** The objects indexed. */
  get size(): number {
    return this.store.list.length;
  }

  /** The nodes waiting to be read again with their new .tex texts (refresh). */
  get pending(): number {
    return this.store.stale.size;
  }

  /** Their reading, by slices (SearchRefresh's clock and step of work). */
  refresh(clock?: () => number, every?: number): SearchRefresh {
    return new SearchRefresh(this, clock, every);
  }

  /**
   * What `q` finds (D1): every one of its words the start of a word of the object, in the fields `f` chooses, without
   * case or accents; ordered by D1 (the group of plans, the field, the order of the titles), `max` at most. Each
   * object's words are read once (a bit per query word, marked in the dictionary); the plans are read for the objects
   * found, the order kept for the `max` best only. A query that narrows the last one (each of its words the start of
   * one of the new ones: a keystroke more) reads only what the last one found.
   */
  query(q: string, f: SearchFilters, where: SearchWhere, max: number): SearchHit[] {
    const words = [...new Set(searchWords(q))].slice(0, MAX_QUERY_WORDS);
    const chosen = FIELDS.map((x) => f[x]), fields = chosen.join();
    if (words.length === 0 || max <= 0 || !chosen.some(Boolean)) return [];
    const st = this.store, all = st.dict.words, D = all.length;
    const last = this.last !== null && this.last.version === st.version ? this.last : null;
    const narrows = last !== null && last.fields === fields && last.words.every((w) => words.some((x) => x.startsWith(w)));
    if (st.flags.length < D) st.flags = new Int32Array(Math.max(D, st.flags.length * 2));
    const flags = st.flags, ids = new Map<string, Int32Array>();
    /** Each query word's bloom: the bits of the dictionary words it starts (all of them past BLOOM_WORDS_MAX). */
    const masks = new Int32Array(words.length * BLOOM_INTS);
    try {
      for (let j = 0; j < words.length; j++) {
        const w = words[j], bit = 1 << j;
        // The dictionary's words that start with it: among those of a word it extends, if the last query had one.
        let from: Int32Array | undefined, fromLength = 0;
        for (const [old, list] of last?.ids ?? []) if (w.startsWith(old) && old.length > fromLength) { from = list; fromLength = old.length; }
        const found: number[] = [];
        if (from) { for (const id of from) if (all[id].startsWith(w)) found.push(id); }
        else for (let id = 0; id < D; id++) if (all[id].startsWith(w)) found.push(id);
        ids.set(w, Int32Array.from(found));
        const mask = j * BLOOM_INTS;
        if (found.length > BLOOM_WORDS_MAX) masks.fill(-1, mask, mask + BLOOM_INTS);
        for (const id of found) {
          flags[id] |= bit;
          if (found.length <= BLOOM_WORDS_MAX) { const b = bloomBit(id); masks[mask + (b >> 5)] |= 1 << (b & 31); }
        }
      }
      const full = words.length === 32 ? -1 : ((1 << words.length) - 1) | 0;
      const slots: number[] = [], ranks: number[] = [];
      // A word that starts no word of the base: nothing can answer.
      if ([...ids.values()].every((x) => x.length > 0)) {
        const list = st.list, blooms = st.blooms, n = words.length, from = narrows ? last!.slots : null;
        const count = from ? from.length : list.length;
        scan: for (let c = 0; c < count; c++) {
          const i = from ? from[c] : c, base = i * BLOOM_INTS;
          for (let j = 0; j < n; j++) {
            let hit = 0;
            for (let q = 0, m = j * BLOOM_INTS; q < BLOOM_INTS; q++) hit |= blooms[base + q] & masks[m + q];
            if (hit === 0) continue scan;
          }
          const rank = this.answers(list[i], chosen, flags, full);
          if (rank >= 0) { slots.push(i); ranks.push(rank); }
        }
      }
      this.last = { words, fields, version: st.version, slots, ids };
      const s = this.state, here = placementsIn(s, planRow(s, where.plan)), lobby = placementsIn(s, planRow(s, where.lobby));
      const best: Candidate[] = [];
      for (let m = 0; m < slots.length; m++) {
        const e = st.list[slots[m]], rank = ranks[m];
        // Full of this plan's and the lobby's: another plan or none could not come in (fix round 1, M2).
        const group = this.groupOf(e, where, here, lobby, best.length === max ? best[max - 1].group : 4);
        if (group < 0 || (f.planOnly && group !== 0)) continue;
        if (best.length === max && compare(group, rank, e, best[max - 1]) >= 0) continue;
        let lo = 0, hi = best.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (compare(group, rank, e, best[mid]) < 0) hi = mid; else lo = mid + 1; }
        best.splice(lo, 0, { e, group, rank });
        if (best.length > max) best.pop();
      }
      return best.map((c) => ({ id: c.e.id, kind: c.e.kind, title: c.e.title, plan: this.planOf(c, where), field: FIELDS[c.rank] }));
    } finally {
      flags.fill(0, 0, D);
    }
  }

  /**
   * The field that answers for `e` (0 to 3: the last field a word of the query is first found in), −1 if a word is found
   * in none of the `chosen` ones. The fields after the one that completes the query are not read.
   */
  private answers(e: Entry, chosen: readonly boolean[], flags: Int32Array, full: number): number {
    const words = e.words;
    let cover = 0, rank = -1, at = 0;
    for (let k = 0; k < 4; k++) {
      const end = e.ends[k];
      if (chosen[k]) {
        // Within the field, it stops once every word missing so far is found.
        const need = full & ~cover;
        let acc = 0;
        for (let i = at; i < end; i++) { acc |= flags[words[i]]; if ((acc & need) === need) break; }
        if ((acc & need) !== 0) {
          cover |= acc;
          rank = k;
          if (cover === full) return rank;
        }
      }
      at = end;
    }
    return -1;
  }

  /**
   * Its group of plans (0 this plan, 1 the lobby, 2 another, 3 none), as the state now has it; −1 if it is gone. A node
   * by the placements of this plan and the lobby, by node row (`here`, `lobby`), then by its count of plans — not read
   * when the results kept are full of groups before 2 (`worst`, the last one's): it is 2 then, and does not come in. A
   * connection by its plans.
   */
  private groupOf(e: Entry, where: SearchWhere, here: ReadonlyMap<number, unknown>, lobby: ReadonlyMap<number, unknown>, worst: number): number {
    const s = this.state;
    if (e.kind === 'node') {
      const row = nodeRow(s, e.id);
      if (row < 0) return -1;
      if (here.has(row)) return 0;
      if (lobby.has(row)) return 1;
      return worst < 2 || placedInCount(s, row) > 0 ? 2 : 3;
    }
    const row = connRow(s, e.id);
    if (row < 0 || connTrashed(s, row)) return -1;
    const plans = this.connectionPlans(e.id);
    return plans.includes(where.plan) ? 0 : plans.includes(where.lobby) ? 1 : plans.length > 0 ? 2 : 3;
  }

  /** A connection's plans (D3): where it has branches, and where its phantoms are. */
  private connectionPlans(id: Id): Id[] {
    const s = this.state, plans = s.branches.plansOf(id);
    for (const ph of phantomsOf(s, id)) {
      const p = s.phantoms.get(ph)?.plan;
      if (p !== undefined && !plans.includes(p)) plans.push(p);
    }
    return plans;
  }

  /** Where its jump goes (D2): this plan, the lobby, the first of its other plans among the tabs then by name, or none. */
  private planOf(c: Candidate, where: SearchWhere): Id | null {
    if (c.group === 0) return where.plan;
    if (c.group === 1) return where.lobby;
    if (c.group === 3) return null;
    const s = this.state;
    const plans = c.e.kind === 'node' ? [...placedIn(s, nodeRow(s, c.e.id))].map((r) => planId(s, r)) : this.connectionPlans(c.e.id);
    const tab = (p: Id) => { const i = where.tabs.indexOf(p); return i < 0 ? where.tabs.length : i; };
    const name = (p: Id) => s.plans.get(p)?.name ?? '';
    return plans.sort((a, b) => tab(a) - tab(b) || COLLATOR.compare(name(a), name(b)) || order(a, b))[0] ?? null;
  }
}
