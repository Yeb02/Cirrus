import { validAnchor } from './annotation.ts';
import type { BranchRec, ConnectionLayout, ConnectionRec, Id, NodeRec, PhantomRec, Placement, PlanRec, PreambleRec, TagKeyDef } from './model.ts';

/**
 * Every change is a record-level operation carrying the record before and after (null = absent).
 * Inverting swaps the two; applying checks that "before" matches the current state.
 */
export type Op =
  | { t: 'node'; before: NodeRec | null; after: NodeRec | null }
  | { t: 'connection'; before: ConnectionRec | null; after: ConnectionRec | null }
  | { t: 'plan'; before: PlanRec | null; after: PlanRec | null }
  | { t: 'tagKey'; before: TagKeyDef | null; after: TagKeyDef | null }
  | { t: 'placement'; before: Placement | null; after: Placement | null }
  | { t: 'branch'; key: BranchRec; before: boolean; after: boolean }
  | { t: 'connLayout'; before: ConnectionLayout | null; after: ConnectionLayout | null }
  | { t: 'phantom'; before: PhantomRec | null; after: PhantomRec | null }
  /** The base's single preamble record (null: never set, DEFAULT_PREAMBLE applies). */
  | { t: 'preamble'; before: PreambleRec | null; after: PreambleRec | null };

/** The two synchronised flows of spec 6.1 (analytics come later). */
export type Flow = 'content' | 'layout';

export function flowOf(op: Op): Flow {
  return op.t === 'node' || op.t === 'connection' || op.t === 'plan' || op.t === 'tagKey' || op.t === 'preamble' ? 'content' : 'layout';
}

export function invertOp(op: Op): Op {
  return { ...op, before: op.after, after: op.before } as Op;
}

/** The object an operation is about, for per-object history (spec 6.3). */
export function subjectOf(op: Op): Id {
  switch (op.t) {
    case 'node':
    case 'connection':
    case 'plan':
    case 'phantom':
      return (op.after ?? op.before)!.id;
    case 'tagKey':
      return (op.after ?? op.before)!.key;
    case 'placement':
      return (op.after ?? op.before)!.node;
    case 'branch':
      return op.key.connection;
    case 'connLayout':
      return (op.after ?? op.before)!.connection;
    case 'preamble':
      return 'preamble';
  }
}

/** An operation or a write received from elsewhere (plan 5a) whose shape is wrong: why, in French. */
export class SyncFormatError extends Error {}

/** The longest identifier parseOp accepts: a record's, a tag key, a PC's (uuidv7 gives 36 characters). */
export const MAX_ID_CHARS = 128;

type Fields = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/;

const bad = (what: string): never => { throw new SyncFormatError(`Opération mal formée : ${what}.`); };
const object = (v: unknown, at: string): Fields => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : bad(`${at} n’est pas un objet`));
/** A plain object with exactly these fields, the optional ones aside; an undefined value counts as absent. */
function fields(v: unknown, at: string, required: readonly string[], optional: readonly string[] = []): Fields {
  const o = object(v, at);
  for (const k of required) if (o[k] === undefined) bad(`${at}.${k} manque`);
  for (const k in o) if (o[k] !== undefined && !required.includes(k) && !optional.includes(k)) bad(`${at}.${k} est inattendu`);
  return o;
}
const text = (v: unknown, at: string): string => (typeof v === 'string' ? v : bad(`${at} n’est pas une chaîne`));
const ident = (v: unknown, at: string): string => {
  const s = text(v, at);
  return s.length > 0 && s.length <= MAX_ID_CHARS ? s : bad(`${at} n’est pas un identifiant de 1 à ${MAX_ID_CHARS} caractères`);
};
const finite = (v: unknown, at: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : bad(`${at} n’est pas un nombre fini`));
const flag = (v: unknown, at: string): boolean => (typeof v === 'boolean' ? v : bad(`${at} n’est pas un booléen`));
const oneOf = <T extends string>(v: unknown, values: readonly T[], at: string): T => (values.includes(v as T) ? (v as T) : bad(`${at} ne peut pas valoir « ${String(v)} »`));
const list = (v: unknown, at: string, item: (x: unknown, at: string) => void): void => {
  if (!Array.isArray(v)) bad(`${at} n’est pas une liste`);
  (v as unknown[]).forEach((x, i) => item(x, `${at}[${i}]`));
};
const maybe = (o: Fields, k: string, check: (v: unknown, at: string) => unknown, at: string): void => { if (o[k] !== undefined) check(o[k], `${at}.${k}`); };
const scalar = (v: unknown, at: string): void => { if (typeof v !== 'string') finite(v, at); };
const vec2 = (v: unknown, at: string): void => { const o = fields(v, at, ['x', 'y']); finite(o.x, `${at}.x`); finite(o.y, `${at}.y`); };

