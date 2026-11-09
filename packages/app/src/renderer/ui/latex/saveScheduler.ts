import { CommandError, type FileRef, type Id, type State } from '@cirrus/core';
import { texConflictName, texSaveBuild, texSaveRefusal, UP_TO_DATE } from '../../actions.ts';
import { nameKey, sameName } from '../../files/merge.ts';
import type { Timers } from '../../latex/scheduler.ts';
import { type EditSession, messageOf } from '../../session.ts';
import type { Question } from '../Dialogs.tsx';

/**
 * Where a .tex's saves stand (TexWorkbench's banner): `saved`, one went through since it opened; `failure`, why the last
 * was refused; `elsewhere`, the file changed elsewhere while text here was unsaved (plan 5b, D6): the next save keeps
 * that version under its conflict name.
 */
export interface SaveState { dirty: boolean; saving: boolean; saved: boolean; failure: string | null; elsewhere: boolean }

/**
 * What a save answers: refused, why, in French; saved, the hash of the version the file now holds (`hash`, the saved
 * text's), and the conflict name the version from elsewhere was kept under, if one was (`kept`, plan 5b, D6).
 */
export type SaveAnswer = { ok: boolean; message?: string; hash?: string; kept?: string };

/**
 * When a .tex typed in its full screen is saved (plan 4b, D6), its clock injected: once typing has paused for
 * `idleMs` (texSaveIdleMs, read when a pause starts), at saveNow (Ctrl+S) and at flush (closing), and only when the
 * text differs from the last one saved — typing then erasing saves nothing. `saved`: the text of the file opened. Saves
 * run one at a time, each taking the text as it is when its turn comes; one that ends with another text to save and no
 * pause running (typed back, meanwhile, to the text saved before it) starts the pause (final review). A save refused
 * keeps the text, and `dirty`; the next one tries again (none is retried on its own: a node gone would be tried for ever).
 *
 * The file changed elsewhere (plan 5b, D6): `base`, the hash of the version the text was made from — the one opened, then
 * each one saved or loaded —, which each save is given (saveTex keeps another version it finds under its conflict
 * name). `arrived` is told the file as the state holds it, at each change.
 */
export class SaveScheduler {
  private saved: string;
  private text: string;
  private readonly save: (text: string, base: string | null) => Promise<SaveAnswer>;
  private readonly timers: Timers;
  private readonly idleMs: () => number;
  private timer: unknown = null;
  private armed = false;
  private queue: Promise<void> = Promise.resolve();
  private saving = false;
  private savedOnce = false;
  private failure: string | null = null;
  /** The hash of the version the text was made from; null: not followed (no base given). */
  private base: string | null;
  /** The hash of a version from elsewhere that arrived while text was unsaved (D6): the next save keeps it. */
  private theirs: string | null = null;
  private readonly listeners = new Set<(s: SaveState) => void>();

  constructor(saved: string, save: (text: string, base: string | null) => Promise<SaveAnswer>, timers: Timers, idleMs: () => number, base: string | null = null) {
    this.saved = saved;
    this.text = saved;
    this.save = save;
    this.timers = timers;
    this.idleMs = idleMs;
    this.base = base;
  }

  /** Whether the text differs from the last one saved. */
  get dirty(): boolean {
    return this.text !== this.saved;
  }

  /**
   * The file as the state now holds it (plan 5b, D6), told at each change. Another version than the text's (`base`),
   * which came from elsewhere: with nothing unsaved, 'reload' — the caller reads it, then gives it (reloaded) —; with
   * unsaved text, the text stays, and `elsewhere` says that the next save keeps that version under its conflict name.
   * Nothing while a save runs — the version that arrives then is its own, or one it keeps —: its end tells the state, and
   * the caller tells the file again. Nothing either without a base.
   */
  arrived(file: FileRef): 'reload' | null {
    if (this.saving || this.base === null) return null;
    if (file.hash === this.base) {
      this.setTheirs(null);
      return null;
    }
    if (!this.dirty) return 'reload';
    this.setTheirs(file.hash);
    return null;
  }

