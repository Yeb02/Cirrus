import type { ConnectionLayout, FileRef, Id, NodeRec, PhantomRec, Placement, PlanRec, PreambleRec, TagKeyDef, TagValue } from './model.ts';
import { dataOf, emptyState, type Indices, layoutKey, reindexRest, type State } from './state.ts';
import { type ConnTable, EMPTY_TAGS, INCLUSION, KINDS, NO_RECORD, type Pool, type Rows, SOURCE, TARGET } from './tables.ts';

// The state as one ArrayBuffer (plan 3c, decisions 4 and 5): the snapshot kept in the base and sent to the interface.
// The tables go row for row (identifiers, reference counts, free lists, columns, pools packed); records as columns
// that refer to rows and to one table of strings, UTF-8 and separated by \0; the rare irregular records, the plans, the
// tag keys, the layouts and the preamble as JSON. Of the indices, the three that cost most to derive go as they are
// (memberOf, placedIn, groupOf), the others are rebuilt (reindexRest). Layout, little-endian, every section 8-aligned:
//   header (32 bytes): magic, version, total length, two checksum words over everything after the header, section count;
//   directory: offset and length in bytes of each section, in the order of SECTION_NAMES;
//   the sections, numeric first, then the strings, then the JSON.

/**
 * The format's version: a snapshot of another version is not read (the base's tables are). Bump it with any change,
 * but for a JSON field whose absence decodes right in the snapshots written before it (the preamble, plan 4b).
 */
export const SNAPSHOT_VERSION = 1;
const MAGIC = 0x53524943; // 'CIRS'
const HEADER_BYTES = 32;

/** A buffer that is not a snapshot of this version, or a damaged one. */
export class SnapshotError extends Error {}

const SECTION_NAMES = [
  'counts', 'nodeRefs', 'nodeFree', 'nodeRecs', 'nodeTrashed', 'planRefs', 'planFree', 'connRefs', 'connFree', 'connKind', 'connTitles', 'connRelations',
  'connTags', 'connTrashed', 'memberLen', 'members', 'branchLen', 'branches', 'placeCount', 'placeNode', 'placeXyk', 'phantoms', 'phantomXyk',
  'memberOfLen', 'memberOf', 'placedInLen', 'placedIn', 'groupLen', 'groups', 'listInts', 'listNums', 'strings', 'json',
] as const;
type Section = (typeof SECTION_NAMES)[number];
const SECTIONS = SECTION_NAMES.length;
const DATA_START = align8(HEADER_BYTES + 8 * SECTIONS);
const sectionIndex = (name: Section) => SECTION_NAMES.indexOf(name);

/** The scalars of the counts section, in this order. */
const COUNT_NAMES = ['nodeEnd', 'planEnd', 'connEnd', 'nodes', 'plans', 'connections', 'branches', 'placements', 'phantoms', 'strings'] as const;
type Counts = Record<(typeof COUNT_NAMES)[number], number>;

/** Node records, five integers per row: state (NO_NODE, REGULAR or IRREGULAR), title, summary, tags list, files list. */
const NODE_STRIDE = 5;
const NO_NODE = 0, REGULAR = 1, IRREGULAR = 2;
/** Phantoms, six integers each: identifier (or −1 − its JSON's string), plan, connection, of.kind, of.node, group (−1: none). */
const PHANTOM_STRIDE = 6;
/** The value of a tag in the lists: none, a string, a number (index in listNums). */
const NO_VALUE = 0, STRING_VALUE = 1, NUMBER_VALUE = 2;
/** The files of every decoded node that has none (records are never changed in place; frozen, a mistake would throw). */
const NO_FILES: readonly FileRef[] = Object.freeze([]);

