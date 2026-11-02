import { useEffect } from 'react';

export interface Question {
  text: string;
  detail?: string;
  /** In the order shown; the first is the answer Enter gives. */
  choices: { value: string; label: string }[];
  answer(value: string | null): void;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * A question asked over the graph (« partout ou ici seulement », spec 10, 11, 19): its first choice has the focus;
 * Escape gives up the whole action.
 */
export function AskDialog(props: { q: Question; onClose(): void }) {
  const answer = (v: string | null) => { props.onClose(); props.q.answer(v); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); answer(null); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [props.q]);
  return (
    <div className="ask" role="dialog" onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onKeyDown={stop}>
      <p>{props.q.text}</p>
      {props.q.detail && <p className="detail">{props.q.detail}</p>}
      <div className="choices">
        {props.q.choices.map((c, i) => <button key={c.value} autoFocus={i === 0} onClick={() => answer(c.value)}>{c.label}</button>)}
        <button className="cancel" onClick={() => answer(null)}>Annuler</button>
      </div>
    </div>
  );
}
