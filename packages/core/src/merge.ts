import type { ConnectionRec, FileRef, Id, Member, NodeRec, PhantomRec, Placement, PlanRec, TagKeyDef, TagValue } from './model.ts';
import type { Op } from './ops.ts';
import { canonical, layoutKey, placementOf, type State } from './state.ts';
import type { RemoteUnit, Unit } from './sync.ts';

// The merge of a pending write with what the server made meanwhile (plan 5a, D4; spec 6.2): record by record, field by
// field, between the write's "before" (base), the record as the state holds it now (theirs) and the write's "after"
// (mine). It reads the records the write touches and the received changes, never the rest of the base.

/** What two file names are compared by (the reimport's rule, plan 4a): Unicode NFC, then the case, the French way. */
export const fileNameKey = (name: string): string => name.normalize('NFC').toLocaleLowerCase('fr');

/** When a change was made, and by which PC. */
export interface Stamp { at: number; pc: string }
/**
 * The more recent change wins; at the same time, the greater PC identifier. A change with no stamp never wins. The
 * shared settings (task 6, R23) are decided by the same order, at the server and at each PC.
 */
export const newer = (a: Stamp | undefined, b: Stamp): boolean => a !== undefined && (a.at > b.at || (a.at === b.at && a.pc > b.pc));
const same = (a: unknown, b: unknown): boolean => a === b || canonical(a ?? null) === canonical(b ?? null);
/** A node or a connection in the trash, or absent. */
const deleted = (r: unknown): boolean => r === null || r === undefined || (r as { trashedAt?: number }).trashedAt !== undefined;

const SEP = '\u0000';
/** The record an operation writes, as a key: what a write's operations are grouped by (and a reconciliation's `gone`). */
export function recordKey(op: Op): string {
  switch (op.t) {
    case 'node':
    case 'connection':
    case 'plan':
    case 'phantom':
      return `${op.t}${SEP}${(op.after ?? op.before)!.id}`;
    case 'tagKey':
      return `tagKey${SEP}${(op.after ?? op.before)!.key}`;
    case 'placement': {
      const p = (op.after ?? op.before)!;
      return `placement${SEP}${p.plan}${SEP}${p.node}`;
    }
    case 'connLayout': {
      const l = (op.after ?? op.before)!;
      return `connLayout${SEP}${l.plan}${SEP}${l.connection}`;
    }
    case 'branch':
      return `branch${SEP}${op.key.plan}${SEP}${op.key.connection}${SEP}${op.key.node}`;
    case 'preamble':
      return 'preamble';
  }
}

/** The record an operation writes, as the state holds it now (a branch: its presence). */
function current(s: State, op: Op): unknown {
  switch (op.t) {
    case 'node': return s.nodes.get((op.after ?? op.before)!.id) ?? null;
    case 'connection': return s.connections.get((op.after ?? op.before)!.id) ?? null;
    case 'plan': return s.plans.get((op.after ?? op.before)!.id) ?? null;
    case 'tagKey': return s.tagKeys.get((op.after ?? op.before)!.key) ?? null;
    case 'placement': {
      const p = (op.after ?? op.before)!;
      return placementOf(s, p.plan, p.node) ?? null;
    }
    case 'branch': return s.branches.has(op.key);
    case 'connLayout': {
      const l = (op.after ?? op.before)!;
      return s.connLayouts.get(layoutKey(l.plan, l.connection)) ?? null;
    }
    case 'phantom': return s.phantoms.get((op.after ?? op.before)!.id) ?? null;
    case 'preamble': return s.preamble;
  }
}

/**
 * A record's fields as the merge sees them, each as its canonical text: a node's or a connection's own fields, each tag
 * key's values, each file by name (fileNameKey), each member's role by node; a plan's name and type; any other record is
 * one field (''). What a received change is stamped on.
 */
