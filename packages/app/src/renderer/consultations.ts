import type { Id } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';

/**
 * The local recording of consultations (plan 6a, D6, spec 20): what the user looks at, kept in a file of this PC
 * (main/consultations.ts) from the start of his data entry. Not an action: nothing here enters the journal or the undo.
 * The interface keeps its events in a queue, hands them to the main process every consultationsFlushMs and at closing,
 * and decides at each emission point what the event is (the pure functions below); the main process validates and writes
 * them. Neither typed text nor content is recorded, but the text of a search.
 */

/** What is recorded, in one place: the main process accepts these kinds and no other. Identifiers, never French words. */
export const CONSULTATION_KINDS = [
  'app_open', 'app_close', 'plan_shown', 'node_popup', 'connection_popup', 'file_preview', 'file_fullscreen', 'search', 'jump', 'focus', 'blur',
] as const;
export type ConsultationKind = (typeof CONSULTATION_KINDS)[number];

/**
 * One event, as the interface hands it to the main process: `at` in milliseconds (this PC's clock), `subject` the node
 * or connection concerned, `plan` the plan it happened in (or, for a jump, the one it went to), `detail` the search's
 * text, a file's name, or how a jump was made.
 */
export interface Consultation { at: number; kind: ConsultationKind; subject?: Id; plan?: Id; detail?: string }

/** What an emission point decides: the event without its date. Without a `plan`, the queue puts the plan shown. */
export type ConsultationDraft = Omit<Consultation, 'at'>;

/** The most events in one batch the main process accepts, and the most the queue keeps (the oldest dropped beyond). */
export const MAX_CONSULTATION_BATCH = 10_000;
/** The longest `detail` the main process accepts; the queue cuts a longer one (a search typed at length). */
export const MAX_DETAIL_CHARS = 2000;

/** `text` cut to MAX_DETAIL_CHARS UTF-16 units, without leaving half of a surrogate pair at its end. */
function clip(text: string): string {
  if (text.length <= MAX_DETAIL_CHARS) return text;
  const end = text.charCodeAt(MAX_DETAIL_CHARS - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? MAX_DETAIL_CHARS - 1 : MAX_DETAIL_CHARS);
}

/** What the queue reads of the app, and does through it. */
export interface QueueDeps {
  /** Hands a batch to the main process (fire and forget: `window.cirrus.recordConsultations`). May throw. */
  send(events: Consultation[]): void;
  /** The switch, as of now: off, nothing is queued, nothing is sent. */
  enabled(): boolean;
  /** consultationsFlushMs, as of now: read each time a wait begins. */
  flushMs(): number;
  /** The plan shown, which an event without its own plan is made in. */
  plan?(): Id | undefined;
  /** This PC's clock. */
  now?(): number;
}

/**
 * The events waiting to be sent, in order. The first event of an empty queue starts a wait of `flushMs()`, at the end of
 * which everything goes in one batch; an empty queue has no timer, so an idle window wakes for nothing. A batch whose
 * send fails stays and goes at the next wait, with what came since; the queue holds `bound` events at most, the oldest
 * dropped, so a main process that never answers cannot make memory grow (Review Focus 5). `finish` is the closing's:
 * one attempt, a failure dropped without a word, never thrown.
 */
export class ConsultationQueue {
  private events: Consultation[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly deps: QueueDeps;
  private readonly bound: number;
  constructor(deps: QueueDeps, bound = MAX_CONSULTATION_BATCH) {
    this.deps = deps;
    this.bound = bound;
  }

  /** How many events wait. */
  get size(): number {
    return this.events.length;
  }

  record(draft: ConsultationDraft): void {
    if (!this.deps.enabled()) return;
    const event: Consultation = { at: (this.deps.now ?? Date.now)(), kind: draft.kind };
    if (draft.subject !== undefined) event.subject = draft.subject;
    const plan = draft.plan ?? this.deps.plan?.();
    if (plan !== undefined) event.plan = plan;
    if (draft.detail !== undefined) event.detail = clip(draft.detail);
    this.events.push(event);
    if (this.events.length > this.bound) this.events.splice(0, this.events.length - this.bound);
    this.schedule();
  }

  /** The wait's end: the batch goes; if sending fails, it stays for the next wait. */
  private flush(): void {
    this.timer = undefined;
    if (this.events.length === 0) return;
    // Switched off while events waited: they are not written.
    if (!this.deps.enabled()) {
      this.events = [];
      return;
    }
    const batch = this.events;
    this.events = [];
    try {
      this.deps.send(batch);
    } catch {
      this.events = [...batch, ...this.events].slice(-this.bound);
      this.schedule();
    }
  }

  /** The switch turned off: what waits is dropped, and nothing is awake for it. */
  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.events = [];
  }

