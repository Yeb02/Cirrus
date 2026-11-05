import type { LatexStatus } from '@cirrus/core';
import { useEffect, useRef, useState } from 'react';
import { noticeFor } from '../../latex/install.ts';

const LABELS = { install: 'Installer', retry: 'Réessayer', later: 'Plus tard' } as const;

/**
 * The notice of LaTeX's state at the top of the window (task 7), over the graph with the toasts (noticeFor): without
 * LaTeX, the offer to install TinyTeX, once per session — « Plus tard » puts it away —; the installation's progress,
 * and a missing package's; « LaTeX est installé. » for `toastMs` once it is; a failure with its reason and
 * « Réessayer ». An installation started again (from the settings too) shows again what comes of it.
 */
export function LatexNotice(props: { status: LatexStatus | null; toastMs: number; onInstall(): void }) {
  const { status } = props;
  const [dismissed, setDismissed] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  /** TinyTeX's installation seen under way, which `ready` then ends. */
  const installing = useRef(false);
  useEffect(() => {
    if (status?.state === 'installing' && status.progress.step !== 'package') {
      installing.current = true;
      setDismissed(false);
      setJustInstalled(false);
    } else if (status?.state === 'ready' && installing.current) {
      installing.current = false;
      setJustInstalled(true);
    } else if (status?.state !== 'installing') installing.current = false;
  }, [status]);
  useEffect(() => {
    if (!justInstalled) return;
    const timer = window.setTimeout(() => setJustInstalled(false), props.toastMs);
    return () => window.clearTimeout(timer);
  }, [justInstalled]);
  const notice = noticeFor(status, { dismissed, justInstalled });
  if (!notice) return null;
  return (
    <div className="toast latex-notice">
      <span>{notice.text}</span>
      {notice.actions.map((a) => (
        <button key={a} className={a === 'later' ? 'later' : undefined} onClick={() => (a === 'later' ? setDismissed(true) : props.onInstall())}>{LABELS[a]}</button>
      ))}
    </div>
  );
}