function fieldTexts(t: Op['t'], rec: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (rec === null || rec === undefined) return out;
  const put = (f: string, v: unknown) => { if (v !== undefined && !out.has(f)) out.set(f, canonical(v)); };
  const byKey = (tags: readonly TagValue[]) => {
    const values = new Map<string, unknown[]>();
    for (const x of tags) values.set(x.key, [...(values.get(x.key) ?? []), x.value ?? null]);
    for (const [k, v] of values) put(`tag:${k}`, v);
  };
  if (t === 'node') {
    const n = rec as NodeRec;
    put('title', n.title); put('summary', n.summary); put('trashedAt', n.trashedAt); put('anchor', n.anchor);
    byKey(n.tags);
    for (const f of n.files) put(`file:${fileNameKey(f.name)}`, f);
  } else if (t === 'connection') {
    const c = rec as ConnectionRec;
    put('kind', c.kind); put('title', c.title); put('relation', c.relation); put('trashedAt', c.trashedAt);
    byKey(c.tags);
    for (const m of c.members) put(`member:${m.node}`, m.role);
  } else if (t === 'plan') {
    const p = rec as PlanRec;
    put('name', p.name); put('type', p.type);
  } else put('', rec);
  return out;
}

/**
 * What the received writes did, read once per reconciliation (cached by their array): per record and per field, the
 * stamp of the last received write that changed it; per node or connection, the last received write that deleted it
 * (to the trash, or away).
 */
interface Received { stamps: Map<string, Map<string, Stamp>>; deletedBy: Map<Id, RemoteUnit> }
const received = new WeakMap<readonly RemoteUnit[], Received>();

function receivedOf(remote: readonly RemoteUnit[]): Received {
  let r = received.get(remote);
  if (r) return r;
  r = { stamps: new Map(), deletedBy: new Map() };
  for (const u of remote) {
    const stamp: Stamp = { at: u.at, pc: u.pc };
    for (const op of u.ops) {
      if (op.t === 'branch') continue;
      const key = recordKey(op), before = fieldTexts(op.t, op.before), after = fieldTexts(op.t, op.after);
      let fields = r.stamps.get(key);
      for (const f of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(f) === after.get(f)) continue;
        if (!fields) r.stamps.set(key, (fields = new Map()));
        fields.set(f, stamp);
      }
      if ((op.t === 'node' || op.t === 'connection') && !deleted(op.before) && deleted(op.after)) r.deletedBy.set(op.before!.id, u);
    }
  }
  received.set(remote, r);
  return r;
}

/** One record a write touches: its first operation (identity), the only one when there is one; base, theirs, mine, merged. */
interface Entry { op: Op; only: Op | null; base: unknown; mine: unknown; theirs: unknown; merged: unknown }

/** What a record's merge reads: its fields' stamps, the write's own, the registry, the objects whose deletion is undone. */
interface Ctx {
  stamps: Map<string, Stamp> | undefined;
  mine: Stamp;
  defs: ReadonlyMap<string, TagKeyDef>;
  /** Thrown away by the write, but changed meanwhile elsewhere: the write loses their deletion (D4). */
  kept: Set<Id>;
  /** Thrown away elsewhere, but changed by the write: they come back (D4). */
  back: Set<Id>;
  /** The .tex conflict copies made, by name. */
  copies: string[];
}

/** The field rule (D4): changed on one side, that side's value; on both, the more recent change's. */
function pick<T>(b: T, t: T, m: T, field: string, c: Ctx): T {
  if (same(m, b)) return t;
  if (same(t, b)) return m;
  if (same(t, m)) return t;
  return newer(c.stamps?.get(field), c.mine) ? t : m;
}

/** A record that is one field (placement, phantom, layout, registry key, preamble, D4): deleted on one side, changed on the other, the change wins. */
function whole(b: unknown, t: unknown, m: unknown, c: Ctx): unknown {
  if (same(m, b)) return t;
  if (same(t, b)) return m;
  if (same(t, m)) return t;
  if (t === null) return m;
  if (m === null) return t;
  return newer(c.stamps?.get(''), c.mine) ? t : m;
}

/**
 * Tags (D4): a key the registry declares single-valued (not a word) is one field; every other tag (a word, a value of a
 * multiple key or of a key outside the registry, such as `auteur`) is an element of a set, where the additions and the
 * removals of both sides count. In theirs' order, then what only mine has, in mine's order.
 */
