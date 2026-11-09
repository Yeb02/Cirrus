import { CommandError, type FileRef, type Id, type State } from '@cirrus/core';
import { reconcileTexBuild, texConflictName, texSaveRefusal, UP_TO_DATE } from '../../actions.ts';
import { decodeText } from '../../files/decode.ts';
import { sameName } from '../../files/merge.ts';
import { MB, readHead } from '../../files/read.ts';
import { type EditSession, messageOf } from '../../session.ts';
import type { Question } from '../Dialogs.tsx';
import { BINARY } from '../viewers/common.tsx';
import type { SaveAnswer } from './saveScheduler.ts';

// The comparison of a .tex with its conflict copy (plan 5b, D7): what its full screen (CompareView) reads, follows and
// saves, apart from CodeMirror — the parts that need no DOM.

/** What the comparison says of a file above textViewMaxMb: it is neither read nor edited. */
export const TOO_BIG = 'Trop grand pour être comparé ici.';

/** Whether the original or its copy is above `maxMb` (textViewMaxMb): by the sizes the node holds, before anything is read. */
export const tooBigToCompare = (original: FileRef, copy: FileRef, maxMb: number): boolean => original.size > maxMb * MB || copy.size > maxMb * MB;

/** The header's text: both files, by their names. */
export const compareTitle = (original: string, copy: string): string => `Comparer « ${original} » et « ${copy} »`;

/**
 * A .tex's bytes as the editor reads them, as the .tex full screen's readOpened does it (decodeText: UTF-8 with or
 * without a BOM, Windows-1252, UTF-16), its line breaks « \n »: a binary, or a head read of a longer file, is said so.
 */
export function texTextOf(bytes: Uint8Array, truncated: boolean): { text: string } | { binary: true } | { tooLong: true } {
  const d = decodeText(bytes, truncated);
  if ('binary' in d) return { binary: true };
  if (truncated) return { tooLong: true };
  return { text: d.text.replace(/\r\n?/g, '\n') };
}

/** A .tex read by readHead, up to `maxMb` (textViewMaxMb), and decoded (texTextOf). A file the store cannot serve rejects with readHead's ReadError. */
export async function readTexText(file: FileRef, maxMb: number, signal?: AbortSignal): Promise<{ text: string } | { binary: true } | { tooLong: true }> {
  const { bytes, truncated } = await readHead(file, maxMb * MB, signal);
  return texTextOf(bytes, truncated);
}

/**
 * Both texts of a comparison, read and decoded (readTexText): the original's (`a`) and the copy's (`b`); or why they
 * cannot be compared (`message`): above `maxMb` (TOO_BIG, said before anything is read), or a binary.
 */
export async function readCompared(original: FileRef, copy: FileRef, maxMb: number, signal?: AbortSignal): Promise<{ a: string; b: string } | { message: string }> {
  if (tooBigToCompare(original, copy, maxMb)) return { message: TOO_BIG };
  const [a, b] = await Promise.all([readTexText(original, maxMb, signal), readTexText(copy, maxMb, signal)]);
  if ('binary' in a || 'binary' in b) return { message: BINARY };
  if ('tooLong' in a || 'tooLong' in b) return { message: TOO_BIG };
  return { a: a.text, b: b.text };
}

/**
 * The question asked before leaving a comparison whose original has blocks taken from the copy that are not saved:
 * leave (`close`), or stay. « Annuler » has the focus, as the preamble's and the .tex's: Enter never throws them away.
 */
export function abandonQuestion(original: string, close: () => void): Question {
  return {
    text: 'Abandonner la réconciliation ?',
    detail: `Ce qui a été repris dans « ${original} » n’est pas enregistré.`,
    choices: [{ value: 'close', label: 'Abandonner' }],
    focusCancel: true,
    answer: (v) => { if (v === 'close') close(); },
  };
}

/**
 * The original in a comparison, followed as a .tex's text is in its full screen (SaveScheduler, plan 5b, D6): by the hash
 * of the version loaded (`base`), against the file as the state holds it (`arrived`). The text is `dirty` once blocks
 * were taken (`edit`). A version from elsewhere with nothing taken is to be read and loaded (`arrived` says 'reload',
 * then `reloaded`); with blocks taken, the text stays, `elsewhere` says that the save will keep that version under its
 * conflict name, and the save is given `base`, the hash of the version the text was made from (reconcileTex).
 */
