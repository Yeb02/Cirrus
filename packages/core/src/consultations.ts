import type { Id } from './model.ts';
import { MAX_ID_CHARS } from './ops.ts';

// The consultations (plan 6a, D6; plan 6b, D7, spec 20): what the user looks at, recorded by each PC in a file of its own
// (the app's main/consultations.ts), then sent to the server, which keeps every PC's (the server's tokens.ts). Not an
// action: nothing here enters the journal, the sync of the base or the undo. Their form, checked strictly on both sides,
// is here: the main process checks the interface's batches, the server each PC's.

/** What is recorded, in one place: the main process and the server accept these kinds and no other. Identifiers, never French words. */
export const CONSULTATION_KINDS = [
  'app_open', 'app_close', 'plan_shown', 'node_popup', 'connection_popup', 'file_preview', 'file_fullscreen', 'search', 'jump', 'focus', 'blur',
] as const;
export type ConsultationKind = (typeof CONSULTATION_KINDS)[number];

/**
 * The kinds that say an object was looked at (D7: « jamais revus »): their `subject` is the node or connection seen. A
 * search counts only with a result chosen, a jump only with an object framed — that is, with a subject.
 */
export const SEEN_KINDS: readonly ConsultationKind[] = ['node_popup', 'connection_popup', 'file_preview', 'file_fullscreen', 'jump', 'search'];

/**
 * One event, as the interface hands it to the main process: `at` in milliseconds (this PC's clock), `subject` the node
 * or connection concerned, `plan` the plan it happened in (or, for a jump, the one it went to), `detail` the search's
 * text, a file's name, or how a jump was made.
 */
export interface Consultation { at: number; kind: ConsultationKind; subject?: Id; plan?: Id; detail?: string }

/** An event as a PC sends it to the server (D7): numbered by its row in that PC's file, which the server keys it by. */
export interface SentConsultation extends Consultation { seq: number }

/** The most events in one batch the main process accepts, and the most the interface's queue keeps (the oldest dropped beyond). */
export const MAX_CONSULTATION_BATCH = 10_000;
/** The longest `detail` the main process and the server accept; the interface's queue cuts a longer one (a search typed at length). */
export const MAX_DETAIL_CHARS = 2000;

/**
 * POST /consultations (D7): the most events in one request, and its largest body. The PC sends its events by batches of
 * MAX_CONSULTATIONS_PER_REQUEST at most, each cut short before its JSON passes MAX_CONSULTATIONS_BODY_BYTES (an event
 * holds 13 KiB at most: a detail of 2 000 UTF-16 units, 6 bytes each at worst once in JSON, and two identifiers).
 */
export const MAX_CONSULTATIONS_PER_REQUEST = 1000;
export const MAX_CONSULTATIONS_BODY_BYTES = 2 ** 20;

const FIELDS: ReadonlySet<string> = new Set(['at', 'kind', 'subject', 'plan', 'detail']);
const SENT_FIELDS: ReadonlySet<string> = new Set([...FIELDS, 'seq']);
const KINDS: ReadonlySet<string> = new Set(CONSULTATION_KINDS);

/** An identifier, as a field of an event: text of 1 to MAX_ID_CHARS characters, or absent. */
function idField(x: unknown, what: string): string | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_ID_CHARS) throw new Error(`${what} n’est pas un identifiant`);
  return x;
}

/** One event checked, as `parse` reads it: a copy of its known fields; throws, in French, saying what. */
function event(x: unknown, fields: ReadonlySet<string>): Consultation {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error('pas un objet');
  for (const key of Object.keys(x)) if (!fields.has(key)) throw new Error(`le champ « ${key.slice(0, 40)} » est inconnu`);
  const e = x as Record<string, unknown>;
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) throw new Error('genre inconnu');
  if (typeof e.at !== 'number' || !Number.isSafeInteger(e.at) || e.at < 0) throw new Error('l’heure n’est pas un entier positif');
  if (e.detail !== undefined && (typeof e.detail !== 'string' || e.detail.length > MAX_DETAIL_CHARS)) throw new Error(`le détail n’est pas un texte de ${MAX_DETAIL_CHARS} caractères au plus`);
  const out: Consultation = { at: e.at, kind: e.kind as ConsultationKind };
  const subject = idField(e.subject, 'le sujet'), plan = idField(e.plan, 'le plan');
  if (subject !== undefined) out.subject = subject;
  if (plan !== undefined) out.plan = plan;
  if (e.detail !== undefined) out.detail = e.detail as string;
  return out;
}

/** A batch checked whole: an array of at most `max` events, each checked by `each` (its index given). Throws, in French, saying what. */
function batchOf<T>(batch: unknown, max: number, each: (x: unknown, i: number) => T): T[] {
  if (!Array.isArray(batch)) throw new Error('le lot n’est pas un tableau');
  if (batch.length > max) throw new Error(`le lot compte plus de ${max} événements`);
  return batch.map((x: unknown, i): T => {
    try {
      return each(x, i);
    } catch (err) {
      throw new Error(`événement ${i} : ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * A batch from the interface (plan 6a, D6), checked whole before anything is written: an array of at most
 * MAX_CONSULTATION_BATCH events, each a plain object of the fields at, kind, subject, plan and detail alone (the PC is
 * the main process's to say), a known kind, an integer time, identifiers within MAX_ID_CHARS, a detail within
 * MAX_DETAIL_CHARS. One event out of line refuses the batch: a page that sends one is not the page that was built.
 * Throws, in French, saying what.
 */
export function parseConsultations(batch: unknown): Consultation[] {
  return batchOf(batch, MAX_CONSULTATION_BATCH, (x) => event(x, FIELDS));
}

/**
 * A batch from a PC (plan 6b, D7: the server's POST /consultations), checked as parseConsultations checks the
 * interface's, each event with its `seq` too — an integer from 1, strictly greater than the one before it (a PC sends
 * its rows in order) —, MAX_CONSULTATIONS_PER_REQUEST events at most. Throws, in French, saying what.
 */
export function parseSentConsultations(batch: unknown): SentConsultation[] {
  let last = 0;
  return batchOf(batch, MAX_CONSULTATIONS_PER_REQUEST, (x): SentConsultation => {
    const e = event(x, SENT_FIELDS), seq = (x as { seq?: unknown }).seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw new Error('son numéro n’est pas un entier à partir de 1');
    if (seq <= last) throw new Error('son numéro ne suit pas celui d’avant');
    last = seq;
    return { seq, ...e };
  });
}