function mergeTags(b: readonly TagValue[], t: readonly TagValue[], m: readonly TagValue[], c: Ctx): TagValue[] {
  const single = (key: string) => { const d = c.defs.get(key); return d !== undefined && !d.multi && d.type !== 'word'; };
  const element = (x: TagValue) => JSON.stringify(x.value === undefined ? [x.key] : [x.key, x.value]);
  const inBase = new Set(b.filter((x) => !single(x.key)).map(element)), inMine = new Set(m.filter((x) => !single(x.key)).map(element));
  const valueIn = (tags: readonly TagValue[], key: string) => tags.find((x) => x.key === key);
  const out: TagValue[] = [], done = new Set<string>();
  const emit = (x: TagValue, fromMine: boolean) => {
    if (single(x.key)) {
      if (done.has(`key:${x.key}`)) return;
      done.add(`key:${x.key}`);
      const v = pick(valueIn(b, x.key), valueIn(t, x.key), valueIn(m, x.key), `tag:${x.key}`, c);
      if (v) out.push(v);
      return;
    }
    const e = element(x);
    if (done.has(e)) return;
    // Theirs, unless mine removed it; mine, only what it added.
    if (fromMine ? inBase.has(e) : inBase.has(e) && !inMine.has(e)) return;
    done.add(e);
    out.push(x);
  };
  for (const x of t) emit(x, false);
  for (const x of m) emit(x, true);
  return out;
}

/** « a.tex » with « x » before its extension: « a x.tex »; a name whose only dot leads it (« .env ») has none. */
function beforeExtension(name: string, x: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? `${name} ${x}` : `${name.slice(0, dot)} ${x}${name.slice(dot)}`;
}

/**
 * The name of a .tex conflict copy (D4, R4): « nom (conflit du AAAA-MM-JJ HHhMM).tex », from the losing write's time
 * in this PC's local time; « (2) », « (3) »… after it when a file of the node already has that name (`taken`, by
 * fileNameKey), as on reimport. A full screen's save keeps the version from elsewhere under it too (plan 5b, D6).
 */
export function conflictName(name: string, at: number, taken: ReadonlySet<string>): string {
  const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
  const copy = beforeExtension(name, `(conflit du ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())})`);
  if (!taken.has(fileNameKey(copy))) return copy;
  for (let n = 2; ; n++) {
    const again = beforeExtension(copy, `(${n})`);
    if (!taken.has(fileNameKey(again))) return again;
  }
}

/** Whether `name` is a conflict copy's of the file named `key` (fileNameKey): « nom (conflit du AAAA-MM-JJ HHhMM).tex », maybe « (n) » after. */
export function isCopyOf(name: string, key: string): boolean {
  const k = fileNameKey(name), dot = key.lastIndexOf('.'), head = `${key.slice(0, dot)} (conflit du `, ext = key.slice(dot);
  return k.startsWith(head) && k.endsWith(ext) && /^\d{4}-\d{2}-\d{2} \d{2}h\d{2}\)( \(\d+\))?$/.test(k.slice(head.length, k.length - ext.length));
}

/**
 * Files (D4): by name (fileNameKey). Deleted on one side and changed on the other, the change wins. Changed on both: the
 * more recent wins; for a .tex with two contents both stay, the other one renamed as a conflict copy. In theirs' order,
 * then what only mine has, then the copies.
 *
 * One copy per conflict, holding the losing side's last version: a copy of the .tex's base version is the same
 * conflict's earlier round — in theirs, my version that lost at an earlier write of this replay (or another PC's
 * replay); in mine, their version that lost at an earlier replay of this write — and the new copy replaces it.
 */
function mergeFiles(b: readonly FileRef[], t: readonly FileRef[], m: readonly FileRef[], c: Ctx): FileRef[] {
  const byName = (files: readonly FileRef[]) => {
    const map = new Map<string, FileRef>();
    for (const f of files) { const k = fileNameKey(f.name); if (!map.has(k)) map.set(k, f); }
    return map;
  };
  const B = byName(b), T = byName(t), M = byName(m);
  // The .tex changed on both sides into two contents: the loser's version, and the earlier rounds' copies it replaces.
  const losers: { file: FileRef; at: number }[] = [], replaced = new Set<string>();
  for (const [k, mf] of M) {
    // Changed on both sides, or added on both, into two contents.
    const bf = B.get(k), tf = T.get(k);
    if (!k.endsWith('.tex') || !tf || tf.hash === mf.hash || (bf && (same(mf, bf) || same(tf, bf)))) continue;
    const stamp = c.stamps?.get(`file:${k}`), theirs = newer(stamp, c.mine);
    losers.push(theirs ? { file: mf, at: c.mine.at } : { file: tf, at: stamp?.at ?? c.mine.at });
    if (bf) for (const [x, f] of [...T, ...M]) if (!B.has(x) && f.hash === bf.hash && isCopyOf(f.name, k)) replaced.add(x);
  }
  const out: FileRef[] = [], done = new Set<string>(replaced);
  const emit = (k: string) => {
    if (done.has(k)) return;
    done.add(k);
    const bf = B.get(k), tf = T.get(k), mf = M.get(k);
    let f: FileRef | undefined;
    if (same(mf, bf)) f = tf;
    else if (same(tf, bf)) f = mf;
    else if (same(tf, mf) || !mf) f = tf;
    else if (!tf) f = mf;
    else f = newer(c.stamps?.get(`file:${k}`), c.mine) ? tf : mf;
    if (f) out.push(f);
  };
  for (const f of t) emit(fileNameKey(f.name));
  for (const f of m) emit(fileNameKey(f.name));
  const taken = new Set(out.map((f) => fileNameKey(f.name)));
  for (const { file, at } of losers) {
    const name = conflictName(file.name, at, taken);
    taken.add(fileNameKey(name));
    out.push({ ...file, name });
    c.copies.push(name);
  }
  return out;
}