  /**
   * The version from elsewhere read (`text`, of hash `hash`): it becomes the text, saved, and the base. False, nothing
   * done, when text was typed or a save started meanwhile: the caller tells the file again (arrived).
   */
  reloaded(text: string, hash: string): boolean {
    if (this.dirty || this.saving) return false;
    this.saved = text;
    this.text = text;
    this.base = hash;
    this.setTheirs(null);
    return true;
  }

  /** The text as typed now: the pause starts again, or is dropped when the text is back to the one saved. */
  edit(text: string): void {
    this.text = text;
    this.disarm();
    if (this.dirty) this.arm();
    this.tell();
  }

  /** Saves at once (Ctrl+S), after a save under way; resolves once done, or refused. */
  saveNow(): Promise<void> {
    this.disarm();
    const next = this.queue.then(() => this.write());
    this.queue = next;
    return next;
  }

  /** At closing: what is left saved, the saves under way waited for. */
  flush(): Promise<void> {
    return this.saveNow();
  }

  /** `cb` is told the state now, then at each change; returns the unsubscription. */
  onState(cb: (s: SaveState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state());
    return () => { this.listeners.delete(cb); };
  }

  /** Nothing more on its own: the pause dropped (what is typed stays, for a flush). */
  dispose(): void {
    this.disarm();
    this.listeners.clear();
  }

  private arm(): void {
    this.timer = this.timers.set(() => { this.armed = false; void this.saveNow(); }, this.idleMs());
    this.armed = true;
  }

  private disarm(): void {
    if (!this.armed) return;
    this.timers.clear(this.timer);
    this.armed = false;
  }

  private async write(): Promise<void> {
    const text = this.text;
    if (text === this.saved) return;
    this.saving = true;
    this.tell();
    let r: SaveAnswer;
    try {
      r = await this.save(text, this.base);
    } catch (e) {
      r = { ok: false, message: messageOf(e) };
    }
    this.saving = false;
    if (r.ok) {
      this.saved = text;
      this.savedOnce = true;
      this.failure = null;
      // The file holds this text now: a version from elsewhere is kept beside it, or was this very text.
      if (r.hash !== undefined && this.base !== null) this.base = r.hash;
      this.theirs = null;
    } else this.failure = r.message ?? 'enregistrement refusé';
    // Typed meanwhile, and still to save with no pause running: the pause starts. A refusal of the same text is not
    // tried again on its own.
    if (this.text !== text && this.dirty && !this.armed) this.arm();
    this.tell();
  }

  private setTheirs(hash: string | null): void {
    if (hash === this.theirs) return;
    this.theirs = hash;
    this.tell();
  }

  private state(): SaveState {
    return { dirty: this.dirty, saving: this.saving, saved: this.savedOnce, failure: this.failure, elsewhere: this.theirs !== null };
  }

  private tell(): void {
    const s = this.state();
    for (const cb of this.listeners) cb(s);
  }
}

/** The merge key of a .tex's saves (D6): its node and its name as sameName compares it. */
export function texMergeKey(node: Id, name: string): string {
  return `tex:${node}:${nameKey(name)}`;
}

/**
 * A .tex saved (D6): its text stored (`storeText`, the main process's), then the node's file replaced by it in its
 * place, through the session, merged with the saves of the same .tex that came right before it (texMergeKey): one
 * modification of the history, one undo step. Refused — the node or the file gone, the store refusing the text —, why
 * in French; a text the file holds already is saved, nothing written. A node or a file gone already is refused before
 * anything is stored. Saved, the answer gives the hash the file now holds.
 *
 * `base` (plan 5b, D6): the hash of the version the text was made from. The file holding another one when the action is
 * computed — changed elsewhere meanwhile, the synchronisation's —, that version is kept under its conflict name in the
 * same action (texSaveBuild's `keepTheirs`), which the answer names (`kept`); never merged with the saves before it, so
 * that its own undo step gives both files back. Decided when the action is computed, after whatever the session ran
 * first: a version arrived while the text was stored is kept too.
 */
