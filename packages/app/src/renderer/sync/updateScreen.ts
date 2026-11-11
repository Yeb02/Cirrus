import type { UpdateFlow } from '../../main/sync/protocol.ts';

// The forced update's screen (2026-11-11; plan 9, D4): over the whole window, above everything, from the moment the
// updater holds a signed manifest of a newer version. It blocks the app while the installer downloads and the app
// restarts — no button then —; a failure, a refusal or the end-to-end check's stop offers to go on, for that attempt
// only: the next check's attempt shows it again.

/** What the screen shows: its title, its line, the download's progress (whole percent, or none), its one button. */
export interface UpdateScreen { title: string; line: string; percent: number | null; action: string | null; attempt: number }

/** The button after a failure or a refusal. */
export const GO_ON = 'Continuer sans mettre à jour';

/** The screen of `flow`, none when there is no update under way or when its attempt was dismissed (`dismissed`, the last). */
export function updateScreenOf(flow: UpdateFlow | undefined, dismissed: number): UpdateScreen | null {
  if (!flow) return null;
  const shown = (line: string, action: string | null = null, percent: number | null = null): UpdateScreen => ({
    title: `Mise à jour de Cirrus vers ${flow.version}`, line, percent, action, attempt: flow.attempt,
  });
  // Never dismissed: all goes well.
  if (flow.step === 'downloading') return shown('Téléchargement…', null, flow.percent ?? null);
  if (flow.step === 'restarting') return shown('Enregistrement, puis redémarrage…');
  if (flow.attempt <= dismissed) return null;
  switch (flow.step) {
    case 'failed': return shown(`Le téléchargement a échoué (${flow.message}). Cirrus réessaiera à la prochaine vérification.`, GO_ON);
    case 'refused': return shown(`Mise à jour refusée : ${flow.message}. Rien n’est installé.`, GO_ON);
    case 'trial': return shown('Essai de bout en bout : la mise à jour est vérifiée et prête, mais son installation n’est pas lancée.', 'Continuer');
  }
}

/** Whether a key reaches the page while the screen is up: Enter or Space on its own button, which they press; none else. */
export function passesKey(key: string, onButton: boolean): boolean {
  return onButton && (key === 'Enter' || key === ' ');
}

/** The chip's line for the update under way (syncSession.ts: chipOf). */
export function updateChipLine(flow: UpdateFlow): string {
  const to = `Mise à jour vers ${flow.version}`;
  switch (flow.step) {
    case 'downloading': return `${to} : téléchargement…`;
    case 'restarting': return `${to} : redémarrage…`;
    case 'trial': return `${to} : essai, non installée`;
    case 'failed': return `${to} : téléchargement échoué`;
    case 'refused': return `${to} refusée`;
  }
}