/**
 * A connection's members (D4): by node, each one's role a field; deleted on one side and changed on the other, the
 * change wins; a member the write removed but whose node it may not throw away (kept) stays. In theirs' order, then what
 * only mine has.
 */
function mergeMembers(b: readonly Member[], t: readonly Member[], m: readonly Member[], c: Ctx): Member[] {
  const byNode = (members: readonly Member[]) => new Map(members.map((x) => [x.node, x]));
  const B = byNode(b), T = byNode(t), M = byNode(m);
  const out: Member[] = [], done = new Set<Id>();
  const emit = (node: Id) => {
    if (done.has(node)) return;
    done.add(node);
    const bm = B.get(node), tm = T.get(node), mm = M.get(node);
    let r: Member | undefined;
    if (bm && !mm && c.kept.has(node)) r = tm;
    else if (same(mm, bm)) r = tm;
    else if (same(tm, bm)) r = mm;
    else if (same(tm, mm) || !mm) r = tm;
    else if (!tm) r = mm;
    else r = newer(c.stamps?.get(`member:${node}`), c.mine) ? tm : mm;
    if (r) out.push(r);
  };
  for (const x of t) emit(x.node);
  for (const x of m) emit(x.node);
  return out;
}

function mergeNode(b: NodeRec, t: NodeRec, m: NodeRec, c: Ctx): NodeRec {
  const out: NodeRec = {
    id: m.id, title: pick(b.title, t.title, m.title, 'title', c), summary: pick(b.summary, t.summary, m.summary, 'summary', c),
    tags: mergeTags(b.tags, t.tags, m.tags, c), files: mergeFiles(b.files, t.files, m.files, c),
  };
  const trashedAt = pick(b.trashedAt, t.trashedAt, m.trashedAt, 'trashedAt', c), anchor = pick(b.anchor, t.anchor, m.anchor, 'anchor', c);
  if (trashedAt !== undefined) out.trashedAt = trashedAt;
  if (anchor !== undefined) out.anchor = anchor;
  return out;
}

function mergeConnection(b: ConnectionRec, t: ConnectionRec, m: ConnectionRec, c: Ctx): ConnectionRec {
  const out: ConnectionRec = {
    id: m.id, kind: pick(b.kind, t.kind, m.kind, 'kind', c), title: pick(b.title, t.title, m.title, 'title', c),
    relation: pick(b.relation, t.relation, m.relation, 'relation', c), tags: mergeTags(b.tags, t.tags, m.tags, c), members: mergeMembers(b.members, t.members, m.members, c),
  };
  const trashedAt = pick(b.trashedAt, t.trashedAt, m.trashedAt, 'trashedAt', c);
  if (trashedAt !== undefined) out.trashedAt = trashedAt;
  return out;
}

/**
 * A node or a connection: field by field; deleted (to the trash, or away) on one side and changed on the other, the
 * change wins — what comes back leaves the trash (back), what the write threw away stays as theirs (kept).
 */
