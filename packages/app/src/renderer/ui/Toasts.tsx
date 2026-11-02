export interface Toast { id: number; text: string }

/** Notifications: refused edits, undo steps in another plan (spec 6.4). */
export function Toasts(props: { toasts: Toast[] }) {
  if (props.toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {props.toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
    </div>
  );
}
