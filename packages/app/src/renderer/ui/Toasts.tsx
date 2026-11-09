import type { RenderParams } from '@cirrus/view';
import { type ReactNode, useEffect, useState } from 'react';

/** A notification; `closable`: a .bib's import (plan 4c), which a click on it or Escape closes before its time. */
export interface Toast { id: number; text: string; closable?: boolean }

/**
 * How long a notification stays: toastMs; a .bib's import, whose lists of duplicates and problems are read, bibNoticeMs
 * (review of task 6, I1).
 */
export const toastMsFor = (closable: boolean, p: Pick<RenderParams, 'toastMs' | 'bibNoticeMs'>): number => (closable ? p.bibNoticeMs : p.toastMs);
/** The notifications once a click on `id` closed it: a closable one only (the others take no clicks). */
export const toastClicked = (shown: Toast[], id: number): Toast[] => (shown.some((t) => t.id === id && t.closable) ? shown.filter((t) => t.id !== id) : shown);
/** The notifications once an Escape that nothing took closed the closable ones: the same list when there is none. */
export const toastsEscaped = (shown: Toast[]): Toast[] => (shown.some((t) => t.closable) ? shown.filter((t) => !t.closable) : shown);

/** App's notifications (Toasts), `paramsRef` holding toastMs and bibNoticeMs. */
export function useToasts(paramsRef: { readonly current: Pick<RenderParams, 'toastMs' | 'bibNoticeMs'> }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  /**
   * A notification, for toastMs; `closable` (a .bib's import, plan 4c), for bibNoticeMs, unless a click on it or an
   * Escape that nothing took closes it sooner (review of task 6, I1).
   */
  const toast = (text: string, closable = false) => {
    const id = Math.random();
    setToasts((t) => [...t, closable ? { id, text, closable } : { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), toastMsFor(closable, paramsRef.current));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setToasts(toastsEscaped); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** A click on the notification `id`: closed if it is closable. */
  const closeToast = (id: number) => setToasts((t) => toastClicked(t, id));
  return { toasts, toast, closeToast };
}

/**
 * Notifications: refused edits, undo steps in another plan (spec 6.4); `children` above them (LaTeX's notice, task 7).
 * One of several lines (a .bib imported, plan 4c) keeps them; a closable one takes a click, which closes it (`onClose`).
 */
export function Toasts(props: { toasts: Toast[]; onClose(id: number): void; children?: ReactNode }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {props.children}
      {props.toasts.map((t) => {
        const kind = t.text.includes('\n') ? 'toast lines' : 'toast';
        if (!t.closable) return <div key={t.id} className={kind}>{t.text}</div>;
        return <div key={t.id} className={`${kind} closable`} title="Cliquer ou Échap pour fermer" onClick={() => props.onClose(t.id)}>{t.text}</div>;
      })}
    </div>
  );
}
