import type { ReactNode } from 'react';

export interface Toast { id: number; text: string }

/** Notifications: refused edits, undo steps in another plan (spec 6.4); `children` above them (LaTeX's notice, task 7). */
export function Toasts(props: { toasts: Toast[]; children?: ReactNode }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {props.children}
      {props.toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
    </div>
  );
}
