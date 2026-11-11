import { useEffect } from 'react';

export interface Question {
  text: string;
  detail?: string;
  /** In the order shown; the first is the answer Enter gives, */
  choices: { value: string; label: string }[];
  /** unless « Annuler » has the focus: a question whose choices lose what is typed (Enter never does). */
  focusCancel?: boolean;
  /** No « Annuler »: a question whose choices include giving up (« Non »); Escape still does. */
  noCancel?: boolean;
  answer(value: string | null): void;
}

/** The button that has the focus as the question opens, which Enter presses: a choice's index, −1 for « Annuler ». */
export function focusedChoice(q: Question): number {
  return q.focusCancel || q.choices.length === 0 ? -1 : 0;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * A question asked over the graph (« partout ou ici seulement », spec 10, 11, 19): its first choice has the focus, or
 * « Annuler » (focusedChoice); Escape gives up the whole action.
 */
export function AskDialog(props: { q: Question; onClose(): void }) {
  const answer = (v: string | null) => { props.onClose(); props.q.answer(v); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); answer(null); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [props.q]);
  const focused = focusedChoice(props.q);
  return (
    <div className="ask" role="dialog" onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onKeyDown={stop}>
      <p>{props.q.text}</p>
      {props.q.detail && <p className="detail">{props.q.detail}</p>}
      <div className="choices">
        {props.q.choices.map((c, i) => <button key={c.value} autoFocus={i === focused} onClick={() => answer(c.value)}>{c.label}</button>)}
        {!props.q.noCancel && <button className="cancel" autoFocus={focused === -1} onClick={() => answer(null)}>Annuler</button>}
      </div>
    </div>
  );
}
