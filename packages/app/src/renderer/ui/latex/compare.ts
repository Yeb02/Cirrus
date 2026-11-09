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

/** Why a new version of a compared file is not shown (D6): above textViewMaxMb, or unreadable (a binary, bytes not served). */
export type NotShown = 'tooBig' | 'unreadable';

/**
 * A new version from elsewhere of a file compared (the original or its copy, D6), read to be shown: its text, decoded as
 * readCompared has it; or why not (NotShown) — above `maxMb`, by the size the node holds (nothing read) or by its head
 * cut there; a binary, or bytes the store cannot serve (told to the console). Never rejects: the caller says why, and
 * the text shown stays.
 */
export async function readNewVersion(file: FileRef, maxMb: number, signal?: AbortSignal): Promise<{ text: string } | { not: NotShown }> {
  if (file.size > maxMb * MB) return { not: 'tooBig' };
  try {
    const r = await readTexText(file, maxMb, signal);
    return 'text' in r ? r : { not: 'tooLong' in r ? 'tooBig' : 'unreadable' };
  } catch (e) {
    if (!signal?.aborted) console.error(`Lecture de « ${file.name} » :`, e);
    return { not: 'unreadable' };
  }
}

/**
 * The notification of a new version of the original that the comparison does not load (D6): the text shown stays, and
 * that version is kept — the original still, or under its conflict name by a save with blocks taken.
 */
export function originalNotLoaded(name: string, why: NotShown): string {
  return why === 'tooBig'
    ? `« ${name} » a été modifié sur un autre PC, mais sa nouvelle version est trop grande pour être comparée ici : elle est gardée.`
    : `« ${name} » a été modifié sur un autre PC, mais sa nouvelle version n’a pas pu être lue.`;
}

/** The notification of a new version of the copy shown on the right (task 8a): the copy is read-only, nothing is lost. */
export function copyReloadedNotice(name: string): string {
  return `La copie « ${name} » a changé sur un autre PC : sa nouvelle version est montrée.`;
}

/** The notification of a new version of the copy that cannot be shown: the right side stays, and the copy is never removed for it. */
export function copyNotLoaded(name: string, why: NotShown): string {
  const not = why === 'tooBig' ? 'est trop grande pour être comparée ici' : 'n’a pas pu être lue';
  return `La copie « ${name} » a changé sur un autre PC, mais sa nouvelle version ${not} : elle est gardée.`;
}

/** The notification of « Enregistrer et retirer la copie » whose copy changed elsewhere before the save (reconcileTex's `copyKept`). */
export function copyKeptNotice(name: string): string {
  return `La copie « ${name} » a changé sur un autre PC : elle est gardée.`;
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
 * What the window's closing makes of a comparison (task 8a, from the review of task 6): blocks taken and not saved are
 * saved as « Enregistrer » saves them — `save(m.text, m.base, null)`: the original only, a version from elsewhere kept
 * under its conflict name (D6), the copy left in the node —, one action that Ctrl+Z undoes once the app is open again.
 * Nothing taken: nothing asked. Saved, the text is the model's saved one. The answer, or null when nothing was to save.
 */
export async function closingSave(
  m: Reconciliation, save: (text: string, base: string | null, removeCopy: null) => Promise<SaveAnswer>,
): Promise<SaveAnswer | null> {
  if (!m.dirty) return null;
  const text = m.text, r = await save(text, m.base, null);
  if (r.ok) m.wrote(text, r.hash);
  return r;
}

/** What a reconciliation answers: a save's answer, and the copy's name when it was to be removed but changed meanwhile (`copyKept`). */
export type ReconcileAnswer = SaveAnswer & { copyKept?: string };

/**
 * A comparison saved (plan 5b, D7): `text`, the original with the blocks taken from the copy, stored (`storeText`, the
 * main process's) and replacing the original in its node; null when none was taken, the original then left as it is.
 * `removeCopy`: the copy compared — its name, the hash of the version shown — leaves the node's files in the same action
 * (the blob stays in the store); holding another version when the action is computed, it stays, and the answer names it
 * (`copyKept`, task 8a). One action, « Réconcilier « x.tex » » (reconcileTexBuild), never merged with the saves before
 * it: one undo step. Refused — the node or the original gone, the store refusing the text —, why in French; a node or
 * an original gone already is refused before anything is stored. Saved, the answer gives the hash the original now holds.
 *
 * `base` (D6, as saveTex has it): the hash of the version the text was made from. The original holding another one when
 * the action is computed — changed elsewhere meanwhile —, that version is kept under its conflict name in the same
 * action, which the answer names (`kept`).
 */
export async function reconcileTex(
  session: Pick<EditSession, 'run' | 'state'>, storeText: (name: string, text: string) => Promise<FileRef>, node: Id, original: string, text: string | null,
  opts: { removeCopy?: Pick<FileRef, 'name' | 'hash'>; base?: string | null } = {},
): Promise<ReconcileAnswer> {
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
  const remove = opts.removeCopy;
  /** The copy's name when it holds another version than the one compared, as the action is computed: it stays. */
  let copyKept: string | undefined;
  // Never merged with the saves before it: one undo step.
  const { result: r, kept } = await runKeepingTheirs(
    session, node, original, ref, opts.base,
    (st, keep) => {
      const now = remove && st.nodes.get(node)?.files.find((f) => sameName(f.name, remove.name));
      copyKept = now && now.hash !== remove.hash ? now.name : undefined;
      return reconcileTexBuild(st, node, original, ref, { removeCopy: remove, keepTheirs: keep.theirs !== undefined, at: keep.at });
    },
  );
  if (!r.ok && r.message !== UP_TO_DATE) return { ok: false, message: r.message };
  const hash = ref?.hash ?? session.state.nodes.get(node)?.files.find((f) => sameName(f.name, original))?.hash;
  const answer: ReconcileAnswer = hash === undefined ? { ok: true } : { ok: true, hash };
  if (r.ok && kept !== undefined) answer.kept = kept;
  if (copyKept !== undefined) answer.copyKept = copyKept;
  return answer;
}
