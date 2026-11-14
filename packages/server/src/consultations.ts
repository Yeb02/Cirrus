import { isObject, parseSentConsultations, type SentConsultation } from '@cirrus/core';
import { MAX_CONSULTATIONS_PER_REQUEST } from './bounds.ts';

// The consultations of every PC (plan 6b, D7): POST /consultations { events: [{ seq, at, kind, subject?, plan?, detail? }] },
// a PC's batch, checked whole before anything is written. serveur.db keeps them (tokens.ts), each under the PC of the
// request's token, never one the body would name.

/** A refused POST /consultations: a body that is not one (400), or a batch of more than MAX_CONSULTATIONS_PER_REQUEST events (413); in French. */
export class ConsultationsError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The events of a POST /consultations body, or ConsultationsError for the first thing wrong: a body other than
 * `{ events }`, `events` not a list (400), more than MAX_CONSULTATIONS_PER_REQUEST of them (413), one event out of line
 * (400: the core's parseSentConsultations — its fields, its kind, its time, its identifiers, its detail, its number,
 * strictly growing). Costs the body's size.
 */
export function parseConsultationsBody(body: unknown): SentConsultation[] {
  if (!isObject(body) || !Array.isArray(body.events) || Object.keys(body).length !== 1) {
    throw new ConsultationsError(400, 'Corps attendu : { events: [{ seq, at, kind, subject?, plan?, detail? }] }, les consultations de ce PC.');
  }
  const events = body.events as unknown[];
  if (events.length > MAX_CONSULTATIONS_PER_REQUEST) throw new ConsultationsError(413, `Au plus ${MAX_CONSULTATIONS_PER_REQUEST} consultations par requête.`);
  try {
    return parseSentConsultations(events);
  } catch (e) {
    throw new ConsultationsError(400, `Consultations refusées : ${e instanceof Error ? e.message : String(e)}.`);
  }
}
