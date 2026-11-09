import { CommandError, type FileRef, type Id, type State } from '@cirrus/core';
import { type Build, texConflictName, texSaveBuild, texSaveRefusal, UP_TO_DATE } from '../../actions.ts';
import { nameKey, sameName } from '../../files/merge.ts';
import type { Timers } from '../../latex/scheduler.ts';
import { type EditSession, messageOf, type Result } from '../../session.ts';
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
 * A text followed against the version of its file it was made from (plan 5b, D6), as the .tex full screen has it
 * (SaveScheduler) and the comparison's original (Reconciliation, compare.ts): the text as it is (`text`), the one the
 * file holds as far as it knows (`saved`: opened, saved or loaded), the hash of that version (`base`; null: not
 * followed), and whether a version from elsewhere arrived while the text differed from it (`elsewhere`) — the next save
 * keeps that version under its conflict name.
 */
export class FollowedText {
  private savedText: string;
  private current: string;
  private hash: string | null;
  /** The hash of the version from elsewhere that arrived while the text differed from the one saved. */
  private theirs: string | null = null;

  constructor(text: string, base: string | null) {
    this.savedText = text;
    this.current = text;
    this.hash = base;
  }

  /** The text as it is now. */
  get text(): string {
    return this.current;
  }

  /** The text the file holds, as far as it knows: opened, saved or loaded. */
  get saved(): string {
    return this.savedText;
  }

  /** The hash of the version the text was made from; null: not followed. */
  get base(): string | null {
    return this.hash;
  }

  /** Whether the text differs from the one saved. */
  get dirty(): boolean {
    return this.current !== this.savedText;
  }

  /** Whether a version from elsewhere arrived while the text differed from the one saved (the banner says it). */
  get elsewhere(): boolean {
    return this.theirs !== null;
  }

  /** The text as it is now. */
  edit(text: string): void {
    this.current = text;
  }

  /**
   * `text` written: the file holds it now, of hash `hash` (the base unchanged without one, or when not followed), and a
   * version from elsewhere is kept beside it, or was that very text.
   */
  wrote(text: string, hash?: string): void {
    this.savedText = text;
    if (hash !== undefined && this.hash !== null) this.hash = hash;
    this.theirs = null;
  }

  /**
   * The file as the state holds it, by its hash: another version than the text's, which came from elsewhere. With
   * nothing unsaved, 'reload' — the caller reads it, then gives it (reloaded) —; else the text stays, and `elsewhere`
   * says so. The file back to the text's version: nothing from elsewhere any more. Nothing when not followed.
   */
  arrived(hash: string): 'reload' | null {
    if (this.hash === null) return null;
    if (hash === this.hash) {
      this.theirs = null;
      return null;
    }
    if (!this.dirty) return 'reload';
    this.theirs = hash;
    return null;
  }

  /**
   * The version from elsewhere read (`text`, of hash `hash`): the text, saved, and the base. False, nothing done, when
   * the text changed meanwhile: the caller tells the file again (arrived).
   */
  reloaded(text: string, hash: string): boolean {
    if (this.dirty) return false;
    this.savedText = text;
    this.current = text;
    this.hash = hash;
    this.theirs = null;
    return true;
  }
}

/**
 * When a .tex typed in its full screen is saved (plan 4b, D6), its clock injected: once typing has paused for
 * `idleMs` (texSaveIdleMs, read when a pause starts), at saveNow (Ctrl+S) and at flush (closing), and only when the
 * text differs from the last one saved — typing then erasing saves nothing. `saved`: the text of the file opened. Saves
 * run one at a time, each taking the text as it is when its turn comes; one that ends with another text to save and no
 * pause running (typed back, meanwhile, to the text saved before it) starts the pause (final review). A save refused
 * keeps the text, and `dirty`; the next one tries again (none is retried on its own: a node gone would be tried for ever).
 *
 * The file changed elsewhere (plan 5b, D6): its text followed (FollowedText) by the hash of the version it was made from
 * — the one opened, then each one saved or loaded —, which each save is given (saveTex keeps another version it finds
 * under its conflict name). `arrived` is told the file as the state holds it, at each change.
 */
export class SaveScheduler {
  private readonly followed: FollowedText;
  private readonly save: (text: string, base: string | null) => Promise<SaveAnswer>;
  private readonly timers: Timers;
  private readonly idleMs: () => number;
  private timer: unknown = null;
  private armed = false;
  private queue: Promise<void> = Promise.resolve();
  private saving = false;
  private savedOnce = false;
  private failure: string | null = null;
  private readonly listeners = new Set<(s: SaveState) => void>();

  constructor(saved: string, save: (text: string, base: string | null) => Promise<SaveAnswer>, timers: Timers, idleMs: () => number, base: string | null = null) {
    this.followed = new FollowedText(saved, base);
    this.save = save;
    this.timers = timers;
    this.idleMs = idleMs;
  }

  /** Whether the text differs from the last one saved. */
  get dirty(): boolean {
    return this.followed.dirty;
  }