  /** Closing: what waits goes now, once; a failed attempt is dropped silently. */
  finish(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.events;
    this.events = [];
    if (batch.length === 0 || !this.deps.enabled()) return;
    try {
      this.deps.send(batch);
    } catch {
      // dropped: the closing never waits for, nor reports, a recording
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.flush(), Math.max(1, this.deps.flushMs()));
  }
}

/**
 * The recording as the settings have it: on only if the switch is exactly 'yes', and never in bench and capture modes (they
 * measure, they do not use). Any other value — a settings file edited by hand, a setting of another version — is off: a
 * privacy switch fails closed.
 */
export function consultationSettings(p: Pick<RenderParams, 'consultationsRecord' | 'consultationsFlushMs'>, measuring: boolean): { record: boolean; flushMs: number } {
  return { record: !measuring && p.consultationsRecord === 'yes', flushMs: p.consultationsFlushMs };
}

/** A plan shown (App's active tab): none while the state is not there. */
export function planShownDraft(plan: Id | null): ConsultationDraft | null {
  return plan === null ? null : { kind: 'plan_shown', plan };
}

/** The pop-up of a connection: one event for each connection the line clicked stands for. */
export function connectionDrafts(connections: readonly Id[]): ConsultationDraft[] {
  return connections.map((subject) => ({ kind: 'connection_popup', subject }));
}

/**
 * A search (the box of Ctrl+K): its text, trimmed, and the result chosen if there is one; a text typed and then given
 * up has no subject. A blank field is no search. Not made at each keystroke: once, when the box ends.
 */
export function searchDraft(text: string, chosen?: { id: Id }): ConsultationDraft | null {
  const detail = clip(text.trim());
  if (detail === '') return null;
  return chosen ? { kind: 'search', detail, subject: chosen.id } : { kind: 'search', detail };
}

/** How a jump was made, and where it went (Jumps tells its host): the plan it arrived in, and the object framed, if any. */
export interface JumpMade { kind: 'reveal' | 'teleport' | 'back' | 'forward'; plan: Id; subject?: Id }

/** A jump: the object framed as subject, the plan it arrived in; how, when it was not a search's or a link's reveal. */
export function jumpDraft(j: JumpMade): ConsultationDraft {
  const draft: ConsultationDraft = { kind: 'jump', plan: j.plan };
  if (j.subject !== undefined) draft.subject = j.subject;
  if (j.kind !== 'reveal') draft.detail = j.kind;
  return draft;
}

/**
 * The window's focus, which the time spent is read from: an event when it changes, none when it is the state already
 * (a hidden window loses its focus too: two signals, one `blur`).
 */
export class FocusTracker {
  private focused: boolean;
  constructor(focused: boolean) {
    this.focused = focused;
  }

  set(focused: boolean): ConsultationDraft | null {
    if (focused === this.focused) return null;
    this.focused = focused;
    return { kind: focused ? 'focus' : 'blur' };
  }
}

// The app's queue (App configures it): off until the settings are read, so that a user who stopped the recording never
// has even its first event kept.
let settings = { record: false, flushMs: 10_000 };
let planShown: () => Id | undefined = () => undefined;

export const consultations = new ConsultationQueue({
  send: (events) => window.cirrus.recordConsultations(events),
  enabled: () => settings.record,
  flushMs: () => settings.flushMs,
  plan: () => planShown(),
});

/**
 * The settings as they now are (consultationSettings), and where the plan shown is read. Turned off, the queue is emptied
 * at once: the events that waited were made under the switch's old value and are not written (« éteint : rien n'est écrit »).
 */
export function configureConsultations(next: { record: boolean; flushMs: number }, plan?: () => Id | undefined): void {
  settings = next;
  if (plan) planShown = plan;
  if (!next.record) consultations.clear();
}
