import type { FileRef, Id } from '@cirrus/core';
import { reconcileTexBuild, texSaveRefusal, UP_TO_DATE } from '../../actions.ts';
import { sameName } from '../../files/merge.ts';
import { MB } from '../../files/read.ts';
import { type EditSession, messageOf } from '../../session.ts';
import type { Question } from '../Dialogs.tsx';
import { BINARY } from '../viewers/common.tsx';
import { FollowedText, runKeepingTheirs, type SaveAnswer } from './saveScheduler.ts';
import { readTexText } from './texText.ts';

// The comparison of a .tex with its conflict copy (plan 5b, D7): what its full screen (CompareView) reads, follows and
// saves, apart from CodeMirror — the parts that need no DOM.

/** What the comparison says of a file above textViewMaxMb: it is neither read nor edited. */
export const TOO_BIG = 'Trop grand pour être comparé ici.';

/** Whether the original or its copy is above `maxMb` (textViewMaxMb): by the sizes the node holds, before anything is read. */
export const tooBigToCompare = (original: FileRef, copy: FileRef, maxMb: number): boolean => original.size > maxMb * MB || copy.size > maxMb * MB;

/** The header's text: both files, by their names. */
export const compareTitle = (original: string, copy: string): string => `Comparer « ${original} » et « ${copy} »`;

/**
 * Both texts of a comparison, read and decoded (readTexText, the .tex full screen's reading too): the original's (`a`)
 * and the copy's (`b`); or why they cannot be compared (`message`): above `maxMb` (TOO_BIG, said before anything is
 * read), or a binary.
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
 * The original in a comparison, followed as a .tex's text is in its full screen (plan 5b, D6): the same FollowedText as
 * SaveScheduler's — by the hash of the version loaded (`base`), against the file as the state holds it (`arrived`). The
 * text is `dirty` once blocks were taken (`edit`). A version from elsewhere with nothing taken is to be read and loaded
 * (`arrived` says 'reload', then `reloaded`, the editor given that text in the same call); with blocks taken, the text
 * stays, `elsewhere` says that the save will keep that version under its conflict name, and the save is given `base`,
 * the hash of the version the text was made from (reconcileTex). The comparison closes once saved: nothing is written
 * to it after.
 */
export class Reconciliation extends FollowedText {}

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
  // Never merged with the saves before it: one undo step.
  const { result: r, kept } = await runKeepingTheirs(
    session, node, original, ref, opts.base,
    (st, keep) => reconcileTexBuild(st, node, original, ref, { removeCopy: opts.removeCopy, keepTheirs: keep.theirs !== undefined, at: keep.at }),
  );
  if (!r.ok && r.message !== UP_TO_DATE) return { ok: false, message: r.message };
  const hash = ref?.hash ?? session.state.nodes.get(node)?.files.find((f) => sameName(f.name, original))?.hash;
  const answer: SaveAnswer = hash === undefined ? { ok: true } : { ok: true, hash };
  return r.ok && kept !== undefined ? { ...answer, kept } : answer;
}