function mergeObject(t: 'node' | 'connection', e: Entry, id: Id, c: Ctx): unknown {
  const base = e.base as NodeRec | ConnectionRec | null, theirs = e.theirs as NodeRec | ConnectionRec | null, mine = e.mine as NodeRec | ConnectionRec | null;
  if (base === null) return mine ?? theirs;
  if (mine === null) return same(theirs, base) ? null : theirs;
  // Deleted there, changed here: it comes back, as mine made it; deleted on both sides, it stays deleted.
  if (theirs === null) return same(mine, base) || (deleted(mine) && !deleted(base)) ? null : c.back.has(id) ? withoutTrash(mine) : mine;
  const merged = t === 'node' ? mergeNode(base as NodeRec, theirs as NodeRec, mine as NodeRec, c) : mergeConnection(base as ConnectionRec, theirs as ConnectionRec, mine as ConnectionRec, c);
  if (c.back.has(id)) return withoutTrash(merged);
  if (c.kept.has(id)) return theirs.trashedAt === undefined ? withoutTrash(merged) : { ...merged, trashedAt: theirs.trashedAt };
  return merged;
}

function withoutTrash<T extends { trashedAt?: number }>(r: T): T {
  if (r.trashedAt === undefined) return r;
  const { trashedAt: _trashed, ...rest } = r;
  return rest as T;
}

/**
 * A pending write replayed on the state as it is now (D4): `u`'s operations grouped by record (its first "before", its
 * last "after"), each record merged with the state's, and written from the state's — the write as it would be made now.
 * `remote`: the received writes applied since `u` was made or last replayed (their times decide the conflicts, and they
 * name what a deletion took). The write itself when nothing changed; null when it no longer changes anything. Records
 * the write deletes but that were changed elsewhere lose that deletion, with their placements, branches, memberships
 * and phantoms; records it changes but that were deleted elsewhere come back, with the placements and branches that
 * deletion took, where their plan, connection and membership still stand. `s` is read, never written.
 *
 * `gone` (final review of plan 5a, Minor 1): the records that a pending write dropped before this one had created
 * (recordKey). One this write found (its "before") but that is absent now is not written again: the dropped write's
 * record would otherwise come back through this one, a creation the notification said was dropped. `lost`: those.
 */