  /**
   * The file as the state now holds it (plan 5b, D6), told at each change (FollowedText.arrived): with nothing unsaved,
   * 'reload' for a version from elsewhere; with unsaved text, `elsewhere` says the next save keeps it. Nothing while a
   * save runs — the version that arrives then is its own, or one it keeps —: its end tells the state, and the caller
   * tells the file again. Nothing either without a base.
   */
  arrived(file: FileRef): 'reload' | null {
    if (this.saving) return null;
    const was = this.followed.elsewhere, r = this.followed.arrived(file.hash);
    if (this.followed.elsewhere !== was) this.tell();
    return r;
  }

  /**
   * The version from elsewhere read (`text`, of hash `hash`): it becomes the text, saved, and the base. False, nothing
   * done, when text was typed or a save started meanwhile: the caller tells the file again (arrived). The caller gives
   * the editor that text in the same call (LatexEditorHandle.load): no keystroke can land between them.
   */
  reloaded(text: string, hash: string): boolean {
    if (this.saving) return false;
    const was = this.followed.elsewhere;
    if (!this.followed.reloaded(text, hash)) return false;
    if (was) this.tell();
    return true;
  }

  /** The text as typed now: the pause starts again, or is dropped when the text is back to the one saved. */
  edit(text: string): void {
    this.followed.edit(text);
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
    const f = this.followed, text = f.text;
    if (text === f.saved) return;
    this.saving = true;
    this.tell();
    let r: SaveAnswer;
    try {
      r = await this.save(text, f.base);
    } catch (e) {
      r = { ok: false, message: messageOf(e) };
    }
    this.saving = false;
    if (r.ok) {
      f.wrote(text, r.hash);
      this.savedOnce = true;
      this.failure = null;
    } else this.failure = r.message ?? 'enregistrement refusé';
    // Typed meanwhile, and still to save with no pause running: the pause starts. A refusal of the same text is not
    // tried again on its own.
    if (f.text !== text && f.dirty && !this.armed) this.arm();
    this.tell();
  }

  private state(): SaveState {
    return { dirty: this.dirty, saving: this.saving, saved: this.savedOnce, failure: this.failure, elsewhere: this.followed.elsewhere };
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
 * same action (texSaveBuild's `keepTheirs`, through runKeepingTheirs), which the answer names (`kept`); never merged with
 * the saves before it, so that its own undo step gives both files back. Decided when the action is computed, after
 * whatever the session ran first: a version arrived while the text was stored is kept too.
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
  const { result: r, kept } = await runKeepingTheirs(
    session, node, name, ref, base, (st, keep) => texSaveBuild(st, node, ref, keep.theirs ? { keepTheirs: keep.theirs, at: keep.at } : {}), texMergeKey(node, name),
  );
  if (r.ok) return kept === undefined ? { ok: true, hash: ref.hash } : { ok: true, hash: ref.hash, kept };
  return r.message === UP_TO_DATE ? { ok: true, hash: ref.hash } : { ok: false, message: r.message };
}

/**
 * The version the file `name` of `node` holds in `st` when it is neither `base` — the version the saved text was made
 * from — nor `ours`, the saved text's own: the one that came from elsewhere (plan 5b, D6). None without a base.
 */
export function versionFromElsewhere(st: State, node: Id, name: string, base: string | null | undefined, ours: string): FileRef | undefined {
  const f = st.nodes.get(node)?.files.find((x) => sameName(x.name, name));
  return base !== undefined && base !== null && f !== undefined && f.hash !== base && f.hash !== ours ? f : undefined;
}

/**
 * A save of the .tex `name` of `node` through the session that keeps the version from elsewhere (plan 5b, D6), as the
 * full screen's (saveTex) and the comparison's (reconcileTex) have it. `ref`: the text saved, stored already (null:
 * none). When the action is computed — after whatever the session ran first —, `build` is given the version from
 * elsewhere (versionFromElsewhere, against `base`), to keep under its conflict name at `at`; a build that is null is
 * « Déjà à jour. ». The answer: the session's, and the name that version was kept under (`kept`, texConflictName: the
 * same files, the same time). `merge`, the session's merge key, is dropped when a version from elsewhere is there
 * already: a save that keeps one is its own undo step.
 */
export async function runKeepingTheirs(
  session: Pick<EditSession, 'run' | 'state'>, node: Id, name: string, ref: FileRef | null, base: string | null | undefined,
  build: (st: State, keep: { theirs?: FileRef; at: number }) => Build, merge?: string,
): Promise<{ result: Result; kept?: string }> {
  const theirsIn = (st: State) => (ref === null ? undefined : versionFromElsewhere(st, node, name, base, ref.hash));
  const at = Date.now();
  let kept: string | undefined;
  const result = await session.run((st) => {
    const theirs = theirsIn(st);
    const b = build(st, theirs ? { theirs, at } : { at });
    if (!b) throw new CommandError(UP_TO_DATE);
    const a = b(st);
    kept = theirs ? texConflictName(st.nodes.get(node)!.files, name, at) : undefined;
    return a;
  }, merge === undefined || theirsIn(session.state) ? {} : { merge });
  return kept === undefined ? { result } : { result, kept };
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
