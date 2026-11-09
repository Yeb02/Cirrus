import {
  type Action, connId, connKind, connRelation, connRow, connRowCount, connTags, connTitle, connTrashed, type Id, KNOWLEDGE, nodeAt, type NodeRec, nodeRow,
  phantomsOf, placedIn, placementsIn, planId, planRow, type State, type TagValue,
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
/** Items read between two looks at the clock, in a build made by slices. */
const CLOCK_EVERY = 64;

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

/** Each word of `t` as written, in order, repeats kept. */
function forEachWord(t: string, f: (raw: string) => void): void {
  const n = t.length;
  let i = 0;
  while (i < n) {
    let len = wordUnitAt(t, i);
    if (len === 0) { i++; continue; }
    const start = i;
    do i += len; while (i < n && (len = wordUnitAt(t, i)) > 0);
    f(t.slice(start, i));
  }
}

/** A text's words as the index compares them (fold: no case, no accents, ligatures as two letters), in order. */
export function searchWords(text: string): string[] {
  const out: string[] = [];
  forEachWord(text, (raw) => { const w = fold(raw); if (w !== '') out.push(w); });
  return out;
}

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
  /** Its folded title: the order of the results among equals, as a plain comparison (the collator only breaks its ties). */
  readonly key: string;
  /** The numbers of its words, field after field (FIELDS), each field's without repeats; field f ends at `ends[f]`. */
  readonly words: Int32Array;
  readonly ends: readonly [number, number, number, number];
}

/** Collects an entry's word numbers, field by field, each field without repeats (a stamp per word number). */
class WordBuffer {
  private buf = new Int32Array(1024);
  private n = 0;
  private seen = new Int32Array(1024);
  private stamp = 0;
  private readonly dict: Dictionary;
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

  /** A new entry. */
  begin(): void { this.n = 0; this.field(); }
  /** A new field (a word of the previous one counts again); where the field before it ended. */
  field(): number {
    if (++this.stamp === 0x7fffffff) { this.seen.fill(0); this.stamp = 1; }
    return this.n;
  }
  text(t: string): void { if (t !== '') forEachWord(t, this.add); }
  tags(tags: readonly TagValue[]): void {
    for (const t of tags) {
      this.text(t.key);
      if (t.value !== undefined) this.text(String(t.value));
    }
  }
  take(): Int32Array { return this.buf.slice(0, this.n); }
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

/**
 * The index's storage, handed from each index to the next (SearchIndex.build): only the latest index is to be asked.
 * The entries are in a list (the query reads it whole), each at its slot, its bloom at the same slot.
 */
class Store {
  readonly dict = new Dictionary();
  readonly words = new WordBuffer(this.dict);
  readonly list: Entry[] = [];
  readonly slots = new Map<Id, number>();
  blooms = new Int32Array(1024 * BLOOM_INTS);
  /** The nodes that have a .tex, with the hashes they read: a change of the texts reads only them again. */
  readonly tex = new Map<Id, readonly string[]>();
  /** The query's marks, one bit per query word, by word number: zero between queries. */
  flags = new Int32Array(0);

  set(id: Id, e: Entry | null): void {
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

  /** A node read again from the state (`n`: its record, none if it is gone). */
  setNode(id: Id, n: NodeRec | undefined, texts: ReadonlyMap<string, string>): void {
    let tex: string[] | null = null;
    for (const f of n?.files ?? []) if (fileKind(f.name) === 'tex') (tex ??= []).push(f.hash);
    if (tex) this.tex.set(id, tex); else this.tex.delete(id);
    this.set(id, n && n.trashedAt === undefined ? this.nodeEntry(n, tex, texts) : null);
  }

  /** A connection read again from the state, by its row (−1: gone). */
  setConnection(s: State, id: Id, row: number): void {
    this.set(id, this.connectionEntry(s, row));
  }

  /** A live node's entry, null without a word. */
  private nodeEntry(n: NodeRec, tex: readonly string[] | null, texts: ReadonlyMap<string, string>): Entry | null {
    const b = this.words;
    b.begin();
    b.text(n.title);
    const t = b.field();
    b.tags(n.tags);
    const g = b.field();
    b.text(n.summary);
    const m = b.field();
    for (const h of tex ?? []) b.text(texts.get(h) ?? '');
    const c = b.field();
    return c === 0 ? null : { id: n.id, kind: 'node', title: n.title, key: fold(n.title), words: b.take(), ends: [t, g, m, c] };
  }

  /**
   * A connection's entry: a knowledge connection outside the trash only — never a document's structure (spec 5.3), nor a
   * group's inclusion, which has no text and is drawn as its envelope; null without a word. Read from its columns: the
   * bench's base has half a million connections, most without text.
   */
  private connectionEntry(s: State, row: number): Entry | null {
    if (row < 0 || connKind(s, row) !== KNOWLEDGE || connTrashed(s, row)) return null;
    const title = connTitle(s, row), relation = connRelation(s, row), tags = connTags(s, row);
    if (title === '' && relation === '' && tags.length === 0) return null;
    const b = this.words;
    b.begin();
    b.text(title);
    const t = b.field();
    b.tags(tags);
    const g = b.field();
    b.text(relation);
    const m = b.field();
    return m === 0 ? null : { id: connId(s, row), kind: 'connection', title, key: fold(title), words: b.take(), ends: [t, g, m, m] };
  }
}

/**
 * A whole build made a slice at a time (Global Constraints, « La performance »: the window is never frozen by it — at
 * 50 000 nodes with long summaries it takes about two seconds). Each `step` reads until its deadline; each object is read
 * as the state is when its turn comes. The actions applied meanwhile are given to the index it ends with
 * (SearchIndex.build, by their subjects): what one of them changed after its object was read is read again.
 */
export class SearchBuild {
  private readonly s: State;
  private readonly texts: ReadonlyMap<string, string>;
  private readonly store = new Store();
  private readonly nodes: Id[];
  private node = 0;
  private row = 0;

