import type { CompileRequest, TexError } from '@cirrus/core';
import { knownLabels } from '../../latex/scheduler.ts';
import type { Question } from '../Dialogs.tsx';

/**
 * What the preamble's full screen compiles under the draft (D5, task 7): an accented paragraph, a numbered equation
 * cited by \eqref, a list and a link — what a preamble most often changes the look of.
 */
export const PREAMBLE_SAMPLE = [
  'Un paragraphe accentué, pour voir le texte : « Déjà, l’âme naïve du cœur où s’élève ça. » L’entropie d’une source',
  'est donnée par l’équation~\\eqref{eq:exemple-entropie}, que l’on cite ici :',
  '\\begin{equation}',
  '  H(X) = -\\sum_{x} p(x) \\log_2 p(x).',
  '  \\label{eq:exemple-entropie}',
  '\\end{equation}',
  '\\begin{itemize}',
  '  \\item une liste, à puces ;',
  '  \\item avec des mathématiques en ligne, $\\alpha \\leq \\beta$.',
  '\\end{itemize}',
  'Un lien : \\href{https://www.ctan.org}{CTAN}.',
  '',
].join('\n');

/** The slot of the preamble's preview (CompileRequest.slot). */
export const PREAMBLE_SLOT = 'preamble';

/** PREAMBLE_SAMPLE compiled as a page under `draft`: nothing to inject, no file. */
export function preambleRequest(draft: string): CompileRequest {
  return {
    slot: PREAMBLE_SLOT, mode: 'page', source: PREAMBLE_SAMPLE, preamble: draft, refs: [], broken: [], doubled: [], cites: [], doubledCites: [],
    unknownCites: [], known: knownLabels(PREAMBLE_SLOT), resources: [], widthCm: null,
  };
}

/**
 * What « Enregistrer » does now: `close` when the draft is the preamble in effect; `wait` while the draft's compilation
 * runs (its answer decides); `ask` when it does not compile (brokenPreambleQuestion); `save` otherwise — LaTeX absent
 * included, which cannot tell.
 */
export function saveStep(draft: string, saved: string, view: { pending: boolean; error: TexError | null }): 'close' | 'wait' | 'ask' | 'save' {
  if (draft === saved) return 'close';
  if (view.pending) return 'wait';
  return view.error ? 'ask' : 'save';
}

/** Saving a draft that does not compile would break every compilation: asked, « Annuler » with the focus. */
export function brokenPreambleQuestion(save: () => void): Question {
  return {
    text: 'Le préambule ne compile pas. L’enregistrer quand même ?',
    choices: [{ value: 'save', label: 'Enregistrer quand même' }],
    focusCancel: true,
    answer: (v) => { if (v === 'save') save(); },
  };
}

/** Escape (or ×) with the draft changed: asked before what is typed is lost, « Annuler » with the focus. */
export function discardPreambleQuestion(close: () => void): Question {
  return {
    text: 'Abandonner les modifications du préambule ?',
    choices: [{ value: 'drop', label: 'Abandonner' }],
    focusCancel: true,
    answer: (v) => { if (v === 'drop') close(); },
  };
}

/**
 * Leaving without saving — « Annuler », Escape or × once nothing is to be saved or the draft is dropped, « Enregistrer »
 * on an unchanged draft —: the prepared pdfLaTeX are set back to `saved`, the preamble in effect, which the draft's
 * compilations had taken them from (the next summary would otherwise wait for a cold one; final review), then the full
 * screen closes. Saving needs none: App prepares them with the new preamble.
 */
export function leaveUnsaved(saved: string, warm: (preamble: string) => void, close: () => void): void {
  warm(saved);
  close();
}