function tags(v: unknown, at: string): void {
  list(v, at, (x, a) => { const t = fields(x, a, ['key'], ['value']); ident(t.key, `${a}.key`); maybe(t, 'value', scalar, a); });
}

function nodeRec(v: unknown, at: string): Fields {
  const n = fields(v, at, ['id', 'title', 'summary', 'tags', 'files'], ['trashedAt', 'anchor']);
  ident(n.id, `${at}.id`);
  text(n.title, `${at}.title`);
  text(n.summary, `${at}.summary`);
  tags(n.tags, `${at}.tags`);
  list(n.files, `${at}.files`, (x, a) => {
    const f = fields(x, a, ['name', 'hash', 'size']);
    if (text(f.name, `${a}.name`) === '') bad(`${a}.name est vide`);
    if (!HASH.test(text(f.hash, `${a}.hash`))) bad(`${a}.hash n’est pas une empreinte SHA-256`);
    if (!Number.isSafeInteger(f.size) || (f.size as number) < 0) bad(`${a}.size n’est pas une taille`);
  });
  maybe(n, 'trashedAt', finite, at);
  if (n.anchor !== undefined && !validAnchor(n.anchor)) bad(`${at}.anchor est hors de ses bornes`);
  return n;
}

function connectionRec(v: unknown, at: string): Fields {
  const c = fields(v, at, ['id', 'kind', 'title', 'relation', 'tags', 'members'], ['trashedAt']);
  ident(c.id, `${at}.id`);
  oneOf(c.kind, ['knowledge', 'inclusion', 'structure'], `${at}.kind`);
  text(c.title, `${at}.title`);
  text(c.relation, `${at}.relation`);
  tags(c.tags, `${at}.tags`);
  list(c.members, `${at}.members`, (x, a) => { const m = fields(x, a, ['node', 'role']); ident(m.node, `${a}.node`); oneOf(m.role, ['source', 'target', 'associate'], `${a}.role`); });
  maybe(c, 'trashedAt', finite, at);
  return c;
}

function planRec(v: unknown, at: string): Fields {
  const p = fields(v, at, ['id', 'name', 'type']);
  ident(p.id, `${at}.id`);
  text(p.name, `${at}.name`);
  oneOf(p.type, ['lobby', 'plan', 'document'], `${at}.type`);
  return p;
}

function tagKeyRec(v: unknown, at: string): Fields {
  const t = fields(v, at, ['key', 'type', 'scope', 'multi', 'required'], ['defaultValue', 'enumValues']);
  ident(t.key, `${at}.key`);
  oneOf(t.type, ['word', 'number', 'enum', 'date', 'text'], `${at}.type`);
  oneOf(t.scope, ['node', 'connection', 'both'], `${at}.scope`);
  flag(t.multi, `${at}.multi`);
  flag(t.required, `${at}.required`);
  maybe(t, 'defaultValue', scalar, at);
  if (t.enumValues !== undefined) list(t.enumValues, `${at}.enumValues`, (x, a) => { const e = fields(x, a, ['name', 'rank']); text(e.name, `${a}.name`); finite(e.rank, `${a}.rank`); });
  return t;
}

function placementRec(v: unknown, at: string): Fields {
  const p = fields(v, at, ['plan', 'node', 'x', 'y', 'k']);
  ident(p.plan, `${at}.plan`);
  ident(p.node, `${at}.node`);
  for (const k of ['x', 'y', 'k']) finite(p[k], `${at}.${k}`);
  return p;
}