export class Reconciliation {
  private loaded: string;
  private text: string;
  private hash: string;
  private theirs = false;

  constructor(text: string, base: string) {
    this.loaded = text;
    this.text = text;
    this.hash = base;
  }

  /** Whether the text differs from the one loaded. */
  get dirty(): boolean {
    return this.text !== this.loaded;
  }

  /** Whether a version from elsewhere arrived while blocks were taken (the banner says it). */
  get elsewhere(): boolean {
    return this.theirs;
  }

  /** The hash of the version the text was made from. */
  get base(): string {
    return this.hash;
  }

  /** The text as it is now. */
  edit(text: string): void {
    this.text = text;
  }

  /**
   * The original as the state now holds it, told at each change: another version than the text's. 'reload' when nothing
   * was taken (the caller reads it, then gives it: `reloaded`); else the text stays, and `elsewhere` says so.
   */
  arrived(hash: string): 'reload' | null {
    if (hash === this.hash) {
      this.theirs = false;
      return null;
    }
    if (!this.dirty) return 'reload';
    this.theirs = true;
    return null;
  }

  /** The version from elsewhere, read (`text`, of hash `hash`), becomes the text, loaded. False, nothing done, when blocks were taken meanwhile: tell the file again. */
  reloaded(text: string, hash: string): boolean {
    if (this.dirty) return false;
    this.loaded = text;
    this.text = text;
    this.hash = hash;
    this.theirs = false;
    return true;
  }
}

/**
 * A comparison saved (plan 5b, D7): `text`, the original with the blocks taken from the copy, stored (`storeText`, the
 * main process's) and replacing the original in its node; null when none was taken, the original then left as it is.
 * `removeCopy`: the copy leaves the node's files in the same action (the blob stays in the store). One action,
 * « Réconcilier « x.tex » » (reconcileTexBuild), never merged with the saves before it: one undo step. Refused — the node
 * or the original gone, the store refusing the text —, why in French; a node or an original gone already is refused
 * before anything is stored. Saved, the answer gives the hash the original now holds.
 *
 * `base` (D6, as saveTex has it): the hash of the version the text was made from. The original holding another one when
 * the action is computed — changed elsewhere meanwhile —, that version is kept under its conflict name in the same
 * action, which the answer names (`kept`).
 */
export async function reconcileTex(
  session: Pick<EditSession, 'run' | 'state'>, storeText: (name: string, text: string) => Promise<FileRef>, node: Id, original: string, text: string | null,
  opts: { removeCopy?: string; base?: string | null } = {},
): Promise<SaveAnswer> {
  const refused = texSaveRefusal(session.state, node, original);
  if (refused) return { ok: false, message: refused };
  let ref: FileRef | null = null;
  if (text !== null) {
    try {
      ref = await storeText(original, text);
    } catch (e) {
      return { ok: false, message: messageOf(e) };
    }
  }
  const held = (st: State): FileRef | undefined => st.nodes.get(node)?.files.find((f) => sameName(f.name, original));
  /** Whether the original holds another version than the text's base and the saved text's own: the one from elsewhere. */
  const elsewhere = (st: State): boolean => {
    const f = held(st);
    return ref !== null && opts.base != null && f !== undefined && f.hash !== opts.base && f.hash !== ref.hash;
  };
  const at = Date.now();
  let kept: string | undefined;
  const r = await session.run((st) => {
    const keepTheirs = elsewhere(st);
    const build = reconcileTexBuild(st, node, original, ref, { removeCopy: opts.removeCopy, keepTheirs, at });
    if (!build) throw new CommandError(UP_TO_DATE);
    const a = build(st);
    // The name reconcileTexBuild gave it: the same files, the same time.
    kept = keepTheirs ? texConflictName(st.nodes.get(node)!.files, original, at) : undefined;
    return a;
  });
  if (!r.ok && r.message !== UP_TO_DATE) return { ok: false, message: r.message };
  const hash = ref?.hash ?? held(session.state)?.hash;
  const answer: SaveAnswer = hash === undefined ? { ok: true } : { ok: true, hash };
  return r.ok && kept !== undefined ? { ...answer, kept } : answer;
}