export function rebaseUnit(s: State, u: Unit, remote: readonly RemoteUnit[], gone?: { has(key: string): boolean; readonly size: number }): { unit: Unit | null; conflictCopies: string[]; lost: string[] } {
  const rx = receivedOf(remote);
  const entries = new Map<string, Entry>();
  for (const op of u.ops) {
    const key = recordKey(op), e = entries.get(key);
    if (e) {
      e.mine = op.after;
      e.only = null;
    } else entries.set(key, { op, only: op, base: op.before, mine: op.after, theirs: null, merged: null });
  }
  for (const e of entries.values()) e.theirs = current(s, e.op);
  const lost: string[] = [];
  if (gone && gone.size > 0) {
    const absent = (r: unknown) => r === null || r === false;
    for (const [key, e] of entries) {
      if (!gone.has(key) || absent(e.base) || !absent(e.theirs)) continue;
      entries.delete(key);
      lost.push(key);
    }
  }
  const c: Ctx = { stamps: undefined, mine: { at: u.at, pc: u.pc }, defs: s.tagKeys, kept: new Set(), back: new Set(), copies: [] };
  const entryOf = (t: string, ...key: string[]) => entries.get([t, ...key].join(SEP));

  // Deleted on one side, changed on the other: the objects the write may not throw away (kept), those it brings back.
  for (const e of entries.values()) {
    if ((e.op.t !== 'node' && e.op.t !== 'connection') || deleted(e.base)) continue;
    const id = (e.op.after ?? e.op.before)!.id;
    if (deleted(e.mine) && !deleted(e.theirs) && !same(e.theirs, e.base)) c.kept.add(id);
    else if (deleted(e.theirs) && !deleted(e.mine) && !same(e.mine, e.base)) c.back.add(id);
  }
  // A node's placements change it too: moved there while thrown away here, kept; placed or moved here while thrown away
  // there, back (its record written by this write, when it does not touch it).
  const revive: NodeRec[] = [];
  for (const e of entries.values()) {
    if (e.op.t !== 'placement') continue;
    const node = (e.op.after ?? e.op.before)!.node, n = entryOf('node', node);
    if (e.mine === null && e.base !== null && e.theirs !== null && !same(e.theirs, e.base) && n && !deleted(n.base) && deleted(n.mine) && !deleted(n.theirs)) c.kept.add(node);
    if (e.mine !== null && !same(e.mine, e.base) && (!n || same(n.mine, n.base)) && !c.back.has(node)) {
      const rec = s.nodes.get(node);
      if (rec?.trashedAt === undefined || !rx.deletedBy.has(node)) continue;
      c.back.add(node);
      if (!n) revive.push(rec);
    }
  }
  // A connection the write threw away because it removed a node it may not throw away: kept too.
  for (const e of entries.values()) {
    if (e.op.t !== 'connection' || deleted(e.base) || !deleted(e.mine)) continue;
    const mine = e.mine as ConnectionRec | null;
    if ((e.base as ConnectionRec).members.some((m) => c.kept.has(m.node) && !mine?.members.some((x) => x.node === m.node))) c.kept.add((e.base as ConnectionRec).id);
  }

  for (const [key, e] of entries) {
    c.stamps = rx.stamps.get(key);
    const op = e.op;
    switch (op.t) {
      case 'node':
      case 'connection':
        e.merged = mergeObject(op.t, e, (op.after ?? op.before)!.id, c);
        break;
      case 'branch':
        e.merged = e.base === true && e.mine === false && (c.kept.has(op.key.node) || c.kept.has(op.key.connection)) ? e.theirs : e.mine !== e.base ? e.mine : e.theirs;
        break;
      case 'placement':
        e.merged = e.mine === null && e.base !== null && c.kept.has((e.base as Placement).node) ? e.theirs : whole(e.base, e.theirs, e.mine, c);
        break;
      case 'phantom': {
        const p = e.base as PhantomRec | null;
        e.merged = e.mine === null && p !== null && (c.kept.has(p.connection) || c.kept.has(p.of.node)) ? e.theirs : whole(e.base, e.theirs, e.mine, c);
        break;
      }
      case 'plan': {
        const b = e.base as PlanRec | null, t = e.theirs as PlanRec | null, m = e.mine as PlanRec | null;
        e.merged = b && t && m ? { id: m.id, name: pick(b.name, t.name, m.name, 'name', c), type: pick(b.type, t.type, m.type, 'type', c) } : whole(b, t, m, c);
        break;
      }
      default:
        e.merged = whole(e.base, e.theirs, e.mine, c);
    }
  }

  // What comes back takes back the placements and branches its deletion took (that write's), where they still make sense.
  const extra: Op[] = [], extraKeys = new Set<string>();
  for (const rec of revive) extra.push({ t: 'node', before: rec, after: withoutTrash(rec) });
  const connectionAfter = (id: Id): ConnectionRec | null => {
    const e = entryOf('connection', id);
    return e ? (e.merged as ConnectionRec | null) : s.connections.get(id) ?? null;
  };
  for (const id of c.back) {
    for (const op of rx.deletedBy.get(id)?.ops ?? []) {
      if (op.t !== 'placement' && op.t !== 'branch') continue;
      const key = recordKey(op);
      if (entries.has(key) || extraKeys.has(key)) continue;
      if (op.t === 'placement') {
        const p = op.before;
        if (!p || op.after || p.node !== id || !s.plans.has(p.plan) || placementOf(s, p.plan, p.node)) continue;
        extra.push({ t: 'placement', before: null, after: p });
      } else {
        const k = op.key, conn = connectionAfter(k.connection);
        if (!op.before || op.after || !s.plans.has(k.plan) || s.branches.has(k) || !conn || conn.trashedAt !== undefined) continue;
        if (!conn.members.some((m) => m.node === k.node) || (k.connection !== id && !conn.members.some((m) => m.node === id))) continue;
        extra.push({ t: 'branch', key: k, before: false, after: true });
      }
      extraKeys.add(key);
    }
  }

  // Each record written from the state's; the write's own operation when it is still exactly that.
  const ops: Op[] = [];
  let reused = 0;
  for (const e of entries.values()) {
    if (same(e.merged, e.theirs)) continue;
    if (e.only && same(e.only.before, e.theirs) && same(e.only.after, e.merged)) {
      ops.push(e.only);
      reused++;
    } else ops.push(e.op.t === 'branch' ? { t: 'branch', key: e.op.key, before: e.theirs as boolean, after: e.merged as boolean } : ({ t: e.op.t, before: e.theirs, after: e.merged } as Op));
  }
  ops.push(...extra);
  if (ops.length === 0) return { unit: null, conflictCopies: c.copies, lost };
  if (reused === u.ops.length && ops.length === reused) return { unit: u, conflictCopies: c.copies, lost };
  return { unit: { ...u, ops }, conflictCopies: c.copies, lost };
}
