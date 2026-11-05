import { BASE_PACKAGES, type LatexStatus } from '@cirrus/core';
import { type RenderParams, WORD } from '@cirrus/view';
import { LATEX_SOURCES } from '../../main/latex/sources.ts';

/** The pinned installer's size, in whole Mo (decimal, as a download is told): 74 for TinyTeX v2026.11 (final review, M4). */
const DOWNLOAD_MO = Math.round(LATEX_SOURCES.tinytex.bytes / 1e6);

/**
 * The settings with `name` added to `latexPackages`, the shared list every PC installs at its start (D1): null when
 * the list holds it already, when every installation gets it (BASE_PACKAGES), or when the setting would refuse it.
 */
export function withPackage(params: RenderParams, name: string): RenderParams | null {
  if (!WORD.test(name) || params.latexPackages.includes(name) || BASE_PACKAGES.includes(name)) return null;
  return { ...params, latexPackages: [...params.latexPackages, name] };
}

/** What the settings' « LaTeX » section says of LaTeX on this PC; null: not known yet. */
export function latexStateText(s: LatexStatus | null): string {
  if (s === null) return 'LaTeX : …';
  switch (s.state) {
    case 'ready': return `LaTeX : prêt (${s.version})`;
    case 'absent': return 'LaTeX : absent';
    case 'installing': return 'LaTeX : installation…';
    case 'failed': return 'LaTeX : l’installation a échoué';
  }
}

/** The notice's text and buttons: `install` (« Installer »), `retry` (« Réessayer »), `later` (« Plus tard »). */
export interface LatexNoticeContent { text: string; actions: ('install' | 'retry' | 'later')[] }

/**
 * The notice at the top of the window (task 7), for `s` (null: not known yet): LaTeX absent, the offer to install it,
 * until « Plus tard » (`dismissed`, for the session); its installation's progress, and a package's; once installed
 * during the session, « LaTeX est installé. » for a moment (`justInstalled`); its failure, the reason, with « Réessayer »,
 * until « Plus tard ». Nothing when LaTeX was there from the start.
 */
export function noticeFor(s: LatexStatus | null, seen: { dismissed: boolean; justInstalled: boolean }): LatexNoticeContent | null {
  if (s === null) return null;
  switch (s.state) {
    case 'absent':
      return seen.dismissed ? null : {
        text: `LaTeX n’est pas installé : les résumés et les .tex s’affichent en source. Cirrus peut installer TinyTeX (environ ${DOWNLOAD_MO} Mo à télécharger).`,
        actions: ['install', 'later'],
      };
    case 'installing': {
      const p = s.progress;
      const text = p.step === 'download' ? `Installation de LaTeX : ${p.total > 0 ? Math.floor((100 * p.done) / p.total) : 0} %`
        : p.step === 'extract' ? 'Installation de LaTeX : décompression…'
        : p.step === 'packages' ? 'Installation des paquets…'
        : `Installation du paquet LaTeX « ${p.name} »…`;
      return { text, actions: [] };
    }
    case 'ready':
      return seen.justInstalled ? { text: 'LaTeX est installé.', actions: [] } : null;
    case 'failed':
      return seen.dismissed ? null : { text: `L’installation de LaTeX a échoué : ${s.message}`, actions: ['retry', 'later'] };
  }
}