  constructor(s: State, texts: ReadonlyMap<string, string>) {
    this.s = s;
    this.texts = texts;
    this.nodes = [...s.nodes.keys()];
  }

  /**
   * Reads until `deadline` (performance.now()), looking at the clock every `every` objects (so many at least); the index
   * once every object is read.
   */
  step(deadline: number, every = CLOCK_EVERY): SearchIndex | null {
    const s = this.s, st = this.store;
    let k = 0;
    const late = () => ++k % every === 0 && performance.now() >= deadline;
    while (this.node < this.nodes.length) {
      const id = this.nodes[this.node++];
      st.setNode(id, s.nodes.get(id), this.texts);
      if (late()) return null;
    }
    for (const end = connRowCount(s); this.row < end;) {
      const r = this.row++;
      if (connKind(s, r) !== KNOWLEDGE) continue;
      st.setConnection(s, connId(s, r), r);
      if (late()) return null;
    }
    return SearchIndex.of(s, this.texts, st);
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
 * A query's words and fields, with what answered it: its objects' slots (any plan; the slots hold while the index is
 * the latest), and each word's dictionary numbers.
 */
interface LastQuery { words: string[]; fields: string; slots: number[]; ids: Map<string, Int32Array> }

/**
 * The index (D1). Built whole once (SearchBuild; `build` without `previous`), it is then built again at each change of
 * the state from the last one (`previous`): with the actions applied since (`action`, their operations as one), only
 * the nodes and connections they touch are read again — whatever their operations say in between (a synchronisation's
 * rewinds: each subject is read as it now is); without one (undefined), only the nodes whose .tex were read since
 * (`texts`, the registry's: plan 4b). A null action (a reload), or another state, builds it whole. The plans an object is
 * in are not kept: the query reads them for what it finds, as the state now has them. The storage goes from each index
 * to the next: the previous one is not to be asked any more.
 */
export class SearchIndex {
  readonly state: State;
  private readonly texts: ReadonlyMap<string, string>;
  private readonly store: Store;
  private last: LastQuery | null = null;

  private constructor(s: State, texts: ReadonlyMap<string, string>, store: Store) {
    this.state = s;
    this.texts = texts;
    this.store = store;
  }

  /** @internal SearchBuild's end: its storage, as an index. */
  static of(s: State, texts: ReadonlyMap<string, string>, store: Store): SearchIndex {
    return new SearchIndex(s, texts, store);
  }

  static build(s: State, texts: ReadonlyMap<string, string>, previous?: SearchIndex, action?: Action | null): SearchIndex {
    if (!previous || previous.state !== s || action === null) return new SearchBuild(s, texts).step(Infinity)!;
    const st = previous.store, done = new Set<Id>();
    for (const op of action?.ops ?? []) {
      if (op.t !== 'node' && op.t !== 'connection') continue;
      const id = (op.after ?? op.before)!.id;
      if (done.has(id)) continue;
      done.add(id);
      if (op.t === 'node') st.setNode(id, s.nodes.get(id), texts);
      else st.setConnection(s, id, connRow(s, id));
    }
    // The .tex read since: the nodes whose texts are no longer those read.
    if (texts !== previous.texts) {
      for (const [id, hashes] of [...st.tex]) {
        if (!done.has(id) && hashes.some((h) => texts.get(h) !== previous.texts.get(h))) st.setNode(id, s.nodes.get(id), texts);
      }
    }
    return new SearchIndex(s, texts, st);
  }

  /** The objects indexed. */
  get size(): number {
    return this.store.list.length;
  }

  /**
   * What `q` finds (D1): every one of its words the start of a word of the object, in the fields `f` chooses, without
   * case or accents; ordered by D1 (the group of plans, the field, the French order of the titles), `max` at most. Each
   * object's words are read once (a bit per query word, marked in the dictionary); the plans are read for the objects
   * found, the order kept for the `max` best only. A query that narrows the last one (each of its words the start of
   * one of the new ones: a keystroke more) reads only what the last one found.
   */
  query(q: string, f: SearchFilters, where: SearchWhere, max: number): SearchHit[] {
    const words = [...new Set(searchWords(q))].slice(0, MAX_QUERY_WORDS);
    const chosen = FIELDS.map((x) => f[x]), fields = chosen.join();
    if (words.length === 0 || max <= 0 || !chosen.some(Boolean)) return [];
    const st = this.store, all = st.dict.words, D = all.length, last = this.last;
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
      this.last = { words, fields, slots, ids };
      const matches = slots.map((i) => st.list[i]);
      const s = this.state, here = placementsIn(s, planRow(s, where.plan)), lobby = placementsIn(s, planRow(s, where.lobby));
      const best: Candidate[] = [];
      for (let m = 0; m < matches.length; m++) {
        const e = matches[m], rank = ranks[m];
        const group = this.groupOf(e, where, here, lobby);
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
   * Its group of plans (0 this plan, 1 the lobby, 2 another, 3 none), as the state now has it; −1 if it is gone. A
   * node by the placements of this plan and the lobby, by node row (`here`, `lobby`); a connection by its plans.
   */
  private groupOf(e: Entry, where: SearchWhere, here: ReadonlyMap<number, unknown>, lobby: ReadonlyMap<number, unknown>): number {
    const s = this.state;
    if (e.kind === 'node') {
      const row = nodeRow(s, e.id);
      if (row < 0 || nodeAt(s, row)?.trashedAt !== undefined) return -1;
      return here.has(row) ? 0 : lobby.has(row) ? 1 : placedIn(s, row).length > 0 ? 2 : 3;
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