/** What the JSON section holds. */
interface JsonPart {
  plans: [row: number, rec: PlanRec][];
  tagKeys: TagKeyDef[];
  /** Each layout with its plan and connection as strings of the table (the rest as it is). */
  layouts: [plan: number, connection: number, rest: Omit<ConnectionLayout, 'plan' | 'connection'>][];
  /** Placements that are not five numbers and two identifiers, by index in the placement columns (which keep their node row). */
  placements: [index: number, rec: Placement][];
  /** Connection titles and relations that are not strings (only through invalid data), by row. */
  connTexts: [row: number, title: unknown, relation: unknown][];
  /** Strings that the \0-separated table cannot carry (a \0 inside, a lone surrogate), by index; their slot holds ''. */
  strings: [index: number, value: string][];
  /** The nodes with several direct groups (index groupOf), by plan row and node row. */
  multi: [plan: number, node: number, groups: number[]][];
  /**
   * Absent when the base never set one (plan 4b): a snapshot of such a base is the same as one written before the
   * field existed, and one written before decodes without it, so the version stays.
   */
  preamble?: PreambleRec;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

/** Whether `o` has exactly `n` defined own properties (no more than the known ones checked by the caller). */
function definedKeys(o: object, n: number): boolean {
  let k = 0;
  for (const key in o) if ((o as Record<string, unknown>)[key] !== undefined) k++;
  return k === n;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function regularTag(t: unknown): boolean {
  if (!isObject(t) || typeof t.key !== 'string') return false;
  const v = t.value;
  return (v === undefined || typeof v === 'string' || typeof v === 'number') && definedKeys(t, v === undefined ? 1 : 2);
}

function regularFile(f: unknown): boolean {
  return isObject(f) && typeof f.name === 'string' && typeof f.hash === 'string' && typeof f.size === 'number' && definedKeys(f, 3);
}

function regularNode(n: NodeRec): boolean {
  const t = n.trashedAt;
  return typeof n.id === 'string' && typeof n.title === 'string' && typeof n.summary === 'string' && Array.isArray(n.tags) && Array.isArray(n.files)
    && (t === undefined || (typeof t === 'number' && !Number.isNaN(t))) && definedKeys(n, t === undefined ? 5 : 6);
}

function regularPlacement(p: Placement, plan: Id, node: Id): boolean {
  return p.plan === plan && p.node === node && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.k === 'number' && definedKeys(p, 5);
}

function regularPhantom(p: PhantomRec): boolean {
  const of = p.of as unknown;
  return typeof p.id === 'string' && typeof p.plan === 'string' && typeof p.connection === 'string' && isObject(of) && typeof of.kind === 'string'
    && typeof of.node === 'string' && definedKeys(of, 2) && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.k === 'number'
    && (p.group === undefined || typeof p.group === 'string') && definedKeys(p, p.group === undefined ? 7 : 8);
}

/** The strings after the row identifiers, each once: interned by value, so that every reference to one is one string. */
class StringTable {
  readonly others: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly base: number;
  readonly empty: number;

  constructor(base: number) {
    this.base = base;
    this.empty = this.of('');
  }

  of(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.base + this.others.length;
      this.others.push(s);
      this.index.set(s, i);
    }
    return i;
  }
}

/** Tag and file lists: integers (and the numbers they refer to), each list at an offset, −1 for an empty one. */
class Lists {
  readonly ints: number[] = [];
  readonly nums: number[] = [];
  private readonly st: StringTable;

  constructor(st: StringTable) {
    this.st = st;
  }

  tags(tags: readonly TagValue[]): number {
    if (tags.length === 0) return -1;
    const at = this.ints.length, st = this.st, ints = this.ints;
    if (!tags.every(regularTag)) {
      ints.push(-1, st.of(JSON.stringify(tags)));
      return at;
    }
    ints.push(tags.length);
    for (const t of tags) {
      const v = t.value;
      if (v === undefined) ints.push(st.of(t.key), NO_VALUE, 0);
      else if (typeof v === 'string') ints.push(st.of(t.key), STRING_VALUE, st.of(v));
      else { ints.push(st.of(t.key), NUMBER_VALUE, this.nums.length); this.nums.push(v); }
    }
    return at;
  }

