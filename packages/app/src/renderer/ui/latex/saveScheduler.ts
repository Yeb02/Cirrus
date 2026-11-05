import type { FileRef, Id } from '@cirrus/core';
import { texSaveBuild, texSaveRefusal, UP_TO_DATE } from '../../actions.ts';
import { nameKey } from '../../files/merge.ts';
import type { Timers } from '../../latex/scheduler.ts';
import { type EditSession, messageOf } from '../../session.ts';

/** Where a .tex's saves stand (TexWorkbench's banner): `saved`, one went through since it opened; `failure`, why the last was refused. */
export interface SaveState { dirty: boolean; saving: boolean; saved: boolean; failure: string | null }

/** What a save answers: refused, why, in French. */
export type SaveAnswer = { ok: boolean; message?: string };

/**
 * When a .tex typed in its full screen is saved (plan 4b, D6), its clock injected: once typing has paused for
 * `idleMs` (texSaveIdleMs, read when a pause starts), at saveNow (Ctrl+S) and at flush (closing), and only when the
 * text differs from the last one saved — typing then erasing saves nothing. `saved`: the text of the file opened. Saves
 * run one at a time, each taking the text as it is when its turn comes. A save refused keeps the text, and `dirty`;
 * the next one tries again (none is retried on its own: a node gone would be tried for ever).
 */
export class SaveScheduler {
  private saved: string;
  private text: string;
  private readonly save: (text: string) => Promise<SaveAnswer>;
  private readonly timers: Timers;
  private readonly idleMs: () => number;
  private timer: unknown = null;
  private armed = false;
  private queue: Promise<void> = Promise.resolve();
  private saving = false;
  private savedOnce = false;
  private failure: string | null = null;
  private readonly listeners = new Set<(s: SaveState) => void>();

  constructor(saved: string, save: (text: string) => Promise<SaveAnswer>, timers: Timers, idleMs: () => number) {
    this.saved = saved;
    this.text = saved;
    this.save = save;
    this.timers = timers;
    this.idleMs = idleMs;
  }

  /** Whether the text differs from the last one saved. */
  get dirty(): boolean {
    return this.text !== this.saved;
  }

  /** The text as typed now: the pause starts again, or is dropped when the text is back to the one saved. */
  edit(text: string): void {
    this.text = text;
    this.disarm();
    if (this.dirty) {
      this.timer = this.timers.set(() => { this.armed = false; void this.saveNow(); }, this.idleMs());
      this.armed = true;
    }
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
      r = await this.save(text);
    } catch (e) {
      r = { ok: false, message: messageOf(e) };
    }
    this.saving = false;
    if (r.ok) {
      this.saved = text;
      this.savedOnce = true;
      this.failure = null;
    } else this.failure = r.message ?? 'enregistrement refusé';
    this.tell();
  }

  private state(): SaveState {
    return { dirty: this.dirty, saving: this.saving, saved: this.savedOnce, failure: this.failure };
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
 * anything is stored.
 */
export async function saveTex(
  session: Pick<EditSession, 'run' | 'state'>, storeText: (name: string, text: string) => Promise<FileRef>, node: Id, name: string, text: string,
): Promise<SaveAnswer> {
  const refused = texSaveRefusal(session.state, node, name);
  if (refused) return { ok: false, message: refused };
  let ref: FileRef;
  try {
    ref = await storeText(name, text);
  } catch (e) {
    return { ok: false, message: messageOf(e) };
  }
  const build = texSaveBuild(session.state, node, ref);
  if (!build) return { ok: true };
  const r = await session.run(build, { merge: texMergeKey(node, name) });
  return r.ok || r.message === UP_TO_DATE ? { ok: true } : { ok: false, message: r.message };
}