function layoutRec(v: unknown, at: string): Fields {
  const l = fields(v, at, ['plan', 'connection', 'handles'], ['marker', 'angle']);
  ident(l.plan, `${at}.plan`);
  ident(l.connection, `${at}.connection`);
  const handles = object(l.handles, `${at}.handles`);
  for (const node in handles) {
    ident(node, `${at}.handles (nœud)`);
    const h = fields(handles[node], `${at}.handles.${node}`, ['b1', 'b2']);
    vec2(h.b1, `${at}.handles.${node}.b1`);
    vec2(h.b2, `${at}.handles.${node}.b2`);
  }
  maybe(l, 'marker', vec2, at);
  maybe(l, 'angle', finite, at);
  return l;
}

function phantomRec(v: unknown, at: string): Fields {
  const p = fields(v, at, ['id', 'plan', 'connection', 'of', 'x', 'y', 'k'], ['group']);
  for (const k of ['id', 'plan', 'connection']) ident(p[k], `${at}.${k}`);
  const of = fields(p.of, `${at}.of`, ['kind', 'node']);
  oneOf(of.kind, ['node', 'center', 'absent'], `${at}.of.kind`);
  ident(of.node, `${at}.of.node`);
  for (const k of ['x', 'y', 'k']) finite(p[k], `${at}.${k}`);
  maybe(p, 'group', ident, at);
  return p;
}

function preambleRec(v: unknown, at: string): Fields {
  const p = fields(v, at, ['text']);
  text(p.text, `${at}.text`);
  return p;
}

/** Per record type: its check, and the fields that name it (an operation's "before" and "after" are the same record). */
const RECORDS: Record<Exclude<Op['t'], 'branch'>, { check: (v: unknown, at: string) => Fields; identity: readonly string[] }> = {
  node: { check: nodeRec, identity: ['id'] },
  connection: { check: connectionRec, identity: ['id'] },
  plan: { check: planRec, identity: ['id'] },
  tagKey: { check: tagKeyRec, identity: ['key'] },
  placement: { check: placementRec, identity: ['plan', 'node'] },
  connLayout: { check: layoutRec, identity: ['plan', 'connection'] },
  phantom: { check: phantomRec, identity: ['id'] },
  preamble: { check: preambleRec, identity: [] },
};

/**
 * An operation received from elsewhere (another PC through the server, plan 5a), checked whole before anything reads
 * it: its type; every field of each record, of the right type, finite numbers, identifiers of 1 to MAX_ID_CHARS
 * characters, known enumerations, no field the model does not have; a "before" and an "after" of the same record, not
 * both absent. Returns it as given; throws SyncFormatError, in French, otherwise.
 */
export function parseOp(x: unknown): Op {
  const t = fields(x, 'l’opération', ['t'], ['before', 'after', 'key']).t;
  if (t === 'branch') {
    const op = fields(x, 'branch', ['t', 'key', 'before', 'after']);
    const key = fields(op.key, 'branch.key', ['plan', 'connection', 'node']);
    for (const k of ['plan', 'connection', 'node']) ident(key[k], `branch.key.${k}`);
    flag(op.before, 'branch.before');
    flag(op.after, 'branch.after');
    return x as Op;
  }
  const type = typeof t === 'string' && Object.hasOwn(RECORDS, t) ? (t as keyof typeof RECORDS) : bad(`type « ${String(t)} » inconnu`);
  const op = fields(x, type, ['t'], ['before', 'after']);
  const { check, identity } = RECORDS[type];
  const before = op.before === null || op.before === undefined ? null : check(op.before, `${type}.before`);
  const after = op.after === null || op.after === undefined ? null : check(op.after, `${type}.after`);
  if (op.before === undefined || op.after === undefined) bad(`${type} : « before » et « after » sont requis, null pour un enregistrement absent`);
  if (!before && !after) bad(`${type} : ni « before » ni « after »`);
  if (before && after && identity.some((k) => before[k] !== after[k])) bad(`${type} : « before » et « after » ne sont pas le même enregistrement`);
  return x as Op;
}