  files(files: readonly FileRef[]): number {
    if (files.length === 0) return -1;
    const at = this.ints.length, st = this.st, ints = this.ints;
    if (!files.every(regularFile)) {
      ints.push(-1, st.of(JSON.stringify(files)));
      return at;
    }
    ints.push(files.length);
    for (const f of files) { ints.push(st.of(f.name), st.of(f.hash), this.nums.length); this.nums.push(f.size); }
    return at;
  }
}

/** A section written straight into the snapshot, without an intermediate copy: its size, then its bytes at an offset. */
interface Deferred { readonly byteLength: number; write(buf: ArrayBuffer, offset: number): void }

/** The pool's lists packed in owner order, for owners [0, owners). */
function packed(pool: Pool, owners: number): Deferred {
  const start = pool.start, len = pool.len, data = pool.data;
  let total = 0;
  for (let o = 0; o < owners; o++) total += len[o];
  return {
    byteLength: 4 * total,
    write(buf, offset) {
      const out = new Int32Array(buf, offset, total);
      let k = 0;
      for (let o = 0; o < owners; o++) for (let i = start[o], end = i + len[o]; i < end; i++) out[k++] = data[i];
    },
  };
}

/**
 * Two words over the 32-bit words of `u` (an even number of them): four multiplicative lanes, so that any one word
 * changed changes the result, folded into a hash and a sum. Four lanes rather than one: the multiplications overlap.
 */
function checksum(u: Uint32Array): [number, number] {
  let a = 0x811c9dc5, b = 0x050c5d1f, c = 0x1b873593, d = 0x2f6f7e3d;
  const P = 0x01000193, n = u.length - (u.length % 4);
  for (let i = 0; i < n; i += 4) {
    a = Math.imul(a ^ u[i], P);
    b = Math.imul(b ^ u[i + 1], P);
    c = Math.imul(c ^ u[i + 2], P);
    d = Math.imul(d ^ u[i + 3], P);
  }
  for (let i = n; i < u.length; i++) a = Math.imul(a ^ u[i], P);
  return [Math.imul(Math.imul(a ^ b, P) ^ c, P) ^ d, (a + b + c + d + u.length) | 0].map((x) => x >>> 0) as [number, number];
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const isWellFormed = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

/** The state as a snapshot (decodeState reads it back): O(base), one buffer. */
export function encodeState(s: State): ArrayBuffer {
  const T = dataOf(s).tables, N = T.nodes, P = T.plans, C = T.conns;
  const nodeEnd = N.rows.end, planEnd = P.rows.end, connEnd = C.rows.end;
  for (const [rows, end] of [[N.rows, nodeEnd], [P.rows, planEnd], [C.rows, connEnd]] as const) {
    if (rows.ids.length !== end) throw new Error('encodeState: rows out of step with their identifiers');
  }
  const st = new StringTable(nodeEnd + planEnd + connEnd), lists = new Lists(st), empty = st.empty;
  const json: JsonPart = { plans: [], tagKeys: [...T.tagKeys.values()], layouts: [], placements: [], connTexts: [], strings: [], multi: [] };
  if (T.preamble) json.preamble = T.preamble;
  const nodeIndex = N.rows.row, planIndex = P.rows.row, connIndex = C.rows.row, planBase = nodeEnd, connBase = nodeEnd + planEnd;
  // A reference to an identifier that has a row is that row's string: on decoding, the same string as the row's.
  const nodeRef = (id: Id) => { const r = nodeIndex.get(id); return r === undefined ? st.of(id) : r; };
  const planRef = (id: Id) => { const r = planIndex.get(id); return r === undefined ? st.of(id) : planBase + r; };
  const connRef = (id: Id) => { const r = connIndex.get(id); return r === undefined ? st.of(id) : connBase + r; };

  const nodeRecs = new Int32Array(nodeEnd * NODE_STRIDE), nodeTrashed = new Float64Array(nodeEnd).fill(NaN), recs = N.recs;
  for (let r = 0; r < nodeEnd; r++) {
    const n = recs[r], o = r * NODE_STRIDE;
    if (n === undefined) continue;
    if (regularNode(n)) {
      nodeRecs[o] = REGULAR;
      nodeRecs[o + 1] = n.title === '' ? empty : st.of(n.title);
      nodeRecs[o + 2] = n.summary === '' ? empty : st.of(n.summary);
      nodeRecs[o + 3] = lists.tags(n.tags);
      nodeRecs[o + 4] = lists.files(n.files);
      if (n.trashedAt !== undefined) nodeTrashed[r] = n.trashedAt;
    } else {
      nodeRecs[o] = IRREGULAR;
      nodeRecs[o + 1] = st.of(JSON.stringify(n));
    }
  }
  for (let r = 0; r < planEnd; r++) { const p = P.recs[r]; if (p !== undefined) json.plans.push([r, p]); }

  // Connection texts and tags, sparse: (row, string) and (row, list) pairs for the rows that have some.
  const connTitles: number[] = [], connRelations: number[] = [], connTags: number[] = [];
  const titles = C.title, relations = C.relation, tags = C.tags, noTags = EMPTY_TAGS;
  for (let r = 0; r < connEnd; r++) {
    const t = titles[r], rel = relations[r], tg = tags[r];
    if (t !== '' || rel !== '') {
      if (typeof t !== 'string' || typeof rel !== 'string') json.connTexts.push([r, t, rel]);
      else {
        if (t !== '') connTitles.push(r, st.of(t));
        if (rel !== '') connRelations.push(r, st.of(rel));
      }
    }
    if (tg !== noTags && tg.length > 0) connTags.push(r, lists.tags(tg));
  }

  const placeCount = new Int32Array(planEnd), placeNode = new Int32Array(P.placementCount), placeXyk = new Float64Array(3 * P.placementCount);
  let i = 0;
  for (let p = 0; p < planEnd; p++) {
    const map = P.placements[p];
    if (map === undefined) continue;
    placeCount[p] = map.size;
    const plan = P.rows.ids[p], ids = N.rows.ids;
    for (const [n, pl] of map) {
      placeNode[i] = n;
      if (regularPlacement(pl, plan, ids[n])) {
        placeXyk[3 * i] = pl.x;
        placeXyk[3 * i + 1] = pl.y;
        placeXyk[3 * i + 2] = pl.k;
      } else json.placements.push([i, pl]);
      i++;
    }
  }
  if (i !== P.placementCount) throw new Error('encodeState: placements out of step with their count');

  const phantoms = new Int32Array(PHANTOM_STRIDE * T.phantoms.size), phantomXyk = new Float64Array(3 * T.phantoms.size);
  i = 0;
  for (const ph of T.phantoms.values()) {
    const o = PHANTOM_STRIDE * i;
    if (regularPhantom(ph)) {
      phantoms[o] = st.of(ph.id);
      phantoms[o + 1] = planRef(ph.plan);
      phantoms[o + 2] = connRef(ph.connection);
      phantoms[o + 3] = st.of(ph.of.kind);
      phantoms[o + 4] = nodeRef(ph.of.node);
      phantoms[o + 5] = ph.group === undefined ? -1 : nodeRef(ph.group);
      phantomXyk[3 * i] = ph.x;
      phantomXyk[3 * i + 1] = ph.y;
      phantomXyk[3 * i + 2] = ph.k;
    } else phantoms[o] = -1 - st.of(JSON.stringify(ph));
    i++;
  }
  for (const l of T.layouts.values()) {
    const { plan, connection, ...rest } = l;
    json.layouts.push([planRef(plan), connRef(connection), rest]);
  }
  // Each plan's direct groups (−1 for a plan without), packed.
  const I = dataOf(s).index, groupLen = new Int32Array(planEnd).fill(-1);
  let groupTotal = 0;
  for (let p = 0; p < planEnd; p++) {
    const pg = I.groupOf[p];
    if (pg === undefined) continue;
    groupLen[p] = pg.group.length;
    groupTotal += pg.group.length;
    for (const [n, gs] of pg.multi) json.multi.push([p, n, gs]);
  }
  const groups = new Int32Array(groupTotal);
  groupTotal = 0;
  for (let p = 0; p < planEnd; p++) {
    const pg = I.groupOf[p];
    if (pg !== undefined) { groups.set(pg.group, groupTotal); groupTotal += pg.group.length; }
  }

  // The strings: row identifiers (nodes, plans, connections, '' for a free row), then the others. The others (texts
  // typed by the user) are checked for a \0 one by one; an identifier with one (never made by uuidv7) changes the count
  // decodeState checks, which then refuses the snapshot. A lone surrogate, which UTF-8 would replace, is looked for in
  // every string, once the whole text has shown one.
  const all = N.rows.ids.concat(P.rows.ids, C.rows.ids, st.others);
  for (let k = all.length - st.others.length; k < all.length; k++) if (all[k].includes('\0')) { json.strings.push([k, all[k]]); all[k] = ''; }
  let text = all.join('\0');
  if (!isWellFormed(text)) {
    for (let k = 0; k < all.length; k++) if (!isWellFormed(all[k])) { json.strings.push([k, all[k]]); all[k] = ''; }
    text = all.join('\0');
  }
  const encoder = new TextEncoder();

  const counts: Counts = {
    nodeEnd, planEnd, connEnd, nodes: N.count, plans: P.count, connections: C.count, branches: C.branchCount, placements: P.placementCount,
    phantoms: T.phantoms.size, strings: all.length,
  };
  const parts: Record<Section, ArrayBufferView | Deferred> = {
    counts: Int32Array.from(COUNT_NAMES, (k) => counts[k]),
    nodeRefs: N.rows.refs.subarray(0, nodeEnd), nodeFree: Int32Array.from(N.rows.free), nodeRecs, nodeTrashed,
    planRefs: P.rows.refs.subarray(0, planEnd), planFree: Int32Array.from(P.rows.free),
    connRefs: C.rows.refs.subarray(0, connEnd), connFree: Int32Array.from(C.rows.free),
    connKind: C.kind.subarray(0, connEnd), connTitles: Int32Array.from(connTitles), connRelations: Int32Array.from(connRelations), connTags: Int32Array.from(connTags),
    connTrashed: C.trashedAt.subarray(0, connEnd),
    memberLen: C.members.len.subarray(0, connEnd), members: packed(C.members, connEnd),
    branchLen: C.branches.len.subarray(0, connEnd), branches: packed(C.branches, connEnd),
    placeCount, placeNode, placeXyk, phantoms, phantomXyk,
    memberOfLen: I.memberOf.len.subarray(0, nodeEnd), memberOf: packed(I.memberOf, nodeEnd),
    placedInLen: I.placedIn.len.subarray(0, nodeEnd), placedIn: packed(I.placedIn, nodeEnd), groupLen, groups,
    listInts: Int32Array.from(lists.ints), listNums: Float64Array.from(lists.nums),
    strings: encoder.encode(text), json: encoder.encode(JSON.stringify(json)),
  };

  const dir = new Uint32Array(2 * SECTIONS);
  let at = DATA_START;
  SECTION_NAMES.forEach((name, k) => {
    dir[2 * k] = at;
    dir[2 * k + 1] = parts[name].byteLength;
    at = align8(at + parts[name].byteLength);
  });
  if (at > 0xffffffff) throw new Error('encodeState: the state is too large for a snapshot');
  const buf = new ArrayBuffer(at), bytes = new Uint8Array(buf);
  new Uint32Array(buf, HEADER_BYTES, 2 * SECTIONS).set(dir);
  SECTION_NAMES.forEach((name, k) => {
    const part = parts[name];
    if ('write' in part) part.write(buf, dir[2 * k]);
    else bytes.set(bytesOf(part), dir[2 * k]);
  });
  const head = new Uint32Array(buf, 0, HEADER_BYTES / 4);
  head[0] = MAGIC;
  head[1] = SNAPSHOT_VERSION;
  head[2] = at;
  [head[3], head[4]] = checksum(new Uint32Array(buf, HEADER_BYTES));
  head[5] = SECTIONS;
  return buf;
}

/** The format version of a snapshot, from its header (magic and length checked, not the checksum). */
export function snapshotVersion(buf: ArrayBuffer): number {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES || buf.byteLength % 8 !== 0) throw new SnapshotError('Pas un instantané.');
  const head = new Uint32Array(buf, 0, HEADER_BYTES / 4);
  if (head[0] !== MAGIC || head[2] !== buf.byteLength) throw new SnapshotError('Pas un instantané, ou tronqué.');
  return head[1];
}

const corrupt = (what: string) => new SnapshotError(`Instantané endommagé : ${what}.`);

/**
 * The state of a snapshot (encodeState), indices rebuilt. Its columns and pools are views on `buf` where they can be
 * (the buffer belongs to the state from then on); each table's identifier map is built at its first use (Rows.restored).
 * Throws SnapshotError on another version, a damaged or truncated buffer, or any reference out of its table: the
 * caller then reads the base's tables.
 */
export function decodeState(buf: ArrayBuffer): State {
  const version = snapshotVersion(buf);
  if (version !== SNAPSHOT_VERSION) throw new SnapshotError(`Instantané de la version ${version}, attendu ${SNAPSHOT_VERSION}.`);
  const head = new Uint32Array(buf, 0, HEADER_BYTES / 4);
  if (head[5] !== SECTIONS || buf.byteLength < DATA_START) throw corrupt('en-tête');
  const [h, sum] = checksum(new Uint32Array(buf, HEADER_BYTES));
  if (h !== head[3] || sum !== head[4]) throw corrupt('somme de contrôle');
  const dir = new Uint32Array(buf, HEADER_BYTES, 2 * SECTIONS);
  let previous = DATA_START;
  for (let k = 0; k < SECTIONS; k++) {
    const o = dir[2 * k], len = dir[2 * k + 1];
    if (o !== align8(previous) || o + len > buf.byteLength) throw corrupt('répertoire');
    previous = o + len;
  }
  /** Section `name` as `n` elements of `type` (any length when n is undefined). */
  const view = <A extends Int32Array | Float64Array | Uint8Array>(type: { new (b: ArrayBuffer, o: number, n: number): A; BYTES_PER_ELEMENT: number }, name: Section, n?: number): A => {
    const k = sectionIndex(name), len = dir[2 * k + 1];
    if (len % type.BYTES_PER_ELEMENT !== 0 || (n !== undefined && len !== n * type.BYTES_PER_ELEMENT)) throw corrupt(name);
    return new type(buf, dir[2 * k], len / type.BYTES_PER_ELEMENT);
  };
  const i32 = (name: Section, n?: number) => view(Int32Array, name, n);
  const f64 = (name: Section, n?: number) => view(Float64Array, name, n);
  const raw = i32('counts', COUNT_NAMES.length);
  const counts = Object.fromEntries(COUNT_NAMES.map((k, i) => [k, raw[i]])) as Counts;
  const { nodeEnd, planEnd, connEnd } = counts;
  if (nodeEnd < 0 || planEnd < 0 || connEnd < 0) throw corrupt('comptes');

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const strs = decoder.decode(view(Uint8Array, 'strings')).split('\0');
  if (strs.length !== counts.strings || strs.length < nodeEnd + planEnd + connEnd) throw corrupt('table des chaînes');
  const json = JSON.parse(decoder.decode(view(Uint8Array, 'json'))) as JsonPart;
  if (!isObject(json) || ![json.plans, json.tagKeys, json.layouts, json.placements, json.connTexts, json.strings, json.multi].every(Array.isArray)) throw corrupt('JSON');
  for (const [k, v] of json.strings) {
    if (!(k >= 0 && k < strs.length) || typeof v !== 'string') throw corrupt('chaînes à part');
    strs[k] = v;
  }
  const stringCount = strs.length;
  const str = (k: number): string => {
    if (!(k >= 0 && k < stringCount)) throw corrupt('référence à une chaîne');
    return strs[k];
  };

  const s = emptyState(), T = dataOf(s).tables, N = T.nodes, P = T.plans, C = T.conns;
  const nodeFree = restoreRows(N.rows, strs, 0, nodeEnd, i32('nodeRefs', nodeEnd), i32('nodeFree'));
  const planFree = restoreRows(P.rows, strs, nodeEnd, planEnd, i32('planRefs', planEnd), i32('planFree'));
  const connFree = restoreRows(C.rows, strs, nodeEnd + planEnd, connEnd, i32('connRefs', connEnd), i32('connFree'));
  const nodeIds = N.rows.ids, planIds = P.rows.ids;

  // Tag and file lists.
  const listInts = i32('listInts'), listNums = f64('listNums');
  const int = (k: number): number => {
    if (!(k >= 0 && k < listInts.length)) throw corrupt('listes');
    return listInts[k];
  };
  const num = (k: number): number => {
    if (!(k >= 0 && k < listNums.length)) throw corrupt('listes');
    return listNums[k];
  };
  const parsedList = <T>(k: number): T[] => {
    const v: unknown = JSON.parse(str(int(k)));
    if (!Array.isArray(v)) throw corrupt('liste');
    return v as T[];
  };
  const tagList = (at: number): TagValue[] => {
    const n = int(at);
    if (n < 0) return parsedList<TagValue>(at + 1);
    const out: TagValue[] = [];
    for (let i = 0, k = at + 1; i < n; i++, k += 3) {
      const key = str(int(k)), kind = int(k + 1);
      if (kind === NO_VALUE) out.push({ key });
      else if (kind === STRING_VALUE) out.push({ key, value: str(int(k + 2)) });
      else if (kind === NUMBER_VALUE) out.push({ key, value: num(int(k + 2)) });
      else throw corrupt('tag');
    }
    return out;
  };
  const fileList = (at: number): FileRef[] => {
    const n = int(at);
    if (n < 0) return parsedList<FileRef>(at + 1);
    const out: FileRef[] = [];
    for (let i = 0, k = at + 1; i < n; i++, k += 3) out.push({ name: str(int(k)), hash: str(int(k + 1)), size: num(int(k + 2)) });
    return out;
  };

  // Node records.
  const nodeRecs = i32('nodeRecs', nodeEnd * NODE_STRIDE), nodeTrashed = f64('nodeTrashed', nodeEnd), recs = N.recs;
  // Empty lists shared, as the connections' tags are (EMPTY_TAGS): a hundred thousand arrays fewer on a large base.
  const noTags = EMPTY_TAGS as TagValue[], noFiles = NO_FILES as FileRef[];
  let count = 0;
  for (let r = 0; r < nodeEnd; r++) {
    const o = r * NODE_STRIDE, state = nodeRecs[o];
    if (state === NO_NODE) { recs.push(undefined); continue; }
    if (nodeFree[r] !== 0) throw corrupt('nœud sur une rangée libre');
    let rec: NodeRec;
    if (state === REGULAR) {
      const tags = nodeRecs[o + 3], files = nodeRecs[o + 4];
      rec = {
        id: nodeIds[r], title: str(nodeRecs[o + 1]), summary: str(nodeRecs[o + 2]), tags: tags < 0 ? noTags : tagList(tags), files: files < 0 ? noFiles : fileList(files),
      };
      const t = nodeTrashed[r];
      if (t === t) rec.trashedAt = t;
    } else if (state === IRREGULAR) {
      rec = JSON.parse(str(nodeRecs[o + 1])) as NodeRec;
      if (!isObject(rec) || rec.id !== nodeIds[r]) throw corrupt('nœud');
      rec.id = nodeIds[r];
    } else throw corrupt('nœud');
    recs.push(rec);
    count++;
  }
  N.count = count;

  // Plans: records from the JSON, placements from their columns, in each plan's order.
  for (let r = 0; r < planEnd; r++) { P.recs.push(undefined); P.placements.push(undefined); }
  for (const [r, rec] of json.plans) {
    if (!(r >= 0 && r < planEnd) || planFree[r] !== 0 || !isObject(rec) || rec.id !== planIds[r] || P.recs[r] !== undefined) throw corrupt('plan');
    rec.id = planIds[r];
    P.recs[r] = rec;
    P.count++;
  }
  const placeCount = i32('placeCount', planEnd), placeNode = i32('placeNode', counts.placements), placeXyk = f64('placeXyk', 3 * counts.placements);
  const odd = new Map<number, Placement>();
  for (const [k, rec] of json.placements) {
    if (!isObject(rec)) throw corrupt('placement');
    odd.set(k, rec);
  }
  let i = 0;
  for (let p = 0; p < planEnd; p++) {
    const n = placeCount[p];
    if (n === 0) continue;
    if (planFree[p] !== 0 || n < 0 || i + n > counts.placements) throw corrupt('placements');
    const map = new Map<number, Placement>(), plan = planIds[p];
    for (const end = i + n; i < end; i++) {
      const nr = placeNode[i];
      if (!(nr >= 0 && nr < nodeEnd) || nodeFree[nr] !== 0) throw corrupt('placement');
      const rec = odd.get(i);
      if (rec === undefined) map.set(nr, { plan, node: nodeIds[nr], x: placeXyk[3 * i], y: placeXyk[3 * i + 1], k: placeXyk[3 * i + 2] });
      else {
        if (rec.plan !== plan || rec.node !== nodeIds[nr]) throw corrupt('placement');
        rec.plan = plan;
        rec.node = nodeIds[nr];
        map.set(nr, rec);
      }
    }
    P.placements[p] = map;
  }
  if (i !== counts.placements) throw corrupt('placements');
  P.placementCount = i;

  // Connections: columns as views, texts and tags filled with their defaults then set where the sparse pairs say.
  const kind = view(Uint8Array, 'connKind', connEnd), kinds = KINDS.length, none = NO_RECORD, inclusion = INCLUSION;
  /** The inclusion rows, for the check of groupOf. */
  const inclusions: number[] = [];
  count = 0;
  for (let r = 0; r < connEnd; r++) {
    const k = kind[r];
    if (k === none) continue;
    if (k >= kinds || connFree[r] !== 0) throw corrupt('genre de connexion');
    if (k === inclusion) inclusions.push(r);
    count++;
  }
  C.count = count;
  C.kind = kind;
  C.trashedAt = f64('connTrashed', connEnd);
  const titles = (C.title = new Array<string>(connEnd).fill('')), relations = (C.relation = new Array<string>(connEnd).fill(''));
  const tags = (C.tags = new Array<readonly TagValue[]>(connEnd).fill(EMPTY_TAGS));
  /** Sparse (row, value) pairs of section `name`, each row a held one. */
  const pairs = (name: Section, set: (r: number, v: number) => void) => {
    const a = i32(name);
    if (a.length % 2 !== 0) throw corrupt(name);
    for (let k = 0; k < a.length; k += 2) {
      const r = a[k];
      if (!(r >= 0 && r < connEnd) || connFree[r] !== 0) throw corrupt(name);
      set(r, a[k + 1]);
    }
  };
  pairs('connTitles', (r, v) => { titles[r] = str(v); });
  pairs('connRelations', (r, v) => { relations[r] = str(v); });
  pairs('connTags', (r, v) => { tags[r] = tagList(v); });
  for (const [r, title, relation] of json.connTexts) {
    if (!(r >= 0 && r < connEnd)) throw corrupt('textes de connexion');
    titles[r] = title as string;
    relations[r] = relation as string;
  }
  const memberData = i32('members'), memberLen = i32('memberLen', connEnd);
  restorePool(C.members, memberLen, memberData, 1);
  for (let k = 0; k < memberData.length; k++) {
    const m = memberData[k], n = m >> 2;
    if ((m & 3) === 3 || !(n >= 0 && n < nodeEnd) || nodeFree[n] !== 0) throw corrupt('membre');
  }
  const branchData = i32('branches'), branchLen = i32('branchLen', connEnd);
  restorePool(C.branches, branchLen, branchData, 2);
  for (let k = 0; k < branchData.length; k += 2) {
    const p = branchData[k], n = branchData[k + 1];
    if (!(p >= 0 && p < planEnd) || planFree[p] !== 0 || !(n >= 0 && n < nodeEnd) || nodeFree[n] !== 0) throw corrupt('branche');
  }
  for (let r = 0; r < connEnd; r++) if ((kind[r] === none && memberLen[r] > 0) || (connFree[r] !== 0 && branchLen[r] > 0)) throw corrupt('connexion');
  C.branchCount = branchData.length / 2;

  // Phantoms, layouts, tag keys.
  const phantoms = i32('phantoms', PHANTOM_STRIDE * counts.phantoms), phantomXyk = f64('phantomXyk', 3 * counts.phantoms);
  for (let k = 0; k < counts.phantoms; k++) {
    const o = PHANTOM_STRIDE * k;
    let rec: PhantomRec;
    if (phantoms[o] >= 0) {
      rec = {
        id: str(phantoms[o]), plan: str(phantoms[o + 1]), connection: str(phantoms[o + 2]),
        of: { kind: str(phantoms[o + 3]), node: str(phantoms[o + 4]) } as PhantomRec['of'], x: phantomXyk[3 * k], y: phantomXyk[3 * k + 1], k: phantomXyk[3 * k + 2],
      };
      if (phantoms[o + 5] >= 0) rec.group = str(phantoms[o + 5]);
    } else {
      rec = JSON.parse(str(-1 - phantoms[o])) as PhantomRec;
      if (!isObject(rec) || typeof rec.id !== 'string') throw corrupt('fantôme');
    }
    T.phantoms.set(rec.id, rec);
  }
  if (T.phantoms.size !== counts.phantoms) throw corrupt('fantôme en double');
  for (const [plan, connection, rest] of json.layouts) {
    if (!isObject(rest)) throw corrupt('disposition');
    const l = { plan: str(plan), connection: str(connection), ...rest } as ConnectionLayout;
    T.layouts.set(layoutKey(l.plan, l.connection), l);
  }
  for (const t of json.tagKeys) {
    if (!isObject(t) || typeof t.key !== 'string') throw corrupt('clé de tag');
    T.tagKeys.set(t.key, t);
  }
  if (json.preamble !== undefined) {
    if (!isObject(json.preamble) || typeof json.preamble.text !== 'string') throw corrupt('préambule');
    T.preamble = json.preamble;
  }
  if (N.count !== counts.nodes || P.count !== counts.plans || C.count !== counts.connections || C.branchCount !== counts.branches) throw corrupt('comptes');

  // The indices kept: memberOf (connection rows with a record, per node row), placedIn (plan rows), groupOf. Each is
  // checked against the tables it derives from by what can be counted cheaply (R17): a wrong one, carried over from a
  // session, sends the load back to the tables, which rebuild it.
  const I = dataOf(s).index;
  const memberOfData = i32('memberOf'), memberOfLen = i32('memberOfLen', nodeEnd);
  restorePool(I.memberOf, memberOfLen, memberOfData, 1);
  for (let k = 0; k < memberOfData.length; k++) {
    const c = memberOfData[k];
    if (!(c >= 0 && c < connEnd) || kind[c] === none) throw corrupt('index memberOf');
  }
  // memberOf has one entry per member, unless a connection lists a node twice (rare): then the members are counted as
  // memberOf counts them, each node once per connection.
  if (memberOfData.length > memberData.length || (memberOfData.length < memberData.length && memberOfData.length !== distinctMembers(memberData, memberLen))) {
    throw corrupt('index memberOf, autant d’entrées que de membres');
  }
  const placedInData = i32('placedIn'), placedInLen = i32('placedInLen', nodeEnd);
  restorePool(I.placedIn, placedInLen, placedInData, 1);
  for (let k = 0; k < placedInData.length; k++) {
    const p = placedInData[k];
    if (!(p >= 0 && p < planEnd) || planFree[p] !== 0) throw corrupt('index placedIn');
  }
  const placedCount = new Int32Array(nodeEnd);
  for (let i = 0; i < placeNode.length; i++) placedCount[placeNode[i]]++;
  for (let r = 0; r < nodeEnd; r++) {
    if (nodeFree[r] !== 0 && (memberOfLen[r] > 0 || placedInLen[r] > 0)) throw corrupt('index d’une rangée libre');
    if (placedInLen[r] !== placedCount[r]) throw corrupt('index placedIn, autant d’entrées que de placements');
  }
  const groupLen = i32('groupLen', planEnd), groups = i32('groups');
  let at = 0;
  for (let p = 0; p < planEnd; p++) {
    const n = groupLen[p];
    if (n < 0) { I.groupOf.push(undefined); continue; }
    if (planFree[p] !== 0 || at + n > groups.length) throw corrupt('groupes');
    const group = groups.subarray(at, at + n);
    at += n;
    for (let k = 0; k < n; k++) { const g = group[k]; if (g !== -1 && (!(g >= 0 && g < nodeEnd) || nodeFree[g] !== 0)) throw corrupt('groupes'); }
    I.groupOf.push({ group, multi: new Map() });
  }
  if (at !== groups.length) throw corrupt('groupes');
  for (const [p, n, gs] of json.multi) {
    const pg = I.groupOf[p];
    if (pg === undefined || !(n >= 0 && n < nodeEnd) || !Array.isArray(gs)) throw corrupt('groupes multiples');
    pg.multi.set(n, gs);
  }
  checkGroups(I.groupOf, C, inclusions, memberData, branchData, nodeEnd);
  reindexRest(s);
  return s;
}

/** The members of each connection counted as memberOf counts them: each node once per connection. */
function distinctMembers(md: Int32Array, len: Int32Array): number {
  let distinct = 0;
  for (let c = 0, k = 0; c < len.length; c++) {
    const n = len[c];
    if (n === 2) distinct += md[k] >> 2 === md[k + 1] >> 2 ? 1 : 2;
    else {
      for (let i = k, end = k + n; i < end; i++) {
        const node = md[i] >> 2;
        let j = k;
        while (j < i && md[j] >> 2 !== node) j++;
        if (j === i) distinct++;
      }
    }
    k += n;
  }
  return distinct;
}

/**
 * groupOf against the inclusions it derives from (R17), in one pass over them: each (plan, node) that an inclusion not
 * in the trash groups (first source in first target, both branches shown) has that group, or holds it among its
 * several (multi), and no other (plan, node) has a group.
 */
function checkGroups(groupOf: Indices['groupOf'], C: ConnTable, inclusions: number[], md: Int32Array, bd: Int32Array, nodeEnd: number): void {
  const source = SOURCE, target = TARGET, ms = C.members.start, ml = C.members.len, bs = C.branches.start, bl = C.branches.len;
  const trashed = C.trashedAt, seen: (Uint8Array | undefined)[] = [];
  let entries = 0, pairs = 0;
  for (const pg of groupOf) if (pg) for (let k = 0; k < pg.group.length; k++) if (pg.group[k] >= 0) entries++;
  for (const c of inclusions) {
    if (!Number.isNaN(trashed[c]) || bl[c] === 0) continue;
    let m = -1, g = -1;
    for (let i = ms[c], end = i + ml[c]; i < end; i++) {
      const role = md[i] & 3;
      if (role === source && m < 0) m = md[i] >> 2;
      else if (role === target && g < 0) g = md[i] >> 2;
    }
    if (m < 0 || g < 0) continue;
    const b0 = bs[c], b1 = b0 + bl[c];
    for (let i = b0; i < b1; i += 2) {
      if (bd[i + 1] !== m) continue;
      const p = bd[i];
      let shown = false;
      for (let j = b0; j < b1 && !shown; j += 2) shown = bd[j] === p && bd[j + 1] === g;
      if (!shown) continue;
      const pg = groupOf[p], has = pg !== undefined && m < pg.group.length ? pg.group[m] : -1;
      if (has < 0 || (has !== g && !pg!.multi.get(m)?.includes(g))) throw corrupt('index groupOf');
      const marks = (seen[p] ??= new Uint8Array(nodeEnd));
      if (marks[m] === 0) { marks[m] = 1; pairs++; }
    }
  }
  if (pairs !== entries) throw corrupt('index groupOf, autant de groupes que d’inclusions');
}

/**
 * Rows of a table from their identifiers (strings [base, base + end)), reference counts (a view) and free list; returns
 * which rows are free. A free row has no identifier and no reference, a held one some reference; the identifier map is
 * left to be built when first needed.
 */
function restoreRows(rows: Rows, strs: string[], base: number, end: number, refs: Int32Array, free: Int32Array): Uint8Array {
  const isFree = new Uint8Array(end);
  for (let k = 0; k < free.length; k++) {
    const r = free[k];
    if (!(r >= 0 && r < end) || isFree[r] !== 0) throw corrupt('liste libre');
    isFree[r] = 1;
    rows.free.push(r);
  }
  const ids = (rows.ids = strs.slice(base, base + end));
  for (let r = 0; r < end; r++) if (isFree[r] !== 0 ? ids[r] !== '' || refs[r] !== 0 : !(refs[r] > 0)) throw corrupt('rangée');
  rows.refs = refs;
  rows.end = end;
  rows.restored();
  return isFree;
}

/** A pool from its lists' lengths (a view) and their entries packed in owner order (a view): no waste, each list its size. */
function restorePool(pool: Pool, len: Int32Array, data: Int32Array, stride: number): void {
  const start = new Int32Array(len.length);
  let top = 0;
  for (let o = 0; o < len.length; o++) {
    const n = len[o];
    if (n < 0 || n % stride !== 0) throw corrupt('pool');
    start[o] = top;
    top += n;
  }
  if (top !== data.length) throw corrupt('pool');
  pool.start = start;
  pool.len = len;
  pool.cap = len.slice();
  pool.data = data;
  pool.top = top;
  pool.waste = 0;
}