export async function saveTex(
  session: Pick<EditSession, 'run' | 'state'>, storeText: (name: string, text: string) => Promise<FileRef>, node: Id, name: string, text: string,
  base?: string | null,
): Promise<SaveAnswer> {
  const refused = texSaveRefusal(session.state, node, name);
  if (refused) return { ok: false, message: refused };
  let ref: FileRef;
  try {
    ref = await storeText(name, text);
  } catch (e) {
    return { ok: false, message: messageOf(e) };
  }
  /** The file's version in `st` when it is neither the text's base nor the text itself: the one from elsewhere. */
  const elsewhere = (st: State): FileRef | undefined => {
    const f = st.nodes.get(node)?.files.find((x) => sameName(x.name, name));
    return base !== undefined && base !== null && f !== undefined && f.hash !== base && f.hash !== ref.hash ? f : undefined;
  };
  const at = Date.now();
  let kept: string | undefined;
  const r = await session.run((st) => {
    const theirs = elsewhere(st);
    const build = texSaveBuild(st, node, ref, theirs ? { keepTheirs: theirs, at } : {});
    if (!build) throw new CommandError(UP_TO_DATE);
    const a = build(st);
    // The name texSaveBuild gave it: the same files, the same time.
    kept = theirs ? texConflictName(st.nodes.get(node)!.files, ref.name, at) : undefined;
    return a;
  }, elsewhere(session.state) ? {} : { merge: texMergeKey(node, name) });
  if (r.ok) return kept === undefined ? { ok: true, hash: ref.hash } : { ok: true, hash: ref.hash, kept };
  return r.message === UP_TO_DATE ? { ok: true, hash: ref.hash } : { ok: false, message: r.message };
}

/** « HHhMM » at `at`, in this PC's time, as a conflict copy's name has it; another day than `now`'s: « le AAAA-MM-JJ à HHhMM ». */
function since(at: number, now: number): string {
  const d = new Date(at), today = new Date(now), p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}h${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `le ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} à ${time}`;
}

/** The full screen's banner when another PC has the .tex open (plan 5b, D6): its name at the server, since when (`since`, this PC's clock). */
export function openedElsewhere(pc: string, at: number, now: number): string {
  return `Ce .tex est ouvert sur « ${pc} » depuis ${since(at, now)} : sa dernière version y est peut-être restée.`;
}

/** The full screen's banner when `name` changed elsewhere while its text here is unsaved (D6): its conflict name, its time yet to come. */
export function changedElsewhere(name: string): string {
  const dot = name.lastIndexOf('.'), copy = dot <= 0 ? `${name} (conflit du … )` : `${name.slice(0, dot)} (conflit du … )${name.slice(dot)}`;
  return `« ${name} » a aussi été modifié sur un autre PC : à l’enregistrement, cette version-là sera gardée sous « ${copy} ».`;
}

/** The notification of a version from elsewhere loaded, nothing being unsaved here (D6). */
export function reloadedNotice(name: string): string {
  return `« ${name} » a été modifié sur un autre PC : sa nouvelle version est chargée.`;
}

/** The notification of a save that kept the version from elsewhere under its conflict name `kept` (D6). */
export function keptNotice(name: string, kept: string): string {
  return `« ${name} » a été modifié sur deux PC : l’autre version est gardée sous « ${kept} ».`;
}

/**
 * The question a full screen asks before leaving a .tex whose text could not be saved (`failure`, why): close without
 * saving (`close`), or stay. « Annuler » has the focus (task 5 review): Enter never throws the text away.
 */
export function unsavedQuestion(name: string, failure: string | null, close: () => void): Question {
  return {
    text: 'Fermer sans enregistrer ?',
    detail: `Le texte tapé dans « ${name} » n’est pas enregistré${failure ? ` : ${failure}` : '.'}`,
    choices: [{ value: 'close', label: 'Fermer sans enregistrer' }],
    focusCancel: true,
    answer: (v) => { if (v === 'close') close(); },
  };
}
